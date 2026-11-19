import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import { engineStatePaths } from '../../adapters/engine/opentofu/workspace.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { applyGcpInfrastructureEngine, resolveEngineContext } from '../infrastructure-engine.js';
import { launchEnvironment } from '../launch.js';

let directory: string;
const production = 'project-production';
const staging = 'project-staging';
const region = 'us-central1';
const prior = { engine: { importedSecrets: ['API_TOKEN'] } };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-apply-target-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider call'); }));
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/unused' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('synthetic-token');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(type: 'noop' | 'create' = 'create') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'target-test', gitRemoteUrl: 'https://github.com/example/app' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: prior });
  for (const [scope, projectId] of [['example/app#gcp:' + production, production], ['example/app#gcp:' + staging, staging], ['example/app', staging]] as const) {
    const row = ctx.repos.connections.create({ provider: 'cloudrun', scope,
      credentialsEncrypted: ctx.secretStore.encryptObject({ projectId,
        runtimeServiceAccountEmail: 'runtime@' + projectId + '.iam.gserviceaccount.com',
        credentials: JSON.stringify({ type: 'service_account', project_id: projectId,
          client_email: 'deployer@' + projectId + '.iam.gserviceaccount.com', private_key: 'synthetic-key' }) }) });
    ctx.repos.connections.updateStatus(row.id, 'verified');
  }
  const specFor = (gcpProjectId?: string) => projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    production: { hosting: { provider: 'cloudrun', gcpProjectId, region }, services: { web: {} } },
  } });
  const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
    kind: 'hv_plan', scope: 'infrastructure-engine', environmentName: environment.name, specRevision: 1, observedFingerprint: null,
    engine: { planId: 'tofu-plan', state: { provider: 'gcp', projectId: project.id, environmentId: environment.id, partition: 'environment' },
      gcpProjectId: production, region },
    actions: [{ id: 'service:web', type, requiresConfirm: true, resource: { kind: 'service', name: 'web', provider: 'gcp' },
      verified: true, reason: 'Reviewed service', metadata: { engineSegment: { id: 'opentofu:tofu-plan', engine: 'opentofu',
        planDigest: 'p', configurationDigest: 'c', engineVersion: '1.13.9', providerVersions: {}, addresses: ['google_cloud_run_v2_service.web'] } } }],
  } });
  return {
    state: engineStatePaths({ provider: 'gcp', projectId: project.id, environmentId: environment.id, partition: 'environment' }),
    context: (selected?: string) => resolveEngineContext(ctx, project, specFor(selected), environment.name),
    launch: () => launchEnvironment(ctx, { project, spec: specFor(production), environmentName: environment.name, specRevision: 1 }),
    apply: (confirmActions: string[]) => applyGcpInfrastructureEngine(ctx, { project, spec: specFor(production), specRevision: 1, planId: run.id, confirmActions }),
    read: () => ctx.repos.environments.findById(environment.id)!.platformBindings,
    retry: () => resolveEngineContext(ctx, project, specFor(staging), environment.name),
    bindElsewhere: () => ctx.repos.environments.updatePlatformBindings(environment.id, { provider: 'cloudrun', projectId: staging, region, environmentId: region }),
  };
}

it('retains the reviewed project across interruption of the first provider write and blocks a retargeted retry', async () => {
  const f = fixture();
  let atDispatch: Record<string, unknown> | undefined;
  const provider = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockImplementation(async () => {
    atDispatch = f.read();
    throw new Error('Interrupted before a resource receipt');
  });
  expect(await f.apply(['service:web'])).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(provider).toHaveBeenCalledOnce();
  expect(atDispatch).toEqual({ ...prior, provider: 'cloudrun', projectId: production, region, environmentId: region });
  expect(f.read()).toEqual(atDispatch);
  expect(await f.retry()).toEqual({ blocked: expect.stringContaining(production) });
});

it('requires the original project binding for an explicit selector when earlier environment state survives', async () => {
  const f = fixture();
  mkdirSync(f.state.plans, { recursive: true });
  writeFileSync(join(f.state.plans, 'old.tfplan'), 'old saved plan');
  expect(await f.context(production)).toMatchObject({ gcpProjectId: production });

  writeFileSync(f.state.statePath, 'historical private state');
  expect(await f.context()).toMatchObject({ gcpProjectId: staging });
  expect(await f.context(production)).toEqual({ blocked: expect.stringMatching(/recover.*binding/i) });
  expect(await f.apply(['service:web'])).toMatchObject({ kind: 'blocked' });
  expect(await f.launch()).toMatchObject({ status: 'blocked', message: expect.stringMatching(/recover.*binding/i) });
  expect(f.read()).toEqual(prior);

  f.bindElsewhere();
  expect(await f.context(staging)).toMatchObject({ gcpProjectId: staging });
  expect(await f.context(production)).toEqual({ blocked: expect.stringContaining(staging) });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['unconfirmed', 'noop'] as const)('leaves an unbound environment untouched for a %s plan', async mode => {
  const f = fixture(mode === 'noop' ? 'noop' : 'create');
  const provider = vi.spyOn(OpenTofuEngine.prototype, 'apply');
  expect(await f.apply([])).toMatchObject({ kind: 'executed', result: { success: mode === 'noop' } });
  expect(f.read()).toEqual(prior);
  expect(provider).not.toHaveBeenCalled();
});

it('keeps a binding that changed after context resolution and stops before provider dispatch', async () => {
  const f = fixture();
  vi.mocked(CloudRunAdapter.prototype.engineAccessToken).mockImplementationOnce(async () => {
    f.bindElsewhere();
    return 'synthetic-token';
  });
  const provider = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockRejectedValue(new Error('Unexpected engine dispatch'));
  expect(await f.apply(['service:web'])).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(provider).not.toHaveBeenCalled();
  expect(f.read()).toMatchObject({ ...prior, projectId: staging });
});

it('stops if an older run leaves state during apply preflight', async () => {
  const f = fixture();
  vi.mocked(CloudRunAdapter.prototype.engineAccessToken).mockImplementationOnce(async () => {
    mkdirSync(f.state.root, { recursive: true });
    writeFileSync(f.state.statePath, 'historical private state');
    return 'synthetic-token';
  });
  const provider = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockRejectedValue(new Error('Unexpected engine dispatch'));
  expect(await f.apply(['service:web'])).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(provider).not.toHaveBeenCalled();
  expect(f.read()).toEqual(prior);
});
