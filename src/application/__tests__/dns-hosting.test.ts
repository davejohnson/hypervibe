import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { environmentSpecSchema, projectSpecSchema } from '../../domain/spec/spec.schema.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { IProviderLifecycleAdapter } from '../../domain/ports/provider.port.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { planHostedDns, applyDnsPlan } from '../dns-hosting.js';
import { diffEnvironment } from '../../domain/plan/diff.engine.js';
import { parseHostingBindings } from '../../domain/ports/hosting.port.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import '../providers.js';

const dns = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn(), reconcile: vi.fn(), owned: vi.fn(() => false) }));
const absence = vi.hoisted(() => vi.fn());
vi.mock('../dns-absence.js', () => ({ verifyDnsTrafficAbsent: absence }));
vi.mock('../dns-engine.js', () => ({ prepareDnsEnginePlan: dns.prepare, executeDnsEngineSegment: dns.execute,
  executeDnsOwnershipReconciliation: dns.reconcile, hasOwnedDnsRecords: dns.owned }));
let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-dns-hosting-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  dns.prepare.mockReset(); dns.execute.mockReset(); dns.reconcile.mockReset(); dns.owned.mockReturnValue(false);
  absence.mockReset(); absence.mockResolvedValue({ ready: true, zoneFingerprint: 'exact-zone-fingerprint', connectionId: 'cf-1' });
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'dns-hosting', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 'rs-1', customDomains: ['app.example.com'] } },
    domainDns: { name: 'app.example.com', providerDomainId: 'rd-1', serviceName: 'web', serviceId: 'rs-1', environmentId: 're-1', records: [] },
  } });
  const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, domain: 'app.example.com',
    services: { web: {} }, dns: { provider: 'cloudflare', zone: { id: 'zone-1', name: 'example.com', accountId: 'account-1' } } });
  const spec = projectSpecSchema.parse({ version: 1, project: 'dns-hosting', environments: { production: environmentSpec } });
  const observed = { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', projectExists: true,
    completeness: { project: 'complete', environment: 'complete', services: 'complete' },
    services: [{ name: 'web', externalId: 'rs-1', workloadKind: 'web', status: 'running', config: {}, envVarKeys: [], envVarHashes: {}, customDomains: ['app.example.com'],
      customDomainStatus: { 'app.example.com': { providerDomainId: 'rd-1', providerVerified: false,
        dnsRecords: [{ name: 'app.example.com', type: 'DNS_RECORD_TYPE_CNAME', value: 'web.up.railway.app.', purpose: 'DNS_RECORD_PURPOSE_TRAFFIC_ROUTE' }] } } }],
    observedAt: new Date().toISOString(), databases: [], partial: false, warnings: [],
  } as ObservedState;
  const segment = { id: 'opentofu:dns-plan-1', engine: 'opentofu' as const, planDigest: 'plan-digest', configurationDigest: 'config-digest', engineVersion: '1.13.9', providerVersions: {} };
  const descriptor = { version: 1 as const, planId: 'dns-plan-1', segment,
    state: { provider: 'dns-cloudflare', projectId: project.id, environmentId: environment.id, partition: 'environment' as const },
    zone: { provider: 'cloudflare' as const, zoneId: 'zone-1', zoneName: 'example.com', scope: { accountId: 'account-1' } },
    owner: 'hosting-domain', domain: 'app.example.com', connectionId: 'cf-1', zoneFingerprint: 'zone-fingerprint', payloadEncrypted: 'encrypted' };
  const actions = [{ id: 'dns:record', type: 'create' as const, resource: { kind: 'domain' as const, name: 'app.example.com CNAME', provider: 'dns-cloudflare' },
    verified: true, reason: 'Create reviewed DNS', metadata: { operation: 'dnsEngine', engineSegment: { ...segment, addresses: ['cloudflare_dns_record.app'] } } }];
  dns.prepare.mockResolvedValue({ descriptor, actions, ready: false });
  dns.execute.mockResolvedValue({ outcomes: { 'cloudflare_dns_record.app': 'succeeded' }, diagnostics: [] });
  const adapter = { name: 'railway', observe: vi.fn(async () => observed) } as unknown as IProviderLifecycleAdapter;
  vi.spyOn(ctx.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  return { ctx, project, environment, spec, observed, descriptor, actions };
}

function cancelFixture() {
  const f = fixture();
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: {
    ...parseHostingBindings(f.environment).domainDns, dnsStagePending: true, dnsSelection: f.spec.environments.production!.dns,
  } });
  f.spec.environments.production = environmentSpecSchema.parse({ ...f.spec.environments.production, domain: undefined, dns: undefined });
  const current = f.ctx.repos.environments.findById(f.environment.id)!;
  const actions = diffEnvironment({ spec: f.spec.environments.production, envName: 'production', observed: f.observed,
    local: { projectExists: true, environmentExists: true, services: [], components: [], bindings: parseHostingBindings(current) },
    customDomainManagement: 'managed' }).actions.filter(action => action.resource.kind === 'domain');
  return { ...f, actions };
}

function applyOrdinaryPlan(f: Pick<ReturnType<typeof fixture>, 'ctx' | 'project' | 'environment' | 'spec' | 'observed'>, actions: PlanAction[]) {
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: f.observed, warnings: [] });
  const plan = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan',
    plan: { kind: 'hv_plan', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions } });
  return executePlanApply(f.ctx, { ...f, specRevision: 1, planId: plan.id, confirmActions: actions.map(action => action.id) });
}

describe('hosting DNS saved-plan boundary', () => {
  it('persists the exact prepared segment from a fresh native hosting attachment', async () => {
    const f = fixture();
    const planned = await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 });
    expect(planned && !('blocked' in planned)).toBe(true);
    if (!planned || 'blocked' in planned) throw Error('Expected DNS plan');
    const saved = new ConvergeExecutor().loadPlan(planned.planRunId);
    expect(saved).not.toHaveProperty('error');
    expect(saved).toMatchObject({ document: { scope: 'dns-engine', dns: { descriptor: f.descriptor } } });
    expect(dns.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'hosting-domain', records: [expect.objectContaining({
      name: 'app.example.com', type: 'CNAME', values: ['web.up.railway.app'], ttl: 300,
    })] }));
    expect(dns.execute).not.toHaveBeenCalled();
  });

  it('rejects a same-name service with a different native hosting identity before engine planning', async () => {
    const f = fixture();
    f.observed.services[0]!.externalId = 'different-service';
    expect(await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 })).toHaveProperty('blocked');
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it('executes the saved segment once without preparing a new plan inside apply', async () => {
    const f = fixture();
    const planned = await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 });
    if (!planned || 'blocked' in planned) throw Error('Expected DNS plan');
    dns.prepare.mockClear();
    const applied = await applyDnsPlan(f.ctx, { ...f, specRevision: 1, planId: planned.planRunId, confirmActions: [] });
    expect(applied).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(dns.execute).toHaveBeenCalledOnce();
    expect(dns.execute).toHaveBeenCalledWith(expect.objectContaining({ descriptor: f.descriptor }));
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it('blocks DNS apply when the exact hosting attachment requirements change after review', async () => {
    const f = fixture();
    const planned = await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 });
    if (!planned || 'blocked' in planned) throw Error('Expected DNS plan');
    f.observed.services[0]!.customDomainStatus!['app.example.com']!.dnsRecords![0]!.value = 'different.up.railway.app';
    expect(await applyDnsPlan(f.ctx, { ...f, specRevision: 1, planId: planned.planRunId, confirmActions: [] })).toHaveProperty('kind', 'blocked');
    expect(dns.execute).not.toHaveBeenCalled();
  });

  it('dispatches an explicit ownership reconciliation without running or replanning infrastructure', async () => {
    const f = fixture();
    dns.prepare.mockResolvedValue({ descriptor: f.descriptor, ready: false, actions: [{
      id: 'dns-reconcile:hosting-domain', type: 'update', verified: true,
      resource: { kind: 'domain', name: 'app.example.com', provider: 'dns-cloudflare' },
      reason: 'Observe native absence and reconcile local ownership', metadata: { operation: 'dnsOwnershipReconcile' },
    }] });
    dns.reconcile.mockResolvedValue({ success: true, message: 'Fresh DNS evidence reconciled' });
    const planned = await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 });
    if (!planned || 'blocked' in planned) throw Error('Expected DNS reconciliation plan');
    dns.prepare.mockClear();
    expect(await applyDnsPlan(f.ctx, { ...f, specRevision: 1, planId: planned.planRunId, confirmActions: [] }))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    expect(dns.reconcile).toHaveBeenCalledOnce();
    expect(dns.reconcile).toHaveBeenCalledWith(expect.objectContaining({ descriptor: f.descriptor }));
    expect(dns.execute).not.toHaveBeenCalled();
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it('preserves readiness uncertainty without reattaching an already owned domain', async () => {
    const f = fixture();
    dns.prepare.mockResolvedValue({ descriptor: f.descriptor, actions: [], ready: true });
    const actions = [{ id: 'domain:app.example.com', type: 'update' as const, resource: { kind: 'domain' as const, name: 'app.example.com', provider: 'railway' }, reason: 'pending', verified: true }];
    expect(await planHostedDns(f.ctx, { ...f, actions, environmentName: 'production', specRevision: 1 })).toBeNull();
    expect(actions[0]).toMatchObject({ type: 'update', metadata: { operation: 'domainDnsReady', dnsEngineReady: true } });
    expect(dns.execute).not.toHaveBeenCalled();
  });

  it('plans cancellation of a fresh attachment only after exact traffic DNS absence', async () => {
    const f = fixture();
    const selection = f.spec.environments.production!.dns;
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: {
      ...parseHostingBindings(f.environment).domainDns, dnsStagePending: true, dnsSelection: selection,
    } });
    f.spec.environments.production = environmentSpecSchema.parse({ ...f.spec.environments.production, domain: undefined, dns: undefined });
    const environment = f.ctx.repos.environments.findById(f.environment.id)!;
    const actions = diffEnvironment({ spec: f.spec.environments.production, envName: 'production', observed: f.observed,
      local: { projectExists: true, environmentExists: true, services: [], components: [], bindings: parseHostingBindings(environment) },
      customDomainManagement: 'managed' }).actions.filter(action => action.resource.kind === 'domain');
    expect(await planHostedDns(f.ctx, { ...f, actions, environmentName: 'production', specRevision: 1 })).toBeNull();
    expect(actions[0]).toMatchObject({ type: 'destroy', requiresConfirm: true,
      metadata: { dnsCancellationVerified: true, dnsCancellationProof: { zoneFingerprint: 'exact-zone-fingerprint', connectionId: 'cf-1' } } });
    expect(actions[0]?.metadata).not.toHaveProperty('blockedReason');
    expect(absence).toHaveBeenCalledWith(expect.objectContaining({ domain: 'app.example.com',
      zone: { provider: 'cloudflare', zoneId: 'zone-1', zoneName: 'example.com', scope: { accountId: 'account-1' } } }));
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it.each(['Traffic DNS remains at this hostname.', 'DNS absence is unknown.'])('preserves a cancelled fresh claim when %s', async reason => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: {
      ...parseHostingBindings(f.environment).domainDns, dnsStagePending: true, dnsSelection: f.spec.environments.production!.dns,
    } });
    f.spec.environments.production = environmentSpecSchema.parse({ ...f.spec.environments.production, domain: undefined, dns: undefined });
    absence.mockResolvedValue({ ready: false, reason });
    expect(await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 })).toEqual({ blocked: [reason] });
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it.each([true, false])('rechecks absence immediately before applying a reviewed cancellation (absent=%s)', async ready => {
    const f = cancelFixture();
    const detachCustomDomain = vi.fn(async () => ({ success: true, message: 'Exact native domain removed' }));
    vi.mocked(f.ctx.adapterFactory.getProviderAdapter).mockResolvedValue({ success: true,
      adapter: { name: 'railway', observe: async () => f.observed, detachCustomDomain } as unknown as IProviderLifecycleAdapter });
    expect(await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 })).toBeNull();
    absence.mockClear();
    absence.mockResolvedValue(ready ? { ready: true, zoneFingerprint: 'exact-zone-fingerprint', connectionId: 'cf-1' }
      : { ready: false, reason: 'Traffic DNS appeared after review; preserve the claim.' });
    await applyOrdinaryPlan(f, f.actions);
    expect(absence).toHaveBeenCalledWith(expect.objectContaining({ expected: { zoneFingerprint: 'exact-zone-fingerprint', connectionId: 'cf-1' } }));
    if (ready) {
      expect(detachCustomDomain).toHaveBeenCalledWith({ projectId: 'rp-1', environmentId: 're-1', serviceId: 'rs-1',
        domain: 'app.example.com', customDomainId: 'rd-1' });
      expect(parseHostingBindings(f.ctx.repos.environments.findById(f.environment.id)).domainDns).toBeUndefined();
    } else {
      expect(detachCustomDomain).not.toHaveBeenCalled();
      expect(parseHostingBindings(f.ctx.repos.environments.findById(f.environment.id)).domainDns?.providerDomainId).toBe('rd-1');
    }
    expect(dns.prepare).not.toHaveBeenCalled();
    expect(dns.execute).not.toHaveBeenCalled();
  });

  it('retains the selected DNS scope with a fresh attachment before DNS planning', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: undefined });
    f.observed.services[0]!.customDomains = [];
    f.observed.services[0]!.customDomainStatus = {};
    f.spec.environments.production!.dns!.connectionScope = 'repo:example/app';
    const attachCustomDomain = vi.fn(async () => ({ success: true, message: 'Native attachment created',
      data: { customDomainId: 'rd-new', providerVerified: false, dnsRecords: [] } }));
    vi.mocked(f.ctx.adapterFactory.getProviderAdapter).mockResolvedValue({ success: true,
      adapter: { name: 'railway', observe: async () => f.observed, attachCustomDomain } as unknown as IProviderLifecycleAdapter });
    await applyOrdinaryPlan(f, [{ id: 'domain:app.example.com', type: 'create', verified: true,
      resource: { kind: 'domain', name: 'app.example.com', provider: 'railway' }, reason: 'Attach the requested domain' }]);
    expect(attachCustomDomain).toHaveBeenCalledOnce();
    expect(parseHostingBindings(f.ctx.repos.environments.findById(f.environment.id)).domainDns).toMatchObject({
      providerDomainId: 'rd-new', dnsStagePending: true, records: [], dnsSelection: {
        provider: 'cloudflare', zone: { id: 'zone-1', name: 'example.com', accountId: 'account-1' }, connectionScope: 'repo:example/app',
      },
    });
    expect(dns.prepare).not.toHaveBeenCalled();
  });

  it('does not infer cancellation authority from an old incomplete DNS binding', async () => {
    const f = fixture();
    f.spec.environments.production = environmentSpecSchema.parse({ ...f.spec.environments.production, domain: undefined, dns: undefined });
    expect(await planHostedDns(f.ctx, { ...f, environmentName: 'production', specRevision: 1 })).toBeNull();
    expect(absence).not.toHaveBeenCalled();
    expect(dns.prepare).not.toHaveBeenCalled();
  });
});
