import { createHash, randomUUID } from 'node:crypto';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { dnsEngineBackend, buildDnsConfiguration, dnsRecordAddress, dnsRecordNativeId } from '../adapters/dns/tofu/dns-engine.backend.js';
import { resolveDnsConnection, dnsZoneFingerprint } from '../adapters/dns-observation/connections.js';
import type { DnsObserver } from '../adapters/dns-observation/http-observer.js';
import { cnameConflictTypes, type DnsRecordIntent, type DnsRecordType, type DnsObservedRecord, type DnsZoneIdentity } from '../domain/ports/dns.port.js';
import type { EngineActionSegment, EngineConfiguration, EngineSegmentResult, EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../domain/ports/infrastructure-engine.port.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { DomainHandoffBlocked, exactHandoffDnsChanges, type HandoffReview } from '../domain/plan/domain-handoff.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { resolveDnsPolicy } from '../domain/services/dns-policy.service.js';
import { additionalGcpDomainDnsOwner } from '../domain/services/domain-scope.js';
import { inspectDomainSecurity } from '../domain/services/domain-security.service.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandContext } from './context.js';

export const DNS_ENGINE_OPERATION = 'dnsEngine';
export const DNS_RECONCILE_OPERATION = 'dnsOwnershipReconcile';
export interface DesiredDnsRecord { key: string; name: string; type: DnsRecordType; values: string[]; ttl: number; proxied?: boolean }
interface ManagedRecord { owner: string; intent: DnsRecordIntent; address: string }
interface DnsBinding {
  version: 1; zone: DnsZoneIdentity; domain: string; connectionScope?: string;
  recordsEncrypted: string; ownersEncrypted: string; configurationEncrypted: string;
  zoneFingerprint: string; zoneNativeId?: string; ownedOwners: string[]; ownerDomains?: Record<string, string>; attempt?: DnsPlanDescriptor;
  trafficOnlyDomainId?: string;
}
export interface DnsPlanDescriptor {
  version: 1; planId: string; segment: Omit<EngineActionSegment, 'addresses'>;
  state: EngineStateIdentity & { partition: 'environment' }; zone: DnsZoneIdentity; owner: string; domain: string;
  connectionId: string; connectionScope?: string; zoneFingerprint: string; payloadEncrypted: string;
}
interface Snapshot { name: string; type: DnsRecordType; fingerprint: string }
interface DnsPayload {
  configuration: EngineConfiguration; records: DnsRecordIntent[]; retired: DnsRecordIntent[];
  owners: Record<string, DesiredDnsRecord[]>; managed: ManagedRecord[]; observations: Snapshot[]; bindingFingerprint: string;
  readOnlyReconciliation?: boolean; zoneNativeId?: string; trafficOnlyDomainId?: string;
}

/** Re-bind the frozen DNS intent to the reviewed public origin before executing its saved segment. */
export function verifyHandoffDnsPayload(ctx: CommandContext, descriptor: DnsPlanDescriptor, review: HandoffReview, stage: unknown): boolean {
  if (stage !== 'route' && stage !== 'cleanup') return false;
  const payload = ctx.secretStore.decryptObject<DnsPayload>(descriptor.payloadEncrypted);
  const cNames = payload.records.filter(record => record.type === 'CNAME');
  const traffic = cNames[0];
  const host = new URL(review.edge.origin).hostname;
  if (cNames.length !== 1 || !traffic || traffic.name !== review.hostname || traffic.proxied !== true || traffic.ttl !== 1
    || traffic.values.length !== 1 || dnsValue('CNAME', traffic.values[0]!) !== host
    || traffic.authority.kind !== 'managed' || traffic.authority.nativeId !== review.recordId || traffic.authority.preserveValues.length
    || dnsRecordAddress(descriptor.zone, traffic) !== review.recordAddress) return false;
  const other = [...payload.records.filter(record => record !== traffic), ...payload.retired];
  return (stage === 'cleanup' || !payload.retired.length) && other.every(record => record.type === 'TXT' && record.authority.kind === 'managed'
    && review.verification.some(proof => proof.address === dnsRecordAddress(descriptor.zone, record)
      && proof.id === (record.authority as { nativeId: string }).nativeId && proof.name === record.name));
}
export interface DnsPlanInput {
  handoff?: { review: HandoffReview; stage: 'route' | 'cleanup' };
  ctx: CommandContext; project: Project; environment: Environment; environmentSpec: EnvironmentSpec;
  owner: string; domain: string; records: DesiredDnsRecord[]; remove?: boolean; retainExistingTypes?: DnsRecordType[];
  /** Import exact existing records without authorizing a provider mutation. */
  adoptOnly?: { mode: 'plan' | 'verify'; providerDomainId: string };
}
export interface DnsPreparedPlan { actions: PlanAction[]; descriptor?: DnsPlanDescriptor; ready: boolean; blocked?: string[] }
export interface DnsEngineDependencies {
  connect: typeof resolveDnsConnection;
  engine: () => Promise<OpenTofuEngine>;
  security: typeof inspectDomainSecurity;
}
const defaults: DnsEngineDependencies = {
  connect: resolveDnsConnection, security: inspectDomainSecurity,
  engine: async () => {
    const engine = await (await import('./engine-shared.js')).openTofuEngine();
    if ('blocked' in engine) throw new Error(engine.blocked);
    return engine;
  },
};
const sorted = (values: string[]) => [...new Set(values)].sort();
const normalized = (name: string) => name.toLowerCase().replace(/\.$/, '');
function dnsValue(type: DnsRecordType, value: string): string {
  if (type === 'CNAME') return normalized(value);
  if (type === 'MX') {
    const parts = /^(\d+)\s+(\S+)$/.exec(value);
    return parts ? `${Number(parts[1])} ${parts[2] === '.' ? '.' : normalized(parts[2]!)}` : value;
  }
  if (type === 'AAAA') {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return value; }
  }
  return value;
}
const normalizedValues = (type: DnsRecordType, values: string[]) => sorted(values.map(value => dnsValue(type, value)));
function privateValues(records: DnsRecordIntent[]): string[] {
  return sorted(records.flatMap(record => [...record.values, ...(record.authority.kind === 'absent' ? [] : record.authority.preserveValues),
    ...(record.authority.kind === 'adopt' ? record.authority.existingValues : [])]));
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** An import can include an in-place provider update. Inspect the raw plan before saving it. */
function onlyExactDnsImports(shown: unknown, configuration: EngineConfiguration): boolean {
  const rows = (shown as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(rows)) return false;
  const expected = new Set(Object.keys(configuration.resources));
  for (const row of rows) {
    if (!row || row.mode !== 'managed' || !expected.delete(row.address) || row.deposed || row.previous_address
      || !Array.isArray(row.change?.actions) || row.change.actions.length !== 1 || row.change.actions[0] !== 'no-op') return false;
    const id = configuration.imports?.[row.address];
    if (id ? row.change.importing?.id !== id : row.change.importing !== undefined) return false;
  }
  return expected.size === 0;
}

function sameZone(left: DnsZoneIdentity, right: DnsZoneIdentity): boolean {
  return left.provider === right.provider && left.zoneId === right.zoneId && normalized(left.zoneName) === normalized(right.zoneName)
    && ['accountId', 'projectId', 'subscriptionId', 'resourceGroup'].every(key => left.scope[key as keyof typeof left.scope] === right.scope[key as keyof typeof right.scope]);
}
const extraOwner = (owner?: string) => Boolean(owner && /^gcp-domain-[a-f0-9]{20}$/.test(owner));
const bindingKey = (owner?: string) => extraOwner(owner) || owner === 'edge-domain' ? `dnsEngine_${owner}` : 'dnsEngine';

/** The original primary DNS state also holds email and other integrations. Extra hosts have independent state and recovery. */
export function gcpDomainDnsOwner(environment: Environment, domain: string, primary?: string, savedOwner?: string): string {
  const extra = additionalGcpDomainDnsOwner(domain);
  if (savedOwner === extra || binding(environment, extra)) return extra;
  const legacy = getDnsOwnedDomain(environment, 'gcp-domain');
  const claims = (environment.platformBindings.engine as { domainClaims?: Record<string, { owner?: string }>; domains?: string[] } | undefined);
  // Older mappings had one implicit primary owner, even before the first DNS receipt was written.
  const reserved = new Set([...(legacy ? [legacy] : []),
    ...Object.entries(claims?.domainClaims ?? {}).filter(([, claim]) => !claim.owner || claim.owner === 'gcp-domain').map(([hostname]) => hostname),
    ...(claims?.domains ?? []).filter(hostname => !claims?.domainClaims?.[hostname] && !binding(environment, additionalGcpDomainDnsOwner(hostname))),
  ]);
  if (savedOwner === 'gcp-domain' || reserved.has(domain)) return 'gcp-domain';
  if (!reserved.size && normalized(primary ?? '') === domain) return 'gcp-domain';
  return extra;
}
function binding(environment: Environment, owner?: string): DnsBinding | undefined {
  const value = environment.platformBindings[bindingKey(owner)] as DnsBinding | undefined;
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || !value.zone || typeof value.recordsEncrypted !== 'string'
    || typeof value.ownersEncrypted !== 'string' || typeof value.configurationEncrypted !== 'string') throw new Error('The saved DNS ownership record is unreadable; preserve it before continuing.');
  return value;
}
export function getDnsBindingIdentity(environment: Environment, owner?: string): DnsZoneIdentity | undefined { return binding(environment, owner)?.zone; }
export function importedTrafficClaim(environment: Environment, hostname: string): string | undefined {
  const saved = binding(environment, 'hosting-domain');
  return saved?.ownerDomains?.['hosting-domain'] === hostname && hasOwnedDnsRecords(environment, 'hosting-domain') ? saved.trafficOnlyDomainId : undefined;
}
export function getDnsBindingSelection(environment: Environment, owner?: string): { zone: DnsZoneIdentity; connectionScope?: string } | undefined {
  const saved = binding(environment, owner);
  return saved ? { zone: saved.zone, connectionScope: saved.connectionScope } : undefined;
}
export function getDnsOwnedDomain(environment: Environment, owner: string): string | undefined {
  const saved = binding(environment, owner);
  return hasOwnedDnsRecords(environment, owner) ? saved?.ownerDomains?.[owner] ?? saved?.domain : undefined;
}
export function hasOwnedDnsRecords(environment: Environment, owner?: string): boolean {
  const saved = binding(environment, owner);
  return Boolean(saved && (saved.attempt && (!owner || saved.attempt.owner === owner)
    || (owner ? saved.ownedOwners?.includes(owner) : saved.ownedOwners?.length)));
}
export function ownedGcpDnsDomains(environment: Environment): string[] {
  return ['gcp-domain', ...Object.keys(environment.platformBindings).filter(key => key.startsWith('dnsEngine_')).map(key => key.slice(10))]
    .flatMap(owner => getDnsOwnedDomain(environment, owner) ?? []);
}
export function onlyGoogleProofRemains(ctx: CommandContext, environment: Environment, owner: string, proofName: string): boolean {
  const saved = binding(environment, owner);
  if (!saved || saved.attempt) return false;
  const records = owned(ctx, saved).filter(record => record.owner === owner && record.intent.values.length);
  return records.length > 0 && records.every(record => record.intent.type === 'TXT' && normalized(record.intent.name) === proofName
    && record.intent.authority.kind === 'managed');
}
function owned(ctx: CommandContext, saved: DnsBinding | undefined): ManagedRecord[] {
  if (!saved) return [];
  const records = ctx.secretStore.decryptObject<ManagedRecord[]>(saved.recordsEncrypted);
  if (!Array.isArray(records) || records.some(record => !record || typeof record.owner !== 'string' || typeof record.address !== 'string'
    || !record.intent || record.intent.authority?.kind !== 'managed' || typeof record.intent.authority.nativeId !== 'string')) {
    throw new Error('The saved DNS record inventory is unreadable; no resource absence has been established.');
  }
  return records;
}
/** Safe native identities only. Never returns TXT tokens, credential values or raw engine state. */
export function readDnsOwnedRecords(ctx: CommandContext, environment: Environment, owner?: string): Array<{ nativeId: string; name: string; type: DnsRecordType; address: string; owner: string; retainedOnly?: true }> {
  const slots = owner ? [owner] : [undefined, ...Object.keys(environment.platformBindings).filter(key => key.startsWith('dnsEngine_')).map(key => key.slice(10))];
  return slots.flatMap(slot => owned(ctx, binding(environment, slot))).filter(record => !owner || record.owner === owner).map(record => ({
    nativeId: record.intent.authority.kind === 'managed' ? record.intent.authority.nativeId : '',
    name: record.intent.name, type: record.intent.type, address: record.address, owner: record.owner,
    ...(record.intent.values.length === 0 ? { retainedOnly: true as const } : {}),
  }));
}
function recordFingerprint(records: DnsObservedRecord[]): string {
  return hash(records.map(record => ({ ...record, name: normalized(record.name), values: sorted(record.values) }))
    .sort((a, b) => a.nativeId.localeCompare(b.nativeId)));
}
async function observeRecords(observer: DnsObserver, name: string, type: DnsRecordType): Promise<DnsObservedRecord[]> {
  const observed = await observer.observeRecordSets(name, type);
  if (observed.status === 'unknown') throw new Error(observed.reason);
  return observed.status === 'absent' ? [] : observed.value.map(record => ({ ...record, values: normalizedValues(type, record.values) }));
}
function ownerOf(key: string): string { return key.split(':', 1)[0]!; }
export function dnsEngineState(environment: Environment, provider: string, owner?: string): EngineStateIdentity & { partition: 'environment' } {
  if (owner === 'edge-domain') {
    const receipt = environment.platformBindings.edgeDomain as { projectId?: string; targetId?: string; sourceId?: string } | undefined;
    if (receipt?.targetId !== environment.id || receipt.projectId !== environment.projectId || !receipt.sourceId) throw new Error('The transferred DNS state has no matching ownership receipt.');
    return { provider: `dns-${provider}`, projectId: environment.projectId, environmentId: receipt.sourceId, partition: 'environment' };
  }
  if (!extraOwner(owner) && environment.platformBindings.edgeDomainReleased) {
    // The original state now belongs to the target. Any future DNS work on the donor starts in its own namespace.
    return { provider: `dns-${provider}`, projectId: environment.projectId, environmentId: `${environment.id}-after-handoff`, partition: 'environment' };
  }
  return { provider: `dns-${provider}`, projectId: environment.projectId, environmentId: extraOwner(owner) ? `${environment.id}-${owner}` : environment.id, partition: 'environment' };
}

/** A handoff changes one already-owned, proxied CNAME in place. Verification TXT can retire only after the hosting claim is gone. */
export async function observeEdgeDomainDns(ctx: CommandContext, project: Project, environment: Environment, hostname: string,
  transferred: boolean, deps: DnsEngineDependencies = defaults, observation: 'ownership' | 'serving' = 'ownership') {
  const slot = transferred ? 'edge-domain' : 'hosting-domain';
  const saved = binding(environment, slot);
  if (!saved || saved.zone.provider !== 'cloudflare' || !saved.zone.scope.accountId || !saved.zoneNativeId
    || saved.domain !== hostname && saved.ownerDomains?.['hosting-domain'] !== hostname) throw new DomainHandoffBlocked('Adopt the exact Cloudflare DNS records for the source domain first.');
  const inventory = owned(ctx, saved);
  const previous = saved.attempt ? ctx.secretStore.decryptObject<DnsPayload>(saved.attempt.payloadEncrypted) : undefined;
  const canonical = previous?.managed ?? inventory;
  if (otherOwnership(ctx, environment, slot, saved.zone, canonical.map(record => record.intent))) throw new DomainHandoffBlocked('Another environment claims this DNS record. Resolve the competing ownership first.');
  if (saved.attempt && saved.attempt.owner !== 'hosting-domain' || saved.ownedOwners.some(owner => owner !== 'hosting-domain')
    || canonical.some(record => record.owner !== 'hosting-domain' || !record.intent.values.length || record.intent.authority.kind !== 'managed'
      || record.intent.authority.preserveValues.length)) throw new DomainHandoffBlocked('This DNS state also owns other records or has an unrelated operation in progress. Preserve its existing consumers.');
  const traffic = canonical.filter(record => record.intent.name === hostname && record.intent.type === 'CNAME');
  if (traffic.length !== 1 || !traffic[0]!.intent.proxied || canonical.some(record => record !== traffic[0] && record.intent.type !== 'TXT')) {
    throw new DomainHandoffBlocked('The private DNS state must own one proxied hostname CNAME and only its source verification TXT records.');
  }
  const connection = await deps.connect({ context: ctx, zone: saved.zone, connectionScope: saved.connectionScope,
    scopeHints: lookupHints(project, hostname, saved.zone) });
  if ('blocked' in connection) throw new DomainHandoffBlocked('The saved DNS connection is unavailable.');
  const zone = await connection.observer.observeZone();
  if (zone.status !== 'present' || zone.value.visibility !== 'public' || !sameZone(zone.value.identity, saved.zone)
    || zone.value.providerNativeId !== saved.zoneNativeId || dnsZoneFingerprint(zone.value) !== saved.zoneFingerprint) throw new DomainHandoffBlocked('The public DNS zone changed or cannot be verified.');
  let stateIds: Record<string, string> | undefined;
  if (observation === 'ownership') {
    const engine = await deps.engine();
    const inspected = await engine.inspectState({ backend: dnsEngineBackend(saved.zone), configuration: ctx.secretStore.decryptObject(saved.configurationEncrypted),
      auth: connection.auth, state: dnsEngineState(environment, saved.zone.provider, slot), project: projectNativeIds });
    if (!inspected.ok || !inspected.present || Object.keys(inspected.value).some(address => !canonical.some(record => record.address === address))) {
      throw new DomainHandoffBlocked('The private engine state cannot establish exclusive ownership of the source DNS records.');
    }
    stateIds = inspected.value;
  }
  const seen = [];
  for (const record of canonical) {
    const { intent, address } = record;
    if (intent.authority.kind !== 'managed') throw new DomainHandoffBlocked('Incomplete DNS ownership.');
    const nativeId = intent.authority.nativeId;
    const native = stateIds?.[address];
    const present = await observeRecords(connection.observer, intent.name, intent.type);
    const exact = present.find(row => row.nativeId === nativeId);
    const retired = previous?.retired.some(old => old.key === intent.key);
    if (!native && !exact && retired && intent.type === 'TXT') continue;
    if (stateIds && (!native || normalizeNativeId(saved.zone, intent, native) !== nativeId) || !exact || exact.values.length !== 1
      || intent.type === 'CNAME' && (present.length !== 1 || exact.proxied !== true || exact.ttl !== 1)
      || !intent.values.includes(exact.values[0]!) && !previous?.records.some(item => item.key === intent.key && item.values.includes(exact.values[0]!))) {
      throw new DomainHandoffBlocked('A managed DNS record changed identity, value, proxy settings or ownership.');
    }
    seen.push({ name: intent.name, type: intent.type, value: exact.values[0]!, id: intent.authority.nativeId, address, key: intent.key });
  }
  const cname = seen.find(record => record.type === 'CNAME')!;
  const key = /^hosting-domain:(.+)\.0$/.exec(cname.key)?.[1];
  if (!key) throw new DomainHandoffBlocked('The source DNS record has no stable hosting address.');
  return { zone: { provider: 'cloudflare' as const, zoneId: saved.zone.zoneId, zoneName: saved.zone.zoneName, scope: { accountId: saved.zone.scope.accountId } },
    connectionId: connection.connectionId, traffic: { ...cname, key }, verification: seen.filter(record => record.type === 'TXT'), pending: Boolean(saved.attempt) };
}
function lookupHints(project: Project, domain: string, zone: DnsZoneIdentity): string[] {
  return [...new Set([parseGitHubRepoFromRemote(project.gitRemoteUrl), domain, normalized(zone.zoneName)].filter((value): value is string => Boolean(value)))];
}
function otherOwnership(ctx: CommandContext, environment: Environment, owner: string, zone: DnsZoneIdentity, intents: DnsRecordIntent[]): string | undefined {
  for (const project of ctx.repos.projects.findAll()) for (const candidate of ctx.repos.environments.findByProjectId(project.id)) {
    for (const key of Object.keys(candidate.platformBindings).filter(key => key === 'dnsEngine' || key.startsWith('dnsEngine_'))) {
      if (candidate.id === environment.id && key === bindingKey(owner)) continue;
      const saved = binding(candidate, key === 'dnsEngine' ? undefined : key.slice(10));
      if (!saved || !sameZone(saved.zone, zone)) continue;
      const inventory = owned(ctx, saved);
      const uncertain = saved.attempt ? ctx.secretStore.decryptObject<DnsPayload>(saved.attempt.payloadEncrypted).records : [];
      for (const intent of intents) {
        const matches = (record: DnsRecordIntent) => normalized(record.name) === normalized(intent.name) && record.type === intent.type;
        if (uncertain.some(matches) || inventory.some(record => matches(record.intent)
          && (zone.provider !== 'cloudflare' || intent.authority.kind !== 'absent' && record.intent.authority.kind !== 'absent'
            && intent.authority.nativeId === record.intent.authority.nativeId))) {
          return 'Another Hypervibe environment owns or is recovering this exact DNS record set. Preserve that state; transferring DNS ownership requires an explicit migration workflow.';
        }
      }
    }
  }
  return undefined;
}

/** Plan a single consumer's contribution; other DNS consumers and adopted sibling values stay retained. */
export async function prepareDnsEnginePlan(input: DnsPlanInput, deps: DnsEngineDependencies = defaults): Promise<DnsPreparedPlan> {
  const blocked = (reason: string): DnsPreparedPlan => ({ actions: [], ready: false, blocked: [reason] });
  try {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(input.owner)) return blocked('DNS consumer identity is invalid.');
    const current = input.ctx.repos.environments.findById(input.environment.id) ?? input.environment;
    const saved = binding(current, input.owner);
    let previous = owned(input.ctx, saved);
    if (input.remove && !saved) return { actions: [], ready: true };
    const effective = input.remove && saved ? { ...input.environmentSpec, domain: input.domain,
      dns: { provider: saved.zone.provider, zone: { id: saved.zone.zoneId, name: saved.zone.zoneName, ...saved.zone.scope }, connectionScope: saved.connectionScope } } as EnvironmentSpec : input.environmentSpec;
    if (!effective.dns) return blocked('Choose the DNS provider and exact zone in environment.dns. Hosting does not choose DNS, and existing records are never adopted by name.');
    const identity = { provider: effective.dns.provider, zoneId: effective.dns.zone.id, zoneName: effective.dns.zone.name,
      scope: Object.fromEntries(Object.entries(effective.dns.zone).filter(([key]) => key !== 'id' && key !== 'name')) } as DnsZoneIdentity;
    if (saved && !sameZone(saved.zone, identity)) return blocked('The selected DNS zone differs from the retained DNS ownership. Remove or explicitly migrate the old DNS contribution before changing providers or zones.');
    const connection = await deps.connect({ context: input.ctx, zone: identity, connectionScope: effective.dns.connectionScope,
      scopeHints: lookupHints(input.project, input.domain, identity) });
    if ('blocked' in connection) return blocked(connection.blocked);
    const zone = await connection.observer.observeZone();
    if (zone.status !== 'present') return blocked(zone.status === 'unknown' ? zone.reason : 'The exact DNS zone is absent. Zone creation is not implemented by this workflow.');
    if (!sameZone(identity, zone.value.identity)) return blocked('The observed DNS zone differs from the selected native identity.');
    if (saved?.zoneNativeId && saved.zoneNativeId !== zone.value.providerNativeId) return blocked('The DNS zone native identity changed or the zone was recreated. Existing record ownership does not transfer to the new zone.');
    if (zone.value.visibility !== 'public') return blocked('Custom-domain readiness currently requires a provider-confirmed public DNS zone.');
    if (saved?.attempt) {
      const attempt = input.ctx.secretStore.decryptObject<DnsPayload>(saved.attempt.payloadEncrypted);
      const engine = await deps.engine();
      const auth = { ...connection.auth, redact: sorted([...connection.auth.redact, ...privateValues([...attempt.records, ...attempt.retired])]) };
      const inspected = await engine.inspectState({ backend: dnsEngineBackend(identity), configuration: attempt.configuration,
        auth, state: dnsEngineState(current, identity.provider, input.owner), project: projectNativeIds });
      if (!inspected.ok) return blocked('The interrupted DNS attempt has unreadable private engine state. Preserve it and retry observation before planning mutations.');
      if (inspected.present) {
        const recovered = new Map(previous.map(record => [record.intent.key, record]));
        for (const record of [...attempt.records, ...attempt.retired]) {
          const address = dnsRecordAddress(identity, record);
          const native = inspected.value[address];
          if (!native) continue;
          const nativeId = normalizeNativeId(identity, record, native);
          const candidates = sorted([...record.values, ...(recovered.get(record.key)?.intent.values ?? []),
            ...(attempt.managed.find(entry => entry.intent.key === record.key)?.intent.values ?? [])]);
          let recoveredValues = candidates;
          if (identity.provider === 'cloudflare') {
            const observed = (await observeRecords(connection.observer, record.name, record.type)).find(entry => entry.nativeId === nativeId);
            if (observed) {
              if (observed.values.length !== 1 || !candidates.includes(observed.values[0]!)) return blocked('The interrupted Cloudflare record changed outside its reviewed before/after values. Preserve it and reconcile the external change.');
              recoveredValues = observed.values;
            }
          }
          recovered.set(record.key, { owner: ownerOf(record.key), address, intent: { ...record,
            values: recoveredValues,
            authority: { kind: 'managed', nativeId, preserveValues: record.authority.kind === 'absent' ? [] : record.authority.preserveValues } } });
        }
        previous = [...recovered.values()];
      } else if (previous.length || attempt.records.some(record => record.authority.kind !== 'absent') || attempt.retired.length) {
        return blocked('The interrupted DNS attempt is missing its ownership state. Missing local state does not prove provider absence.');
      }
    }
    const snapshots = new Map<string, { records: DnsObservedRecord[]; snapshot: Snapshot }>();
    const read = async (name: string, type: DnsRecordType) => {
      const key = `${normalized(name)}|${type}`;
      if (!snapshots.has(key)) {
        const records = await observeRecords(connection.observer, name, type);
        snapshots.set(key, { records, snapshot: { name, type, fingerprint: recordFingerprint(records) } });
      }
      return snapshots.get(key)!.records;
    };
    const owners = saved ? input.ctx.secretStore.decryptObject<Record<string, DesiredDnsRecord[]>>(saved.ownersEncrypted) : {};
    if (!owners || typeof owners !== 'object' || Array.isArray(owners)) return blocked('Saved DNS consumer intent is unreadable.');
    const previousOwnersFingerprint = hash(owners);
    const retained = (owners[input.owner] ?? []).filter(record => input.retainExistingTypes?.includes(record.type));
    owners[input.owner] = input.remove ? [] : input.records.flatMap(record => {
      const base = { ...record, name: normalized(record.name), ttl: effective.dns?.ttl ?? record.ttl };
      // Cloudflare owns individual values; other providers own a complete RRset.
      return identity.provider === 'cloudflare'
        ? normalizedValues(record.type, record.values).map((value, index) => ({ ...base, key: `${input.owner}:${record.key}.${index}`, values: [value] }))
        : [{ ...base, key: `${input.owner}:${record.key}`, values: normalizedValues(record.type, record.values) }];
    });
    owners[input.owner].push(...retained.filter(record => !owners[input.owner]!.some(entry => entry.key === record.key)));
    const desired = Object.values(owners).flat();
    if (desired.some(record => !record || !Array.isArray(record.values))) return blocked('Saved DNS consumer records are unreadable.');
    const proxyValues = new Set<boolean>();
    const records: DnsRecordIntent[] = [];
    for (const record of desired) {
      const present = await read(record.name, record.type);
      if (identity.provider === 'cloudflare') for (const entry of present) if (entry.proxied !== undefined) proxyValues.add(entry.proxied);
      const recordAddress = dnsRecordAddress(identity, { ...record, authority: { kind: 'absent' } });
      const oldGroup = previous.filter(entry => entry.address === recordAddress);
      const old = oldGroup[0];
      if (old) {
        const nativeId = old.intent.authority.kind === 'managed' ? old.intent.authority.nativeId : '';
        const exact = present.find(entry => entry.nativeId === nativeId);
        if (!exact && present.length && identity.provider !== 'cloudflare') return blocked('An owned DNS record changed native identity. No replacement or adoption is authorized.');
        if (identity.provider === 'cloudflare' && exact && JSON.stringify(sorted(exact.values)) !== JSON.stringify(sorted(old.intent.values))) {
          return blocked('An owned Cloudflare record changed outside the reviewed workflow. Preserve it and reconcile its exact value before updating it.');
        }
        const oldValues = oldGroup.flatMap(entry => entry.intent.values);
        const extra = exact?.values.filter(value => !oldValues.includes(value)) ?? [];
        const preserved = old.intent.authority.kind === 'managed' ? old.intent.authority.preserveValues : [];
        records.push({ ...record, authority: { kind: 'managed', nativeId, preserveValues: sorted([...preserved, ...extra]) } });
      } else {
        // Cloudflare's native identity is zone/record; the record ID alone, as its dashboard and API show it, selects the same record.
        const selects = (id: string, nativeId: string) => nativeId === id || (identity.provider === 'cloudflare' && nativeId === `${identity.zoneId}/${id}`);
        const adoption = effective.dns.adoptRecords?.find(entry => normalized(entry.name) === normalized(record.name) && entry.type === record.type
          && present.some(observed => selects(entry.id, observed.nativeId)));
        const exact = adoption && present.find(entry => selects(adoption.id, entry.nativeId));
        if (exact && adoption) {
          if (JSON.stringify(sorted(exact.values)) !== JSON.stringify(normalizedValues(record.type, adoption.values))) return blocked('The DNS record changed after its adoption values were selected. Refresh the explicit adoption intent.');
          if (identity.provider === 'cloudflare' && present.filter(entry => entry.nativeId !== exact.nativeId).some(entry => entry.values.some(value => record.values.includes(value)))) return blocked('Several DNS records match the adoption target. Select each exact native record instead of guessing.');
          const desiredValues = desired.filter(entry => dnsRecordAddress(identity, { ...entry, authority: { kind: 'absent' } }) === recordAddress).flatMap(entry => entry.values);
          // A name holds one CNAME, so taking over the reviewed record replaces its target; other types keep every existing value.
          records.push({ ...record, authority: { kind: 'adopt', nativeId: exact.nativeId, existingValues: exact.values,
            preserveValues: record.type === 'CNAME' ? [] : exact.values.filter(value => !desiredValues.includes(value)) } });
        } else if (present.length && record.type === 'CNAME') {
          return blocked(`${record.name} already has a CNAME that this DNS state does not own (record ${present[0]!.nativeId}), so a new one cannot be created. To point it at this environment instead, add that record's ID and its current target to dns.adoptRecords and review the plan.`);
        } else if (present.length && (identity.provider !== 'cloudflare' || present.some(entry => entry.values.some(value => record.values.includes(value))))) {
          return blocked(`Existing ${record.type} records for ${record.name} are not owned by this DNS state. Add exact native IDs and current values to dns.adoptRecords and review the import plan.`);
        } else records.push({ ...record, authority: { kind: 'absent' } });
      }
      const conflicts = cnameConflictTypes(identity, record.name);
      if (record.type === 'CNAME') for (const other of conflicts) {
        if ((await read(record.name, other)).length) return blocked(`Existing ${other} records conflict with the desired CNAME for ${record.name}; preserve them and resolve the conflict explicitly.`);
      } else if (conflicts.includes(record.type) && (await read(record.name, 'CNAME')).length) return blocked(`An existing CNAME conflicts with ${record.type} at ${record.name}.`);
    }
    const publicSecurity = input.remove ? undefined : await deps.security(input.domain);
    const caaRecords = input.remove ? [] : await read(input.domain, 'CAA');
    const caaIssuers = caaRecords.flatMap(record => record.values.flatMap(value => {
      const match = /^0\s+issue\s+"([^";]+)"$/.exec(value); return match ? [match[1]!] : [];
    }));
    const policy = resolveDnsPolicy({ environmentSpec: effective, existingIdentity: saved?.zone,
      securityObservation: { dnssec: zone.value.dnssec, dnssecValidation: publicSecurity?.dnssec,
        caa: publicSecurity?.caa.status === 'unrestricted' ? { state: 'known', issuers: [] }
          : publicSecurity?.caa.status === 'restricted' && !publicSecurity.caa.inherited && caaIssuers.length ? { state: 'known', issuers: caaIssuers } : { state: 'unknown' },
        ...(proxyValues.size === 1 ? { proxy: [...proxyValues][0] } : {}) },
      capabilities: { proxy: effective.hosting.provider !== 'cloudrun' && identity.provider === 'cloudflare' },
    });
    if (!input.remove && policy.state !== 'ready') return blocked(policy.blockers.map(item => item.reason).join(' '));
    if (!input.remove && publicSecurity?.caa.status === 'issuance_denied') return blocked('Effective CAA policy denies certificate issuance. Preserve it and review the issuer policy before attaching the domain.');
    for (const record of records) if (identity.provider === 'cloudflare' && ['A', 'AAAA', 'CNAME'].includes(record.type)) {
      record.proxied = policy.policy?.proxy === 'on';
      if (record.proxied) record.ttl = 1;
    }
    const retired: DnsRecordIntent[] = [];
    for (const entry of previous.filter(entry => !records.some(record => record.key === entry.intent.key))) {
      const record = entry.intent;
      const authority = record.authority;
      if (authority.kind !== 'managed') return blocked('Retired DNS ownership is incomplete.');
      const present = await read(record.name, record.type);
      const exact = present.find(observed => observed.nativeId === authority.nativeId);
      if (identity.provider === 'cloudflare' && exact && JSON.stringify(sorted(exact.values)) !== JSON.stringify(sorted(record.values))) {
        return blocked('An owned Cloudflare record changed outside the reviewed workflow. Preserve it and reconcile its exact value before removing it.');
      }
      if (!exact && present.length && identity.provider !== 'cloudflare') return blocked('Retired DNS changed native identity. No removal is authorized.');
      const oldValues = previous.filter(old => old.address === entry.address).flatMap(old => old.intent.values);
      const extra = exact?.values.filter(value => !oldValues.includes(value)) ?? [];
      retired.push({ ...record, authority: { ...authority, preserveValues: sorted([...authority.preserveValues, ...extra]) } });
    }
    const overlap = otherOwnership(input.ctx, current, input.owner, identity, [...records, ...retired]);
    if (overlap) return blocked(overlap);
    if (input.adoptOnly) {
      if (retired.length || records.some(record => record.authority.kind === 'absent'
        || record.authority.kind === 'adopt' && ownerOf(record.key) !== input.owner)) {
        return blocked('Domain adoption requires every traffic record to exist and match its selected native ID. It cannot create or retire records.');
      }
      for (const record of records.filter(entry => ownerOf(entry.key) === input.owner)) {
        const authority = record.authority;
        const candidates = await read(record.name, record.type);
        const exact = authority.kind !== 'absent' && candidates.find(entry => entry.nativeId === authority.nativeId);
        if (!exact || record.type === 'CNAME' && candidates.length !== 1 || JSON.stringify(sorted(exact.values)) !== JSON.stringify(sorted(record.values))
          || identity.provider === 'cloudflare' && exact.proxied !== record.proxied) {
          return blocked('Domain adoption needs the exact current traffic records, targets and proxy settings. Inspect the existing route and review the selected records again.');
        }
        if (!effective.dns.ttl) record.ttl = exact.ttl;
        if (record.ttl !== exact.ttl) return blocked('Domain adoption preserves the current record TTL. Use its existing TTL when reviewing the import.');
      }
    }
    const configuration = buildDnsConfiguration({ zone: identity, records, retiredRecords: retired });
    const engine = await deps.engine();
    const state = dnsEngineState(current, identity.provider, input.owner);
    const publicTarget = input.handoff ? new URL(input.handoff.review.edge.origin).hostname : undefined;
    // The Worker origin is public in the review. Keep it visible to the private exact-change predicate.
    // Credential redactions and private TXT values still apply even if one happens to equal that hostname.
    const sensitiveRecords = [...records, ...retired].flatMap(record => privateValues([record]).filter(value =>
      !publicTarget || record.type !== 'CNAME' || record.name !== input.domain || value !== publicTarget));
    const auth = { ...connection.auth, redact: sorted([...connection.auth.redact, ...sensitiveRecords]) };
    const source = records.filter(record => ownerOf(record.key) === input.owner);
    const recoverTrafficReceipt = Boolean(input.adoptOnly?.mode === 'plan' && saved && source.length
      && source.every(record => record.authority.kind === 'managed'));
    if (input.adoptOnly?.mode === 'verify' || recoverTrafficReceipt) {
      if (!saved || input.adoptOnly?.mode === 'verify' && saved.attempt) return blocked('The source DNS import still needs a completed ownership receipt.');
      const inspected = await engine.inspectState({ backend: dnsEngineBackend(identity), configuration: input.ctx.secretStore.decryptObject(saved.configurationEncrypted),
        auth, state, project: projectNativeIds });
      if (!inspected.ok || !inspected.present || !exactManagedIds(identity, source, inspected.value)) return blocked('The native IDs in the source DNS state do not prove ownership of its current traffic records.');
      if (input.adoptOnly?.mode === 'verify') return { actions: [], ready: true };
    }
    const planId = randomUUID();
    const planned = await engine.plan({ backend: dnsEngineBackend(identity), configuration, auth, state, planId,
      ...(input.adoptOnly ? { verifyPlannedChanges: (shown: unknown) => onlyExactDnsImports(shown, configuration) }
        : input.handoff ? { verifyPlannedChanges: (shown: unknown) => exactHandoffDnsChanges(shown, input.handoff!.review, input.handoff!.stage) } : {}) });
    if (!planned.ok) return blocked(redactEngineOutput(planned.error, auth.redact));
    if (planned.blockers.length || planned.unmanagedDeletes.length) return { actions: [], ready: false, blocked: [...planned.blockers.map(value => redactEngineOutput(value, auth.redact)), ...(planned.unmanagedDeletes.length ? ['DNS state includes undeclared resources. Preserve it and reconcile exact ownership before deleting anything.'] : [])] };
    const allIntents = [...records, ...retired];
    for (const action of planned.actions) {
      const addresses = engineSegmentOf(action)?.addresses ?? [];
      const observedExisting = addresses.some(address => allIntents.some(record => {
        const authority = record.authority;
        return dnsRecordAddress(identity, record) === address && authority.kind !== 'absent'
          && snapshots.get(`${normalized(record.name)}|${record.type}`)?.records.some(entry => entry.nativeId === authority.nativeId);
      }));
      if (action.type === 'replace' || action.type === 'create' && observedExisting) return blocked('The DNS plan would recreate an observed resource. Restore its ownership state or review an explicit import; recreation is not a recovery shortcut.');
    }
    const reconcile = Boolean(saved && planned.actions.every(action => action.type === 'noop') && (hash(owners) !== previousOwnersFingerprint || saved.attempt || recoverTrafficReceipt));
    const payload: DnsPayload = { configuration, records, retired, owners, managed: previous, readOnlyReconciliation: reconcile, zoneNativeId: zone.value.providerNativeId,
      ...(input.adoptOnly && { trafficOnlyDomainId: input.adoptOnly.providerDomainId }),
      observations: [...snapshots.values()].map(entry => entry.snapshot), bindingFingerprint: hash(saved ?? null) };
    const descriptor: DnsPlanDescriptor = { version: 1, planId, segment: planned.segment, state, zone: identity,
      owner: input.owner, domain: input.domain, connectionId: connection.connectionId, connectionScope: effective.dns.connectionScope,
      zoneFingerprint: dnsZoneFingerprint(zone.value), payloadEncrypted: input.ctx.secretStore.encryptObject(payload) };
    const actions: PlanAction[] = planned.actions.map(action => ({ ...action,
      ...(action.type !== 'noop' ? { requiresConfirm: true } : {}),
      reason: action.type === 'noop' ? action.reason : `${action.reason} DNS values and unrelated records are preserved according to the exact reviewed record ownership.`,
      metadata: { ...action.metadata, operation: DNS_ENGINE_OPERATION, domain: input.domain },
    }));
    if (reconcile) actions.splice(0, actions.length, { id: `dns-reconcile:${input.owner}`, type: 'update', verified: true,
      resource: { kind: 'domain', provider: `dns-${identity.provider}`, name: input.domain },
      reason: recoverTrafficReceipt ? 'Verify the existing traffic record and finish recording its hosting attachment. This step makes no DNS changes.'
        : 'Verify exact native DNS absence and retained shared records, then reconcile the saved ownership receipt. This step makes no DNS changes.',
      metadata: { operation: DNS_RECONCILE_OPERATION, domain: input.domain } });
    return { actions, descriptor, ready: actions.every(action => action.type === 'noop') };
  } catch {
    return blocked('DNS planning could not verify its private state or connection. Preserve existing records and retry after resolving access.');
  }
}

/** Explicit observation stage for an engine noop whose local consumer receipt needs reconciliation. */
export async function executeDnsOwnershipReconciliation(input: {
  ctx: CommandContext; project: Project; environment: Environment; descriptor: DnsPlanDescriptor;
}, deps: DnsEngineDependencies = defaults): Promise<ActionResult> {
  const stop = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
  try {
    const d = input.descriptor;
    if (JSON.stringify(d.state) !== JSON.stringify(dnsEngineState(input.environment, d.zone.provider, d.owner))) return stop('DNS ownership verification targets a different environment.');
    const payload = input.ctx.secretStore.decryptObject<DnsPayload>(d.payloadEncrypted);
    if (!payload.readOnlyReconciliation) return stop('This saved DNS artifact does not authorize a read-only ownership reconciliation.');
    const current = input.ctx.repos.environments.findById(input.environment.id) ?? input.environment;
    const saved = binding(current, d.owner);
    if (!saved || hash(saved) !== payload.bindingFingerprint) return stop('DNS ownership changed after review. Run hv_plan again.');
    const overlap = otherOwnership(input.ctx, current, d.owner, d.zone, [...payload.records, ...payload.retired]);
    if (overlap) return stop(overlap);
    const connection = await deps.connect({ context: input.ctx, zone: d.zone, connectionScope: d.connectionScope, scopeHints: lookupHints(input.project, d.domain, d.zone) });
    if ('blocked' in connection) return stop(connection.blocked);
    if (connection.connectionId !== d.connectionId) return stop('The DNS connection changed after review.');
    const zone = await connection.observer.observeZone();
    if (zone.status !== 'present' || dnsZoneFingerprint(zone.value) !== d.zoneFingerprint) return stop('The exact DNS zone changed or could not be observed.');
    if (payload.trafficOnlyDomainId) {
      const engine = await deps.engine();
      const inspected = await engine.inspectState({ backend: dnsEngineBackend(d.zone), configuration: payload.configuration,
        auth: connection.auth, state: d.state, project: projectNativeIds });
      if (!inspected.ok || !inspected.present || !exactManagedIds(d.zone, payload.records.filter(record => ownerOf(record.key) === d.owner), inspected.value)) {
        return stop('The private DNS state no longer contains the reviewed native traffic record IDs.');
      }
    }
    const observations = new Map<string, DnsObservedRecord[]>();
    for (const snapshot of payload.observations) {
      const present = await observeRecords(connection.observer, snapshot.name, snapshot.type);
      if (recordFingerprint(present) !== snapshot.fingerprint) return stop('DNS changed after review. Run hv_plan again.');
      observations.set(`${normalized(snapshot.name)}|${snapshot.type}`, present);
    }
    const managed: ManagedRecord[] = [];
    for (const record of [...payload.records, ...payload.retired]) {
      if (record.authority.kind !== 'managed') return stop('Read-only reconciliation cannot establish new DNS ownership.');
      const authority = record.authority;
      const present = observations.get(`${normalized(record.name)}|${record.type}`);
      if (!present) return stop('The saved DNS verification lacks a complete record observation.');
      const exact = present.find(entry => entry.nativeId === authority.nativeId);
      const address = dnsRecordAddress(d.zone, record);
      const desired = payload.records.some(entry => entry.key === record.key);
      const expected = sorted([...payload.records.filter(entry => dnsRecordAddress(d.zone, entry) === address).flatMap(entry => entry.values), ...authority.preserveValues]);
      if (!expected.length) {
        if (exact) return stop('The exact owned DNS resource is still present.');
        continue;
      }
      if (!exact || JSON.stringify(exact.values) !== JSON.stringify(expected) || exact.ttl !== record.ttl
        || d.zone.provider === 'cloudflare' && ['A', 'AAAA', 'CNAME'].includes(record.type) && exact.proxied !== (record.proxied ?? false)) return stop('DNS has not converged to the exact retained values and security settings.');
      managed.push({ owner: ownerOf(record.key), address, intent: { ...record, values: desired ? record.values : [] } });
    }
    input.ctx.repos.environments.updatePlatformBindings(current.id, { [bindingKey(d.owner)]: { ...saved, domain: d.domain,
      trafficOnlyDomainId: managed.some(record => record.owner === 'hosting-domain' && record.intent.values.length)
        ? payload.trafficOnlyDomainId ?? saved.trafficOnlyDomainId : undefined,
      recordsEncrypted: input.ctx.secretStore.encryptObject(managed), ownersEncrypted: input.ctx.secretStore.encryptObject(payload.owners),
      configurationEncrypted: input.ctx.secretStore.encryptObject(payload.configuration),
      ownedOwners: sorted(managed.filter(record => record.intent.values.length).map(record => record.owner)), attempt: undefined } });
    return { success: true, message: 'Verified exact DNS ownership, absence and preserved shared records without changing DNS.' };
  } catch { return stop('DNS ownership could not be verified completely. Preserve the saved state and retry observation.'); }
}

function projectNativeIds(state: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const root = state as { format_version?: unknown; values?: { root_module?: unknown } };
  if (!root || typeof root !== 'object' || typeof root.format_version !== 'string') throw new Error();
  const visit = (module: unknown) => {
    if (!module || typeof module !== 'object') throw new Error();
    const value = module as { resources?: unknown[]; child_modules?: unknown[] };
    if (value.resources !== undefined && !Array.isArray(value.resources)) throw new Error();
    for (const raw of value.resources ?? []) {
      const item = raw as { mode?: string; address?: string; values?: { id?: unknown } };
      if (item.mode === 'data') continue;
      if (typeof item.address !== 'string' || typeof item.values?.id !== 'string' || /[\r\n]/.test(item.values.id)) throw new Error();
      result[item.address] = item.values.id;
    }
    if (value.child_modules !== undefined && !Array.isArray(value.child_modules)) throw new Error();
    for (const child of value.child_modules ?? []) visit(child);
  };
  if (root.values?.root_module) visit(root.values.root_module);
  else if (root.values && typeof root.values !== 'object') throw new Error();
  return result;
}
function normalizeNativeId(zone: DnsZoneIdentity, record: DnsRecordIntent, id: string): string {
  if (zone.provider === 'cloudflare') {
    if (id.includes('/') && (!id.startsWith(`${zone.zoneId}/`) || id.split('/').length !== 2)) throw new Error('Engine DNS state names a different Cloudflare zone.');
    const native = dnsRecordNativeId(zone, record.name, record.type, id.includes('/') ? id.split('/')[1]! : id);
    if (record.authority.kind === 'adopt' && native !== record.authority.nativeId) throw new Error('Engine state names a different Cloudflare record than the reviewed import.');
    return native;
  }
  const expected = dnsRecordNativeId(zone, record.name, record.type);
  if ((zone.provider === 'azure' ? id.toLowerCase() !== expected.toLowerCase() : id !== expected)) throw new Error('Engine DNS state native identity does not match the reviewed zone and record.');
  return expected;
}

function exactManagedIds(zone: DnsZoneIdentity, records: DnsRecordIntent[], state: Record<string, string>): boolean {
  return records.length > 0 && records.every(record => {
    const native = state[dnsRecordAddress(zone, record)];
    return native && record.authority.kind === 'managed' && normalizeNativeId(zone, record, native) === record.authority.nativeId;
  });
}

/** Execute only the saved DNS segment, rechecking connection, zone and every observed record before mutations. */
export async function executeDnsEngineSegment(input: {
  ctx: CommandContext; project: Project; environment: Environment; descriptor: DnsPlanDescriptor;
  segment: EngineActionSegment; members: PlanAction[];
}, deps: DnsEngineDependencies = defaults): Promise<EngineSegmentResult> {
  const addresses = [...new Set(input.members.flatMap(member => engineSegmentOf(member)?.addresses ?? []))];
  const stop = (message: string): EngineSegmentResult => ({ outcomes: Object.fromEntries(addresses.map(address => [address, 'not_started'])), diagnostics: [message] });
  try {
    const d = input.descriptor;
    if (!d || d.version !== 1 || d.segment.id !== input.segment.id || !/^[a-z][a-z0-9_-]{0,40}$/.test(d.owner)
      || JSON.stringify(d.state) !== JSON.stringify(dnsEngineState(input.environment, d.zone.provider, d.owner))) return stop('The saved DNS plan targets a different environment or segment.');
    if (input.members.some(member => member.metadata?.operation !== DNS_ENGINE_OPERATION)) return stop('This segment contains non-DNS actions.');
    const connection = await deps.connect({ context: input.ctx, zone: d.zone, connectionScope: d.connectionScope,
      scopeHints: lookupHints(input.project, d.domain, d.zone) });
    if ('blocked' in connection) return stop(connection.blocked);
    if (connection.connectionId !== d.connectionId) return stop('The DNS connection changed after review. Generate a new plan.');
    const zone = await connection.observer.observeZone();
    if (zone.status !== 'present' || dnsZoneFingerprint(zone.value) !== d.zoneFingerprint) return stop('The DNS zone identity or security posture changed after review. Generate a new plan.');
    const payload = input.ctx.secretStore.decryptObject<DnsPayload>(d.payloadEncrypted);
    if (!payload || !Array.isArray(payload.observations) || !Array.isArray(payload.records) || !Array.isArray(payload.retired)
      || !payload.configuration?.files || !payload.configuration.resources) return stop('The saved DNS plan payload is unreadable.');
    for (const snapshot of payload.observations) {
      const present = await observeRecords(connection.observer, snapshot.name, snapshot.type);
      if (recordFingerprint(present) !== snapshot.fingerprint) return stop('DNS records changed after review. Generate a fresh plan before modifying them.');
    }
    const current = input.ctx.repos.environments.findById(input.environment.id) ?? input.environment;
    const old = binding(current, d.owner);
    if (hash(old ?? null) !== payload.bindingFingerprint || old && !sameZone(old.zone, d.zone)) return stop('The environment DNS binding changed after this plan.');
    const overlap = otherOwnership(input.ctx, current, d.owner, d.zone, [...payload.records, ...payload.retired]);
    if (overlap) return stop(overlap);
    const trafficOnlyDomainId = payload.trafficOnlyDomainId ?? (payload.records.some(record => ownerOf(record.key) === 'hosting-domain')
      ? old?.trafficOnlyDomainId : undefined);
    const base: DnsBinding = { version: 1, zone: d.zone, domain: d.domain, connectionScope: d.connectionScope, zoneNativeId: payload.zoneNativeId,
      trafficOnlyDomainId,
      zoneFingerprint: d.zoneFingerprint, recordsEncrypted: input.ctx.secretStore.encryptObject(payload.managed),
      ownersEncrypted: input.ctx.secretStore.encryptObject(payload.owners), configurationEncrypted: input.ctx.secretStore.encryptObject(payload.configuration),
      ownedOwners: sorted(payload.managed.filter(record => record.intent.values.length).map(record => record.owner)),
      ownerDomains: { ...old?.ownerDomains, [d.owner]: d.domain }, attempt: d };
    input.ctx.repos.environments.updatePlatformBindings(current.id, { [bindingKey(d.owner)]: base });
    const engine = await deps.engine();
    const auth = { ...connection.auth, redact: sorted([...connection.auth.redact, ...privateValues([...payload.records, ...payload.retired])]) };
    const outcome = await engine.apply({ backend: dnsEngineBackend(d.zone), auth, state: d.state,
      planId: d.planId, segment: { ...input.segment, addresses }, approvedAddresses: addresses });
    const inspected = await engine.inspectState({ backend: dnsEngineBackend(d.zone), configuration: payload.configuration,
      auth, state: d.state, project: projectNativeIds });
    if (!inspected.ok || !inspected.present) return { outcomes: Object.fromEntries(addresses.map(address => [address, 'unknown'])), diagnostics: ['DNS apply finished without readable native ownership state. Preserve the saved attempt and inspect it before retrying.'] };
    // Save IDs from partial state before any provider verification can fail.
    const recovery = new Map(payload.managed.map(record => [record.intent.key, record]));
    for (const record of [...payload.records, ...payload.retired]) {
      const address = dnsRecordAddress(d.zone, record);
      const native = inspected.value[address];
      if (!native) continue;
      const nativeId = normalizeNativeId(d.zone, record, native);
      const old = recovery.get(record.key);
      recovery.set(record.key, { owner: ownerOf(record.key), address, intent: { ...record,
        values: sorted([...record.values, ...(old?.intent.values ?? [])]),
        authority: { kind: 'managed', nativeId, preserveValues: record.authority.kind === 'absent' ? [] : record.authority.preserveValues } } });
    }
    input.ctx.repos.environments.updatePlatformBindings(current.id, { [bindingKey(d.owner)]: { ...base,
      recordsEncrypted: input.ctx.secretStore.encryptObject([...recovery.values()]),
      ownedOwners: sorted([...recovery.values()].filter(record => record.intent.values.length).map(record => record.owner)) } });
    const managed: ManagedRecord[] = [];
    let verificationFailed = false;
    for (const record of [...payload.records, ...payload.retired]) {
      const address = dnsRecordAddress(d.zone, record);
      const native = inspected.value[address];
      const desired = payload.records.some(entry => entry.key === record.key);
      const preserved = record.authority.kind === 'absent' ? [] : record.authority.preserveValues;
      const present = await observeRecords(connection.observer, record.name, record.type);
      if (native) {
        const nativeId = normalizeNativeId(d.zone, record, native);
        const exact = present.find(entry => entry.nativeId === nativeId);
        const expected = sorted([...payload.records.filter(entry => dnsRecordAddress(d.zone, entry) === address).flatMap(entry => entry.values), ...preserved]);
        if (!exact || JSON.stringify(sorted(exact.values)) !== JSON.stringify(expected) || exact.ttl !== record.ttl
          || d.zone.provider === 'cloudflare' && ['A', 'AAAA', 'CNAME'].includes(record.type) && exact.proxied !== (record.proxied ?? false)) verificationFailed = true;
        managed.push({ owner: ownerOf(record.key), address, intent: { ...record, values: desired ? record.values : [],
          authority: { kind: 'managed', nativeId, preserveValues: preserved } } });
      } else if (desired || record.authority.kind !== 'absent' && present.some(entry => entry.nativeId === (record.authority as { nativeId: string }).nativeId)) {
        verificationFailed = true;
      }
    }
    const complete = !verificationFailed && addresses.every(address => outcome.outcomes[address] === 'succeeded');
    const latest = input.ctx.repos.environments.findById(current.id) ?? current;
    input.ctx.repos.environments.updatePlatformBindings(latest.id, { [bindingKey(d.owner)]: { ...base,
      recordsEncrypted: input.ctx.secretStore.encryptObject(managed), ownedOwners: sorted(managed.filter(record => record.intent.values.length).map(record => record.owner)),
      ...(complete ? { attempt: undefined } : {}) } });
    if (verificationFailed) return { outcomes: Object.fromEntries(addresses.map(address => [address, 'unknown'])), diagnostics: ['DNS resources have not converged to the exact reviewed identities and values. Recovery state is retained; observe again before advancing.'] };
    return { ...outcome, diagnostics: outcome.diagnostics.map(value => redactEngineOutput(value, auth.redact)) };
  } catch {
    return { outcomes: Object.fromEntries(addresses.map(address => [address, 'unknown'])), diagnostics: ['DNS apply or verification could not complete safely. Retain its saved ownership and attempt; do not infer absence or recreate resources.'] };
  }
}
