import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import * as repositories from '../../adapters/providers/gcp/gcp-image-repository.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import * as preparation from '../../domain/services/cloud-prepare.execute.js';
import { getCloudPrepareProfile } from '../../domain/services/cloud-prepare.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { applyInfrastructureEngine, planInfrastructureEngine } from '../infrastructure-engine.js';
import { launchEnvironment } from '../launch.js';

const projectId = 'storage-production';
const permission = 'storage.hmacKeys.create';
const iamUrl = `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}:testIamPermissions`;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-storage-key-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(options: { s3?: boolean; published?: boolean; recorded?: boolean; foreign?: boolean } = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'storage', gitRemoteUrl: 'https://github.com/example/storage' });
  const env = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
  const profile = getCloudPrepareProfile('cloudrun')!;
  ctx.repos.projects.updatePolicies(project.id, () => ({ gcpProjectPreparations: { [projectId]: {
    version: profile.version, preparedAt: '2026-11-19', gcpProjectId: projectId,
    requiredApis: [...profile.requiredApis], requiredRoles: [...profile.requiredRoles, 'roles/storage.admin', ...(options.recorded ? ['roles/storage.hmacKeyAdmin'] : [])],
    artifactRepositoryRegions: ['us-central1'],
  } } }));
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', scope: 'example/storage#gcp:' + projectId,
    credentialsEncrypted: ctx.secretStore.encryptObject({ projectId, runtimeServiceAccountEmail: 'runtime@' + projectId + '.iam.gserviceaccount.com',
      credentials: JSON.stringify({ type: 'service_account', project_id: projectId, client_email: 'deploy@' + projectId + '.iam.gserviceaccount.com', private_key: 'synthetic-key' }) }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'cloudrun', gcpProjectId: projectId }, services: {},
    storage: { documents: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: [], ...(options.s3 === false ? {} : { access: 's3' }) } },
  } } });
  const params = { project, spec, environmentName: env.name, specRevision: 1 };
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('deploy-token');
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/unused' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(directory);
  vi.spyOn(repositories, 'observeImageRepository').mockResolvedValue({ state: 'present' });
  const enginePlan = vi.spyOn(OpenTofuEngine.prototype, 'plan').mockResolvedValue({ ok: true, segmentId: 'segment', planFile: '/unused',
    segment: { id: 'segment', engine: 'opentofu', planDigest: 'a', configurationDigest: 'b', engineVersion: '1', providerVersions: {} },
    actions: [], blockers: [], unmanagedDeletes: [] });
  const engineApply = vi.spyOn(OpenTofuEngine.prototype, 'apply').mockRejectedValue(new Error('Unexpected provider mutation'));
  const prepare = vi.spyOn(preparation, 'runCloudPrepare').mockResolvedValue({ success: true, mode: 'preview', planId: 'review-access' });
  let iam = () => Response.json({});
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === iamUrl) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer deploy-token');
      expect(JSON.parse(String(init?.body))).toEqual({ permissions: [permission] });
      return iam();
    }
    if (init?.method) throw new Error('Unexpected provider write');
    if (url.includes('/secrets?')) return Response.json({});
    if (!url.includes('/secrets/')) throw new Error('Unexpected URL ' + url);
    if (!options.published) return new Response(null, { status: 404 });
    if (url.endsWith('/versions/latest')) return Response.json({ state: 'ENABLED', name: url.split('/v1/')[1]!.replace('/latest', '/1') });
    return Response.json({ labels: { 'managed-by': options.foreign ? 'other-manager' : 'hypervibe', 'hv-environment': env.id } });
  });
  vi.stubGlobal('fetch', fetch);
  return { plan: () => planInfrastructureEngine(ctx, params),
    apply: (planId: string, confirmActions: string[]) => applyInfrastructureEngine(ctx, { ...params, planId, confirmActions }),
    launch: (approveAccess?: string[]) => launchEnvironment(ctx, { ...params, stopAfter: 'prepare', approveAccess }),
    setIam: (response: () => Response) => { iam = response; }, prepare, enginePlan, engineApply, fetch };
}

it('blocks the infrastructure preview on missing key-create permission and offers the scoped S3 access preview', async () => {
  const f = fixture();
  expect(await f.plan()).toMatchObject({ blocked: [expect.stringContaining(permission)] });
  expect(f.enginePlan).not.toHaveBeenCalled();
  expect(await f.launch()).toMatchObject({ status: 'needs_access', accessId: 'storage-s3', grants: { planId: 'review-access' } });
  expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ environmentProjectId: projectId, gcsAccess: 's3', confirm: false }));
  f.setIam(() => Response.json({ permissions: [permission] }));
  expect(await f.plan()).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({ id: 'storage-s3-key:documents', verified: true })]) });
  expect(await f.launch()).toMatchObject({ status: 'ready', phase: 'prepare' });
  expect(f.prepare).toHaveBeenCalledTimes(1);
});

it('previews a scoped repair when a recorded grant is no longer effective', async () => {
  const f = fixture({ recorded: true });
  expect(await f.launch()).toMatchObject({ status: 'needs_access', accessId: 'storage-s3' });
  expect(f.prepare).toHaveBeenCalledOnce();
});

it('checks both ownership labels before treating a key pair as published', async () => {
  const f = fixture({ published: true, foreign: true });
  expect(await f.launch()).toMatchObject({ status: 'blocked', message: expect.stringContaining('ownership') });
  expect(f.prepare).not.toHaveBeenCalled();
});

it('verifies the effective permission after a reviewed grant before reporting preparation ready', async () => {
  const f = fixture();
  expect(await f.launch()).toMatchObject({ status: 'needs_access', accessId: 'storage-s3' });
  expect(await f.launch(['storage-s3'])).toMatchObject({ status: 'blocked', message: expect.stringContaining('not yet effective') });
  f.prepare.mockImplementationOnce(async () => {
    f.setIam(() => Response.json({ permissions: [permission] }));
    return { success: true, mode: 'applied' };
  });
  expect(await f.launch(['storage-s3'])).toMatchObject({ status: 'ready', phase: 'prepare' });
  expect(f.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ environmentProjectId: projectId, gcsAccess: 's3', confirm: true }));
});

it('rechecks permission before executing an already reviewed plan', async () => {
  const f = fixture();
  f.setIam(() => Response.json({ permissions: [permission] }));
  const plan = await f.plan();
  if ('blocked' in plan) throw new Error(plan.blocked.join(' '));
  f.setIam(() => Response.json({}));
  expect(await f.apply(plan.planRunId, plan.confirmActions)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining(permission) });
  expect(f.engineApply).not.toHaveBeenCalled();
});

it.each([() => new Response(null, { status: 403 }), () => Response.json({ permissions: 'invalid' }), () => { throw new Error('offline'); }])(
  'keeps an inconclusive permission check separate from an IAM grant', async response => {
    const f = fixture();
    f.setIam(response);
    expect(await f.plan()).toMatchObject({ blocked: [expect.stringMatching(/could not verify/i)] });
    expect(await f.launch()).toMatchObject({ status: 'blocked', message: expect.stringMatching(/could not verify/i) });
    expect(f.prepare).not.toHaveBeenCalled();
  });

it.each([{ s3: false }, { published: true }])('skips key-create access when no new key is needed (%j)', async options => {
  const f = fixture(options);
  expect(await f.plan()).toMatchObject({ actions: [] });
  expect(await f.launch()).toMatchObject({ status: 'ready', phase: 'prepare' });
  expect(f.fetch.mock.calls.map(([url]) => url)).not.toContain(iamUrl);
  expect(f.prepare).not.toHaveBeenCalled();
});
