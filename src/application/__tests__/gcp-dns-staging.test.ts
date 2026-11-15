import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { applyInfrastructureEngine, planInfrastructureEngine, verifyGcpDnsSource } from '../infrastructure-engine.js';
import * as dns from '../dns-engine.js';
import * as absence from '../dns-absence.js';
import { domainEngineKey } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance(); directory = mkdtempSync(path.join(tmpdir(), 'hv-gcp-dns-stages-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture(options: { owned?: boolean; mapping?: boolean; remove?: boolean } = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'gcp-dns-stages', defaultPlatform: 'cloudrun' });
  project.gitRemoteUrl = 'https://github.com/example/dns-stages';
  const identity = { provider: 'aws' as const, zoneId: 'Z123456', zoneName: 'example.com', scope: { accountId: '123456789012' } };
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    engine: { kind: 'opentofu', ...(options.remove ? { domains: ['app.example.com'] } : {}) },
    services: { web: { serviceId: 'native-web-staging' } },
    ...(options.remove ? { dnsEngine: { version: 1, zone: identity, domain: 'app.example.com', ownedOwners: ['gcp-domain'],
      recordsEncrypted: ctx.secretStore.encryptObject([]), ownersEncrypted: ctx.secretStore.encryptObject({}),
      configurationEncrypted: ctx.secretStore.encryptObject({}), zoneFingerprint: 'observed-zone' } } : {}),
  } });
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', scope: 'example/dns-stages', credentialsEncrypted: ctx.secretStore.encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'synthetic-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: {
    hosting: { provider: 'cloudrun', region: 'us-central1' }, services: { web: {} },
    ...(!options.remove ? { domain: 'app.example.com', dns: { provider: 'aws', zone: { id: identity.zoneId, name: identity.zoneName, accountId: identity.scope.accountId } } } : {}),
  } } });
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('synthetic-engine-token');
  vi.spyOn(CloudRunAdapter.prototype, 'siteVerificationAccessToken').mockResolvedValue('synthetic-verification-token');
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  const segment = { id: 'saved-dns-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { aws: '6.44.0' } };
  const prepare = vi.spyOn(dns, 'prepareDnsEnginePlan').mockImplementation(async input => ({ ready: false,
    actions: [{ id: 'dns:fixture', type: input.remove ? 'destroy' : 'create', verified: true,
      resource: { kind: 'domain', name: input.domain, provider: `dns-${identity.provider}` }, reason: 'Exact reviewed DNS stage',
      ...(input.remove ? { requiresConfirm: true, dataBearing: true } : {}),
      metadata: { operation: 'dnsEngine', engineSegment: { ...segment, addresses: ['aws_route53_record.fixture'] } } }],
    descriptor: { version: 1, planId: 'saved-dns-plan', segment, zone: identity,
      state: { provider: 'dns-aws', projectId: project.id, environmentId: environment.id, partition: 'environment' },
      owner: input.owner, domain: input.domain, connectionId: 'aws-connection', zoneFingerprint: 'observed-zone', payloadEncrypted: 'encrypted' },
  }));
  const engine = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => {
    const hostingSegment = { ...segment, id: 'saved-hosting-segment', providerVersions: { google: '8.9.0' } };
    return { ok: true, segmentId: hostingSegment.id, segment: hostingSegment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
      actions: Object.entries(configuration.resources).map(([address, resource]) => ({ id: resource.actionId, type: 'create',
        resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'Native hosting claim',
        metadata: { engineSegment: { ...hostingSegment, addresses: [address] } } })),
    };
  });
  const mapping = { metadata: { name: 'app.example.com', namespace: '123456789', uid: 'native-mapping-uid', generation: 1 },
    spec: { routeName: 'native-web-staging' }, status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'False' }],
      resourceRecords: [{ name: 'app', type: 'CNAME', rrdata: 'provider-returned.example.net.' }] } };
  const inspect = vi.spyOn(OpenTofuEngine.prototype, 'inspectState').mockImplementation(async params => ({ ok: true, present: true,
    value: params.project({ format_version: '1.0', values: { root_module: { resources: [{
      mode: 'managed', address: `google_cloud_run_domain_mapping.${domainEngineKey('app.example.com')}`,
      type: 'google_cloud_run_domain_mapping', values: { id: 'locations/us-central1/namespaces/demo-project/domainmappings/app.example.com',
        name: 'app.example.com', project: 'demo-project', location: 'us-central1', metadata: [{ namespace: 'demo-project', uid: 'native-mapping-uid' }], spec: [{ route_name: 'native-web-staging' }] },
    }] } } }),
  }));
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/webResource')) return Response.json({ items: options.owned ? [{ id: 'dns://example.com',
      site: { type: 'INET_DOMAIN', identifier: 'example.com' }, owners: ['deploy@demo-project.iam.gserviceaccount.com'] }] : [] });
    if (url.endsWith('/token')) return Response.json({ token: 'google-site-verification=staged-fixture', method: 'DNS_TXT' });
    if (init?.method && init.method !== 'GET') throw Error('Planning must not mutate provider infrastructure');
    if (url.includes('/domainmappings/')) return options.mapping ? Response.json(mapping) : new Response('', { status: 404 });
    if (url.includes('/secrets?')) return Response.json({ secrets: [] });
    return new Response('', { status: 404 });
  }));
  return { ctx, project, environment, spec, prepare, engine, inspect, requests, mapping };
}

describe('Google hosting and DNS stage composition', () => {
  it('finishes cancellation explicitly when the mapping never reached the provider', async () => {
    const f = fixture({ owned: true, mapping: false, remove: true });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { dnsEngine: undefined,
      engine: { kind: 'opentofu', domains: ['app.example.com'], domainClaims: { 'app.example.com': {
        zone: { provider: 'aws', zoneId: 'Z123456', zoneName: 'example.com', scope: { accountId: '123456789012' } },
      } } } });
    vi.spyOn(absence, 'verifyDnsTrafficAbsent').mockResolvedValue({ ready: true, zoneFingerprint: 'exact-zone', connectionId: 'saved-dns' });
    f.engine.mockResolvedValue({ ok: true, segment: { id: 'empty', engine: 'opentofu', planDigest: 'empty', configurationDigest: 'empty', engineVersion: '1.13.9', providerVersions: {} },
      segmentId: 'empty', planFile: '/unused', actions: [], blockers: [], unmanagedDeletes: [] });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked');
    if ('blocked' in result) throw Error(result.blocked.join(' '));
    expect(result.actions).toEqual([expect.objectContaining({ type: 'update', metadata: expect.objectContaining({ operation: 'gcpDomainForget', domain: 'app.example.com' }) })]);
    const apply = vi.spyOn(OpenTofuEngine.prototype, 'apply');
    expect(await applyInfrastructureEngine(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: result.planRunId, confirmActions: [] })).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(apply).not.toHaveBeenCalled();
    expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings.engine).toMatchObject({ domains: [], domainClaims: {} });
  });
  it('blocks traffic DNS for an unowned same-service mapping', async () => {
    const f = fixture({ owned: true, mapping: true }); f.inspect.mockResolvedValue({ ok: true, present: false });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).toHaveProperty('blocked'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('can cancel an attempted mapping before DNS starts after fresh traffic absence', async () => {
    const f = fixture({ owned: true, mapping: true, remove: true });
    const zone = { provider: 'aws' as const, zoneId: 'Z123456', zoneName: 'example.com', scope: { accountId: '123456789012' } };
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { dnsEngine: undefined,
      engine: { kind: 'opentofu', domains: ['app.example.com'], domainClaims: { 'app.example.com': { zone } } } });
    const verify = vi.spyOn(absence, 'verifyDnsTrafficAbsent').mockResolvedValue({ ready: true, zoneFingerprint: 'exact-zone', connectionId: 'saved-dns' });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked'); expect(verify).toHaveBeenCalledWith(expect.objectContaining({ domain: 'app.example.com', zone }));
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.engine).toHaveBeenCalledOnce();
    if ('blocked' in result) throw Error(result.blocked.join(' '));
    expect(new ConvergeExecutor().loadPlan(result.planRunId)).toMatchObject({ document: { engine: {
      cancelledDomainProofs: { 'app.example.com': { zoneFingerprint: 'exact-zone', connectionId: 'saved-dns' } },
    } } });
  });
  it('preserves a cancelled mapping when native or public DNS absence is unknown', async () => {
    const f = fixture({ owned: true, mapping: true, remove: true });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { dnsEngine: undefined,
      engine: { kind: 'opentofu', domains: ['app.example.com'], domainClaims: { 'app.example.com': {
        zone: { provider: 'aws', zoneId: 'Z123456', zoneName: 'example.com', scope: { accountId: '123456789012' } },
      } } } });
    vi.spyOn(absence, 'verifyDnsTrafficAbsent').mockResolvedValue({ ready: false, reason: 'Public DNS is unknown.' });
    expect(await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' })).toEqual({ blocked: ['Public DNS is unknown.'] });
    expect(f.engine).not.toHaveBeenCalled();
  });
  it('persists ownership TXT as a DNS engine plan before planning a mapping', async () => {
    const f = fixture();
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked');
    if ('blocked' in result) throw Error(result.blocked.join('; '));
    expect(new ConvergeExecutor().loadPlan(result.planRunId)).toMatchObject({ document: { scope: 'dns-engine' } });
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: 'gcp-domain', records: [expect.objectContaining({ name: 'example.com', type: 'TXT' })] }));
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.requests.filter(request => request.method !== 'GET').map(request => request.url)).toEqual(['https://www.googleapis.com/siteVerification/v1/token']);
  });

  it('plans the native hosting claim after ownership without publishing speculative traffic DNS', async () => {
    const f = fixture({ owned: true });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked');
    if ('blocked' in result) throw Error(result.blocked.join('; '));
    expect(new ConvergeExecutor().loadPlan(result.planRunId)).toMatchObject({ document: { scope: 'infrastructure-engine' } });
    expect(f.engine).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(Object.keys(f.engine.mock.calls[0]![0].configuration.resources).some(address => address.startsWith('google_cloud_run_domain_mapping.'))).toBe(true);
  });

  it('plans fresh mapping records in a separate DNS stage while retaining prior ownership TXT', async () => {
    const f = fixture({ owned: true, mapping: true });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked');
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ retainExistingTypes: ['TXT'], records: [expect.objectContaining({
      name: 'app.example.com', type: 'CNAME', values: ['provider-returned.example.net'],
    })] }));
    expect(f.engine).not.toHaveBeenCalled();
  });

  it('plans owned DNS removal before releasing the native hosting claim', async () => {
    const f = fixture({ owned: true, mapping: true, remove: true });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    expect(result).not.toHaveProperty('blocked');
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ remove: true, owner: 'gcp-domain', records: [] }));
    expect(f.engine).not.toHaveBeenCalled();
  });

  it('rejects a replaced mapping before applying its previously reviewed DNS source', async () => {
    const f = fixture({ owned: true, mapping: true });
    const result = await planInfrastructureEngine(f.ctx, { ...f, specRevision: 1, environmentName: 'staging' });
    if ('blocked' in result) throw Error(result.blocked.join('; '));
    const plan = new ConvergeExecutor().loadPlan(result.planRunId);
    if ('error' in plan) throw Error(plan.error);
    const source = plan.document.dns!.source!;
    expect(await verifyGcpDnsSource(f.ctx, f.project, f.spec, source)).toEqual({ ready: true });
    f.mapping.metadata.uid = 'replacement-mapping-uid';
    expect(await verifyGcpDnsSource(f.ctx, f.project, f.spec, source)).toMatchObject({ ready: false });
  });
});
