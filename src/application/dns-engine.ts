import { createHash, randomUUID } from 'node:crypto';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { dnsEngineBackend, buildDnsConfiguration, dnsRecordAddress, dnsRecordNativeId } from '../adapters/dns/tofu/dns-engine.backend.js';
import { resolveDnsConnection, dnsZoneFingerprint } from '../adapters/dns-observation/connections.js';
import type { DnsObserver } from '../adapters/dns-observation/http-observer.js';
import type { DnsRecordIntent, DnsRecordType, DnsObservedRecord, DnsZoneIdentity } from '../domain/ports/dns.port.js';
import type { EngineActionSegment, EngineConfiguration, EngineSegmentResult, EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../domain/ports/infrastructure-engine.port.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { resolveDnsPolicy } from '../domain/services/dns-policy.service.js';
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
  readOnlyReconciliation?: boolean; zoneNativeId?: string;
}
export interface DnsPlanInput {
  ctx: CommandContext; project: Project; environment: Environment; environmentSpec: EnvironmentSpec;
  owner: string; domain: string; records: DesiredDnsRecord[]; remove?: boolean; retainExistingTypes?: DnsRecordType[];
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
    const binary = await ensureEngineBinary();
    if (!binary.ok) throw new Error(binary.error);
    return new OpenTofuEngine({ binary: binary.binary, cipher: (await import('../adapters/secrets/secret-store.js')).getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
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
function sameZone(left: DnsZoneIdentity, right: DnsZoneIdentity): boolean {
  return left.provider === right.provider && left.zoneId === right.zoneId && normalized(left.zoneName) === normalized(right.zoneName)
    && ['accountId', 'projectId', 'subscriptionId', 'resourceGroup'].every(key => left.scope[key as keyof typeof left.scope] === right.scope[key as keyof typeof right.scope]);
}
function binding(environment: Environment): DnsBinding | undefined {
  const value = (environment.platformBindings as { dnsEngine?: DnsBinding }).dnsEngine;
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || !value.zone || typeof value.recordsEncrypted !== 'string'
    || typeof value.ownersEncrypted !== 'string' || typeof value.configurationEncrypted !== 'string') throw new Error('The saved DNS ownership record is unreadable; preserve it before continuing.');
  return value;
}
export function getDnsBindingIdentity(environment: Environment): DnsZoneIdentity | undefined { return binding(environment)?.zone; }
export function getDnsBindingSelection(environment: Environment): { zone: DnsZoneIdentity; connectionScope?: string } | undefined {
  const saved = binding(environment);
  return saved ? { zone: saved.zone, connectionScope: saved.connectionScope } : undefined;
}
export function getDnsOwnedDomain(environment: Environment, owner: string): string | undefined {
  const saved = binding(environment);
  return hasOwnedDnsRecords(environment, owner) ? saved?.ownerDomains?.[owner] ?? saved?.domain : undefined;
}
export function hasOwnedDnsRecords(environment: Environment, owner?: string): boolean {
  const saved = binding(environment);
  return Boolean(saved && (saved.attempt && (!owner || saved.attempt.owner === owner)
    || (owner ? saved.ownedOwners?.includes(owner) : saved.ownedOwners?.length)));
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
  return owned(ctx, binding(environment)).filter(record => !owner || record.owner === owner).map(record => ({
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
function engineState(environment: Environment, provider: string): EngineStateIdentity & { partition: 'environment' } {
  return { provider: `dns-${provider}`, projectId: environment.projectId, environmentId: environment.id, partition: 'environment' };
}
function lookupHints(project: Project, domain: string, zone: DnsZoneIdentity): string[] {
  return [...new Set([parseGitHubRepoFromRemote(project.gitRemoteUrl), domain, normalized(zone.zoneName)].filter((value): value is string => Boolean(value)))];
}
function otherOwnership(ctx: CommandContext, environment: Environment, zone: DnsZoneIdentity, intents: DnsRecordIntent[]): string | undefined {
  for (const project of ctx.repos.projects.findAll()) for (const candidate of ctx.repos.environments.findByProjectId(project.id)) {
    if (candidate.id === environment.id) continue;
    const saved = binding(candidate);
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
  return undefined;
}

/** Plan a single consumer's contribution; other DNS consumers and adopted sibling values stay retained. */
export async function prepareDnsEnginePlan(input: DnsPlanInput, deps: DnsEngineDependencies = defaults): Promise<DnsPreparedPlan> {
  const blocked = (reason: string): DnsPreparedPlan => ({ actions: [], ready: false, blocked: [reason] });
  try {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(input.owner)) return blocked('DNS consumer identity is invalid.');
    const current = input.ctx.repos.environments.findById(input.environment.id) ?? input.environment;
    const saved = binding(current);
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
        auth, state: engineState(current, identity.provider), project: projectNativeIds });
      if (!inspected.ok) return blocked('The interrupted DNS attempt has unreadable private engine state. Preserve it and retry observation before planning mutations.');
      if (inspected.present) {
        const recovered = new Map(previous.map(record => [record.intent.key, record]));
        for (const record of [...attempt.records, ...attempt.retired]) {
          const address = dnsRecordAddress(identity, record);
          const native = inspected.value[address];
          if (!native) continue;
          const nativeId = normalizeNativeId(identity, record, native);
          recovered.set(record.key, { owner: ownerOf(record.key), address, intent: { ...record,
            values: sorted([...record.values, ...(recovered.get(record.key)?.intent.values ?? [])]),
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
    const retained = input.remove ? [] : (owners[input.owner] ?? []).filter(record => input.retainExistingTypes?.includes(record.type));
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
        const adoption = effective.dns.adoptRecords?.find(entry => normalized(entry.name) === normalized(record.name) && entry.type === record.type
          && present.some(observed => observed.nativeId === entry.id));
        const exact = adoption && present.find(entry => entry.nativeId === adoption.id);
        if (exact && adoption) {
          if (JSON.stringify(sorted(exact.values)) !== JSON.stringify(normalizedValues(record.type, adoption.values))) return blocked('The DNS record changed after its adoption values were selected. Refresh the explicit adoption intent.');
          if (identity.provider === 'cloudflare' && present.filter(entry => entry.nativeId !== exact.nativeId).some(entry => entry.values.some(value => record.values.includes(value)))) return blocked('Several DNS records match the adoption target. Select each exact native record instead of guessing.');
          const desiredValues = desired.filter(entry => dnsRecordAddress(identity, { ...entry, authority: { kind: 'absent' } }) === recordAddress).flatMap(entry => entry.values);
          records.push({ ...record, authority: { kind: 'adopt', nativeId: exact.nativeId, existingValues: exact.values,
            preserveValues: exact.values.filter(value => !desiredValues.includes(value)) } });
        } else if (present.length && (identity.provider !== 'cloudflare' || present.some(entry => entry.values.some(value => record.values.includes(value))))) {
          return blocked(`Existing ${record.type} records for ${record.name} are not owned by this DNS state. Add exact native IDs and current values to dns.adoptRecords and review the import plan.`);
        } else records.push({ ...record, authority: { kind: 'absent' } });
      }
      // A CNAME cannot coexist with other ordinary record types at its owner.
      if (record.type === 'CNAME') for (const other of ['A', 'AAAA', 'TXT', 'MX', 'CAA'] as DnsRecordType[]) {
        if ((await read(record.name, other)).length) return blocked(`Existing ${other} records conflict with the desired CNAME for ${record.name}; preserve them and resolve the conflict explicitly.`);
      } else if ((await read(record.name, 'CNAME')).length) return blocked(`An existing CNAME conflicts with ${record.type} at ${record.name}.`);
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
    const overlap = otherOwnership(input.ctx, current, identity, [...records, ...retired]);
    if (overlap) return blocked(overlap);
    const configuration = buildDnsConfiguration({ zone: identity, records, retiredRecords: retired });
    const engine = await deps.engine();
    const state = engineState(current, identity.provider);
    const planId = randomUUID();
    const auth = { ...connection.auth, redact: sorted([...connection.auth.redact, ...privateValues([...records, ...retired])]) };
    const planned = await engine.plan({ backend: dnsEngineBackend(identity), configuration, auth, state, planId });
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
    const reconcile = Boolean(saved && planned.actions.every(action => action.type === 'noop') && (hash(owners) !== previousOwnersFingerprint || saved.attempt));
    const payload: DnsPayload = { configuration, records, retired, owners, managed: previous, readOnlyReconciliation: reconcile, zoneNativeId: zone.value.providerNativeId,
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
      reason: 'Verify exact native DNS absence and retained shared records, then reconcile the saved ownership receipt. This step makes no DNS changes.',
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
    if (JSON.stringify(d.state) !== JSON.stringify(engineState(input.environment, d.zone.provider))) return stop('DNS ownership verification targets a different environment.');
    const payload = input.ctx.secretStore.decryptObject<DnsPayload>(d.payloadEncrypted);
    if (!payload.readOnlyReconciliation) return stop('This saved DNS artifact does not authorize a read-only ownership reconciliation.');
    const current = input.ctx.repos.environments.findById(input.environment.id) ?? input.environment;
    const saved = binding(current);
    if (!saved || hash(saved) !== payload.bindingFingerprint) return stop('DNS ownership changed after review. Run hv_plan again.');
    const overlap = otherOwnership(input.ctx, current, d.zone, [...payload.records, ...payload.retired]);
    if (overlap) return stop(overlap);
    const connection = await deps.connect({ context: input.ctx, zone: d.zone, connectionScope: d.connectionScope, scopeHints: lookupHints(input.project, d.domain, d.zone) });
    if ('blocked' in connection) return stop(connection.blocked);
    if (connection.connectionId !== d.connectionId) return stop('The DNS connection changed after review.');
    const zone = await connection.observer.observeZone();
    if (zone.status !== 'present' || dnsZoneFingerprint(zone.value) !== d.zoneFingerprint) return stop('The exact DNS zone changed or could not be observed.');
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
    input.ctx.repos.environments.updatePlatformBindings(current.id, { dnsEngine: { ...saved, domain: d.domain,
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
    return dnsRecordNativeId(zone, record.name, record.type, id.includes('/') ? id.split('/')[1]! : id);
  }
  const expected = dnsRecordNativeId(zone, record.name, record.type);
  if ((zone.provider === 'azure' ? id.toLowerCase() !== expected.toLowerCase() : id !== expected)) throw new Error('Engine DNS state native identity does not match the reviewed zone and record.');
  return expected;
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
      || JSON.stringify(d.state) !== JSON.stringify(engineState(input.environment, d.zone.provider))) return stop('The saved DNS plan targets a different environment or segment.');
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
    const old = binding(current);
    if (hash(old ?? null) !== payload.bindingFingerprint || old && !sameZone(old.zone, d.zone)) return stop('The environment DNS binding changed after this plan.');
    const overlap = otherOwnership(input.ctx, current, d.zone, [...payload.records, ...payload.retired]);
    if (overlap) return stop(overlap);
    const base: DnsBinding = { version: 1, zone: d.zone, domain: d.domain, connectionScope: d.connectionScope, zoneNativeId: payload.zoneNativeId,
      zoneFingerprint: d.zoneFingerprint, recordsEncrypted: input.ctx.secretStore.encryptObject(payload.managed),
      ownersEncrypted: input.ctx.secretStore.encryptObject(payload.owners), configurationEncrypted: input.ctx.secretStore.encryptObject(payload.configuration),
      ownedOwners: sorted(payload.managed.filter(record => record.intent.values.length).map(record => record.owner)),
      ownerDomains: { ...old?.ownerDomains, [d.owner]: d.domain }, attempt: d };
    input.ctx.repos.environments.updatePlatformBindings(current.id, { dnsEngine: base });
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
    input.ctx.repos.environments.updatePlatformBindings(current.id, { dnsEngine: { ...base,
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
    input.ctx.repos.environments.updatePlatformBindings(latest.id, { dnsEngine: { ...base,
      recordsEncrypted: input.ctx.secretStore.encryptObject(managed), ownedOwners: sorted(managed.filter(record => record.intent.values.length).map(record => record.owner)),
      ...(complete ? { attempt: undefined } : {}) } });
    if (verificationFailed) return { outcomes: Object.fromEntries(addresses.map(address => [address, 'unknown'])), diagnostics: ['DNS resources have not converged to the exact reviewed identities and values. Recovery state is retained; observe again before advancing.'] };
    return { ...outcome, diagnostics: outcome.diagnostics.map(value => redactEngineOutput(value, auth.redact)) };
  } catch {
    return { outcomes: Object.fromEntries(addresses.map(address => [address, 'unknown'])), diagnostics: ['DNS apply or verification could not complete safely. Retain its saved ownership and attempt; do not infer absence or recreate resources.'] };
  }
}
