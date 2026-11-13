import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { CloudRunAdapter } from '../adapters/providers/gcp/cloudrun.adapter.js';
import { dnsZoneScopeForDomain } from '../domain/services/domain-scope.js';
import { dnsHostnameBelongsToZone, dnsHostnameSchema } from '../domain/spec/dns.schema.js';
import type { DesiredDnsRecord } from './dns-engine.js';

/** Google owns verification and mapping; every DNS resource write belongs to the saved engine plan. */
export const DOMAIN_VERIFY_OPERATION = 'gcpDomainVerify';
export const DOMAIN_DNS_OPERATION = 'gcpDomainDns';
export const DOMAIN_READY_OPERATION = 'gcpDomainReady';
export const DOMAIN_DNS_REMOVE_OPERATION = 'gcpDomainDnsRemove';
export interface DomainContext { adapter: CloudRunAdapter; gcpProjectId: string; region: string; serviceName?: string }
type Ownership = 'present' | 'absent' | 'api-disabled' | { unknown: string };
export type DomainMappingObservation = { state: 'absent' } | { state: 'unknown'; reason: string } | {
  state: 'present'; uid: string; namespace: string; domain: string; serviceName: string;
  ready: boolean; certificate: string; dnsRecords?: DesiredDnsRecord[]; sourceFingerprint: string;
};
const normalized = (value: string) => value.toLowerCase().replace(/\.$/, '');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function siteVerificationFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://www.googleapis.com/siteVerification/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, 1);
}
const ownedList = z.object({ items: z.array(z.object({ id: z.string().min(1),
  site: z.object({ type: z.string(), identifier: z.string().min(1) }), owners: z.array(z.string()).min(1),
})).max(10000) });

/** A permission error is unknown. Only a complete successful owned-site list proves nonownership. */
async function observeOwnership(context: DomainContext, verificationDomain: string): Promise<Ownership> {
  try {
    const token = await context.adapter.siteVerificationAccessToken();
    const response = await siteVerificationFetch(token, 'webResource');
    if (!response.ok) {
      if (response.status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(await response.text())) return 'api-disabled';
      return { unknown: `Google Site Verification ownership is unknown (HTTP ${response.status}).` };
    }
    const parsed = ownedList.safeParse(await response.json());
    if (!parsed.success) return { unknown: 'Google returned an incomplete verified-domain inventory.' };
    const matches = parsed.data.items.filter(item => item.site.type === 'INET_DOMAIN' && normalized(item.site.identifier) === verificationDomain);
    if (matches.length > 1) return { unknown: 'Google returned ambiguous ownership identities for the verification domain.' };
    if (!matches.length) return 'absent';
    return matches[0]!.owners.includes(context.adapter.engineDeploymentIdentity()) ? 'present'
      : { unknown: 'The verified domain does not include the exact deployment identity.' };
  } catch { return { unknown: 'The Google verified-domain inventory could not be read.' }; }
}

const mappingSchema = z.object({
  metadata: z.object({ name: z.string().min(1), namespace: z.string().min(1), uid: z.string().min(1),
    generation: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional() }),
  spec: z.object({ routeName: z.string().min(1) }),
  status: z.object({
    observedGeneration: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
    mappedRouteName: z.string().optional(),
    conditions: z.array(z.object({ type: z.string(), status: z.string(), reason: z.string().optional() })).max(64).optional(),
    resourceRecords: z.array(z.object({ name: z.string().optional(), type: z.enum(['A', 'AAAA', 'CNAME']), rrdata: z.string().min(1) })).max(64).optional(),
  }).optional(),
});

/** Fresh immutable mapping identity and its provider-supplied DNS requirements. */
export async function observeDomainMapping(context: DomainContext, domain: string): Promise<DomainMappingObservation> {
  try {
    const token = await context.adapter.engineAccessToken();
    const response = await fetchWithRetry(`https://${context.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${encodeURIComponent(context.gcpProjectId)}/domainmappings/${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }, 1);
    if (response.status === 404) return { state: 'absent' };
    if (!response.ok) return { state: 'unknown', reason: `Cloud Run mapping observation failed (HTTP ${response.status}).` };
    const parsed = mappingSchema.safeParse(await response.json());
    if (!parsed.success) return { state: 'unknown', reason: 'Cloud Run returned an incomplete domain mapping identity or DNS requirements.' };
    const body = parsed.data;
    if (normalized(body.metadata.name) !== domain || context.serviceName && body.spec.routeName !== context.serviceName
      || body.status?.mappedRouteName && body.status.mappedRouteName !== body.spec.routeName) {
      return { state: 'unknown', reason: 'The domain mapping targets a different hostname or native service.' };
    }
    const groups = new Map<string, DesiredDnsRecord>();
    for (const record of body.status?.resourceRecords ?? []) {
      const base = dnsZoneScopeForDomain(domain);
      // Google defines name as relative and applicable only to CNAME records.
      const owner = record.type !== 'CNAME' ? domain : record.name
        ? normalized(record.name).endsWith(`.${base}`) || normalized(record.name) === base
          ? normalized(record.name) : `${normalized(record.name)}.${base}`
        : undefined;
      if (owner !== domain) return { state: 'unknown', reason: 'Cloud Run returned DNS requirements for a different or incomplete record owner.' };
      const value = record.type === 'CNAME' ? normalized(record.rrdata) : record.rrdata;
      const key = `${owner}|${record.type}`;
      const prior = groups.get(key);
      if (prior) prior.values = [...new Set([...prior.values, value])].sort();
      else groups.set(key, { key: `gcp_domain_${record.type.toLowerCase()}`, name: owner, type: record.type, values: [value], ttl: 300, proxied: false });
    }
    const dnsRecords = body.status?.resourceRecords ? [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) : undefined;
    const conditions = body.status?.conditions ?? [];
    const certificate = conditions.find(entry => entry.type === 'CertificateProvisioned');
    const currentGeneration = body.metadata.generation !== undefined && body.status?.observedGeneration !== undefined
      && String(body.metadata.generation) === String(body.status.observedGeneration);
    const ready = currentGeneration && conditions.find(entry => entry.type === 'Ready')?.status === 'True'
      && certificate?.status === 'True';
    const identity = { uid: body.metadata.uid, namespace: body.metadata.namespace, domain, serviceName: body.spec.routeName, dnsRecords };
    return { state: 'present', ...identity, ready, certificate: certificate?.status === 'True' ? 'issued' : certificate?.reason ?? 'pending',
      sourceFingerprint: hash(identity) };
  } catch { return { state: 'unknown', reason: 'The exact Cloud Run domain mapping could not be observed.' }; }
}

export interface DomainPlanActions {
  before: PlanAction[]; after: PlanAction[]; blocked?: string; dnsRecords?: DesiredDnsRecord[];
  ownershipPresent?: boolean; mappingPresent?: boolean; verificationDomain?: string; sourceFingerprint?: string;
}

function healthUrl(domain: string, path: string): URL | undefined {
  try {
    const url = new URL(path, `https://${domain}`);
    return path.startsWith('/') && !path.startsWith('//') && url.origin === `https://${domain}`
      && !url.hash && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

async function successfulHttps(url: URL): Promise<boolean> {
  try {
    const response = await fetchWithRetry(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }, 1);
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300;
  } catch { return false; }
}

/** Google verification, native mapping, engine DNS, and HTTPS remain separate reviewed stages. */
export async function planDomain(context: DomainContext, requestedDomain: string, healthPath: string, zoneName?: string): Promise<DomainPlanActions> {
  const parsed = dnsHostnameSchema.safeParse(requestedDomain);
  const block = (blocked: string): DomainPlanActions => ({ before: [], after: [], blocked });
  if (!parsed.success) return block('Choose a complete public DNS hostname for the custom domain.');
  const domain = parsed.data;
  const url = healthUrl(domain, healthPath);
  if (!url) return block('The health check must stay on the reviewed HTTPS hostname.');
  const verificationDomain = dnsZoneScopeForDomain(domain);
  if (zoneName && !dnsHostnameBelongsToZone(verificationDomain, zoneName)) return block(`Google requires ownership proof at ${verificationDomain}; the selected DNS zone cannot contain that base-domain record.`);
  const ownership = await observeOwnership(context, verificationDomain);
  if (typeof ownership === 'object') return block(ownership.unknown);
  if (ownership === 'api-disabled') return block('The Google Site Verification API is disabled. Review project access preparation before continuing.');
  const mapping = await observeDomainMapping(context, domain);
  if (mapping.state === 'unknown') return block(mapping.reason);
  const dnsRecords: DesiredDnsRecord[] = [];
  if (ownership === 'absent') {
    try {
      const token = await context.adapter.siteVerificationAccessToken();
      const response = await siteVerificationFetch(token, 'token', { method: 'POST', body: JSON.stringify({
        site: { type: 'INET_DOMAIN', identifier: verificationDomain }, verificationMethod: 'DNS_TXT',
      }) });
      if (!response.ok) return block(`Google did not provide the ownership proof (HTTP ${response.status}).`);
      const body = await response.json() as { token?: unknown };
      if (typeof body.token !== 'string' || !body.token.trim() || body.token.length > 8192) return block('Google returned an incomplete ownership proof.');
      dnsRecords.push({ key: 'gcp_domain_verification', name: verificationDomain, type: 'TXT', values: [body.token], ttl: 300, proxied: false });
    } catch { return block('Google ownership proof could not be prepared. No DNS action was authorized.'); }
  } else if (mapping.state === 'present') {
    if (!mapping.dnsRecords?.length) return block('The Cloud Run mapping has not supplied complete DNS requirements yet. Run hv_plan again after it becomes available.');
    dnsRecords.push(...mapping.dnsRecords);
  }
  const metadata = { gcpProjectId: context.gcpProjectId, region: context.region, domain, verificationDomain,
    ...(context.serviceName ? { serviceName: context.serviceName } : {}) };
  const ready = mapping.state === 'present' && mapping.ready && await successfulHttps(url);
  return {
    before: [{ id: `domain-verify:${domain}`, type: ownership === 'present' ? 'noop' : 'create',
      resource: { kind: 'domain', name: `${domain} ownership`, provider: 'gcp' }, verified: true,
      reason: ownership === 'present' ? `Google verified the deployment identity for ${verificationDomain}.` : `Ask Google to verify the reviewed DNS proof for ${verificationDomain}.`,
      metadata: { ...metadata, operation: DOMAIN_VERIFY_OPERATION } }],
    after: [{ id: `domain-ready:${domain}`, type: ready ? 'noop' : 'update', resource: { kind: 'domain', name: `${domain} certificate`, provider: 'gcp' },
      verified: true, reason: 'Verify the exact mapping, issued certificate and successful HTTPS response.',
      metadata: { ...metadata, operation: DOMAIN_READY_OPERATION, healthPath } }],
    dnsRecords, ownershipPresent: ownership === 'present', mappingPresent: mapping.state === 'present', verificationDomain,
    sourceFingerprint: mapping.state === 'present' ? mapping.sourceFingerprint : 'absent',
  };
}

/** Historical plans never gain authority to write DNS without their saved engine artifact. */
export async function executeDomainAction(context: DomainContext, action: PlanAction): Promise<ActionResult> {
  const metadata = action.metadata ?? {};
  const domain = typeof metadata.domain === 'string' ? normalized(metadata.domain) : '';
  const operation = metadata.operation;
  if (operation === DOMAIN_DNS_OPERATION || operation === DOMAIN_DNS_REMOVE_OPERATION) return {
    success: false, status: 'blocked', message: 'This historical DNS action has no saved OpenTofu plan. Run hv_plan to review exact owned DNS resources.',
  };
  if (!dnsHostnameSchema.safeParse(domain).success) return { success: false, status: 'blocked', message: 'The domain action has no exact hostname.' };
  if (metadata.gcpProjectId !== undefined && metadata.gcpProjectId !== context.gcpProjectId
    || metadata.region !== undefined && metadata.region !== context.region
    || context.serviceName && metadata.serviceName !== undefined && metadata.serviceName !== context.serviceName) {
    return { success: false, status: 'blocked', message: 'The reviewed Google project, region or service changed. Run hv_plan again.' };
  }
  if (operation === DOMAIN_VERIFY_OPERATION) {
    const verificationDomain = dnsZoneScopeForDomain(domain);
    if (metadata.verificationDomain !== undefined && metadata.verificationDomain !== verificationDomain) return { success: false, status: 'blocked', message: 'The reviewed base-domain ownership target changed.' };
    const ownership = await observeOwnership(context, verificationDomain);
    if (ownership === 'present') return { success: true, message: `Google verified the deployment identity for ${verificationDomain}.` };
    if (ownership === 'api-disabled') return { success: false, status: 'blocked', message: 'The Google Site Verification API is disabled. Review project access preparation before continuing.' };
    if (typeof ownership === 'object') return { success: false, status: 'blocked', message: ownership.unknown };
    if (metadata.verificationDomain !== verificationDomain) return { success: false, status: 'blocked', message: 'This historical plan did not review base-domain verification. Run hv_plan again.' };
    try {
      const token = await context.adapter.siteVerificationAccessToken();
      const response = await siteVerificationFetch(token, 'webResource?verificationMethod=DNS_TXT', {
        method: 'POST', body: JSON.stringify({ site: { type: 'INET_DOMAIN', identifier: verificationDomain } }),
      });
      if (response.status === 400) return { success: false, status: 'pending', message: 'Google has not validated the staged DNS proof yet. Run hv_plan again after propagation.' };
      if (!response.ok) return { success: false, status: 'blocked', message: `Google domain verification failed (HTTP ${response.status}).` };
      const verified = await observeOwnership(context, verificationDomain);
      return verified === 'present' ? { success: true, message: `Google verified the deployment identity for ${verificationDomain}.` }
        : { success: false, status: 'pending', message: 'Google accepted verification but current ownership has not been confirmed. Run hv_plan again.' };
    } catch { return { success: false, status: 'pending', message: 'Google verification has an uncertain outcome. Re-observe ownership with hv_plan before retrying.' }; }
  }
  if (operation === DOMAIN_READY_OPERATION) {
    const mapping = await observeDomainMapping({ ...context,
      ...(typeof metadata.serviceName === 'string' ? { serviceName: metadata.serviceName } : {}) }, domain);
    if (mapping.state === 'unknown') return { success: false, status: 'blocked', message: mapping.reason };
    if (mapping.state === 'absent') return { success: false, status: 'blocked', message: 'The exact Cloud Run mapping is absent.' };
    if (!mapping.ready) return { success: false, status: 'pending', message: 'Cloud Run has not finished reconciling the mapping and certificate. Run hv_plan again later.' };
    const healthPath = typeof metadata.healthPath === 'string' ? metadata.healthPath : '/';
    const url = healthUrl(domain, healthPath);
    if (!url) return { success: false, status: 'blocked', message: 'The health check must stay on the reviewed HTTPS hostname.' };
    if (await successfulHttps(url)) return { success: true, message: 'The issued custom-domain certificate and HTTPS response are verified.', data: { url: `https://${domain}` } };
    return { success: false, status: 'pending', message: 'The custom domain did not return a successful HTTPS response. Run hv_plan again after the application is ready.' };
  }
  return { success: false, status: 'blocked', message: 'No domain authority exists for this action.' };
}
