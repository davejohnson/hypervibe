import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executeDnsEngineSegment, executeDnsOwnershipReconciliation, hasOwnedDnsRecords, prepareDnsEnginePlan, readDnsOwnedRecords, type DesiredDnsRecord, type DnsEngineDependencies, type DnsPreparedPlan } from '../dns-engine.js';
import type { DnsObservation, DnsObservedRecord, DnsRecordType, DnsZoneIdentity, DnsZoneObservation } from '../../domain/ports/dns.port.js';
import type { EngineActionSegment, EngineConfiguration, EngineSegmentResult } from '../../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';

// These are synthetic application-boundary tests. Provider wire semantics are
// independently reconstructed in dns-observation.api-contract.test.ts. The
// expected ownership decisions follow AGENTS.md: native identity, exact current
// adoption, no mutation on unknown/stale evidence, preserve unrelated values.
const name = 'app.example.com';
const gcpZone: DnsZoneIdentity = { provider: 'gcp', zoneId: 'dns-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } };
const gcpNativeId = 'projects/dns-project/managedZones/dns-zone/rrsets/app.example.com./TXT';
const cfZoneId = '023e105f4ecef8ad9ca31a8372d0c353';
const cfRecordId = '023e105f4ecef8ad9ca31a8372d0c354';
const desired: DesiredDnsRecord = { key: 'verification', name, type: 'TXT', values: ['private-verification-token'], ttl: 300 };
const segment: Omit<EngineActionSegment, 'addresses'> = { id: 'saved-dns-segment', engine: 'opentofu', planDigest: 'reviewed-plan-digest',
  configurationDigest: 'reviewed-configuration-digest', engineVersion: '1.12.2', providerVersions: { google: '8.9.0' } };

beforeEach(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-dns-engine-')), 'test.db')).migrate();
});
afterEach(() => { SqliteAdapter.resetInstance(); });

function fixture(provider: 'gcp' | 'cloudflare' = 'gcp') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'dns-boundary', gitRemoteUrl: 'https://github.com/fixture-owner/dns-boundary.git', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'fixture' });
  const identity: DnsZoneIdentity = provider === 'gcp' ? gcpZone : { provider, zoneId: cfZoneId, zoneName: 'example.com', scope: { accountId: '023e105f4ecef8ad9ca31a8372d0c355' } };
  const zone: DnsZoneObservation = { identity, providerNativeId: provider === 'gcp' ? '123456' : cfZoneId, visibility: 'public', dnssec: 'disabled', nameservers: ['ns.example.net'] };
  const spec = { hosting: { provider: 'cloudrun' }, domain: name,
    dns: { provider, zone: { id: identity.zoneId, name: identity.zoneName, ...identity.scope }, connectionScope: 'fixture-owner/dns-boundary', policy: { proxy: 'off' } } } as EnvironmentSpec;
  const observations = new Map<string, DnsObservation<DnsObservedRecord[]>>();
  let connectionId = 'verified-dns-connection'; let actionType: PlanAction['type'] = 'create';
  let rawState: unknown = { format_version: '1.0', values: { root_module: { resources: [] } } };
  let privateProjection: unknown;
  let applyEffects = () => {};
  let applyOutcome: 'succeeded' | 'failed' = 'succeeded';
  const observeZone = vi.fn(async (): Promise<DnsObservation<DnsZoneObservation>> => ({ status: 'present', value: structuredClone(zone) }));
  const observeRecordSets = vi.fn(async (owner: string, type: DnsRecordType): Promise<DnsObservation<DnsObservedRecord[]>> =>
    structuredClone(observations.get(`${owner.toLowerCase().replace(/\.$/, '')}|${type}`) ?? { status: 'absent' }));
  const plan = vi.fn(async (params: { configuration: EngineConfiguration; planId: string }) => ({
    ok: true, segment, blockers: [], unmanagedDeletes: [],
    actions: Object.entries(params.configuration.resources).map(([address, mapping]): PlanAction => ({
      id: mapping.actionId, type: actionType, resource: { kind: 'domain', name: mapping.name, provider: `dns-${provider}` },
      verified: true, reason: 'Synthetic exact saved engine plan', metadata: { engineSegment: { ...segment, addresses: [address] } },
    })),
  }));
  const apply = vi.fn(async (params: { approvedAddresses: string[] }): Promise<EngineSegmentResult> => {
    applyEffects(); return { outcomes: Object.fromEntries(params.approvedAddresses.map(address => [address, applyOutcome])), diagnostics: [] };
  });
  const inspectState = vi.fn(async (params: { project: (value: unknown) => unknown }) => {
    privateProjection = params.project(rawState); return { ok: true, present: true, value: privateProjection };
  });
  const connect = vi.fn(async () => ({ observer: { observeZone, observeRecordSets }, auth: { env: { PRIVATE_DNS_CREDENTIAL: 'private-auth-token' }, redact: ['private-auth-token'] }, connectionId, connectionProvider: provider === 'gcp' ? 'gcp-dns' : 'cloudflare' }));
  const deps: DnsEngineDependencies = { connect: connect as DnsEngineDependencies['connect'],
    engine: async () => ({ plan, apply, inspectState }) as unknown as Awaited<ReturnType<DnsEngineDependencies['engine']>>,
    security: async () => ({ status: 'observed', basis: 'public-validating-resolver', resolver: 'dns.google', dnssec: 'not_validated',
      caa: { status: 'unrestricted', issuerCompatibility: 'not_restricted' }, guidance: 'Synthetic public DNS security evidence.' }),
  };
  const fresh = () => ctx.repos.environments.findById(environment.id)!;
  const prepare = (records: DesiredDnsRecord[] = [desired], owner = 'domain', remove = false) => prepareDnsEnginePlan({
    ctx, project, environment: fresh(), environmentSpec: spec, domain: name, records, owner, remove,
  }, deps);
  const execute = async (prepared: DnsPreparedPlan) => {
    expect(prepared.blocked).toBeUndefined(); expect(prepared.descriptor).toBeDefined();
    const addresses = prepared.actions.flatMap(action => engineSegmentOf(action)?.addresses ?? []);
    return executeDnsEngineSegment({ ctx, project, environment: fresh(), descriptor: prepared.descriptor!, segment: { ...segment, addresses }, members: prepared.actions }, deps);
  };
  const observe = (values: string[], nativeId = provider === 'gcp' ? gcpNativeId : `${cfZoneId}/${cfRecordId}`, type: DnsRecordType = 'TXT') => observations.set(`${name}|${type}`,
    { status: 'present', value: [{ nativeId, name: `${name}.`, type, values, ttl: 300, ...(provider === 'cloudflare' ? { proxied: false } : {}) }] });
  const engineState = (address: string, nativeId: string) => { rawState = { format_version: '1.0', values: { root_module: { resources: [
    { mode: 'managed', address, values: { id: nativeId, content: 'private-verification-token', provider_credential: 'private-auth-token' } },
  ] } } }; };
  return { ctx, project, environment, fresh, identity, zone, spec, observations, prepare, execute, observe, engineState,
    reconcile: (prepared: DnsPreparedPlan) => executeDnsOwnershipReconciliation({ ctx, project, environment: fresh(), descriptor: prepared.descriptor! }, deps),
    plan, apply, inspectState, connect, observeZone, observeRecordSets, privateProjection: () => privateProjection,
    actionType: (value: PlanAction['type']) => { actionType = value; }, connection: (value: string) => { connectionId = value; },
    effects: (callback: () => void) => { applyEffects = callback; }, outcome: (value: 'succeeded' | 'failed') => { applyOutcome = value; },
    rawState: (value: unknown) => { rawState = value; } };
}

describe('DNS shared application authority', () => {
  it.each(['before-write', 'after-write'] as const)('recovers an interrupted Cloudflare update with the authorized %s singleton', async stage => {
    const f = fixture('cloudflare'); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, cfRecordId); f.effects(() => f.observe(desired.values));
    expect(Object.values((await f.execute(first)).outcomes)).toEqual(['succeeded']);
    const changed = { ...desired, values: ['reviewed-next-verification-value'] };
    f.actionType('update'); const update = await f.prepare([changed]);
    f.effects(() => f.observe(stage === 'after-write' ? changed.values : desired.values));
    f.inspectState.mockRejectedValueOnce(Error('Interrupted ownership capture'));
    expect(Object.values((await f.execute(update)).outcomes)).toEqual(['unknown']);
    f.actionType(stage === 'after-write' ? 'noop' : 'update');
    const recovered = await f.prepare([changed]);
    expect(recovered.blocked).toBeUndefined();
    expect(recovered.actions[0]?.metadata?.operation).toBe(stage === 'after-write' ? 'dnsOwnershipReconcile' : 'dnsEngine');
    expect(f.apply).toHaveBeenCalledTimes(2); // Recovery planning is read-only.
  });
  it('blocks an interrupted Cloudflare update whose live value matches neither reviewed state', async () => {
    const f = fixture('cloudflare'); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, cfRecordId); f.effects(() => f.observe(desired.values)); await f.execute(first);
    const changed = { ...desired, values: ['reviewed-next-verification-value'] };
    f.actionType('update'); const update = await f.prepare([changed]);
    f.effects(() => f.observe(['externally-changed-verification-value']));
    f.inspectState.mockRejectedValueOnce(Error('Interrupted ownership capture')); await f.execute(update);
    f.plan.mockClear(); const recovered = await f.prepare([changed]);
    expect(recovered.blocked).toBeDefined(); expect(f.plan).not.toHaveBeenCalled();
  });
  it('blocks fresh planning when a Google zone is recreated with the same API name', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    f.actionType('update'); f.zone.providerNativeId = 'replacement-zone-native-id';
    expect((await f.prepare()).blocked?.join(' ')).toMatch(/zone.*identity|zone.*recreated/i);
  });
  it('recovers interrupted ownership capture from private engine state without recreating DNS', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token']));
    f.inspectState.mockRejectedValueOnce(Error('interrupted state read'));
    expect(await f.execute(first)).toMatchObject({ outcomes: { [address]: 'unknown' } });
    f.actionType('noop'); const recovery = await f.prepare();
    expect(recovery.blocked).toBeUndefined();
    expect(recovery.actions).toEqual([expect.objectContaining({ metadata: { operation: 'dnsOwnershipReconcile', domain: name } })]);
    f.apply.mockClear(); expect(await f.reconcile(recovery)).toMatchObject({ success: true });
    expect(f.apply).not.toHaveBeenCalled(); expect(readDnsOwnedRecords(f.ctx, f.fresh())).toHaveLength(1);
    expect(f.fresh().platformBindings.dnsEngine).not.toHaveProperty('attempt');
  });
  it('refuses competing RRset ownership in another project even with matching live values', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    const otherProject = f.ctx.repos.projects.create({ name: 'competing-project', defaultPlatform: 'cloudrun' });
    f.ctx.repos.environments.create({ projectId: otherProject.id, name: 'fixture', platformBindings: f.fresh().platformBindings });
    f.plan.mockClear();
    expect((await f.prepare()).blocked?.join(' ')).toContain('Another Hypervibe environment');
    expect(f.plan).not.toHaveBeenCalled();
  });
  it('rechecks competing ownership before the saved segment applies', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    f.actionType('update'); const next = await f.prepare();
    const otherProject = f.ctx.repos.projects.create({ name: 'competing-project', defaultPlatform: 'cloudrun' });
    f.ctx.repos.environments.create({ projectId: otherProject.id, name: 'fixture', platformBindings: f.fresh().platformBindings });
    f.apply.mockClear();
    expect(await f.execute(next)).toMatchObject({ outcomes: { [address]: 'not_started' }, diagnostics: [expect.stringContaining('Another Hypervibe environment')] });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('reconciles already absent owned DNS with an explicit observation step and zero engine writes', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    f.actionType('noop'); f.observations.set(`${name}|TXT`, { status: 'absent' });
    const removed = await f.prepare([], 'domain', true);
    expect(removed.ready).toBe(false);
    expect(removed.actions).toEqual([expect.objectContaining({ type: 'update', metadata: { operation: 'dnsOwnershipReconcile', domain: name } })]);
    f.apply.mockClear();
    expect(await f.reconcile(removed)).toMatchObject({ success: true });
    expect(f.apply).not.toHaveBeenCalled();
    expect(hasOwnedDnsRecords(f.fresh(), 'domain')).toBe(false);
    expect(readDnsOwnedRecords(f.ctx, f.fresh())).toEqual([]);
  });
  it('blocks read-only cleanup when the resource reappears after review', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    f.actionType('noop'); f.observations.set(`${name}|TXT`, { status: 'absent' });
    const removed = await f.prepare([], 'domain', true); f.observe(['new-owner-value']);
    f.apply.mockClear();
    expect(await f.reconcile(removed)).toMatchObject({ success: false, status: 'blocked' });
    expect(f.apply).not.toHaveBeenCalled(); expect(hasOwnedDnsRecords(f.fresh(), 'domain')).toBe(true);
  });
  it('redacts private DNS values from provider failure diagnostics', async () => {
    const f = fixture();
    f.plan.mockResolvedValueOnce({ ok: false, error: 'invalid TXT private-verification-token', stage: 'plan' } as never);
    const planned = await f.prepare();
    expect(planned.blocked).toBeDefined();
    expect(JSON.stringify(planned)).not.toContain('private-verification-token');
  });
  it('blocks an unowned authoritative RRset instead of replacing a lookalike', async () => {
    const f = fixture(); f.observe(['unrelated-owner-value']);
    const result = await f.prepare();
    expect(result.blocked?.join(' ')).toContain('not owned'); expect(f.plan).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });
  it('imports only the exact selected current RRset and preserves every unrelated value', async () => {
    const f = fixture(); f.actionType('update'); f.observe(['unrelated-owner-value', 'private-verification-token']);
    f.spec.dns!.adoptRecords = [{ id: gcpNativeId, name, type: 'TXT', values: ['private-verification-token', 'unrelated-owner-value'] }];
    const result = await f.prepare(); expect(result.blocked).toBeUndefined(); expect(result.actions[0].requiresConfirm).toBe(true);
    const configuration = f.plan.mock.calls[0][0].configuration;
    expect(Object.values(configuration.imports!)).toEqual([gcpNativeId]);
    const serialized = JSON.stringify(configuration.files);
    expect(serialized).toContain('unrelated-owner-value'); expect(serialized).toContain('private-verification-token');
    expect(JSON.stringify(result)).not.toContain('private-verification-token'); expect(JSON.stringify(result)).not.toContain('private-auth-token');
  });
  it('rejects changed adoption values before asking the engine to plan', async () => {
    const f = fixture(); f.observe(['new-value']);
    f.spec.dns!.adoptRecords = [{ id: gcpNativeId, name, type: 'TXT', values: ['reviewed-old-value'] }];
    expect((await f.prepare()).blocked?.join(' ')).toContain('changed'); expect(f.plan).not.toHaveBeenCalled();
  });
  it('does not mistake another native record with identical contents for the selected adoption', async () => {
    const f = fixture('cloudflare'); f.observe(['private-verification-token']);
    f.spec.dns!.adoptRecords = [{ id: `${cfZoneId}/023e105f4ecef8ad9ca31a8372d0c356`, name, type: 'TXT', values: ['private-verification-token'] }];
    expect((await f.prepare()).blocked?.join(' ')).toContain('not owned'); expect(f.plan).not.toHaveBeenCalled();
  });
  it('blocks an unknown record read instead of planning creation', async () => {
    const f = fixture(); f.observations.set(`${name}|TXT`, { status: 'unknown', reason: 'DNS provider access is unknown.' });
    expect((await f.prepare()).blocked).toBeDefined(); expect(f.plan).not.toHaveBeenCalled();
  });
  it.each(['zone', 'record', 'connection'] as const)('refuses an apply after the reviewed %s changes', async changed => {
    const f = fixture(); const prepared = await f.prepare();
    if (changed === 'zone') f.zone.providerNativeId = 'new-numeric-zone-id';
    if (changed === 'record') f.observe(['concurrent-record']);
    if (changed === 'connection') f.connection('different-verified-connection');
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['not_started']); expect(f.apply).not.toHaveBeenCalled();
    expect(f.fresh().platformBindings.dnsEngine).toBeUndefined();
  });
  it('preserves exact identity recovery after a partial engine apply', async () => {
    const f = fixture(); const prepared = await f.prepare(); const address = engineSegmentOf(prepared.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.outcome('failed'); f.effects(() => f.observe(['private-verification-token']));
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['failed']);
    expect(readDnsOwnedRecords(f.ctx, f.fresh())).toEqual([{ nativeId: gcpNativeId, name, type: 'TXT', address, owner: 'domain' }]);
    expect(f.fresh().platformBindings.dnsEngine).toHaveProperty('attempt');
    expect(JSON.stringify(f.privateProjection())).toBe(JSON.stringify({ [address]: gcpNativeId }));
    expect(JSON.stringify(result)).not.toContain('private-auth-token'); expect(JSON.stringify(f.fresh().platformBindings)).not.toContain('private-verification-token');
  });
  it('preserves a sibling value added by another owner before retiring the managed RRset contribution', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token']));
    expect(Object.values((await f.execute(first)).outcomes)).toEqual(['succeeded']);
    // RRset deletion removes all values. Current native observation must therefore
    // preserve this externally added value even when the last managed owner leaves.
    f.observe(['private-verification-token', 'later-unrelated-owner-value']);
    f.actionType('update'); const removed = await f.prepare([], 'domain', true);
    expect(removed.blocked).toBeUndefined();
    const configuration = f.plan.mock.calls.at(-1)![0].configuration;
    expect(JSON.stringify(configuration.files)).toContain('later-unrelated-owner-value');
    expect(JSON.stringify(configuration.files)).not.toContain('private-verification-token');
  });
  it('blocks retirement when a managed Cloudflare record changed outside the workflow', async () => {
    const f = fixture('cloudflare'); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, cfRecordId); f.effects(() => f.observe(['private-verification-token']));
    expect(Object.values((await f.execute(first)).outcomes)).toEqual(['succeeded']);
    f.observe(['later-unrelated-owner-value']); f.plan.mockClear(); f.actionType('destroy');
    const removed = await f.prepare([], 'domain', true);
    expect(removed.blocked?.join(' ')).toContain('changed outside');
    expect(f.plan).not.toHaveBeenCalled();
  });
  it('rejects Cloudflare state identities that explicitly name another zone', async () => {
    const f = fixture('cloudflare'); const prepared = await f.prepare(); const address = engineSegmentOf(prepared.actions[0])!.addresses[0];
    f.engineState(address, `023e105f4ecef8ad9ca31a8372d0c399/${cfRecordId}`); f.effects(() => f.observe(['private-verification-token']));
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['unknown']);
    expect(readDnsOwnedRecords(f.ctx, f.fresh())).toEqual([]);
  });
  it('does not accept a secret or arbitrary text in a native state identity', async () => {
    const f = fixture('cloudflare'); const prepared = await f.prepare(); const address = engineSegmentOf(prepared.actions[0])!.addresses[0];
    f.engineState(address, 'private-auth-token'); f.effects(() => f.observe(['private-verification-token'], `${cfZoneId}/private-auth-token`));
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['unknown']);
    expect(JSON.stringify(readDnsOwnedRecords(f.ctx, f.fresh()))).not.toContain('private-auth-token');
  });
  it('verifies a shared authoritative TXT RRset against the complete desired value set', async () => {
    const f = fixture(); const prepared = await f.prepare([desired, { ...desired, key: 'second-verification', values: ['second-owner-token'] }]);
    const address = engineSegmentOf(prepared.actions[0])!.addresses[0]; f.engineState(address, gcpNativeId);
    f.effects(() => f.observe(['private-verification-token', 'second-owner-token']));
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['succeeded']);
    expect(readDnsOwnedRecords(f.ctx, f.fresh())).toHaveLength(2);
  });
  it('requires the approved TTL to converge rather than checking only record values', async () => {
    const f = fixture(); f.spec.dns!.ttl = 600; const prepared = await f.prepare();
    const address = engineSegmentOf(prepared.actions[0])!.addresses[0]; f.engineState(address, gcpNativeId);
    f.effects(() => f.observe(['private-verification-token'])); // Provider still reports TTL 300.
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['unknown']);
    expect(f.fresh().platformBindings.dnsEngine).toHaveProperty('attempt');
  });
  it('accepts provider-canonical CNAME target casing and the absolute-name trailing dot', async () => {
    const f = fixture();
    const first = await f.prepare([{ key: 'traffic', name, type: 'CNAME', values: ['Target.Example.NET'], ttl: 300 }]);
    const address = engineSegmentOf(first.actions[0])!.addresses[0];
    const nativeId = 'projects/dns-project/managedZones/dns-zone/rrsets/app.example.com./CNAME';
    f.engineState(address, nativeId); f.effects(() => f.observe(['target.example.net.'], nativeId, 'CNAME'));
    const result = await f.execute(first);
    expect(Object.values(result.outcomes)).toEqual(['succeeded']);
    expect(f.fresh().platformBindings.dnsEngine).not.toHaveProperty('attempt');
  });
  it('requires Cloudflare proxy state to converge to the reviewed DNS-only policy', async () => {
    const f = fixture('cloudflare'); const prepared = await f.prepare([{ key: 'traffic', name, type: 'A', values: ['192.0.2.1'], ttl: 300 }]);
    const address = engineSegmentOf(prepared.actions[0])!.addresses[0]; f.engineState(address, cfRecordId);
    f.effects(() => f.observations.set(`${name}|A`, { status: 'present', value: [{ nativeId: `${cfZoneId}/${cfRecordId}`, name, type: 'A', values: ['192.0.2.1'], ttl: 300, proxied: true }] }));
    const result = await f.execute(prepared);
    expect(Object.values(result.outcomes)).toEqual(['unknown']);
    expect(f.fresh().platformBindings.dnsEngine).toHaveProperty('attempt');
  });
  it('rejects missing engine state structure during cleanup instead of calling it empty', async () => {
    const f = fixture(); const first = await f.prepare(); const address = engineSegmentOf(first.actions[0])!.addresses[0];
    f.engineState(address, gcpNativeId); f.effects(() => f.observe(['private-verification-token'])); await f.execute(first);
    f.actionType('destroy'); const removed = await f.prepare([], 'domain', true);
    f.rawState({}); f.effects(() => { f.observations.set(`${name}|TXT`, { status: 'absent' }); });
    const result = await f.execute(removed);
    expect(Object.values(result.outcomes)).toEqual(['unknown']);
    expect(f.fresh().platformBindings.dnsEngine).toHaveProperty('attempt');
  });
});
