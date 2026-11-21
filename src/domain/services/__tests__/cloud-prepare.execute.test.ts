import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { GoogleAuth } from 'google-auth-library';
import * as googleSignIn from '../../../adapters/providers/gcp/google-browser-signin.js';
import * as probe from '../../../application/gcp-transfer-access-probe.js';
import * as transferEvidence from '../../../adapters/providers/gcp/gcp-transfer-slot-evidence.js';
import * as isolationEvidence from '../../../adapters/providers/gcp/gcp-transfer-isolation-evidence.js';
import { transferSlot } from '../../../adapters/providers/gcp/tofu/transfer-slot.js';
import { isolationGrants } from '../../../adapters/providers/gcp/tofu/transfer-isolation.js';
import { runCloudPrepare, verifyAndRecordBootstrapPreparation } from '../cloud-prepare.execute.js';
import { getCloudPreparation, getCloudPrepareProfile, isCloudPrepared } from '../cloud-prepare.js';

const setup = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ success: true, mode: 'preview', planId: 'saved-setup', htmlPath: undefined as string | undefined, actions: [] as unknown[], error: undefined as string | undefined })));
const savedIsolation = vi.hoisted(() => vi.fn());
const contribution = vi.hoisted(() => vi.fn());
vi.mock('../gcp-project-setup.service.js', () => ({ runGcpProjectSetup: setup, getGcpProjectSetupContribution: contribution,
  hasGcpProjectSetup: () => true, getGcpRuntimeIsolation: savedIsolation }));
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
    savedIsolation.mockReset();
    contribution.mockReset();
    setup.mockReset();
    setup.mockResolvedValue({ success: true, mode: 'preview', planId: 'saved-setup', htmlPath: '/reports/saved-setup.html', actions: [], error: undefined });
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

  function seedProject(runtimeServiceAccountEmail?: string) {
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
        runtimeServiceAccountEmail,
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
      htmlPath: '/reports/saved-setup.html',
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

  it('requires a dedicated connection or explicit target identities before accessing Google', async () => {
    const project = seedProject();
    const authorize = vi.fn(async () => 'test-token');
    const result = await runCloudPrepare({ project, provider: 'cloudrun', environmentProjectId: 'app-production',
      defaultAdminAccessTokenProvider: authorize });
    expect(result.success).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires existing Google credentials for an empty transfer slot without browser sign-in (confirm=%s)', async confirm => {
    const project = seedProject(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    const environments = new EnvironmentRepository();
    environments.create({ projectId: project.id, name: 'source', platformBindings: {
      provider: 'railway', projectId: 'railway-project', environmentId: 'railway-source',
    } });
    environments.create({ projectId: project.id, name: 'destination', platformBindings: {
      provider: 'cloudrun', projectId: project.name, environmentId: 'us-central1', engine: { kind: 'opentofu' },
    } });
    const adc = vi.spyOn(GoogleAuth.prototype, 'getClient').mockRejectedValue(new Error('No local credentials'));
    vi.spyOn(googleSignIn, 'configuredGoogleOAuthClient').mockReturnValue({ clientId: 'test-client' });
    const browser = vi.spyOn(googleSignIn, 'signInWithGoogle').mockResolvedValue('browser-access-token');
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected Google request'));
    vi.stubGlobal('fetch', fetch);

    const result = await runCloudPrepare({ project, provider: 'cloudrun',
      migrationAccess: 'empty-transfer-slot', migrationSourceEnvironment: 'source', environmentName: 'destination',
      confirm, ...(confirm ? { gcpSetupPlanId: 'reviewed-plan' } : {}) });
    expect(result.success).toBe(false);
    expect(adc).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();

    const ordinary = await runCloudPrepare({ project, provider: 'cloudrun' });
    expect(ordinary.success).toBe(true);
    expect(browser).toHaveBeenCalledOnce();
  });

  it.each(['verify-copy-access', 'verify-export-file-access'] as const)('dispatches %s only for the original Railway and managed Google bindings and connection identities', async migrationAccess => {
    const project = seedProject(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    const environments = new EnvironmentRepository();
    const source = environments.create({ projectId: project.id, name: 'source', platformBindings: {
      provider: 'railway', projectId: 'railway-project', environmentId: 'railway-source',
    } });
    const destination = environments.create({ projectId: project.id, name: 'destination', platformBindings: {
      provider: 'cloudrun', projectId: project.name, environmentId: 'us-central1', engine: { kind: 'opentofu' },
    } });
    environments.create({ projectId: project.id, name: 'unmanaged', platformBindings: {
      provider: 'cloudrun', projectId: project.name, environmentId: 'us-central1',
    } });
    const token = vi.fn();
    const run = vi.spyOn(probe, 'runGcpTransferAccessProbe').mockResolvedValue({ success: false, error: 'Stopped before cloud access' });
    const readSlot = vi.spyOn(transferEvidence, 'readTransferSlotEvidence');
    const input = { project, provider: 'cloudrun', environmentName: destination.name, migrationSourceEnvironment: source.name,
      migrationAccess, defaultAdminAccessTokenProvider: token };
    const planId = 'probe-ace24cf3-eab9-42d0-9862-b8cf05713c28';
    for (const invalid of [{ confirm: true }, { gcpSetupPlanId: planId }, { region: 'us-west1' }, { environmentName: 'unmanaged' },
      { runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL }, { deployServiceAccountEmail: DEPLOY_SERVICE_ACCOUNT_EMAIL },
      { adminAccessToken: 'separate-token' }, { adminCredentialSource: 'service-account-inline' }, { migrationSourceEnvironment: destination.name }]) {
      expect((await runCloudPrepare({ ...input, ...invalid })).success).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
    for (const confirm of [false, true]) {
      await runCloudPrepare({ ...input, confirm, gcpSetupPlanId: confirm ? planId : undefined });
      expect(run).toHaveBeenLastCalledWith({
        project, target: { projectId: project.name, targetRegion: 'us-central1', sourceEnvironmentId: source.id,
          sourceRailwayProjectId: 'railway-project', sourceRailwayEnvironmentId: 'railway-source', targetEnvironmentId: destination.id },
        targetEnvironmentName: destination.name, sourceEnvironmentName: source.name,
        ...(migrationAccess === 'verify-export-file-access' ? { fileOnly: true } : {}),
        runtimeEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL, deployEmail: DEPLOY_SERVICE_ACCOUNT_EMAIL, token,
        confirm, planId: confirm ? planId : undefined,
      });
    }
    expect(token).not.toHaveBeenCalled();
    expect(readSlot).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it('requires the approved empty slot in the same managed state before planning app restrictions', async () => {
    const project = seedProject(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    const environments = new EnvironmentRepository();
    environments.create({ projectId: project.id, name: 'source', platformBindings: {
      provider: 'railway', projectId: 'railway-project', environmentId: 'railway-source',
    } });
    environments.create({ projectId: project.id, name: 'destination', platformBindings: {
      provider: 'cloudrun', projectId: project.name, environmentId: 'us-central1', engine: { kind: 'opentofu' },
    } });
    const authorize = vi.fn(async () => 'test-token');
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected Google request'));
    vi.stubGlobal('fetch', fetch);
    const result = await runCloudPrepare({ project, provider: 'cloudrun', migrationAccess: 'restrict-app-access',
      migrationSourceEnvironment: 'source', environmentName: 'destination', defaultAdminAccessTokenProvider: authorize });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/approved empty transfer slot/i) });
    expect(authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it('sends the approved source and target to native isolation planning and re-reads Google after apply', async () => {
    const project = seedProject(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    const environments = new EnvironmentRepository();
    const source = environments.create({ projectId: project.id, name: 'source', platformBindings: {
      provider: 'railway', projectId: 'railway-project', environmentId: 'railway-source',
    } });
    const destination = environments.create({ projectId: project.id, name: 'destination', platformBindings: {
      provider: 'cloudrun', projectId: project.name, environmentId: 'us-central1', engine: { kind: 'opentofu' },
    } });
    const target = { projectId: project.name, targetRegion: 'us-central1', sourceRailwayProjectId: 'railway-project',
      sourceRailwayEnvironmentId: 'railway-source', sourceEnvironmentId: source.id, targetEnvironmentId: destination.id };
    const slot = transferSlot(target);
    contribution.mockReturnValue(slot.configuration);
    const createTime = '2026-01-01T00:00:00Z';
    const observation = { projectNumber: '12345', account: { name: 'projects/' + project.name + '/serviceAccounts/' + slot.accountEmail,
      email: slot.accountEmail, uniqueId: '10002', description: slot.description },
      secret: { name: 'projects/12345/secrets/' + slot.secretId, createTime, labels: slot.labels }, directAccessor: true };
    const scope = { target, targetEnvironmentName: destination.name, projectNumber: '12345', runtimeEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      runtimeUniqueId: '10001', bucket: project.name + '-hv-build-source', bucketTimeCreated: createTime,
      copyUniqueId: '10002', secretCreateTime: createTime };
    const evidence = { slot: observation, scope, grants: { 'roles/secretmanager.secretAccessor': 'broad',
      'roles/storage.objectUser': 'broad' } as const, evidenceDigest: 'a'.repeat(64) };
    const readSlot = vi.spyOn(transferEvidence, 'readTransferSlotEvidence').mockResolvedValue(observation);
    const readIsolation = vi.spyOn(isolationEvidence, 'readTransferIsolationEvidence').mockResolvedValue(evidence);
    const result = await runCloudPrepare({ project, provider: 'cloudrun', migrationAccess: 'restrict-app-access', confirm: true,
      migrationSourceEnvironment: source.name, environmentName: destination.name, gcpSetupPlanId: 'reviewed-isolation',
      defaultAdminAccessTokenProvider: async () => 'test-token' });
    expect(result.success, String(result.error)).toBe(true);
    expect(contribution).toHaveBeenCalledWith(project.id, project.name, slot.id);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ confirm: true, gcpSetupPlanId: 'reviewed-isolation',
      transferIsolationReview: evidence, authenticationScope: 'migration:restrict-app-access:' + slot.id }));
    const params = setup.mock.calls[0]![0] as { observeIsolationAfterApply: () => Promise<unknown>; contribution: { configuration: { resources: Record<string, unknown> } } };
    expect(Object.keys(params.contribution.configuration.resources)).toEqual(isolationGrants(scope).map(grant => grant.address));
    readSlot.mockRejectedValueOnce(new Error('slot verification unavailable'));
    await expect(params.observeIsolationAfterApply()).rejects.toThrow('slot verification unavailable');
    expect(readIsolation).toHaveBeenCalledOnce();
  });

  it('rejects conflicting native project selections before authorization or bootstrap verification', async () => {
    const project = seedProject();
    const authorize = vi.fn(async () => 'test-token');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcpProjectId: 'hls-property-care',
      environmentProjectId: 'app-production', defaultAdminAccessTokenProvider: authorize });
    expect(result.success).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    await expect(verifyAndRecordBootstrapPreparation(project, 'test-token', 'hls-property-care',
      DEPLOY_SERVICE_ACCOUNT_EMAIL, RUNTIME_SERVICE_ACCOUNT_EMAIL, 'us-central1', 'app-production')).rejects.toThrow(/project/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it.each(['app-production', 'other-project'])('uses exact project-scoped credentials and checks the nested key project (%s)', async (keyProject) => {
    const project = seedProject();
    const projectId = 'app-production';
    const email = `app-deploy@${projectId}.iam.gserviceaccount.com`;
    new ConnectionRepository().upsertVerifiedBatch([{ provider: 'cloudrun', scope: 'davejohnson/hls-property-care#gcp:app-production',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId, credentials: JSON.stringify({
        type: 'service_account', project_id: keyProject, client_email: email, private_key: 'unused',
      }) }) }]);
    const result = await runCloudPrepare({ project, provider: 'cloudrun', environmentProjectId: projectId, adminAccessToken: 'test-token' });
    if (keyProject === projectId) {
      expect(result).toMatchObject({ success: true, plan: { gcpProjectId: projectId, deployServiceAccountEmail: email } });
      expect(setup).toHaveBeenCalledWith(expect.objectContaining({ gcpProjectId: projectId }));
    } else {
      expect(result.success).toBe(false);
      expect(setup).not.toHaveBeenCalled();
    }
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
    setup.mockResolvedValue({ success: false, mode: 'confirm', planId: 'saved-setup', htmlPath: undefined, actions: [], error: 'Preview the exact setup again.' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const project = seedProject();
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect', adminAccessToken: 'private-admin-token', confirm: true });
    expect(result).toMatchObject({ success: false, error: 'Preview the exact setup again.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new ProjectRepository().findById(project.id)?.policies.cloudPreparation).toBeUndefined();
  });

  it.each([true, false])('verifies role convergence after engine apply before recording preparation (converged=%s)', async (converged) => {
    setup.mockResolvedValue({ success: true, mode: 'confirm', planId: 'saved-setup', htmlPath: '/reports/saved-setup.html', actions: [], error: undefined });
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

  it('cannot grant deployment roles to the saved restricted app by selecting it as a deployment account', async () => {
    const project = seedProject();
    savedIsolation.mockImplementation((_id, _project, email) => email === RUNTIME_SERVICE_ACCOUNT_EMAIL ? {} : undefined);
    const authorize = vi.fn(async () => 'test-token');
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle',
      deployServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL, defaultAdminAccessTokenProvider: authorize });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/restricted app.*deployment/i) });
    expect(setup).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(['exact', 'broad', 'additional', 'altered', 'recreated'])('verifies the saved app restrictions during ordinary GCS preparation (%s)', async observed => {
    const project = seedProject(RUNTIME_SERVICE_ACCOUNT_EMAIL);
    const isolation = {
      target: { projectId: project.name, targetRegion: 'us-central1', sourceEnvironmentId: 'source',
        targetEnvironmentId: 'dest', sourceRailwayProjectId: 'p', sourceRailwayEnvironmentId: 'e' },
      targetEnvironmentName: 'destination', projectNumber: '12345', runtimeEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      runtimeUniqueId: '10001', bucket: project.name + '-hv-build-source', bucketTimeCreated: '2026-01-01T00:00:00Z',
      copyUniqueId: '10002', secretCreateTime: '2026-01-01T00:00:00Z',
    };
    savedIsolation.mockImplementation((_id, _project, email) => email === isolation.runtimeEmail ? isolation : undefined);
    const bindings = isolationGrants(isolation).map(({ role, member, condition }) => ({
      role, members: [member], condition: observed === 'broad' ? undefined :
        observed === 'altered' ? { ...condition, expression: 'true' } : condition,
    }));
    if (observed === 'additional') bindings.push({ role: bindings[1]!.role, members: bindings[1]!.members, condition: undefined });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/projects/' + project.name)) return Response.json({ name: 'projects/12345', projectId: project.name, state: 'ACTIVE' });
      if (url.includes('/services/storage.googleapis.com')) return Response.json({ name: 'projects/12345/services/storage.googleapis.com', parent: 'projects/12345', config: { name: 'storage.googleapis.com' }, state: 'ENABLED' });
      if (url.endsWith(':getIamPolicy')) return Response.json({ version: 3, bindings: [
        { role: 'roles/storage.admin', members: ['serviceAccount:' + DEPLOY_SERVICE_ACCOUNT_EMAIL] },
        ...bindings,
      ] });
      if (url.includes('/serviceAccounts/')) return Response.json({
        name: 'projects/' + project.name + '/serviceAccounts/' + RUNTIME_SERVICE_ACCOUNT_EMAIL,
        projectId: project.name, email: RUNTIME_SERVICE_ACCOUNT_EMAIL, uniqueId: observed === 'recreated' ? '20001' : '10001',
      });
      throw new Error('Unexpected Google request');
    }));
    const result = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle',
      adminAccessToken: 'test-token', confirm: true });
    if (observed === 'exact') {
      expect(result.success, String(result.error)).toBe(true);
      expect(getCloudPreparation(new ProjectRepository().findById(project.id)!, 'cloudrun')?.runtimeRequiredRoles).toContain('roles/storage.objectUser');
    } else {
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/restriction/i) });
      expect(getCloudPreparation(new ProjectRepository().findById(project.id)!, 'cloudrun')).toBeNull();
    }
  });

  it('preserves the environment, native project, and region when retrying authorization', async () => {
    const project = seedProject();
    const projectId = 'app-production';
    const result = await runCloudPrepare({ project, provider: 'cloudrun', environmentProjectId: projectId, environmentName: 'production',
      region: 'us-west1', deployServiceAccountEmail: `app-deploy@${projectId}.iam.gserviceaccount.com`,
      defaultAdminAccessTokenProvider: async () => { throw new Error('Google authorization failed'); } });
    expect(result).toMatchObject({ success: false, adminCredentialSetup: {
      retryCall: { environment: 'production', gcpProjectId: projectId, region: 'us-west1' },
      credentialExample: expect.stringContaining('environment="production"'),
    } });
  });

  it('records confirmed permission grants only for the selected project', async () => {
    const projects = new ProjectRepository();
    const project = seedProject();
    const legacy = { version: 'legacy', preparedAt: '2025-01-01', gcpProjectId: 'hls-property-care' };
    projects.update(project.id, { policies: { cloudPreparation: { cloudrun: legacy } } });
    const dedicatedId = 'app-production';
    const email = `app-deploy@${dedicatedId}.iam.gserviceaccount.com`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/projects/app-production')) return Response.json({ name: 'projects/12345', projectId: dedicatedId, state: 'ACTIVE' });
      if (url.includes('/services/storage.googleapis.com')) return Response.json({ name: 'projects/12345/services/storage.googleapis.com', parent: 'projects/12345', config: { name: 'storage.googleapis.com' }, state: 'ENABLED' });
      if (url.endsWith('/projects/app-production:getIamPolicy')) return Response.json({ bindings: [{ role: 'roles/storage.viewer', members: [`serviceAccount:${email}`] }] });
      throw new Error(`Unexpected request ${url}`);
    }));
    const result = await runCloudPrepare({ project, provider: 'cloudrun', environmentProjectId: dedicatedId,
      gcpProjectId: dedicatedId, deployServiceAccountEmail: email, confirm: true, gcsAccess: 'inspect', adminAccessToken: 'test-token' });
    expect(result.success, String(result.error)).toBe(true);
    const updated = projects.findById(project.id)!;
    expect(getCloudPreparation(updated, 'cloudrun')).toMatchObject(legacy);
    expect(getCloudPreparation(updated, 'cloudrun', dedicatedId)).toMatchObject({ gcpProjectId: dedicatedId, requiredRoles: ['roles/storage.viewer'] });
    expect(getCloudPreparation(updated, 'cloudrun', 'app-staging')).toBeNull();
  });

  it('refuses to remove grants that are not owned by project setup state', async () => {
    const project = seedProject();
    const result = await runCloudPrepare({ project, provider: 'cloudrun', queueAccess: 'remove', adminAccessToken: 'private-admin-token' });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not owned') });
    expect(setup).not.toHaveBeenCalled();
  });

});
