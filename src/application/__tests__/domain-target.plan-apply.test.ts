import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import * as domainSecurity from '../../domain/services/domain-security.service.js';
import { setupCustomDomain } from '../../domain/services/domain.service.js';
import type { ObservedState } from '../../domain/ports/observe.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import '../providers.js';

// Synthetic shared-provider contract: the reviewed environment has one public
// web workload. The reported staging counterexample bound cron, worker, then
// web, and attached the hostname to cron. Provider transport/identity evidence
// is covered separately by the Railway HTTP contract suite.
const hostname = 'app.example.com';
const desiredServices = {
  cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 * * * *', public: false },
  worker: { workloadKind: 'worker', public: false },
  web: {}, // The schema's web/public defaults remain supported.
};
const oldDomain = {
  name: hostname, proxied: false, providerDomainId: 'domain-cron',
  serviceName: 'cron', serviceId: 'service-cron', environmentId: 'staging-id',
  zoneId: 'zone-id',
  records: [{ id: 'dns-old', name: hostname, type: 'CNAME', target: 'cron.example.net' }],
};

describe('custom domain desired service plan/apply boundary', () => {
  let dir: string;
  let ctx: CommandContext;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hv-domain-target-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
    ctx = createCommandContext();
    vi.spyOn(domainSecurity, 'inspectDomainSecurity').mockResolvedValue(undefined);
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(options: { services?: Record<string, unknown>; owner?: string; boundDomain?: boolean; order?: string[]; recreateRevision?: string } = {}) {
    const project = ctx.repos.projects.create({ name: 'domain-target', defaultPlatform: 'railway' });
    const spec = new SpecStore().replace(project, {
      version: 1, project: project.name,
      environments: { staging: { hosting: { provider: 'railway' }, envFile: { mode: 'off' },
        services: options.services ?? desiredServices, domain: hostname, domainProxy: false,
        ...(options.recreateRevision ? { domainRecreateRevision: options.recreateRevision } : {}) } },
    });
    const order = options.order ?? ['cron', 'worker', 'web'];
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId: 'project-id', environmentId: 'staging-id',
      services: Object.fromEntries(order.map(name => [name, { serviceId: `service-${name}`,
        ...(name === options.owner ? { customDomains: [hostname] } : {}) }])),
      ...(options.boundDomain ? { domainDns: oldDomain } : {}),
    } });
    const observed: ObservedState = {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'project-id', environmentId: 'staging-id', partial: false, warnings: [], databases: [],
      completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      services: order.map(name => ({ name, externalId: `service-${name}`,
        workloadKind: name === 'cron' ? 'cron' : name === 'worker' ? 'worker' : 'web',
        config: spec.spec.environments.staging!.services[name] ?? {}, envVarKeys: [], envVarHashes: {}, status: 'running', sourceState: 'disconnected',
        customDomains: name === options.owner ? [hostname] : [],
        ...(name === options.owner ? { customDomainStatus: { [hostname]: {
          providerDomainId: `domain-${name}`, providerVerified: true, dnsConfigured: true,
        } } } : {}),
      })),
    };
    for (const [name, buildConfig] of Object.entries(spec.spec.environments.staging!.services)) {
      ctx.repos.services.create({ projectId: project.id, name, buildConfig });
    }
    const attach = vi.fn(async () => ({ success: true, message: 'Attached', data: {
      customDomainId: 'domain-web', providerVerified: false, dnsRecords: [{
        name: hostname, type: 'CNAME', value: 'web.example.net', purpose: 'traffic-route',
      }],
    } }));
    const detach = vi.fn(async () => {
      for (const service of observed.services) { service.customDomains = []; service.customDomainStatus = {}; }
      return { success: true, message: 'Exact attachment absent', data: { customDomainId: 'domain-cron' } };
    });
    const adapter = { name: 'railway', capabilities: { supportsObserve: true },
      observe: vi.fn(async () => observed), attachCustomDomain: attach, detachCustomDomain: detach,
      recreateCustomDomain: vi.fn(attach) };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: adapter as never });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async () => ({ observed, warnings: [] }));
    const connection = ctx.repos.connections.create({ provider: 'cloudflare', scope: 'example.com',
      credentialsEncrypted: ctx.secretStore.encryptObject({ apiToken: 'synthetic-cloudflare-key' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => {});
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-id', name: 'example.com', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    const deleteDns = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord').mockResolvedValue({ id: 'dns-old' });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([{
      id: 'dns-old', name: hostname, type: 'CNAME', content: 'cron.example.net',
    } as never]);
    const upsertDns = vi.spyOn(CloudflareAdapter.prototype, 'upsertDnsRecord').mockResolvedValue({
      action: 'created', record: { id: 'dns-new', name: hostname, type: 'CNAME', content: 'web.example.net' } as never,
    });
    const plan = async () => {
      const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
      if ('error' in result) throw new Error(result.error);
      const action = result.actions.find(candidate => candidate.id === `domain:${hostname}`);
      if (!action) throw new Error(`Planner did not emit the domain action: ${result.actions.map(candidate => candidate.id).join(', ')}`);
      return { result, action };
    };
    // Isolate the actual planner-produced domain action so unrelated workload
    // provisioning cannot conceal its mutation authority or failure receipt.
    const apply = async (action: PlanAction, confirm = true) => {
      const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
        kind: 'hv_plan', environmentName: 'staging', specRevision: spec.revision, observedFingerprint: null,
        actions: [{ ...action, dependsOn: undefined }],
      } });
      return executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision,
        planId: run.id, confirmActions: confirm ? [action.id] : [] });
    };
    return { project, environment, spec, observed, attach, detach, deleteDns, upsertDns, plan, apply, adapter };
  }

  it.each([['cron', 'worker', 'web'], ['worker', 'web', 'cron'], ['web', 'cron', 'worker']])(
    'pins and applies the desired public web service with binding order %j', async (...order) => {
      const f = fixture({ order });
      const { action } = await f.plan();
      expect(action.metadata).toMatchObject({ serviceName: 'web', serviceId: 'service-web',
        projectId: 'project-id', environmentId: 'staging-id' });
      await f.apply(action);
      expect(f.attach).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-id', environmentId: 'staging-id',
        serviceId: 'service-web', domain: hostname, dnsZone: 'example.com' });
    });

  it('rejects direct setup without an explicit reviewed service instead of selecting the first binding', async () => {
    const f = fixture();
    const result = await setupCustomDomain({ project: f.project, environment: f.environment, domain: hostname });
    expect(result.success).toBe(false);
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.upsertDns).not.toHaveBeenCalled();
  });

  it('never adopts a verified attachment on a bound worker when desired public service is web', async () => {
    const f = fixture({ owner: 'worker' });
    const { action } = await f.plan();
    expect(action.type).not.toBe('noop');
    expect(action.metadata?.operation).not.toBe('customDomainAdopt');
    expect(action.metadata?.blockedReason).toBeTruthy();
  });

  it('plans confirmation-gated retarget with exact old ownership and desired new web identity', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    expect(action).toMatchObject({ type: 'replace', requiresConfirm: true, metadata: {
      operation: 'customDomainRetarget', projectId: 'project-id', environmentId: 'staging-id',
      serviceName: 'web', serviceId: 'service-web', previousDomain: oldDomain,
    } });
  });

  it.each([
    { worker: { workloadKind: 'worker', public: true } },
    { web: { public: false } },
    { web: {}, api: {} },
  ])('blocks a domain with no unique public web selection: %j', async services => {
    const f = fixture({ services });
    const { action } = await f.plan();
    expect(action.metadata?.blockedReason).toBeTruthy();
    await f.apply(action);
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
  });

  it('rejects changed bound target identity before any provider mutation', async () => {
    const f = fixture();
    const { action } = await f.plan();
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {
      cron: { serviceId: 'service-cron' }, worker: { serviceId: 'service-worker' }, web: { serviceId: 'replacement-web' },
    } });
    const result = await f.apply(action);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.upsertDns).not.toHaveBeenCalled();
  });

  it('requires confirmation before retarget, then removes only the old attachment and retains pending new identity', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    expect(action.type).toBe('replace');
    await f.apply(action, false);
    expect(f.detach).not.toHaveBeenCalled();
    await f.apply(action);
    expect(f.detach).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-id', environmentId: 'staging-id',
      serviceId: 'service-cron', domain: hostname, customDomainId: 'domain-cron' });
    expect(f.deleteDns).toHaveBeenCalledExactlyOnceWith('zone-id', 'dns-old');
    expect(f.attach).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-id', environmentId: 'staging-id',
      serviceId: 'service-web', domain: hostname, dnsZone: 'example.com' });
    expect(f.detach.mock.invocationCallOrder[0]).toBeLessThan(f.deleteDns.mock.invocationCallOrder[0]!);
    expect(f.deleteDns.mock.invocationCallOrder[0]).toBeLessThan(f.attach.mock.invocationCallOrder[0]!);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings).toMatchObject({ domainDns: {
      name: hostname, providerDomainId: 'domain-web', serviceName: 'web', serviceId: 'service-web',
      environmentId: 'staging-id', zoneId: 'zone-id', records: [{ id: 'dns-new' }],
    }, services: { cron: { customDomains: [] }, web: { customDomains: [hostname] } } });
  });

  it.each(['old-domain-id', 'new-service-id', 'unknown-services', 'old-dns-content'])('blocks stale retarget %s before deletion', async drift => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    expect(action.type).toBe('replace');
    if (drift === 'old-domain-id') f.observed.services[0]!.customDomainStatus![hostname]!.providerDomainId = 'replacement-domain';
    if (drift === 'new-service-id') f.observed.services.find(service => service.name === 'web')!.externalId = 'replacement-web';
    if (drift === 'unknown-services') f.observed.completeness!.services = 'unknown';
    if (drift === 'old-dns-content') ctx.repos.environments.updatePlatformBindings(f.environment.id, {
      domainDns: { ...oldDomain, records: [{ ...oldDomain.records[0], target: 'different.example.net' }] },
    });
    await f.apply(action);
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.deleteDns).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('preserves old recovery binding on partial teardown and never attaches the new target', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    expect(action.type).toBe('replace');
    f.deleteDns.mockRejectedValueOnce(new Error('Synthetic DNS deletion failure'));
    await f.apply(action);
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.attach).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toEqual(oldDomain);
  });

  it('replans ordinary attach after cleanup succeeds but the new attachment fails', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    expect(action.type).toBe('replace');
    f.attach.mockResolvedValueOnce({ success: false, message: 'Synthetic attach failure' } as never);
    await f.apply(action);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toBeUndefined();
    const retry = await f.plan();
    expect(retry.action.type).toBe('update');
    expect(retry.action.metadata?.operation).not.toBe('customDomainRetarget');
    await f.apply(retry.action);
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(2);
  });

  it('recovers after the first DNS delete succeeds and the second fails without deleting the provider attachment twice', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const previousDomain = { ...oldDomain, records: [...oldDomain.records,
      { id: 'dns-txt', name: '_verify.app.example.com', type: 'TXT', target: 'old-verification' }] };
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: previousDomain });
    const remainingRecords = previousDomain.records.map(record => ({ ...record, content: record.target }));
    vi.mocked(CloudflareAdapter.prototype.listDnsRecords).mockImplementation(async (_zone, type) =>
      remainingRecords.filter(record => record.type === type) as never);
    let providerDeletes = 0;
    f.detach.mockImplementation(async () => {
      const oldOwner = f.observed.services[0]!;
      if (oldOwner.customDomains.includes(hostname)) providerDeletes += 1;
      oldOwner.customDomains = []; oldOwner.customDomainStatus = {};
      return { success: true, message: 'Exact attachment absent', data: { customDomainId: 'domain-cron' } };
    });
    let failedOnce = false;
    f.deleteDns.mockImplementation(async (_zone, id) => {
      if (id === 'dns-txt' && !failedOnce) { failedOnce = true; throw new Error('Synthetic second DNS failure'); }
      remainingRecords.splice(remainingRecords.findIndex(record => record.id === id), 1);
      return { id };
    });
    const { action } = await f.plan();
    await f.apply(action);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toEqual(previousDomain);
    expect(f.attach).not.toHaveBeenCalled();
    const retry = await f.plan();
    expect(retry.action).toMatchObject({ type: 'replace', requiresConfirm: true,
      metadata: { operation: 'customDomainRetarget', previousDomain } });
    await f.apply(retry.action);
    expect(providerDeletes).toBe(1);
    expect(f.deleteDns.mock.calls.map(call => call[1])).toEqual(['dns-old', 'dns-txt', 'dns-txt']);
    expect(f.attach).toHaveBeenCalledTimes(1);
  });

  it('retains a new attachment and first DNS receipt when its second DNS write fails', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    f.attach.mockResolvedValueOnce({ success: true, message: 'Attached', data: {
      customDomainId: 'domain-web', providerVerified: false, dnsRecords: [
        { name: hostname, type: 'CNAME', value: 'web.example.net', purpose: 'traffic-route' },
        { name: '_verify.app.example.com', type: 'TXT', value: 'new-verification', purpose: 'verification' },
      ],
    } });
    f.upsertDns.mockResolvedValueOnce({ action: 'created', record: { id: 'dns-new', name: hostname } as never })
      .mockRejectedValueOnce(new Error('Synthetic second write failure'));
    const { action } = await f.plan();
    await f.apply(action);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toMatchObject({
      serviceName: 'web', serviceId: 'service-web', providerDomainId: 'domain-web',
      records: [{ id: 'dns-new', name: hostname, type: 'CNAME', target: 'web.example.net' }],
    });
    const web = f.observed.services.find(service => service.name === 'web')!;
    web.customDomains = [hostname]; web.customDomainStatus = { [hostname]: {
      providerDomainId: 'domain-web', providerVerified: false, dnsConfigured: false,
    } };
    f.upsertDns.mockRejectedValue(new Error('Synthetic retry fails before any new DNS receipt'));
    const retry = await f.plan();
    await f.apply(retry.action);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toMatchObject({
      providerDomainId: 'domain-web', records: [{ id: 'dns-new', name: hostname, type: 'CNAME', target: 'web.example.net' }],
    });
  });

  it('retains a validated creation acknowledgement and waits for the same observed ID before retrying', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    f.attach.mockResolvedValueOnce({ success: false, message: 'Create acknowledged; exact readback unavailable', data: {
      phase: 'customDomainCreateVerification', creationAcknowledged: true, customDomainId: 'domain-web',
      projectId: 'project-id', environmentId: 'staging-id', serviceId: 'service-web', domain: hostname,
    } } as never);
    const { action } = await f.plan();
    await f.apply(action);
    const pendingBindings = ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(pendingBindings.domainDns).toMatchObject({ name: hostname, providerDomainId: 'domain-web',
      serviceName: 'web', serviceId: 'service-web', environmentId: 'staging-id', creationAcknowledged: true, records: [] });
    expect(pendingBindings.services).toMatchObject({ web: { serviceId: 'service-web' } });
    expect((pendingBindings.services as Record<string, { customDomains?: string[] }>).web?.customDomains).toBeUndefined();
    const retry = await f.plan();
    expect(retry.action.metadata?.blockedReason).toBeTruthy();
    await f.apply({ ...retry.action, metadata: { ...retry.action.metadata, blockedReason: undefined } });
    expect(f.attach).toHaveBeenCalledTimes(1);
    const web = f.observed.services.find(service => service.name === 'web')!;
    web.customDomains = [hostname]; web.customDomainStatus = { [hostname]: {
      providerDomainId: 'different-domain', providerVerified: false, dnsConfigured: false,
    } };
    await f.apply({ ...retry.action, metadata: { ...retry.action.metadata, blockedReason: undefined } });
    expect(f.attach).toHaveBeenCalledTimes(1);
    web.customDomainStatus[hostname]!.providerDomainId = 'domain-web';
    const resume = await f.plan();
    await f.apply(resume.action);
    expect(f.attach).toHaveBeenCalledTimes(2);
    expect(f.attach).toHaveBeenLastCalledWith({ projectId: 'project-id', environmentId: 'staging-id',
      serviceId: 'service-web', domain: hostname, dnsZone: 'example.com', customDomainId: 'domain-web' });
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).not.toHaveProperty('creationAcknowledged');
  });

  it('blocks a forged or stale retarget when its provider capability is unsupported', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    const getMetadata = providerRegistry.getMetadata.bind(providerRegistry);
    vi.spyOn(providerRegistry, 'getMetadata').mockImplementation(provider => {
      const metadata = getMetadata(provider);
      return metadata?.lifecycle?.hosting ? { ...metadata, lifecycle: { ...metadata.lifecycle,
        hosting: { ...metadata.lifecycle.hosting, customDomainRetarget: 'unsupported' },
      } } : metadata;
    });
    const blocked = await f.plan();
    expect(blocked.action.metadata?.blockedReason).toBe('domain_retarget_unsupported');
    await f.apply(action);
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.deleteDns).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('never adopts a replacement provider-domain ID on the same desired service', async () => {
    const f = fixture({ owner: 'web' });
    const binding = { ...oldDomain, serviceName: 'web', serviceId: 'service-web', providerDomainId: 'domain-web-original' };
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: binding });
    const { action } = await f.plan();
    expect(action.type).not.toBe('noop');
    expect(action.metadata?.blockedReason).toBeTruthy();
    await f.apply({ ...action, metadata: { ...action.metadata, blockedReason: undefined } });
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.upsertDns).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toEqual(binding);
  });

  it('does not move previously recorded DNS IDs into a replacement Cloudflare zone', async () => {
    const f = fixture({ owner: 'web' });
    const binding = { ...oldDomain, serviceName: 'web', serviceId: 'service-web', providerDomainId: 'domain-web' };
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: binding });
    f.observed.services.find(service => service.name === 'web')!.customDomainStatus![hostname]!.providerVerified = false;
    vi.mocked(CloudflareAdapter.prototype.findZoneByName).mockResolvedValue({
      id: 'replacement-zone', name: 'example.com', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    const { action } = await f.plan();
    await f.apply(action);
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.upsertDns).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.domainDns).toEqual(binding);
  });

  it('resumes an outstanding same-service recreation after exact attachment absence without adopting a replacement', async () => {
    const f = fixture({ recreateRevision: 'same-service-repair' });
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { domainDns: {
      ...oldDomain, serviceName: 'web', serviceId: 'service-web', providerDomainId: 'domain-web-original',
    } });
    const { action } = await f.plan();
    expect(action).toMatchObject({ type: 'replace', requiresConfirm: true });
    expect(action.metadata?.operation).not.toBe('customDomainRetarget');
    await f.apply(action);
    expect(f.adapter.recreateCustomDomain).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-id', environmentId: 'staging-id',
      serviceId: 'service-web', domain: hostname, dnsZone: 'example.com', customDomainId: 'domain-web-original' });
    expect(f.detach).not.toHaveBeenCalled();
  });

  it.each([{ type: 'update' }, { requiresConfirm: false }])('rejects tampered retarget authority %j', async tamper => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    const { action } = await f.plan();
    await f.apply({ ...action, ...tamper } as PlanAction);
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.deleteDns).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('keeps initial service creation actionable while a new domain waits for an exact binding', async () => {
    const f = fixture();
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {} });
    f.observed.services = [];
    const { result, action } = await f.plan();
    expect(result.actions.find(candidate => candidate.id === 'service:web')).toMatchObject({ type: 'create' });
    expect(action.dependsOn).toContain('service:web');
    expect(action.metadata?.serviceName).toBe('web');
    await f.apply(action);
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('allows a missing destination service to be created before replanning a retained old attachment', async () => {
    const f = fixture({ owner: 'cron', boundDomain: true });
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {
      cron: { serviceId: 'service-cron', customDomains: [hostname] }, worker: { serviceId: 'service-worker' },
    } });
    f.observed.services = f.observed.services.filter(service => service.name !== 'web');
    const { result, action } = await f.plan();
    expect(result.actions.find(candidate => candidate.id === 'service:web')).toMatchObject({ type: 'create' });
    expect(action.metadata?.blockedReason).toBeUndefined();
    expect(action.dependsOn).toContain('service:web');
    await f.apply(action);
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('admits retarget only for explicitly reviewed hosting provider contracts', () => {
    const hosting = providerRegistry.all().map(provider => provider.metadata).filter(provider => provider.lifecycle?.hosting);
    expect(Object.fromEntries(hosting.map(provider => [provider.name, provider.lifecycle!.hosting!.customDomainRetarget])))
      .toEqual({ railway: 'managed', cloudrun: 'unsupported', digitalocean: 'unsupported',
        vercel: 'unsupported', fly: 'unsupported', 'azure-container-apps': 'unsupported', ecs: 'unsupported' });
  });
});
