import type { ActionResult } from '../domain/plan/converge.executor.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { CloudRunAdapter } from '../adapters/providers/gcp/cloudrun.adapter.js';
import { findCloudflareZone, getCloudflareAdapterFromHints } from '../domain/services/cloudflare-ops.service.js';
import { dnsZoneScopeForDomain } from '../domain/services/domain-scope.js';
import type { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';

/**
 * Custom domains for OpenTofu-managed Cloud Run environments.
 *
 * OpenTofu owns the Cloud Run domain mapping. Hypervibe owns everything that
 * needs DNS or Google account state: proving ownership to Google as the
 * deployment identity (TXT record + Site Verification API), writing the
 * traffic records, and waiting for the certificate. Users never visit Search
 * Console or a DNS dashboard.
 */
export const DOMAIN_VERIFY_OPERATION = 'gcpDomainVerify';
export const DOMAIN_DNS_OPERATION = 'gcpDomainDns';
export const DOMAIN_READY_OPERATION = 'gcpDomainReady';
export const DOMAIN_DNS_REMOVE_OPERATION = 'gcpDomainDnsRemove';

const SUBDOMAIN_TARGET = 'ghs.googlehosted.com';
const APEX_TARGETS: Record<'A' | 'AAAA', string[]> = {
  A: ['216.239.32.21', '216.239.34.21', '216.239.36.21', '216.239.38.21'],
  AAAA: ['2001:4860:4802:32::15', '2001:4860:4802:34::15', '2001:4860:4802:36::15', '2001:4860:4802:38::15'],
};

type Tri = 'present' | 'absent' | { unknown: string };

export interface DomainContext {
  adapter: CloudRunAdapter;
  gcpProjectId: string;
  region: string;
}

function isApex(domain: string, zoneName: string): boolean {
  return domain === zoneName;
}

function normalizeContent(value: string): string {
  return value.replace(/\.$/, '').toLowerCase();
}

/** The traffic records Google expects; fixed targets, so DNS can be written before the mapping exists. */
export function expectedTrafficRecords(domain: string, zoneName: string): Array<{ type: string; content: string }> {
  return isApex(domain, zoneName)
    ? [...APEX_TARGETS.A.map((content) => ({ type: 'A', content })), ...APEX_TARGETS.AAAA.map((content) => ({ type: 'AAAA', content }))]
    : [{ type: 'CNAME', content: SUBDOMAIN_TARGET }];
}

export async function cloudflareFor(domain: string): Promise<{ adapter: CloudflareAdapter; zoneId: string; zoneName: string } | { error: string }> {
  // A connection scoped to the zone (example.com) covers its hostnames (app.example.com).
  const resolved = getCloudflareAdapterFromHints([...new Set([domain, dnsZoneScopeForDomain(domain)])]);
  if ('error' in resolved) return { error: `Hypervibe needs access to Cloudflare to manage DNS for ${domain}. Connect it with hv_connections provider="cloudflare" action="connect" scope="${domain}" (opens a one-step page in the browser).` };
  const zone = await findCloudflareZone(resolved.adapter, domain);
  if (!zone) return { error: `No Cloudflare zone visible to the connection contains ${domain}.` };
  return { adapter: resolved.adapter, zoneId: zone.id, zoneName: zone.name };
}

async function siteVerificationFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://www.googleapis.com/siteVerification/v1/${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function observeOwnership(context: DomainContext, domain: string): Promise<Tri | 'api-disabled'> {
  const token = await context.adapter.siteVerificationAccessToken();
  const response = await siteVerificationFetch(token, `webResource/${encodeURIComponent(`dns://${domain}`)}`);
  if (response.status === 404) return 'absent';
  if (response.status === 403) {
    const text = await response.text();
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return 'api-disabled';
    // Site Verification answers 403 for resources the caller does not own.
    return /forbidden|permission/i.test(text) ? 'absent' : { unknown: 'Site Verification returned HTTP 403.' };
  }
  if (!response.ok) return { unknown: `Site Verification returned HTTP ${response.status}.` };
  const body = await response.json() as { owners?: string[] };
  return (body.owners ?? []).includes(context.adapter.engineDeploymentIdentity()) ? 'present' : 'absent';
}

async function observeTrafficDns(domain: string): Promise<Tri | { conflict: string }> {
  const cloudflare = await cloudflareFor(domain);
  if ('error' in cloudflare) return { unknown: cloudflare.error };
  let records;
  try {
    records = await cloudflare.adapter.listRecords(cloudflare.zoneId);
  } catch (error) {
    return { unknown: `Reading DNS for ${domain} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const atName = records.filter((record) => normalizeContent(record.name) === domain && ['A', 'AAAA', 'CNAME'].includes(record.type));
  const expected = expectedTrafficRecords(domain, cloudflare.zoneName);
  const foreign = atName.find((record) => !expected.some((target) => target.type === record.type && normalizeContent(record.content) === target.content));
  if (foreign) return { conflict: `${domain} already has a ${foreign.type} record pointing elsewhere. Hypervibe will not overwrite DNS it did not create; remove it or choose another hostname.` };
  if (atName.some((record) => record.proxied)) return { conflict: `${domain} is proxied by Cloudflare; Google cannot issue its certificate. Turn the proxy off for this record.` };
  return expected.every((target) => atName.some((record) => record.type === target.type && normalizeContent(record.content) === target.content)) ? 'present' : 'absent';
}

async function domainMapping(context: DomainContext, domain: string): Promise<{ state: 'present'; ready: boolean; certificate: string } | { state: 'absent' } | { state: 'unknown'; reason: string }> {
  const token = await context.adapter.engineAccessToken();
  const response = await fetchWithRetry(`https://${context.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${context.gcpProjectId}/domainmappings/${domain}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unknown', reason: `Cloud Run returned HTTP ${response.status} for the ${domain} mapping.` };
  const body = await response.json() as { status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }> } };
  const conditions = body.status?.conditions ?? [];
  const condition = (type: string) => conditions.find((entry) => entry.type === type);
  return {
    state: 'present',
    ready: condition('Ready')?.status === 'True',
    certificate: condition('CertificateProvisioned')?.status === 'True' ? 'issued' : condition('CertificateProvisioned')?.reason ?? 'pending',
  };
}

export interface DomainPlanActions {
  before: PlanAction[];
  after: PlanAction[];
  blocked?: string;
}

/** Observes one desired domain and returns the Hypervibe-owned actions around the engine's mapping. */
export async function planDomain(context: DomainContext, domain: string, healthPath: string): Promise<DomainPlanActions> {
  const base = { verified: true, metadata: { gcpProjectId: context.gcpProjectId, region: context.region, domain } };
  const ownership = await observeOwnership(context, domain);
  if (typeof ownership === 'object') return { before: [], after: [], blocked: ownership.unknown };
  const dns = await observeTrafficDns(domain);
  if (typeof dns === 'object') return { before: [], after: [], blocked: 'conflict' in dns ? dns.conflict : dns.unknown };
  const mapping = await domainMapping(context, domain);
  if (mapping.state === 'unknown') return { before: [], after: [], blocked: mapping.reason };

  const before: PlanAction[] = [
    {
      ...base, id: `domain-verify:${domain}`, type: ownership === 'present' ? 'noop' : 'create',
      resource: { kind: 'domain', name: `${domain} ownership`, provider: 'gcp' },
      reason: ownership === 'present'
        ? `Google already recognizes Hypervibe as the owner of ${domain}.`
        : `Hypervibe will prove ownership of ${domain} to Google with a DNS TXT record${ownership === 'api-disabled' ? ' (enabling the Site Verification API first)' : ''}.`,
      metadata: { ...base.metadata, operation: DOMAIN_VERIFY_OPERATION },
    },
    {
      ...base, id: `domain-dns:${domain}`, type: dns === 'present' ? 'noop' : 'create',
      resource: { kind: 'domain', name: `${domain} DNS`, provider: 'cloudflare' },
      reason: dns === 'present' ? `DNS for ${domain} already points at Google.` : `Hypervibe will point ${domain} at Google in Cloudflare (DNS only, not proxied).`,
      metadata: { ...base.metadata, operation: DOMAIN_DNS_OPERATION },
    },
  ];
  const ready = mapping.state === 'present' && mapping.ready;
  const after: PlanAction[] = [{
    ...base, id: `domain-ready:${domain}`, type: ready ? 'noop' : 'update',
    resource: { kind: 'domain', name: `${domain} certificate`, provider: 'gcp' },
    reason: ready ? `${domain} serves HTTPS.` : `Hypervibe will wait for Google to issue the HTTPS certificate for ${domain} and check that it answers.`,
    metadata: { ...base.metadata, operation: DOMAIN_READY_OPERATION, healthPath },
  }];
  return { before, after };
}

export function planDomainDnsRemoval(context: DomainContext, domain: string, dependsOn: string[]): PlanAction {
  return {
    id: `domain-dns-remove:${domain}`, type: 'destroy', verified: true,
    resource: { kind: 'domain', name: `${domain} DNS`, provider: 'cloudflare' },
    reason: `Hypervibe will remove the DNS records it created for ${domain}.`,
    requiresConfirm: true,
    dependsOn,
    metadata: { operation: DOMAIN_DNS_REMOVE_OPERATION, gcpProjectId: context.gcpProjectId, region: context.region, domain },
  };
}

async function enableSiteVerification(context: DomainContext): Promise<boolean> {
  const token = await context.adapter.engineAccessToken();
  const response = await fetchWithRetry(`https://serviceusage.googleapis.com/v1/projects/${context.gcpProjectId}/services/siteverification.googleapis.com:enable`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) return false;
  // Enablement propagates asynchronously; wait until the API answers.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await observeOwnership(context, '__probe__.invalid') !== 'api-disabled') return true;
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
  return false;
}

export async function executeDomainAction(context: DomainContext, action: PlanAction): Promise<ActionResult> {
  const { domain, operation, healthPath } = action.metadata as { domain: string; operation: string; healthPath?: string };
  if (operation === DOMAIN_VERIFY_OPERATION) {
    let ownership = await observeOwnership(context, domain);
    if (ownership === 'present') return { success: true, message: `Google already recognizes Hypervibe as the owner of ${domain}.` };
    if (ownership === 'api-disabled') {
      if (!await enableSiteVerification(context)) return { success: false, status: 'blocked', message: 'The Google Site Verification API could not be enabled for this project.' };
      ownership = await observeOwnership(context, domain);
    }
    if (typeof ownership === 'object') return { success: false, status: 'blocked', message: ownership.unknown };
    const token = await context.adapter.siteVerificationAccessToken();
    const site = { type: 'INET_DOMAIN', identifier: domain };
    const tokenResponse = await siteVerificationFetch(token, 'token', { method: 'POST', body: JSON.stringify({ site, verificationMethod: 'DNS_TXT' }) });
    if (!tokenResponse.ok) return { success: false, message: `Google did not issue a verification token for ${domain} (HTTP ${tokenResponse.status}).` };
    const verificationToken = (await tokenResponse.json() as { token?: string }).token;
    if (!verificationToken) return { success: false, message: 'Google returned an empty verification token.' };
    const cloudflare = await cloudflareFor(domain);
    if ('error' in cloudflare) return { success: false, status: 'blocked', message: cloudflare.error };
    const existing = await cloudflare.adapter.listRecords(cloudflare.zoneId, 'TXT');
    if (!existing.some((record) => normalizeContent(record.name) === domain && record.content.replace(/"/g, '') === verificationToken)) {
      // Create, never upsert: other TXT records at this name belong to someone else.
      await cloudflare.adapter.createRecord(cloudflare.zoneId, { name: domain, type: 'TXT', content: verificationToken, ttl: 120 });
    }
    // DNS propagation to Google takes a little while; retry the verification.
    for (let attempt = 0; attempt < 20; attempt++) {
      const verify = await siteVerificationFetch(token, 'webResource?verificationMethod=DNS_TXT', { method: 'POST', body: JSON.stringify({ site }) });
      if (verify.ok) return { success: true, message: `Google verified Hypervibe as the owner of ${domain}.` };
      if (verify.status !== 400) return { success: false, message: `Google rejected verification of ${domain} (HTTP ${verify.status}).` };
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
    return { success: false, status: 'pending', message: `Google has not seen the verification record for ${domain} yet. Run hv_plan again in a few minutes.` };
  }

  if (operation === DOMAIN_DNS_OPERATION) {
    const dns = await observeTrafficDns(domain);
    if (dns === 'present') return { success: true, message: `DNS for ${domain} already points at Google.` };
    if (typeof dns === 'object') return { success: false, status: 'blocked', message: 'conflict' in dns ? dns.conflict : dns.unknown };
    const cloudflare = await cloudflareFor(domain);
    if ('error' in cloudflare) return { success: false, status: 'blocked', message: cloudflare.error };
    const existing = await cloudflare.adapter.listRecords(cloudflare.zoneId);
    for (const target of expectedTrafficRecords(domain, cloudflare.zoneName)) {
      const present = existing.some((record) => normalizeContent(record.name) === domain && record.type === target.type && normalizeContent(record.content) === target.content);
      if (!present) await cloudflare.adapter.createRecord(cloudflare.zoneId, { name: domain, type: target.type, content: target.content, ttl: 300, proxied: false });
    }
    return await observeTrafficDns(domain) === 'present'
      ? { success: true, message: `${domain} now points at Google.` }
      : { success: false, status: 'pending', message: `DNS for ${domain} was written but could not be confirmed yet.` };
  }

  if (operation === DOMAIN_READY_OPERATION) {
    const deadline = Date.now() + 12 * 60 * 1000;
    let last = 'pending';
    while (Date.now() < deadline) {
      const mapping = await domainMapping(context, domain);
      if (mapping.state === 'unknown') return { success: false, status: 'blocked', message: mapping.reason };
      if (mapping.state === 'absent') return { success: false, status: 'blocked', message: `The ${domain} mapping does not exist.` };
      last = mapping.certificate;
      if (mapping.ready) {
        try {
          const response = await fetchWithRetry(`https://${domain}${healthPath ?? '/'}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
          if (response.status < 500) return { success: true, message: `https://${domain} answers (HTTP ${response.status}).`, data: { url: `https://${domain}` } };
        } catch { /* certificate or edge still settling */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
    return { success: false, status: 'pending', message: `Google is still issuing the certificate for ${domain} (${last}). This can take up to an hour; run hv_plan again later to check.` };
  }

  if (operation === DOMAIN_DNS_REMOVE_OPERATION) {
    const cloudflare = await cloudflareFor(domain);
    if ('error' in cloudflare) return { success: false, status: 'blocked', message: cloudflare.error };
    const expected = expectedTrafficRecords(domain, cloudflare.zoneName);
    const records = await cloudflare.adapter.listRecords(cloudflare.zoneId);
    // Only the exact Google targets Hypervibe writes; anything else at the name is left alone.
    for (const record of records.filter((entry) => normalizeContent(entry.name) === domain
      && expected.some((target) => target.type === entry.type && normalizeContent(entry.content) === target.content))) {
      await cloudflare.adapter.deleteRecord(cloudflare.zoneId, record.id);
    }
    return await observeTrafficDns(domain) === 'absent'
      ? { success: true, message: `Removed the DNS records Hypervibe created for ${domain}.` }
      : { success: false, status: 'pending', message: `DNS removal for ${domain} could not be confirmed yet.` };
  }
  return { success: false, status: 'blocked', message: `No domain authority exists for ${action.id}.` };
}
