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
import { getCloudPrepareProfile, isCloudPrepared } from '../cloud-prepare.js';

const RUNTIME_SERVICE_ACCOUNT_EMAIL =
  'hypervibe-runtime@hls-property-care.iam.gserviceaccount.com';
const DEPLOY_SERVICE_ACCOUNT_EMAIL =
  'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com';

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

  it('grants deploy act-as only on the exact runtime account and converges idempotently', async () => {
    const project = seedProject();
    const deployMember = `serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}`;
    const runtimeResource = `projects/hls-property-care/serviceAccounts/${RUNTIME_SERVICE_ACCOUNT_EMAIL}`;
    const runtimeAccountUrl = `https://iam.googleapis.com/v1/projects/hls-property-care/serviceAccounts/`
      + `${encodeURIComponent(RUNTIME_SERVICE_ACCOUNT_EMAIL)}`;
    const runtimePolicyUrl = 'https://iam.googleapis.com/v1/projects/hls-property-care/'
      + 'serviceAccounts/123456789012345678901';
    let projectPolicy: {
      version: number;
      etag: string;
      bindings: Array<{ role: string; members: string[] }>;
    } = {
      version: 1,
      etag: 'project-etag-1',
      bindings: [{ role: 'roles/iam.serviceAccountUser', members: [deployMember] }],
    };
    let runtimePolicy: {
      version: number;
      etag: string;
      bindings: Array<{ role: string; members: string[] }>;
    } = {
      version: 1,
      etag: 'runtime-etag-1',
      bindings: [{ role: 'roles/viewer', members: ['user:runtime-owner@example.com'] }],
    };
    let projectPolicyRevision = 1;
    let runtimePolicyRevision = 1;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v3/projects/hls-property-care') && method === 'GET') {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      if (url.includes('serviceusage.googleapis.com')
        && url.includes('/services/')
        && method === 'GET') {
        const service = decodeURIComponent(url.slice(url.lastIndexOf('/services/') + 10));
        return Response.json({
          name: `projects/123456789012/services/${service}`,
          parent: 'projects/123456789012',
          config: { name: service },
          state: 'ENABLED',
        });
      }
      if (url === runtimeAccountUrl && method === 'GET') {
        return Response.json({
          name: runtimeResource,
          projectId: 'hls-property-care',
          uniqueId: '123456789012345678901',
          email: RUNTIME_SERVICE_ACCOUNT_EMAIL,
        });
      }
      if (url === `${runtimePolicyUrl}:getIamPolicy` && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          options: { requestedPolicyVersion: 3 },
        });
        return Response.json(runtimePolicy);
      }
      if (url === `${runtimePolicyUrl}:setIamPolicy` && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.policy.etag).toBe(`runtime-etag-${runtimePolicyRevision}`);
        expect(body.updateMask).toBe('bindings,etag');
        runtimePolicyRevision += 1;
        runtimePolicy = {
          ...body.policy,
          etag: `runtime-etag-${runtimePolicyRevision}`,
        };
        return Response.json(runtimePolicy);
      }
      if (url.includes('cloudresourcemanager.googleapis.com')
        && url.endsWith(':getIamPolicy')
        && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          options: { requestedPolicyVersion: 3 },
        });
        return Response.json(projectPolicy);
      }
      if (url.includes('cloudresourcemanager.googleapis.com')
        && url.endsWith(':setIamPolicy')
        && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.policy.etag).toBe(`project-etag-${projectPolicyRevision}`);
        expect(body.updateMask).toBe('bindings,etag');
        projectPolicyRevision += 1;
        projectPolicy = {
          ...body.policy,
          etag: `project-etag-${projectPolicyRevision}`,
        };
        return Response.json(projectPolicy);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(first).toMatchObject({
      success: true,
      grantedRuntimeServiceAccountRoles: ['roles/iam.serviceAccountUser'],
      existingRuntimeServiceAccountRoles: [],
      revokedRoles: ['roles/iam.serviceAccountUser'],
    });
    expect(projectPolicy.bindings.some((binding) => (
      binding.role === 'roles/iam.serviceAccountUser'
      && binding.members.includes(deployMember)
    ))).toBe(false);
    expect(runtimePolicy.bindings).toContainEqual({
      role: 'roles/iam.serviceAccountUser',
      members: [deployMember],
    });
    expect(runtimePolicy.bindings).toContainEqual({
      role: 'roles/viewer',
      members: ['user:runtime-owner@example.com'],
    });

    const refreshed = new ProjectRepository().findById(project.id)!;
    expect(isCloudPrepared(refreshed, 'cloudrun')).toBe(true);
    expect(refreshed.policies.cloudPreparation).toMatchObject({
      cloudrun: {
        version: 'gcp-cloudrun-v2',
        runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
        runtimeServiceAccountAccessRoles: ['roles/iam.serviceAccountUser'],
      },
    });
    const runtimeSetCalls = () => fetchMock.mock.calls.filter(([url, init]) => (
      String(url) === `${runtimePolicyUrl}:setIamPolicy` && init?.method === 'POST'
    )).length;
    expect(runtimeSetCalls()).toBe(1);

    const second = await runCloudPrepare({
      project: refreshed,
      provider: 'cloudrun',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(second).toMatchObject({
      success: true,
      grantedRuntimeServiceAccountRoles: [],
      existingRuntimeServiceAccountRoles: ['roles/iam.serviceAccountUser'],
    });
    expect(runtimeSetCalls()).toBe(1);
  });

  it('fails before project IAM changes when runtime account policy state has no etag', async () => {
    const project = seedProject();
    const runtimeAccountUrl = `https://iam.googleapis.com/v1/projects/hls-property-care/serviceAccounts/`
      + `${encodeURIComponent(RUNTIME_SERVICE_ACCOUNT_EMAIL)}`;
    const runtimePolicyUrl = 'https://iam.googleapis.com/v1/projects/hls-property-care/'
      + 'serviceAccounts/123456789012345678901';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v3/projects/hls-property-care') && method === 'GET') {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      if (url.includes('serviceusage.googleapis.com')
        && url.includes('/services/')
        && method === 'GET') {
        const service = decodeURIComponent(url.slice(url.lastIndexOf('/services/') + 10));
        return Response.json({
          name: `projects/123456789012/services/${service}`,
          parent: 'projects/123456789012',
          config: { name: service },
          state: 'ENABLED',
        });
      }
      if (url === runtimeAccountUrl && method === 'GET') {
        return Response.json({
          name: `projects/hls-property-care/serviceAccounts/${RUNTIME_SERVICE_ACCOUNT_EMAIL}`,
          projectId: 'hls-property-care',
          uniqueId: '123456789012345678901',
          email: RUNTIME_SERVICE_ACCOUNT_EMAIL,
        });
      }
      if (url === `${runtimePolicyUrl}:getIamPolicy` && method === 'POST') {
        return Response.json({ version: 1, bindings: [] });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('runtime service account IAM policy'),
      requiredAdminPermissions: expect.arrayContaining([
        'iam.serviceAccounts.get',
        'iam.serviceAccounts.getIamPolicy',
        'iam.serviceAccounts.setIamPolicy',
      ]),
      adminCredentialSetup: {
        requiredRoles: expect.arrayContaining(['roles/iam.serviceAccountAdmin']),
        serviceAccountResourceScope:
          `projects/hls-property-care/serviceAccounts/${RUNTIME_SERVICE_ACCOUNT_EMAIL}`,
      },
    });
    expect(fetchMock.mock.calls.some(([url]) => (
      String(url).includes('cloudresourcemanager.googleapis.com')
      && String(url).endsWith(':getIamPolicy')
    ))).toBe(false);
    expect(new ProjectRepository().findById(project.id)?.policies.cloudPreparation)
      .toBeUndefined();
    expect(new AuditRepository().findByAction('cloud.prepare.failed')[0]?.details)
      .toMatchObject({ failureCategory: 'runtime_service_account_iam_failed' });
  });

  it('grants queue lifecycle and runtime use to distinct identities', async () => {
    const project = seedProject();
    let iamPolicy: {
      version: number;
      etag: string;
      bindings: Array<{ role: string; members: string[] }>;
    } = { version: 1, etag: 'queue-policy-etag', bindings: [] };
    let serviceEnabled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v3/projects/hls-property-care')) {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      if (url.endsWith('/v1/projects/hls-property-care/services/pubsub.googleapis.com')) {
        return Response.json({
          name: 'projects/123456789012/services/pubsub.googleapis.com',
          parent: 'projects/123456789012',
          config: { name: 'pubsub.googleapis.com' },
          state: serviceEnabled ? 'ENABLED' : 'DISABLED',
        });
      }
      if (url.includes('serviceusage.googleapis.com') && url.endsWith(':enable')) {
        serviceEnabled = true;
        return Response.json({ name: 'operations/enable-pubsub' });
      }
      if (url.endsWith('/v1/operations/enable-pubsub')) {
        return Response.json({ name: 'operations/enable-pubsub', done: true });
      }
      if (url.endsWith(':getIamPolicy')) return Response.json(iamPolicy);
      if (url.endsWith(':setIamPolicy') && init?.method === 'POST') {
        iamPolicy = JSON.parse(String(init.body)).policy;
        return Response.json(iamPolicy);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      runtimeServiceAccountEmail: RUNTIME_SERVICE_ACCOUNT_EMAIL,
      queueAccess: 'lifecycle',
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(payload.success).toBe(true);
    const deployMember =
      'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com';
    const runtimeMember = `serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}`;
    expect(iamPolicy.bindings).toContainEqual({
      role: 'roles/pubsub.editor',
      members: [deployMember],
    });
    expect(iamPolicy.bindings).toContainEqual({
      role: 'roles/pubsub.publisher',
      members: [runtimeMember],
    });
    expect(iamPolicy.bindings).toContainEqual({
      role: 'roles/pubsub.subscriber',
      members: [runtimeMember],
    });
    expect(iamPolicy.bindings.some((binding) =>
      binding.role === 'roles/pubsub.editor' && binding.members.includes(runtimeMember)
    )).toBe(false);
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

  it('uses existing Google default credentials to prepare only the reviewed staged access', async () => {
    const project = seedProject();
    let iamPolicy = {
      version: 1,
      etag: 'storage-policy-etag',
      bindings: [{
        role: 'roles/run.admin',
        members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
      }],
    };

    const enabledServices = new Set<string>();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/v3/projects/hls-property-care') && method === 'GET') {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      const serviceMatch = url.match(/\/v1\/projects\/hls-property-care\/services\/([^:]+)$/);
      if (serviceMatch && method === 'GET') {
        const service = decodeURIComponent(serviceMatch[1]);
        return Response.json({
          name: `projects/123456789012/services/${service}`,
          parent: 'projects/123456789012',
          config: { name: service },
          state: enabledServices.has(service) ? 'ENABLED' : 'DISABLED',
        });
      }
      if (url.includes('serviceusage.googleapis.com') && url.endsWith(':enable') && method === 'POST') {
        const service = decodeURIComponent(url.match(/\/services\/([^:]+):enable$/)?.[1] ?? '');
        enabledServices.add(service);
        return Response.json({ name: `operations/enable-${service.replaceAll('.', '-')}` });
      }
      const operationMatch = url.match(/\/v1\/(operations\/enable-[A-Za-z0-9.-]+)$/);
      if (operationMatch && method === 'GET') {
        return Response.json({ name: operationMatch[1], done: true });
      }
      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        return Response.json(iamPolicy);
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        iamPolicy = JSON.parse(String(init?.body)).policy;
        return Response.json(iamPolicy);
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
    expect(payload.enabledApis).toEqual([
      { service: 'storage.googleapis.com', status: 'enabled' },
    ]);
    expect(payload.grantedRoles).toEqual(['roles/storage.viewer']);
    expect(payload.existingRoles).toEqual([]);
    expect(payload).toMatchObject({ provider: 'cloudrun', version: 'gcp-cloudrun-v2' });

    const setIamCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(':setIamPolicy') && init?.method === 'POST'
    );
    expect(setIamCall).toBeTruthy();
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    const bindings = setIamBody.policy.bindings as Array<{ role: string; members: string[] }>;
    expect(bindings).toContainEqual({
      role: 'roles/storage.viewer',
      members: ['serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com'],
    });
    expect(bindings.map(({ role }) => role)).toEqual([
      'roles/run.admin',
      'roles/storage.viewer',
    ]);

    const updatedProject = new ProjectRepository().findById(project.id);
    expect(updatedProject?.policies.cloudPreparation).toMatchObject({
      cloudrun: {
        provider: 'cloudrun',
        version: 'gcp-cloudrun-v2',
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

    const refreshedProject = new ProjectRepository().findById(project.id)!;
    await runCloudPrepare({
      project: refreshedProject,
      provider: 'cloudrun',
      memorystoreAccess: 'inspect',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider,
      confirm: true,
    });
    const cumulativelyPrepared = new ProjectRepository().findById(project.id);
    const preparation = cumulativelyPrepared?.policies.cloudPreparation as {
      cloudrun: { requiredApis: string[]; requiredRoles: string[] };
    };
    expect(preparation.cloudrun.requiredApis).toEqual(expect.arrayContaining([
      'compute.googleapis.com',
      'storage.googleapis.com',
      'redis.googleapis.com',
    ]));
    expect(preparation.cloudrun.requiredRoles).toEqual(expect.arrayContaining([
      'roles/compute.networkViewer',
      'roles/storage.viewer',
      'roles/redis.viewer',
    ]));
  });

  it('does not grant IAM or record preparation when API enablement lacks an exact operation', async () => {
    const project = seedProject();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v3/projects/hls-property-care')) {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      if (url.endsWith('/v1/projects/hls-property-care/services/storage.googleapis.com')) {
        return Response.json({
          name: 'projects/123456789012/services/storage.googleapis.com',
          parent: 'projects/123456789012',
          config: { name: 'storage.googleapis.com' },
          state: 'DISABLED',
        });
      }
      if (url.endsWith('/services/storage.googleapis.com:enable') && init?.method === 'POST') {
        return Response.json({ done: true });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('invalid operation response');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(':getIamPolicy'))).toBe(false);
    expect(new ProjectRepository().findById(project.id)?.policies.cloudPreparation).toBeUndefined();
    expect(new AuditRepository().findByAction('cloud.prepare.failed')[0]?.details)
      .toMatchObject({ failureCategory: 'service_enablement_failed' });
  });

  it.each([
    {
      state: 'has no etag',
      policy: { version: 1, bindings: [] },
      error: 'GCP project IAM policy has no etag',
    },
    {
      state: 'has a conditional binding without policy version 3',
      policy: {
        version: 1,
        etag: 'conditional-policy-etag',
        bindings: [{
          role: 'roles/viewer',
          members: ['user:conditional-owner@example.com'],
          condition: {
            title: 'temporary-access',
            expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
          },
        }],
      },
      error: 'GCP project IAM policy contains conditions without version 3',
    },
  ])('blocks before setIamPolicy when project IAM $state', async ({ policy, error }) => {
    const project = seedProject();
    const setIamPolicy = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v3/projects/hls-property-care') && method === 'GET') {
        return Response.json({
          name: 'projects/123456789012',
          projectId: 'hls-property-care',
          state: 'ACTIVE',
        });
      }
      if (url.endsWith('/v1/projects/hls-property-care/services/storage.googleapis.com')
        && method === 'GET') {
        return Response.json({
          name: 'projects/123456789012/services/storage.googleapis.com',
          parent: 'projects/123456789012',
          config: { name: 'storage.googleapis.com' },
          state: 'ENABLED',
        });
      }
      if (url.endsWith(':getIamPolicy') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          options: { requestedPolicyVersion: 3 },
        });
        return Response.json(policy);
      }
      if (url.endsWith(':setIamPolicy') && method === 'POST') {
        setIamPolicy();
        return Response.json({});
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCloudPrepare({
      project,
      provider: 'cloudrun',
      gcsAccess: 'inspect',
      adminAccessToken: 'admin-token',
      confirm: true,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining(error) });
    expect(setIamPolicy).not.toHaveBeenCalled();
    expect(new ProjectRepository().findById(project.id)?.policies.cloudPreparation)
      .toBeUndefined();
    expect(new AuditRepository().findByAction('cloud.prepare.failed')[0]?.details)
      .toMatchObject({ failureCategory: 'project_iam_failed' });
  });

  it('removes only Pub/Sub editor from the deploy identity and preserves other IAM and preparation state', async () => {
    const project = seedProject();
    new ProjectRepository().update(project.id, {
      policies: {
        ...project.policies,
        cloudPreparation: {
          cloudrun: {
            provider: 'cloudrun',
            version: 'gcp-cloudrun-v2',
            preparedAt: new Date().toISOString(),
            gcpProjectId: 'hls-property-care',
            deployServiceAccountEmail: 'hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com',
            requiredApis: ['storage.googleapis.com', 'pubsub.googleapis.com'],
            requiredRoles: ['roles/storage.viewer', 'roles/pubsub.editor'],
          },
        },
      },
    });
    const targetMember = 'serviceAccount:hypervibe-hls-deploy@hls-property-care.iam.gserviceaccount.com';
    let iamPolicy = {
      version: 3,
      etag: 'removal-policy-etag',
      bindings: [
        { role: 'roles/pubsub.editor', members: [targetMember, 'user:queue-owner@example.com'] },
        {
          role: 'roles/pubsub.editor',
          members: [targetMember, 'user:conditional-queue-owner@example.com'],
          condition: { title: 'temporary-access', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
        },
        { role: 'roles/storage.viewer', members: [targetMember] },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':getIamPolicy')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          options: { requestedPolicyVersion: 3 },
        });
        return Response.json(iamPolicy);
      }
      if (url.endsWith(':setIamPolicy') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          policy: {
            version: 3,
            etag: 'removal-policy-etag',
            bindings: [
              { role: 'roles/pubsub.editor', members: ['user:queue-owner@example.com'] },
              {
                role: 'roles/pubsub.editor',
                members: ['user:conditional-queue-owner@example.com'],
                condition: {
                  title: 'temporary-access',
                  expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
                },
              },
              { role: 'roles/storage.viewer', members: [targetMember] },
            ],
          },
          updateMask: 'bindings,etag',
        });
        iamPolicy = body.policy;
        return Response.json(iamPolicy);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await runCloudPrepare({
      project: new ProjectRepository().findById(project.id)!,
      provider: 'cloudrun',
      queueAccess: 'remove',
      adminAuth: 'default',
      defaultAdminAccessTokenProvider: async () => 'admin-token',
      confirm: true,
    });

    expect(payload).toMatchObject({
      success: true,
      enabledApis: [],
      grantedRoles: [],
      existingRoles: [],
      revokedRoles: ['roles/pubsub.editor'],
      alreadyAbsentRoles: [],
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('serviceusage.googleapis.com'))).toBe(false);
    const setIamCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(':setIamPolicy'));
    const setIamBody = JSON.parse(String(setIamCall?.[1]?.body));
    expect(setIamBody.policy.bindings).toEqual([
      { role: 'roles/pubsub.editor', members: ['user:queue-owner@example.com'] },
      {
        role: 'roles/pubsub.editor',
        members: ['user:conditional-queue-owner@example.com'],
        condition: { title: 'temporary-access', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
      },
      { role: 'roles/storage.viewer', members: [targetMember] },
    ]);
    const updatedProject = new ProjectRepository().findById(project.id);
    const preparation = updatedProject?.policies.cloudPreparation as {
      cloudrun: { requiredApis: string[]; requiredRoles: string[] };
    };
    expect(preparation.cloudrun.requiredApis).toEqual([
      'storage.googleapis.com',
      'pubsub.googleapis.com',
    ]);
    expect(preparation.cloudrun.requiredRoles).toEqual(['roles/storage.viewer']);
    expect(new AuditRepository().findByAction('cloud.prepare.succeeded')[0]?.details).toMatchObject({
      queueAccess: 'remove',
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
      version: 'gcp-cloudrun-v2',
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
});
