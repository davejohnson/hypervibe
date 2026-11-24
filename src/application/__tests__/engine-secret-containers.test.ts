import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { observeSecret, writeSecretVersion, planInfrastructureEngine, recordSecretVersionMetadata } from '../infrastructure-engine.js';
import * as infrastructure from '../infrastructure-engine.js';
import * as launch from '../launch.js';
import { secretAges } from '../secret-rotation.js';
import * as hosting from '../../domain/services/hosting-env.service.js';
import { migrateEnvironment } from '../migrate.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { mergeRepoPlatformBindings } from '../../domain/spec/repo-bindings-file.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { parseEnginePlan, translateEnginePlan } from '../../adapters/engine/opentofu/plan-mapping.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import { buildCloudRunConfiguration, secretEngineKey } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-secrets-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function owned() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'engine-secrets', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  return { ctx, project, environment, labels: { 'managed-by': 'hypervibe', 'hv-environment': environment.id } };
}
const ownedLabels = () => ({ labels: owned().labels });
const secret = 'hv-staging-jwt-secret';
const base = `https://secretmanager.googleapis.com/v1/projects/demo-project/secrets/${secret}`;

function engineFixture(perSecret = false) {
  const { ctx, project, environment, labels } = owned();
  project.gitRemoteUrl = 'https://github.com/example/secrets';
  const connection = new ConnectionRepository().create({ provider: 'cloudrun', scope: 'example/secrets', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test-private-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: { hosting: { provider: 'cloudrun', ...(perSecret ? { gcpRuntimeSecretGrants: 'per-secret' } : {}) }, services: { web: {} } },
  }, secrets: { JWT_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] } } });
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('test-token');
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  return { ctx, project, environment, labels, spec };
}

describe('engine-owned Secret Manager containers', () => {
  it('never creates a missing container while writing a value', async () => {
    const { labels } = owned();
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) { writes.push(`${init.method} ${url}`); return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/1` }); }
      return new Response('', { status: 404 });
    }));
    const result = await writeSecretVersion('test-token', 'demo-project', secret, labels, 'private-value');
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ success: false, status: 'blocked', message: expect.stringContaining('hv_plan') });
  });

  it('writes only a version and preserves exact version-bound credential metadata', async () => {
    const { labels } = owned();
    const writes: string[] = [];
    let version = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        writes.push(`${init.method} ${url}`);
        if (url.endsWith(':addVersion')) { version = '2'; return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/2` }); }
        return Response.json({});
      }
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/${version}` } : { labels });
    }));
    expect(await writeSecretVersion('test-token', 'demo-project', secret, { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' }, 'private-value')).toBeUndefined();
    expect(writes).toEqual([`POST ${base}:addVersion`]);
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { latestVersion: '2', labels: { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' } } });
  });

  it('puts containers and their retirement in the saved engine graph without secret values', () => {
    const configuration = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [], environmentId: 'env-123',
      secrets: [{ secretId: secret, labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env-123' } }], retiredSecrets: ['hv-staging-retired'],
    } as Parameters<typeof buildCloudRunConfiguration>[0]);
    expect(configuration.files['secrets.tf.json']).toMatchObject({ resource: { google_secret_manager_secret: expect.any(Object) } });
    expect(Object.values(configuration.resources)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: `secret-container:${secret}`, kind: 'secret', dataBearing: true }),
      expect.objectContaining({ actionId: 'secret-container:hv-staging-retired', kind: 'secret', dataBearing: true }),
    ]));
    expect(JSON.stringify(configuration)).not.toContain('private-value');
  });

  it('stages only consumed runtime grants from the saved environment spec', () => {
    const runtime = 'runtime@demo-project.iam.gserviceaccount.com';
    const keys = ['JWT_SECRET', 'PARTNER_TOKEN', 'DATABASE_URL', 'REDIS_URL', 'files_AWS_ACCESS_KEY_ID', 'files_AWS_SECRET_ACCESS_KEY'];
    const spec = projectSpecSchema.parse({ version: 1, project: 'example', environments: { staging: {
      hosting: { provider: 'cloudrun', gcpRuntimeSecretGrants: 'per-secret' }, services: {
        web: {}, worker: { workloadKind: 'worker' }, schedule: { workloadKind: 'cron', cronSchedule: '0 1 * * *', startCommand: 'node task.js' },
      }, migrations: { mode: 'releaseCommand', command: 'node migrate.js' },
      storage: { files: { provider: 'gcs', type: 'bucket', region: 'us-central1', access: 's3', injectInto: ['web'] } },
    } }, secrets: { JWT_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'] } } });
    const input = infrastructure.buildEngineInput(spec, 'staging', { gcpProjectId: 'demo-project', region: 'us-central1',
      runtimeServiceAccountEmail: runtime, resourceNameFor: name => name, databaseWired: true, cacheWired: true, s3WiredStorage: ['files'],
      importedSecrets: ['PARTNER_TOKEN', 'NODE_AUTH_TOKEN'], secretVersions: Object.fromEntries([...keys, 'NODE_AUTH_TOKEN'].map(key => [key, '2'])) });
    const ids = keys.map(key => `hv-staging-${key.toLowerCase().replaceAll('_', '-')}`);
    const allIds = [...ids, 'hv-staging-node-auth-token', 'unused-transfer-location', 'pending-import'];
    const labels = { 'managed-by': 'hypervibe', 'hv-environment': 'env-123' };
    const config = buildCloudRunConfiguration({ ...input, runtimeServiceAccountEmail: runtime, environmentId: 'env-123',
      secrets: allIds.map(secretId => ({ secretId, labels })) });
    const grants = (config.files['secrets.tf.json'] as any).resource.google_secret_manager_secret_iam_member;
    expect(grants).toEqual(Object.fromEntries(ids.map(id => [secretEngineKey(id), {
      project: 'demo-project', secret_id: `\${google_secret_manager_secret.${secretEngineKey(id)}.secret_id}`,
      member: `serviceAccount:${runtime}`, role: 'roles/secretmanager.secretAccessor',
    }])));
    for (const id of ids) expect(config.resources[`google_secret_manager_secret_iam_member.${secretEngineKey(id)}`]).toMatchObject({
      actionId: `secret-runtime-access:${id}`, requiresConfirm: true,
    });
    expect(JSON.stringify(config.files)).not.toContain('google_project_iam_member');
    const resources = (file: string) => (config.files[file] as { resource: Record<string, Record<string, { depends_on: string[] }>> }).resource;
    const grantsFor = (selected: string[]) => selected.sort().map(id => `google_secret_manager_secret_iam_member.${secretEngineKey(id)}`);
    const app = ids.filter(id => !id.includes('files-aws'));
    expect(resources('cloudrun.tf.json').google_cloud_run_v2_service!.web!.depends_on).toEqual(grantsFor([...ids]));
    expect(resources('workerpools.tf.json').google_cloud_run_v2_worker_pool!.worker!.depends_on).toEqual(grantsFor([...app]));
    expect(resources('jobs.tf.json').google_cloud_run_v2_job!.schedule!.depends_on).toEqual(grantsFor([...app]));
    expect(resources('jobs.tf.json').google_cloud_run_v2_job!.release_command!.depends_on).toEqual(grantsFor([...ids]));
  });

  it.each(['aws', 'azure'])('accepts ordinary %s hosting and rejects the Cloud Run grant setting', (provider) => {
    const spec = { version: 1, project: 'example', environments: { staging: { hosting: { provider }, services: { web: {} } } } };
    expect(projectSpecSchema.safeParse(spec).success).toBe(true);
    const result = projectSpecSchema.safeParse({ ...spec, environments: { staging: {
      ...spec.environments.staging, hosting: { provider, gcpRuntimeSecretGrants: 'per-secret' },
    } } });
    expect(result.error?.issues.map(issue => issue.path)).toEqual([['environments', 'staging', 'hosting', 'gcpRuntimeSecretGrants']]);
  });

  it('retains existing imported alias containers without requesting or recreating their versions', async () => {
    const { ctx, project, environment, labels, spec } = engineFixture();
    const alias = 'hv-staging-job-db-url';
    const name = `projects/demo-project/secrets/${alias}`;
    const updated = projectSpecSchema.parse({ ...spec, environments: { staging: { ...spec.environments.staging,
      database: { provider: 'cloudsql' },
      services: { web: { databaseEnvAliases: { JOB_DB_URL: 'DATABASE_URL', LEGACY_URL: 'DIRECT_URL' } } },
    } } });
    ctx.repos.environments.updatePlatformBindings(environment.id, { engine: {
      kind: 'opentofu', database: { instanceName: 'staging-db' }, secrets: [alias], importedSecrets: ['JOB_DB_URL'], pendingImportedSecrets: ['LEGACY_URL'],
    } });
    let observedLabels = labels;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Planning cannot write to Google.');
      if (url.includes('/secrets?')) return Response.json({ secrets: [{ name }] });
      if (url.endsWith('/' + alias)) return Response.json({ name, labels: observedLabels });
      for (const key of [secret, 'hv-staging-database-url', 'hv-staging-partner-token']) {
        const path = `projects/demo-project/secrets/${key}`;
        if (url.endsWith(path)) return Response.json({ name: path, labels: { ...labels, 'hv-db-login': 'app_a', 'hv-db-instance': 'staging-db' } });
        if (url.endsWith(path + '/versions/latest')) return Response.json({ name: path + '/versions/3', state: 'ENABLED' });
      }
      if (url.includes('artifactregistry.googleapis.com')) return Response.json({ name: 'projects/demo-project/locations/us-central1/repositories/hypervibe', format: 'DOCKER' });
      return new Response('', { status: 404 });
    }));
    const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
    const enginePlan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockResolvedValue({ ok: true, segmentId: segment.id, segment,
      planFile: '/not-executed', blockers: [], unmanagedDeletes: [], actions: [] });
    const params = { project, spec: updated, specRevision: 1, environmentName: environment.name };
    const previous = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'infrastructure-engine', environmentName: environment.name, specRevision: 1, observedFingerprint: null,
      engine: { planId: 'old-plan', state: { provider: 'gcp', projectId: project.id, environmentId: environment.id, partition: 'environment' },
        gcpProjectId: 'demo-project', region: 'us-central1' }, actions: [{ id: 'service:web', type: 'update', verified: true, requiresConfirm: true,
        resource: { kind: 'service', name: 'web', provider: 'gcp' }, reason: 'Reviewed service update',
        metadata: { engineSegment: { ...segment, addresses: ['google_cloud_run_v2_service.web'] } } }],
    } });
    expect(await infrastructure.applyInfrastructureEngine(ctx, { ...params, planId: previous.id, confirmActions: [] }))
      .toMatchObject({ kind: 'blocked', reason: expect.stringContaining('hv_plan') });
    const inventory = await secretAges(ctx, project, updated, environment.name);
    if ('blocked' in inventory) throw new Error(inventory.blocked);
    expect(inventory.secrets.map(entry => entry.key)).not.toContain('JOB_DB_URL');
    const first = await planInfrastructureEngine(ctx, params);
    if ('blocked' in first) throw new Error(first.blocked.join(' '));
    const files = enginePlan.mock.calls[0]![0].configuration.files as Record<string, any>;
    const containers = Object.values(files['secrets.tf.json'].resource.google_secret_manager_secret).map((item: any) => item.secret_id);
    expect(containers).toContain(alias);
    expect(containers).not.toContain('hv-staging-legacy-url');
    await expect(infrastructure.applyInfrastructureEngine(ctx, { project, spec: updated, specRevision: 1,
      planId: first.planRunId, confirmActions: first.confirmActions })).resolves.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.engine).toMatchObject({
      importedSecrets: [], pendingImportedSecrets: [], retainedDatabaseAliasImports: ['JOB_DB_URL', 'LEGACY_URL'],
    });
    delete updated.environments.staging!.services.web!.databaseEnvAliases;
    const next = await planInfrastructureEngine(ctx, { ...params, specRevision: 2 });
    if ('blocked' in next) throw new Error(next.blocked.join(' '));
    const nextFiles = enginePlan.mock.calls.at(-1)![0].configuration.files;
    expect(JSON.stringify(nextFiles['secrets.tf.json'])).toContain(alias);
    expect(JSON.stringify(nextFiles['cloudrun.tf.json'])).not.toMatch(/JOB_DB_URL|LEGACY_URL/);
    const reuse = projectSpecSchema.parse({ ...updated, secrets: { ...updated.secrets, JOB_DB_URL: {
      ownership: 'delegated', principal: 'app administrator', environments: ['staging'],
    } } });
    expect(await planInfrastructureEngine(ctx, { ...params, spec: reuse, specRevision: 3 })).toMatchObject({ blocked: [expect.stringContaining('previous database alias import')] });
    expect(await infrastructure.gcpSecretStore(ctx, project, reuse, environment.name)).toMatchObject({ blocked: expect.stringContaining('previous database alias import') });
    const renamed = { ...updated, secrets: { ...updated.secrets, PARTNER_TOKEN: reuse.secrets.JOB_DB_URL! } };
    expect(await planInfrastructureEngine(ctx, { ...params, spec: renamed, specRevision: 4 })).not.toHaveProperty('blocked');
    observedLabels = { ...labels, 'hv-environment': 'other' };
    expect(await planInfrastructureEngine(ctx, { ...params, specRevision: 2 })).toMatchObject({ blocked: [expect.stringContaining('ownership')] });
    expect(enginePlan).toHaveBeenCalledTimes(3);
  });

  it('plans containers before value writes and wires services only after enabled versions exist', async () => {
    const { ctx, project, environment, labels, spec } = engineFixture();
    const configurations: EngineConfiguration[] = [];
    const enginePlan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => {
      configurations.push(configuration);
      const segment = { id: 'engine-segment', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
      return { ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
        actions: Object.entries(configuration.resources).filter(([address]) => address.startsWith('google_secret_manager_secret.') || address.startsWith('google_cloud_run_v2_service.') || address.startsWith('google_artifact_registry_repository.'))
          .map(([address, resource]) => ({ id: resource.actionId, type: 'create' as const, resource: { kind: resource.kind, name: resource.name, provider: 'gcp' }, verified: true, reason: 'engine preview', metadata: { engineSegment: { ...segment, addresses: [address] } } })),
      };
    });
    let ready = false;
    let repository: 'present' | 'absent' | 'unreadable' = 'present';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Planning cannot write to Google.');
      if (url.includes('artifactregistry.googleapis.com')) return repository === 'present'
        ? Response.json({ name: 'projects/demo-project/locations/us-central1/repositories/hypervibe', format: 'DOCKER' })
        : new Response('', { status: repository === 'absent' ? 404 : 403 });
      if (url.includes('/secrets?')) return Response.json({ secrets: ready ? [{ name: `projects/demo-project/secrets/${secret}` }] : [] });
      if (!ready) return new Response('', { status: 404 });
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/2` } : { labels });
    }));
    const first = await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name });
    expect(first).not.toHaveProperty('blocked');
    if ('blocked' in first) throw new Error(first.blocked.join('; '));
    const value = first.actions.find((action) => action.id === 'secret:JWT_SECRET')!;
    expect(value.dependsOn).toEqual([`secret-container:${secret}`]);
    expect(first.actions.indexOf(value)).toBeGreaterThan(first.actions.findIndex((action) => action.id === `secret-container:${secret}`));
    expect(JSON.stringify(configurations[0]!.files['cloudrun.tf.json'])).not.toContain('secret_key_ref');
    ready = true;
    const second = await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name });
    expect(second).not.toHaveProperty('blocked');
    expect(JSON.stringify(configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('secret_key_ref');
    expect(JSON.stringify(configurations.at(-1)!.files['cloudrun.tf.json'])).toContain('"version":"2"');
    expect(enginePlan).toHaveBeenCalledTimes(2);

    // A release needs the image repository in this environment's region; project setup may have made it elsewhere.
    repository = 'absent';
    const third = await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name });
    if ('blocked' in third) throw new Error(third.blocked.join('; '));
    expect(third.actions[0]).toMatchObject({ id: 'artifact-repository:us-central1', type: 'create' });
    expect(enginePlan.mock.calls.at(-1)![0].state).toEqual({ provider: 'gcp', projectId: project.id, environmentId: 'image-repository-us-central1', partition: 'project-shared' });
    repository = 'unreadable';
    const calls = enginePlan.mock.calls.length;
    expect(await planInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: environment.name })).toMatchObject({ blocked: [expect.stringContaining('did not confirm')] });
    expect(enginePlan.mock.calls.length).toBe(calls + 1);
  });

  it('reviews a scoped grant and rechecks the secret and its policy before the saved apply', async () => {
    const { ctx, project, environment, labels, spec } = engineFixture(true);
    const member = 'serviceAccount:runtime@demo-project.iam.gserviceaccount.com';
    const name = `projects/12345/secrets/${secret}`;
    const role = 'roles/secretmanager.secretAccessor';
    const address = `google_secret_manager_secret_iam_member.${secretEngineKey(secret)}`;
    const requested = `secret-runtime-access:${secret}`;
    const params = { project, spec, specRevision: 2, environmentName: environment.name };
    const actor = { project: 'demo-project', secret_id: secret, member, role };
    const originalTime = '2026-01-02T00:00:00Z';
    let createTime = originalTime;
    let projectNumber = '12345';
    let removing = false;
    const otherMember = 'serviceAccount:other@demo-project.iam.gserviceaccount.com';
    const independent = { role, members: [member], condition: { expression: 'false' } };
    let policy: unknown = { version: 3, bindings: [independent, { role, members: [otherMember] }] };
    const read = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new Error('Review attempted a write.');
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/projects/demo-project') return Response.json({ projectId: 'demo-project', name: `projects/${projectNumber}` });
      if (url.includes('/services/collision')) return Response.json({ generation: '1' });
      if (url === base) return Response.json({ name, labels, createTime });
      if (url === `${base}/versions/latest`) return Response.json({ name: `${name}/versions/2`, state: 'ENABLED' });
      if (url === `${base}:getIamPolicy?options.requestedPolicyVersion=3`) return Response.json(policy);
      if (url.includes('/secrets?')) return Response.json({ secrets: [{ name }] });
      if (url.includes('artifactregistry.googleapis.com')) return Response.json({ name: 'projects/demo-project/locations/us-central1/repositories/hypervibe', format: 'DOCKER' });
      throw new Error('Unexpected provider request');
    });
    vi.stubGlobal('fetch', read);
    vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration, planId, verifyPlannedChanges }) => {
      const segment = { id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'a'.repeat(64),
        configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
      const seen = { format_version: '1.2', resource_changes: [
        { address, type: 'google_secret_manager_secret_iam_member', change: removing ? { actions: ['delete'], before: actor, after: null } : { actions: ['create'], before: null, after: actor } },
        { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service',
          change: { actions: ['no-op'], before: { template: [{ scaling: [] }] }, after: { template: [{ scaling: [] }] } } },
      ] };
      expect(verifyPlannedChanges?.(seen)).toBe(true);
      return { ok: true, segment, segmentId: segment.id, planFile: 'synthetic', ...translateEnginePlan({
        provider: 'gcp', parsed: parseEnginePlan(JSON.stringify(seen)), configuration, segment,
      }) };
    });
    const applyEngine = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockResolvedValue({ outcomes: { [address]: 'succeeded' }, diagnostics: [] });
    const plan = async () => {
      const result = await planInfrastructureEngine(ctx, params);
      if ('blocked' in result) throw new Error(result.blocked.join(' '));
      expect(result.confirmActions).toEqual([requested]);
      expect(result.actions.find(action => action.id === requested)?.reason).toContain(member);
      return result.planRunId;
    };
    const apply = (planId: string, confirmActions = [requested]) => infrastructure.applyInfrastructureEngine(ctx, { ...params, planId, confirmActions });
    const initial = await plan();
    await apply(initial, []);
    expect(applyEngine).not.toHaveBeenCalled();
    createTime = '2026-02-02T00:00:00Z';
    await apply(initial);
    expect(applyEngine).not.toHaveBeenCalled();
    createTime = originalTime;
    const reviewed = await plan();
    policy = { bindings: [{ role, members: [member] }] };
    await apply(reviewed);
    expect(applyEngine).not.toHaveBeenCalled();
    await expect(planInfrastructureEngine(ctx, params)).resolves.toMatchObject({ blocked: [expect.stringContaining('existing grant')] });
    policy = { bindings: 'malformed' };
    await expect(planInfrastructureEngine(ctx, params)).resolves.toMatchObject({ blocked: [expect.stringContaining('could not be verified')] });
    policy = {};
    projectNumber = '99999';
    await expect(planInfrastructureEngine(ctx, params)).resolves.toMatchObject({ blocked: [expect.stringContaining('could not be verified')] });
    projectNumber = '12345';
    const firstGrant = await plan();
    const original = CloudRunAdapter.prototype.engineConnection;
    const changed = vi.spyOn(CloudRunAdapter.prototype, 'engineConnection').mockImplementation(function (this: CloudRunAdapter) {
      return { ...original.call(this), runtimeServiceAccountEmail: 'another@demo-project.iam.gserviceaccount.com' };
    });
    await apply(firstGrant);
    expect(applyEngine).not.toHaveBeenCalled();
    changed.mockRestore();
    const result = await apply(await plan());
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(applyEngine).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ approvedAddresses: [address] }));
    expect(read.mock.calls.some(([url]) => url.endsWith(':access'))).toBe(false);
    const grantBinding = ctx.repos.environments.findById(environment.id)!.platformBindings;
    expect(() => mergeRepoPlatformBindings({}, { engine: { runtimeSecretGrantOrigins: { [secret]: { name, createTime } } } })).toThrow(/local/);
    expect(() => mergeRepoPlatformBindings(grantBinding, { engine: null })).toThrow(/local/);
    expect(mergeRepoPlatformBindings(grantBinding, { engine: { kind: 'opentofu' } }).engine).toMatchObject({
      runtimeSecretGrantOrigins: { [secret]: { name, createTime } },
    });
    // An unsuccessful create on a replacement cannot transfer ownership of a later independent grant.
    createTime = '2026-03-02T00:00:00Z';
    applyEngine.mockResolvedValueOnce({ outcomes: { [address]: 'not_started' }, diagnostics: ['Stale state'] });
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.engine).toMatchObject({
      runtimeSecretGrantOrigins: { [secret]: { name, createTime: originalTime } },
    });
    // Opting out removes the engine-owned IAM member without retiring an unrelated service of the same name.
    removing = true;
    delete params.spec.environments.staging!.hosting.gcpRuntimeSecretGrants;
    policy = { bindings: [{ role, members: [member, otherMember] }] };
    const services = { [secret]: { serviceId: 'collision' } };
    ctx.repos.environments.updatePlatformBindings(environment.id, { services });
    createTime = '2026-03-02T00:00:00Z';
    await expect(planInfrastructureEngine(ctx, params)).resolves.toMatchObject({ blocked: [expect.stringContaining('original secret')] });
    createTime = originalTime;
    const withdrawn = await apply(await plan());
    expect(withdrawn).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.services).toEqual(services);
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings.engine).toMatchObject({ runtimeSecretGrantOrigins: {} });
  });

  it('blocks unknown or foreign containers without writing versions', async () => {
    const { labels } = owned();
    for (const response of [new Response('', { status: 403 }), Response.json({ labels: { ...labels, 'managed-by': 'another-owner' } })]) {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) throw new Error('Unowned container must not be mutated.');
        return url.endsWith('/versions/latest') ? new Response('', { status: 404 }) : response;
      });
      vi.stubGlobal('fetch', fetch);
      expect(await writeSecretVersion('test-token', 'demo-project', secret, labels, 'private-value')).toMatchObject({ success: false, status: 'blocked' });
      expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    }
  });


  it.each([false, true])('prepares imported secret containers before copying values (legacy database alias: %s)', async legacyAlias => {
    const { ctx, project, environment } = owned();
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'gcp',
      ...(legacyAlias ? { platformBindings: { engine: { pendingImportedSecrets: ['APP_DB'], retainedDatabaseAliasImports: ['OLD_DB'] } } } : {}) });
    ctx.repos.services.create({ projectId: project.id, name: 'web' });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} } },
      gcp: { hosting: { provider: 'cloudrun' }, ...(legacyAlias ? { database: { provider: 'cloudsql' } } : {}),
        services: { web: legacyAlias ? { databaseEnvAliases: { APP_DB: 'DATABASE_URL' } } : {} } },
    } });
    new ProjectSpecRepository().insert(project.id, 1, spec);
    const events: string[] = [];
    const engineContext = { environment: target, gcpProjectId: 'demo-project', region: 'us-central1',
      adapter: { engineAccessToken: async () => 'test-token' } } as unknown as infrastructure.EngineContext;
    vi.spyOn(infrastructure, 'resolveEngineContext').mockResolvedValue(engineContext);
    vi.spyOn(hosting, 'readHostingEnvVars').mockResolvedValue({ success: true, provider: 'railway',
      variables: { API_KEY: 'private-value', ...(legacyAlias ? { OLD_DB: 'service=legacy' } : {}) } });
    const write = vi.spyOn(infrastructure, 'writeSecretVersion').mockImplementation(async () => { events.push('copy-value'); return undefined; });
    let authorized = false;
    let rounds = 0;
    vi.spyOn(launch, 'launchEnvironment').mockImplementation(async (_ctx, params) => {
      if (params.stopAfter === 'prepare') return { status: 'ready', phase: 'prepare', infrastructureRounds: 0 };
      events.push('container-plan');
      const binding = ctx.repos.environments.findById(target.id)!.platformBindings as { engine?: infrastructure.EngineBinding };
      if (!authorized) {
        expect(binding.engine?.pendingImportedSecrets?.sort()).toEqual(legacyAlias ? ['API_KEY', 'APP_DB'] : ['API_KEY']);
        return { status: 'needs_confirmation', confirmActions: ['secret-container:hv-gcp-api-key'], changes: [], estimatedMonthlyCost: {} } as unknown as launch.LaunchResult;
      }
      rounds++;
      if (legacyAlias && rounds === 1) {
        ctx.repos.environments.updatePlatformBindings(target.id, { engine: infrastructure.retainDatabaseAliasImports(binding.engine!, ['APP_DB']) });
      }
      return rounds === 1 ? { status: 'ready', phase: 'infrastructure', infrastructureRounds: 1 }
        : { status: 'blocked', message: 'WIRE_ROUND_REACHED' };
    });
    const params = { project, from: environment.name, to: target.name, importSecrets: true };
    expect(await migrateEnvironment(ctx, params)).toMatchObject({ status: 'needs_confirmation' });
    expect(write).not.toHaveBeenCalled();
    authorized = true;
    events.length = 0;
    expect(await migrateEnvironment(ctx, params)).toMatchObject({ status: 'blocked', message: 'WIRE_ROUND_REACHED' });
    expect(events).toEqual(['container-plan', 'copy-value', 'container-plan']);
    expect((ctx.repos.environments.findById(target.id)!.platformBindings as { engine: infrastructure.EngineBinding }).engine).toMatchObject({ importedSecrets: ['API_KEY'], pendingImportedSecrets: [] });
  });


  it('does not apply old credential metadata to an unacknowledged new version', async () => {
    const { labels, ctx, environment } = owned();
    let version = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) { version = '2'; throw new Error('Acknowledgement lost'); }
      return Response.json(url.endsWith('/versions/latest') ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/${version}` }
        : { labels: { ...labels, 'hv-db-generation': '1', 'hv-db-login': 'app_a' } });
    }));
    expect(await writeSecretVersion('test-token', 'demo-project', secret, { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' }, 'private-value')).toMatchObject({ success: false, status: 'pending' });
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('unrecognized version') });
    expect(JSON.stringify(ctx.repos.environments.findById(environment.id)!.platformBindings)).not.toContain('private-value');
  });

  // #573: a save whose response was lost may have been stored. Read what is stored before ever adding another version.
  describe('a value write whose response was lost', () => {
    function cloud(options: { committed: boolean; readable?: boolean }) {
      let version = '1'; let stored = 'old-value'; const posts: string[] = []; let failNext = true;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(url);
          if (failNext) { failNext = false; if (options.committed) { version = '2'; stored = 'private-value'; } throw new Error('Acknowledgement lost'); }
          version = String(Number(version) + 1); stored = JSON.parse(String(init.body)).payload ? Buffer.from(JSON.parse(String(init.body)).payload.data, 'base64').toString('utf8') : stored;
          return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/${version}` });
        }
        if (url.endsWith('/versions/latest:access')) return options.readable === false ? new Response('no', { status: 503 })
          : Response.json({ name: `projects/demo-project/secrets/${secret}/versions/${version}`, payload: { data: Buffer.from(stored).toString('base64') } });
        if (url.endsWith('/versions/latest')) return Response.json({ state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/${version}` });
        return Response.json({ name: `projects/demo-project/secrets/${secret}`, labels: current.labels });
      }));
      return { posts };
    }
    let current: { labels: Record<string, string> };

    it('counts as saved when the stored value is the one being written, with no second version', async () => {
      const fixture = ownedLabels(); current = fixture;
      const { posts } = cloud({ committed: true });
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value')).toBeUndefined();
      expect(posts).toHaveLength(1);
      expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { latestVersion: '2' } });
    });

    it('stays unknown, not saved and not failed, when the stored value cannot be read', async () => {
      const fixture = ownedLabels(); current = fixture;
      const { posts } = cloud({ committed: true, readable: false });
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value')).toMatchObject({ success: false, status: 'pending' });
      expect(posts).toHaveLength(1);
      expect((await observeSecret('test-token', 'demo-project', secret)).state).toBe('unknown');
    });

    it('reports a save that did not go through as safe to repeat', async () => {
      const fixture = ownedLabels(); current = fixture;
      cloud({ committed: false });
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value')).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/was not stored/) });
      // Nothing changed remotely, so the next attempt is an ordinary write.
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value')).toBeUndefined();
    });

    it('a retry with the value that is already stored adopts it; a different value stays blocked; neither adds a version', async () => {
      const fixture = ownedLabels(); current = fixture;
      cloud({ committed: true, readable: false });
      await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value');
      // Same cloud state, now readable: version 2 holds private-value and Hypervibe has not recorded it.
      const posts: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') { posts.push(url); return Response.json({ name: `projects/demo-project/secrets/${secret}/versions/3` }); }
        if (url.endsWith('/versions/latest:access')) return Response.json({ payload: { data: Buffer.from('private-value').toString('base64') } });
        if (url.endsWith('/versions/latest')) return Response.json({ state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/2` });
        return Response.json({ name: `projects/demo-project/secrets/${secret}`, labels: fixture.labels });
      }));
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'a-different-value')).toMatchObject({ success: false, status: 'blocked' });
      expect(await writeSecretVersion('test-token', 'demo-project', secret, fixture.labels, 'private-value')).toBeUndefined();
      expect(posts).toEqual([]);
      expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { latestVersion: '2' } });
    });
  });

  it('preserves adopted labels while exact-version metadata clears a completed retirement', async () => {
    const { labels } = owned();
    const legacy = { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b', 'hv-db-retire': 'app_a' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/versions/latest')
      ? { state: 'ENABLED', name: `projects/demo-project/secrets/${secret}/versions/7` } : { labels: legacy })));
    expect(await observeSecret('test-token', 'demo-project', secret)).toMatchObject({ state: 'present', value: { labels: legacy } });
    expect(recordSecretVersionMetadata('demo-project', secret, '7', { ...labels, 'hv-db-generation': '2', 'hv-db-login': 'app_b' })).toBe(true);
    const observed = await observeSecret('test-token', 'demo-project', secret);
    expect(observed).toMatchObject({ state: 'present', value: { containerLabels: legacy, labels: { 'hv-db-generation': '2', 'hv-db-login': 'app_b' } } });
    if (observed.state !== 'present') throw new Error('Expected owned container');
    expect(observed.value.labels).not.toHaveProperty('hv-db-retire');
  });

});
