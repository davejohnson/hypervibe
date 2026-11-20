import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import * as domainPlanning from '../infrastructure-engine-domain.js';
import { gcpSecretStore, planGcpTeardown, planInfrastructureEngine, strayStateResources } from '../infrastructure-engine.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
vi.mock('../../adapters/providers/gcp/gcp-image-repository.js', async (original) => ({ ...await original<typeof import('../../adapters/providers/gcp/gcp-image-repository.js')>(),
  observeImageRepository: async () => ({ state: 'present' as const }) }));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-outside-containers-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'outside-containers', defaultPlatform: 'cloudrun' });
  project.gitRemoteUrl = 'https://github.com/example/outside-containers';
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': environment.id };
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudrun', scope: 'example/outside-containers', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test-private-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  connections.updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
  }, secrets: { API_KEY: { ownership: 'delegated', principal: 'app-owner', environments: ['staging'] } } });
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('test-token');
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  const configurations: EngineConfiguration[] = [];
  const enginePlan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => {
    configurations.push(configuration);
    const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
      actions: Object.entries(configuration.resources).filter(([address]) => address.startsWith('google_secret_manager_secret.') || address.startsWith('google_cloud_run_v2_service.'))
        .map(([address, resource]) => ({ id: resource.actionId, type: 'create' as const, resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'engine preview', metadata: { engineSegment: { ...segment, addresses: [address] } } })),
    };
  });
  let state: 'absent' | 'unknown' | 'foreign' | 'empty' | 'ready' = 'absent';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method) throw new Error('Plan and collection readiness must not mutate the provider.');
    if (url.includes('/secrets?')) return Response.json({ secrets: [] });
    if (state === 'unknown') return new Response('', { status: 403 });
    if (state === 'absent') return new Response('', { status: 404 });
    if (url.endsWith('/versions/latest')) return state === 'ready'
      ? Response.json({ state: 'ENABLED', name: `projects/demo-project/secrets/${/secrets\/([^/]+)\//.exec(url)![1]}/versions/7` })
      : new Response('', { status: 404 });
    return Response.json({ labels: state === 'foreign' ? { ...labels, 'hv-environment': 'other-environment' } : labels });
  });
  vi.stubGlobal('fetch', fetch);
  return { ctx, project, environment, spec, configurations, enginePlan, fetch, setState: (value: typeof state) => { state = value; } };
}

describe('resources left only in engine state by an apply that was cut off', () => {
  // Live 2026-11-20: the network dropped mid-apply; the engine had created the workloads and a bucket, Hypervibe had
  // recorded none of them, and every later plan stopped at "which this plan does not manage".
  const left = ['google_cloud_run_v2_worker_pool.worker', 'google_cloud_run_v2_worker_pool_iam_member.worker_waker', 'google_storage_bucket.storage_files', 'google_storage_bucket_iam_member.storage_files_runtime'];
  const cutOff = (f: ReturnType<typeof fixture>, extra: string[] = []) => f.enginePlan.mockImplementation(async ({ configuration }) => {
    f.configurations.push(configuration);
    const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    const unmanaged = [...left, ...extra].filter((address) => !configuration.resources[address]);
    const managed = [...new Map(left.filter((address) => configuration.resources[address]).map((address) => [configuration.resources[address]!.actionId, configuration.resources[address]!])).values()];
    return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', unmanagedDeletes: unmanaged,
      blockers: unmanaged.map((address) => `OpenTofu proposed delete for ${address}, which this plan does not manage.`),
      actions: managed.map((resource) => ({ id: resource.actionId, type: 'destroy' as const, resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'engine preview', metadata: { engineSegment: { ...segment, addresses: [] } } })) };
  });
  const params = (f: ReturnType<typeof fixture>) => ({ project: f.project, specRevision: 1, environmentName: 'staging',
    spec: projectSpecSchema.parse({ version: 1, project: f.project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } }) });

  it('plans to remove a workload and a bucket the spec no longer has, although Hypervibe never recorded them', async () => {
    const f = fixture(); cutOff(f);
    const planned = await planInfrastructureEngine(f.ctx, params(f));
    if ('blocked' in planned) throw new Error(planned.blocked.join('; '));
    expect(planned.actions.filter((action) => action.type === 'destroy').map((action) => action.id).sort()).toEqual(['service:worker', 'storage:files']);
    expect(f.enginePlan).toHaveBeenCalledTimes(2);
  });

  it('leaves a workload the spec still has to the ordinary plan', async () => {
    const f = fixture(); cutOff(f);
    const kept = params(f);
    kept.spec.environments.staging!.services.worker = { workloadKind: 'worker', startCommand: 'node worker.js' } as never;
    const planned = await planInfrastructureEngine(f.ctx, kept);
    if ('blocked' in planned) throw new Error(planned.blocked.join('; '));
    // Declared by the spec, so it is managed and was never an unmanaged delete; only the bucket is retired.
    expect(f.configurations.at(-1)!.resources['google_storage_bucket.storage_files']).toMatchObject({ actionId: 'storage:files', dataBearing: true });
    expect(f.configurations.at(-1)!.resources['google_cloud_run_v2_worker_pool.worker']).toMatchObject({ actionId: 'service:worker' });
  });

  it('still blocks when the state holds something that is not a workload, bucket or queue', async () => {
    const f = fixture(); cutOff(f, ['google_compute_network.other']);
    expect(await planInfrastructureEngine(f.ctx, params(f))).toMatchObject({ blocked: [expect.stringContaining('google_compute_network.other')] });
  });

  it('names only workloads, buckets and queues by their own address, never their companions or the database', () => {
    expect(strayStateResources(['google_cloud_run_v2_service.web', 'google_cloud_run_v2_job.nightly_report', 'google_cloud_run_v2_service_iam_member.web_public',
      'google_storage_bucket.storage_user_files', 'google_pubsub_topic.queue_jobs', 'google_sql_database_instance.db']))
      .toEqual({ queues: ['jobs'], services: ['web', 'nightly-report'], storage: ['user-files'] });
  });
});

describe('Google Cloud teardown plan', () => {
  it('plans toward an emptied environment: buckets are emptied first, everything recorded is removed, and a last step checks nothing is left', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'web-1' } },
      engine: { kind: 'opentofu', storage: ['files'], secrets: ['hv-staging-legacy-key'], importedSecrets: ['LEGACY_KEY'] } });
    f.enginePlan.mockImplementation(async ({ configuration }) => {
      f.configurations.push(configuration);
      const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
      const mapped = [...new Map(Object.values(configuration.resources).map((resource) => [resource.actionId, resource])).values()]
        .filter((resource) => !resource.actionId.startsWith('secret-runtime-access:'));
      return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
        actions: mapped.map((resource) => ({ id: resource.actionId, type: 'destroy' as const, resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'engine preview', metadata: { engineSegment: { ...segment, addresses: [] } } })) };
    });
    const planned = await planGcpTeardown(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' });
    if ('blocked' in planned) throw new Error(planned.blocked.join('; '));
    const ids = planned.actions.map((action) => action.id);
    expect(ids[0]).toBe('storage-empty:files');
    expect(ids.at(-1)).toBe('cleanup:leftovers');
    expect(ids).toEqual(expect.arrayContaining(['service:web', 'storage:files']));
    expect(planned.actions.find((action) => action.id === 'storage:files')!.dependsOn).toContain('storage-empty:files');
    expect(planned.actions[0]).toMatchObject({ dataBearing: true, requiresConfirm: true, metadata: { bucket: expect.stringMatching(/staging-files$/), environmentLabel: f.environment.id.toLowerCase() } });
    expect(planned.actions.at(-1)).toMatchObject({ requiresConfirm: true, dependsOn: expect.arrayContaining(['storage-empty:files', 'service:web', 'storage:files']),
      metadata: { workloads: [{ name: 'web', kind: 'services', resource: 'web-1' }], buckets: [expect.stringMatching(/staging-files$/)] } });
    // Nothing the spec declares is kept: no service is configured and the delegated secret no longer targets the environment.
    expect(ids).not.toContain('secret-container:hv-staging-api-key');
    // A value imported during a migration is not kept either: its container is mapped for removal but no longer declared.
    expect(ids).toContain('secret-container:hv-staging-legacy-key');
    expect(JSON.stringify(f.configurations.at(-1)!.files)).not.toContain('hv-staging-legacy-key');
    expect(f.configurations.at(-1)!.resources['google_cloud_run_v2_service.web']).toMatchObject({ actionId: 'service:web' });
    expect(planned.warnings[0]).toContain('cannot be undone');
    // The saved spec still has the environment until the last step runs.
    expect(f.spec.environments.staging!.services.web).toBeDefined();
  });

  it('refuses while the environment still has a custom domain', async () => {
    const f = fixture();
    const spec = projectSpecSchema.parse({ version: 1, project: f.project.name, environments: { staging: { hosting: { provider: 'cloudrun' }, domain: 'app.example.com', services: { web: {} } } } });
    expect(await planGcpTeardown(f.ctx, { project: f.project, spec, specRevision: 1, environmentName: 'staging' })).toMatchObject({ blocked: [expect.stringContaining('custom domains')] });
    expect(f.enginePlan).not.toHaveBeenCalled();
  });
});

describe('outside keys under the engine container boundary', () => {
  it('plans containers before collecting values, then wires only the exact saved version', async () => {
    const f = fixture();
    const params = { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' };
    const first = await planInfrastructureEngine(f.ctx, params);
    expect(first).not.toHaveProperty('blocked');
    if ('blocked' in first) throw new Error(first.blocked.join('; '));
    expect(first.actions).toContainEqual(expect.objectContaining({ id: 'secret-container:hv-staging-api-key' }));
    expect(first.actions.find(action => action.id === 'secret:API_KEY')).toBeUndefined();
    expect(JSON.stringify(f.configurations[0]!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
    f.setState('empty');
    expect(await planInfrastructureEngine(f.ctx, params)).toMatchObject({ blocked: [expect.stringContaining('hv_secrets')], missingOutsideKeys: ['API_KEY'] });
    expect(f.enginePlan).toHaveBeenCalledOnce();
    f.setState('ready');
    expect(await planInfrastructureEngine(f.ctx, params)).not.toHaveProperty('blocked');
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('"version":"7"');
    expect(f.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('never gives a private package token to running services', async () => {
    const f = fixture();
    const spec = projectSpecSchema.parse({ ...f.spec, secrets: { NODE_AUTH_TOKEN: f.spec.secrets!.API_KEY } });
    f.setState('ready');
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec, specRevision: 1, environmentName: 'staging' });
    if ('blocked' in planned) throw new Error(planned.blocked.join('; '));
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
  });

  it('plans without a value for a key declared required: false, and leaves it out of the services', async () => {
    const f = fixture();
    const spec = projectSpecSchema.parse({ ...f.spec, secrets: { API_KEY: { ...f.spec.secrets!.API_KEY, required: false } } });
    f.setState('empty');
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec, specRevision: 1, environmentName: 'staging' });
    expect(planned).not.toHaveProperty('blocked');
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
  });

  it('preserves the migration container round before its private value transfer', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { engine: { pendingImportedSecrets: ['API_KEY'] } });
    f.setState('empty');
    const planned = await planInfrastructureEngine(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' });
    expect(planned).not.toHaveProperty('blocked');
    expect(JSON.stringify(f.configurations.at(-1)!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
  });

  it.each(['absent', 'unknown', 'foreign'] as const)('blocks collection before opening a page for %s containers', async (state) => {
    const f = fixture(); f.setState(state);
    const store = await gcpSecretStore(f.ctx, f.project, f.spec, 'staging');
    expect(store).toHaveProperty('blocked');
    expect(f.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('collects only after ownership is verified and rechecks that boundary on observe', async () => {
    const f = fixture(); f.setState('empty');
    const store = await gcpSecretStore(f.ctx, f.project, f.spec, 'staging');
    if ('blocked' in store) throw new Error(store.blocked);
    expect(await store.observe('API_KEY')).toBe('absent');
    f.setState('ready');
    expect(await store.observe('API_KEY')).toBe('present');
    f.setState('foreign');
    expect(await store.observe('API_KEY')).toHaveProperty('unknown');
  });
});

it('plans separate Cloud Run claims and keeps the exact DNS selection for each hostname', async () => {
  const f = fixture();
  const dns = (name: string, id: string) => ({ provider: 'gcp', connectionScope: `dns/${id}`, zone: { id, name, projectId: 'dns-project' } });
  const desired = projectSpecSchema.parse({ ...f.spec, secrets: {}, environments: { staging: { ...f.spec.environments.staging,
    domain: 'api-test.example.com', dns: dns('example.com', 'example-zone'),
    domains: [{ domain: 'api.test-example.com', dns: dns('test-example.com', 'test-zone') }, { domain: 'app.other.org', dns: dns('other.org', 'other-zone') }] } } });
  vi.spyOn(domainPlanning, 'planDomain').mockResolvedValue({ before: [], after: [], mappingPresent: false, ownershipPresent: true });
  const plan = await planInfrastructureEngine(f.ctx, { project: f.project, spec: desired, specRevision: 1, environmentName: 'staging' });
  if ('blocked' in plan) throw new Error(plan.blocked.join(' '));
  const config = f.configurations.at(-1)!;
  const mappings = (config.files['cloudrun.tf.json'] as any).resource.google_cloud_run_domain_mapping;
  expect(Object.values(mappings).map((row: any) => row.name).sort()).toEqual(['api-test.example.com', 'api.test-example.com', 'app.other.org']);
  expect(new Set(Object.values(mappings).map((row: any) => row.spec[0].route_name)).size).toBe(1);
  expect(f.ctx.repos.runs.findById(plan.planRunId)?.plan).toMatchObject({ engine: { domainClaims: {
    'api-test.example.com': { owner: 'gcp-domain', connectionScope: 'dns/example-zone', zone: { zoneId: 'example-zone' } },
    'app.other.org': { owner: expect.stringMatching(/^gcp-domain-[a-f0-9]+$/), connectionScope: 'dns/other-zone', zone: { zoneId: 'other-zone' } },
  } } });
});

it.each(['example.com', 'other.org'])('keeps an existing primary DNS owner when a new primary in %s is selected', async zoneName => {
  const f = fixture();
  const old = 'a.example.com'; const next = `b.${zoneName}`;
  const selection = (name: string) => ({ provider: 'gcp', zone: { id: name.split('.')[0]!, name, projectId: 'dns-project' } });
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { engine: { kind: 'opentofu', domains: [old], domainClaims: {
    [old]: { zone: { provider: 'gcp', zoneName: 'example.com', zoneId: 'example', scope: { projectId: 'dns-project' } } },
  } } });
  const spec = projectSpecSchema.parse({ ...f.spec, secrets: {}, environments: { staging: { ...f.spec.environments.staging,
    domain: next, dns: selection(zoneName), domains: [{ domain: old, dns: selection('example.com') }] } } });
  vi.spyOn(domainPlanning, 'planDomain').mockResolvedValue({ before: [], after: [], ownershipPresent: true });
  const plan = await planInfrastructureEngine(f.ctx, { project: f.project, spec, specRevision: 2, environmentName: 'staging' });
  if ('blocked' in plan) throw new Error(plan.blocked.join(' '));
  expect(f.ctx.repos.runs.findById(plan.planRunId)?.plan).toMatchObject({ engine: { domainClaims: {
    [old]: { owner: 'gcp-domain', zone: { zoneName: 'example.com' } }, [next]: { owner: expect.stringMatching(/^gcp-domain-[a-f0-9]+$/), zone: { zoneName } },
  } } });
  expect(f.configurations.at(-1)!.resources['google_cloud_run_domain_mapping.domain_a_example_com']?.name).toBe(old);
});
