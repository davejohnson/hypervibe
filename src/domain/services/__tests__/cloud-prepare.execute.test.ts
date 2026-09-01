import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { runCloudPrepare } from '../cloud-prepare.execute.js';

describe('runCloudPrepare', () => {
  let tempDir: string;

  beforeEach(() => {
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
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
        member: 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    const plan = payload.plan as { enableApis: string[]; grantRoles: string[] };
    expect(plan.enableApis).toContain('cloudscheduler.googleapis.com');
    expect(plan.grantRoles).toContain('roles/logging.viewAccessor');
    expect(plan.grantRoles).toContain('roles/cloudscheduler.admin');
    expect(plan.enableApis).not.toContain('storage.googleapis.com');
    expect(plan.grantRoles).not.toContain('roles/storage.viewer');
    expect(plan.grantRoles).not.toContain('roles/storage.admin');
  });

  it('previews least-privilege GCS inspection separately from lifecycle access', async () => {
    const project = seedProject();

    const inspected = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'inspect' });
    const inspectPlan = inspected.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(inspectPlan).toMatchObject({ gcsAccess: 'inspect' });
    expect(inspectPlan.enableApis).toContain('storage.googleapis.com');
    expect(inspectPlan.grantRoles).toContain('roles/storage.viewer');
    expect(inspectPlan.grantRoles).not.toContain('roles/storage.admin');

    const lifecycle = await runCloudPrepare({ project, provider: 'cloudrun', gcsAccess: 'lifecycle' });
    const lifecyclePlan = lifecycle.plan as { enableApis: string[]; grantRoles: string[]; gcsAccess: string };
    expect(lifecyclePlan).toMatchObject({ gcsAccess: 'lifecycle' });
    expect(lifecyclePlan.enableApis).toContain('storage.googleapis.com');
    expect(lifecyclePlan.grantRoles).toContain('roles/storage.admin');
    expect(lifecyclePlan.grantRoles).not.toContain('roles/storage.viewer');
  });

  it('uses existing Google default credentials to prepare the reviewed GCP access', async () => {
    const project = seedProject();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('serviceusage.googleapis.com') && url.endsWith(':enable') && method === 'POST') {
        return Response.json({ name: 'operations/enable-api', done: true });
      }
      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        return Response.json({
          bindings: [{
            role: 'roles/run.admin',
            members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
          }],
        });
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        return Response.json(JSON.parse(String(init?.body)).policy);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const defaultAdminAccessTokenProvider = vi.fn(async () => 'admin-token');

    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(defaultAdminAccessTokenProvider).toHaveBeenCalledOnce();
    expect(payload.enabledApis).toEqual(expect.arrayContaining([
      { service: 'cloudscheduler.googleapis.com', status: 'enabled' },
      { service: 'cloudresourcemanager.googleapis.com', status: 'enabled' },
    ]));
    expect(payload.grantedRoles).toEqual(expect.arrayContaining([
      'roles/logging.viewer',
      'roles/logging.viewAccessor',
      'roles/cloudscheduler.admin',
      'roles/cloudsql.client',
      'roles/storage.viewer',
    ]));
    expect(payload.existingRoles).toEqual(['roles/run.admin']);
    expect(payload).toMatchObject({ provider: 'cloudrun', version: 'gcp-cloudrun-v1' });

    const setIamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(':setIamPolicy') && init?.method === 'POST'
    );
    expect(setIamCall).toBeTruthy();
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    const bindings = setIamBody.policy.bindings as Array<{ role: string; members: string[] }>;
    expect(bindings).toContainEqual({
      role: 'roles/logging.viewAccessor',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });
    expect(bindings).toContainEqual({
      role: 'roles/cloudscheduler.admin',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });
    expect(bindings).toContainEqual({
      role: 'roles/storage.viewer',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });

    const updatedProject = new ProjectRepository().findById(project.id);
    expect(updatedProject?.policies.cloudPreparation).toMatchObject({
      cloudrun: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v1',
        gcpProjectId: 'hls-property-care',
        deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      },
    });
    expect(new AuditRepository().findByAction('cloud.prepare.succeeded')[0]?.details).toMatchObject({
      provider: 'cloudrun',
      gcpProjectId: 'hls-property-care',
      deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      gcsAccess: 'inspect',
      authenticationSource: 'application-default',
    });
  });

  it('returns exact ADC recovery guidance and audits only safe failure provenance', async () => {
    const project = seedProject();
    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAuth: 'default',
      adminCredentialSource: 'application-default',
      defaultAdminAccessTokenProvider: async () => {
        throw new Error('Could not load the default credentials.');
      },
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('stored deploy connection authenticates as hypervibe-hls-deploy@');
    expect(String(payload.error)).toContain('gcloud auth application-default login');
    expect(payload.adminCredentialSetup).toMatchObject({
      credentialType: 'Google user Application Default Credentials (ADC)',
      recommendedSetupUrl: 'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment',
      gcloudCli: {
        requiredWhen: 'gcloud is not installed or not available on PATH',
        officialInstallUrl: 'https://cloud.google.com/sdk/docs/install',
        recommendedInstallation: 'Use Google\'s official platform installer or archive from officialInstallUrl.',
      },
      commands: ['gcloud auth application-default login'],
      optionalQuotaProjectCommand: 'gcloud auth application-default set-quota-project hls-property-care',
      requiredRoles: [
        'roles/serviceusage.serviceUsageAdmin',
        'roles/resourcemanager.projectIamAdmin',
      ],
      resourceScope: 'projects/hls-property-care',
      retryCall: {
        project: 'hls-property-care',
        provider: 'cloudrun',
        action: 'prepare',
        gcsAccess: 'inspect',
        adminAuth: 'default',
        confirm: true,
      },
    });
    expect(String((payload.adminCredentialSetup as Record<string, unknown>).credentialExample))
      .toContain('adminAuth="default"');

    const audit = new AuditRepository().findByAction('cloud.prepare.failed')[0];
    expect(audit?.details).toEqual({
      provider: 'cloudrun',
      version: 'gcp-cloudrun-v1',
      gcpProjectId: 'hls-property-care',
      deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
      gcsAccess: 'inspect',
      authenticationSource: 'application-default',
      failureCategory: 'missing_application_default_credentials',
    });
    expect(JSON.stringify(audit)).not.toContain('Could not load the default credentials');
  });

  it('requires admin credentials when confirming', async () => {
    const project = seedProject();
    const payload = await runCloudPrepare({ project, provider: 'cloudrun', confirm: true });
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('adminAuth="default"');
  });
});
