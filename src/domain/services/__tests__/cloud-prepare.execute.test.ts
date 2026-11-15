import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { runCloudPrepare } from '../cloud-prepare.execute.js';
import { getCloudPrepareProfile, isCloudPrepared } from '../cloud-prepare.js';

const setup = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ success: true, mode: 'preview', planId: 'saved-setup', actions: [] as unknown[], error: undefined as string | undefined })));
vi.mock('../gcp-project-setup.service.js', () => ({ runGcpProjectSetup: setup, getGcpProjectSetupContribution: () => undefined }));
vi.mock('google-auth-library', () => ({ GoogleAuth: class {
  async getClient() { return { getAccessToken: async () => ({ token: 'private-admin-token' }) }; }
} }));

const RUNTIME_SERVICE_ACCOUNT_EMAIL =
  'hypervibe-runtime@hls-property-care.iam.gserviceaccount.com';
const DEPLOY_SERVICE_ACCOUNT_EMAIL =
  'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com';

describe('runCloudPrepare', () => {
  let tempDir: string;

  beforeEach(() => {
    setup.mockReset();
    setup.mockResolvedValue({ success: true, mode: 'preview', planId: 'saved-setup', actions: [], error: undefined });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-cloud-prepare-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedProject() {
    const projectRepo = new ProjectRepository();
    const connectionRepo = new ConnectionRepository();
    const project = projectRepo.create({
      name: 'hls-property-care',
      defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'git@github.com:davejohnson/hls-property-care.git',
    });
    connectionRepo.create({
      provider: 'cloudrun',
      scope: 'davejohnson/hls-property-care',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'hls-property-care',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'hls-property-care',
          private_key: 'not-used',
          client_email: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        }),
      }),
    });
    return project;
  }

  it('previews the bootstrap plan from the existing Cloud Run deploy connection', async () => {
    const project = seedProject();

    const payload = await runCloudPrepare({ project, provider: 'cloudrun' });

    expect(payload).toMatchObject({
      success: true,
      mode: 'preview',
      plan: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v2',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        member: 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    const plan = payload.plan as { enableApis: string[]; grantRoles: string[] };
    expect(plan.enableApis).toContain('cloudscheduler.googleapis.com');
    expect(plan.grantRoles).toContain('roles/logging.viewAccessor');
    expect(plan.grantRoles).toContain('roles/cloudscheduler.admin');
    expect(plan.grantRoles).toContain('roles/iam.serviceAccountUser');
    expect(plan.enableApis).not.toContain('storage.googleapis.com');
    expect(plan.enableApis).not.toContain('redis.googleapis.com');
    expect(plan.enableApis).not.toContain('pubsub.googleapis.com');
    expect(plan.grantRoles).not.toContain('roles/storage.viewer');
    expect(plan.grantRoles).not.toContain('roles/storage.admin');
    expect(plan.grantRoles).not.toContain('roles/redis.viewer');
    expect(plan.grantRoles).not.toContain('roles/redis.admin');
    expect(plan.grantRoles).not.toContain('roles/pubsub.editor');
  });

  it('separates least-privilege workload roles from the deploy identity', async () => {
    const project = seedProject();

    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
    });

    const plan = payload.plan as {
      deployServiceAccountEmail: string;
      runtimeServiceAccountEmail: string;
      member: string;
      runtimeMember: string;
      grantRoles: string[];
      revokeRoles: string[];
      runtimeGrantRoles: string[];
      runtimeServiceAccountGrantRoles: string[];
    };
    expect(plan.runtimeServiceAccountEmail).toBe(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    expect(plan.runtimeMember).toBe(`serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}`);
    expect(plan.grantRoles).toContain('roles/run.admin');
    expect(plan.grantRoles).toContain('roles/cloudsql.admin');
    expect(plan.grantRoles).not.toContain('roles/cloudsql.client');
    expect(plan.grantRoles).not.toContain('roles/iam.serviceAccountUser');
    expect(plan.revokeRoles).toEqual(['roles/iam.serviceAccountUser']);
    expect(plan.runtimeGrantRoles).toEqual([
      'roles/cloudsql.client',
      'roles/secretmanager.secretAccessor',
    ]);
    expect(plan.runtimeServiceAccountGrantRoles).toEqual([
      'roles/iam.serviceAccountUser',
    ]);
    expect(plan.runtimeMember).not.toBe(plan.member);
  });

  it('requires v2 exact runtime access evidence while retaining no-runtime compatibility', () => {
    const profile = getCloudPrepareProfile('cloudrun')!;
    const record = {
      provider: 'cloudrun',
      version: 'gcp-cloudrun-v2',
      preparedAt: '2026-09-10T00:00:00.000Z',
      gcpProjectId: 'hls-property-care',
      deployServiceAccountEmail: DEPLOY_SERVICE_ACCOUNT_EMAIL,
      requiredApis: [...profile.requiredApis],
      requiredRoles: [...profile.requiredRoles],
    };
    const projectWith = (cloudrun: Record<string, unknown>) => ({
      policies: { cloudPreparation: { cloudrun } },
    });

    expect(isCloudPrepared(projectWith(record), 'cloudrun')).toBe(true);
    expect(isCloudPrepared(projectWith({ ...record, version: 'gcp-cloudrun-v1' }), 'cloudrun'))
      .toBe(false);

    const exactRuntimeRecord = {
      ...record,
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      runtimeServiceAccountUniqueId: '123456789012345678901',
      requiredRoles: record.requiredRoles.filter((role) => ![
        'roles/cloudsql.client',
        'roles/secretmanager.secretAccessor',
        'roles/iam.serviceAccountUser',
      ].includes(role)),
      runtimeRequiredRoles: [
        'roles/cloudsql.client',
        'roles/secretmanager.secretAccessor',
      ],
      runtimeServiceAccountAccessRoles: ['roles/iam.serviceAccountUser'],
    };
    expect(isCloudPrepared(projectWith(exactRuntimeRecord), 'cloudrun')).toBe(true);
    expect(isCloudPrepared(projectWith({
      ...exactRuntimeRecord,
      runtimeServiceAccountUniqueId: undefined,
    }), 'cloudrun')).toBe(false);
    expect(isCloudPrepared(projectWith({
      ...exactRuntimeRecord,
      requiredRoles: [...exactRuntimeRecord.requiredRoles, 'roles/iam.serviceAccountUser'],
    }), 'cloudrun')).toBe(false);
  });

  it('previews least-privilege GCS inspection separately from lifecycle access', async () => {
    const project = seedProject();

    const inspected = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect' });
    const inspectPlan = inspected.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(inspectPlan).toMatchObject({ gcsAccess: 'inspect' });
    expect(inspectPlan.enableApis).toEqual(['storage.googleapis.com']);
    expect(inspectPlan.grantRoles).toEqual(['roles/storage.viewer']);

    const lifecycle = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle' });
    const lifecyclePlan = lifecycle.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(lifecyclePlan).toMatchObject({ gcsAccess: 'lifecycle' });
    expect(lifecyclePlan.enableApis).toEqual(['storage.googleapis.com']);
    expect(lifecyclePlan.grantRoles).toEqual(['roles/storage.admin']);
  });

  it('previews project-scoped object access on the runtime identity separately from storage administration', async () => {
    const project = seedProject();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL });
    expect(result).toMatchObject({ mode: 'preview', plan: {
      grantRoles: ['roles/storage.admin'], runtimeGrantRoles: ['roles/storage.objectUser'],
      runtimeGrantScope: 'project',
      runtimeMember: `serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}`,
    } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps Memorystore and Pub/Sub preparation independently explicit', async () => {
    const project = seedProject();

    const inspected = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      memorystoreAccess: 'inspect',
    });
    const inspectPlan = inspected.plan as {
      enableApis: string[];
      grantRoles: string[];
      memorystoreAccess: string;
    };
    expect(inspectPlan).toMatchObject({ memorystoreAccess: 'inspect' });
    expect(inspectPlan.enableApis).toEqual(['compute.googleapis.com', 'redis.googleapis.com']);
    expect(inspectPlan.grantRoles).toEqual(['roles/compute.networkViewer', 'roles/redis.viewer']);

    const queue = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'lifecycle',
    });
    const queuePlan = queue.plan as {
      enableApis: string[];
      grantRoles: string[];
      queueAccess: string;
      runtimeServiceAccountGrantRoles: string[];
    };
    expect(queuePlan).toMatchObject({ queueAccess: 'lifecycle' });
    expect(queuePlan.enableApis).toEqual(['pubsub.googleapis.com']);
    expect(queuePlan.grantRoles).toEqual(['roles/pubsub.editor']);
    expect(queuePlan.runtimeServiceAccountGrantRoles).toEqual([]);

    const removal = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'remove',
    });
    expect(removal.plan).toMatchObject({
      enableApis: [],
      grantRoles: [],
      revokeRoles: ['roles/pubsub.editor'],
      queueAccess: 'remove',
    });
  });

  it('requires admin credentials when confirming', async () => {
    const project = seedProject();
    const payload = await runCloudPrepare({ project, provider: 'cloudrun', confirm: true });
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('adminAuth="default"');

    const cleanup = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      queueAccess: 'remove',
      confirm: true,
    });
    expect(cleanup.requiredAdminPermissions).toEqual([
      'resourcemanager.projects.getIamPolicy',
      'resourcemanager.projects.setIamPolicy',
    ]);
  });
  it('sends only the selected add-on to the saved project setup boundary', async () => {
    const project = seedProject();
    await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect', adminAccessToken: 'private-admin-token' });
    const submitted = setup.mock.lastCall?.[0] as { confirm: boolean; contribution: { id: string; configuration: { files: unknown; resources: unknown } }; auth: { env: unknown } };
    expect(submitted.confirm).toBe(false);
    expect(submitted.contribution.id).toBe('prepare-gcs-inspect');
    expect(JSON.stringify(submitted.contribution)).toContain('roles/storage.viewer');
    expect(JSON.stringify(submitted.contribution)).not.toContain('roles/pubsub.editor');
    expect(JSON.stringify(submitted.contribution)).not.toContain('private-admin-token');
  });

  it('returns a blocked engine confirmation without making provider calls or recording access', async () => {
    setup.mockResolvedValue({ success: false, mode: 'confirm', planId: 'saved-setup', actions: [], error: 'Preview the exact setup again.' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const project = seedProject();
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect', adminAccessToken: 'private-admin-token', confirm: true });
    expect(result).toMatchObject({ success: false, error: 'Preview the exact setup again.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new ProjectRepository().findById(project.id)?.policies.cloudPreparation).toBeUndefined();
  });

  it.each([true, false])('verifies role convergence after engine apply before recording preparation (converged=%s)', async (converged) => {
    setup.mockResolvedValue({ success: true, mode: 'confirm', planId: 'saved-setup', actions: [], error: undefined });
    const requests: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method });
      if (url.endsWith('/projects/hls-property-care')) return Response.json({ name: 'projects/12345', projectId: 'hls-property-care', state: 'ACTIVE' });
      if (url.includes('/services/storage.googleapis.com')) return Response.json({ name: 'projects/12345/services/storage.googleapis.com', parent: 'projects/12345', config: { name: 'storage.googleapis.com' }, state: 'ENABLED' });
      if (url.endsWith(':getIamPolicy')) return Response.json({ version: 1, etag: 'observed', bindings: converged ? [{ role: 'roles/storage.viewer', members: [`serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}`] }] : [] });
      throw new Error(`Unexpected request ${url}`);
    }));
    const project = seedProject();
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect', adminAccessToken: 'private-admin-token', confirm: true });
    expect(result.success).toBe(converged);
    expect(requests.filter(({ method, url }) => method && method !== 'GET' && !url.endsWith(':getIamPolicy'))).toEqual([]);
    expect(Boolean(new ProjectRepository().findById(project.id)?.policies.cloudPreparation)).toBe(converged);
  });

  it('refuses to remove grants that are not owned by project setup state', async () => {
    const project = seedProject();
    const result = await runCloudPrepare({ project, provider: 'cloudrun', queueAccess: 'remove', adminAccessToken: 'private-admin-token' });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not owned') });
    expect(setup).not.toHaveBeenCalled();
  });

});
