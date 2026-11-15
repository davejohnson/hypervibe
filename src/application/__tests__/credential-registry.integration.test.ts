import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import '../providers.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-registry-integration-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

it('one frozen plan synchronizes exact GitHub aliases and a native registry secret, recovering a lost provider response without another replacement', async () => {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'registry-integration', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/application' });
  const inputFile = path.join(directory, '.env'); writeFileSync(inputFile, 'INPUT=reviewed-package-token\n', { mode: 0o600 });
  const credential = { role: 'package-downloads', kind: 'opaque', label: 'Package downloads', purpose: 'Build packages and pull deployed containers', source: `dotenv:${inputFile}#INPUT`, containerPull: [{ environment: 'production', service: 'web', username: 'package-reader' }] };
  const spec = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    github: { repository: 'acme/application', canonicalEnvironment: 'production' }, secrets: {
      NODE_AUTH_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: [], githubActions: { repository: true }, credential },
      IMAGE_REGISTRY_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: [], githubActions: { environments: ['Production/eu'] }, credential },
    }, environments: { production: { hosting: { provider: 'cloudrun' }, envFile: { mode: 'off' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } } });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-west1', services: { web: { serviceId: 'web', resourceUid: 'workload-uid' } } } });
  ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  for (const provider of ['cloudrun', 'github']) { const connection = ctx.repos.connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-management-token' }) }); ctx.repos.connections.updateStatus(connection.id, 'verified'); }
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  // Unrelated hosting observation has no activation proof. The actual registered
  // registry client below executes all exact workload/repository/secret reads.
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null } as any);
  const workload = 'projects/gcp-project/locations/us-west1/services/web';
  const repository = 'projects/gcp-project/locations/us-west1/repositories/remote';
  const secret = 'projects/gcp-project/secrets/pull';
  let currentVersion = `${secret}/versions/1`; let secretValue = 'old-package-token'; let additions = 0; let patches = 0; let interrupt = true;
  const githubWrites: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.github.com') {
      if (init?.method === 'PUT') { githubWrites.push(url.pathname); expect(String(init.body)).not.toContain('reviewed-package-token'); return new Response(null, { status: 204 }); }
      if (url.pathname.endsWith('/public-key')) return Response.json({ key_id: 'key-id', key: Buffer.alloc(32, 1).toString('base64') });
      if (url.pathname.endsWith('/environments/Production%2Feu')) return Response.json({ id: 17, name: 'Production/eu' });
      if (url.pathname.endsWith('/environments')) return Response.json({ total_count: 1, environments: [{ id: 17, name: 'Production/eu' }] });
      const secrets = githubWrites.filter(write => write.startsWith(url.pathname + '/')).map(write => ({ name: write.split('/').at(-1), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));
      return Response.json({ total_count: secrets.length, secrets });
    }
    if (url.hostname === 'run.googleapis.com') return Response.json({ name: workload, uid: 'workload-uid', template: { containers: [{ image: 'us-west1-docker.pkg.dev/gcp-project/remote/acme/app:stable' }] } });
    if (url.hostname === 'artifactregistry.googleapis.com') {
      if (init?.method === 'PATCH') { patches++; currentVersion = JSON.parse(String(init.body)).remoteRepositoryConfig.upstreamCredentials.usernamePasswordCredentials.passwordSecretVersion; }
      return Response.json({ name: repository, mode: 'REMOTE_REPOSITORY', format: 'DOCKER', remoteRepositoryConfig: { dockerRepository: { customRepository: { uri: 'https://ghcr.io' } }, upstreamCredentials: { usernamePasswordCredentials: { username: 'package-reader', passwordSecretVersion: currentVersion } } } });
    }
    expect(url.hostname).toBe('secretmanager.googleapis.com');
    if (url.pathname.endsWith(':addVersion')) {
      additions++; secretValue = Buffer.from(JSON.parse(String(init?.body)).payload.data, 'base64').toString('utf8');
      if (interrupt) { interrupt = false; throw new Error('synthetic lost response'); }
      return Response.json({ name: `${secret}/versions/2`, state: 'ENABLED' });
    }
    const latest = url.pathname.includes('/latest:access');
    const version = latest && additions || url.pathname.includes('/versions/2:access') ? '2' : '1';
    return Response.json({ name: `${secret}/versions/${version}`, payload: { data: Buffer.from(version === '2' ? secretValue : 'old-package-token').toString('base64') } });
  }));
  const plan = await new PlanService().plan(project, 'production', { scope: 'credentials', credential: 'package-downloads', intent: 'rotate' });
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.actions).toHaveLength(3);
  expect(plan.actions.find(action => (action.metadata?.target as any).kind === 'registry')?.reason).toContain('activation waits for managed rollout');
  const confirmActions = plan.actions.map(action => action.id);
  const apply = () => executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId: plan.planRunId, confirmActions });
  expect(await apply()).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(additions).toBe(1);
  writeFileSync(inputFile, 'INPUT=unaccepted-local-edit\n');
  const resumed = await apply();
  expect(resumed).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(additions).toBe(1); expect(patches).toBe(1); expect(secretValue).toBe('reviewed-package-token');
  expect(githubWrites.sort()).toEqual(['/repos/acme/application/actions/secrets/NODE_AUTH_TOKEN', '/repos/acme/application/environments/Production%2Feu/secrets/IMAGE_REGISTRY_TOKEN']);
  expect(ctx.repos.environments.findById(environment.id)!.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'web', provider: 'cloudrun' })]));
  expect(JSON.stringify(resumed)).not.toContain('reviewed-package-token'); expect(JSON.stringify(resumed)).not.toContain('unaccepted-local-edit');
});
