import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import * as crypto from 'node:crypto';
import { buildCloudRunGitHubActionsSteps } from '../cloudrun-ci.workflow.js';
import { buildCloudRunPortableRuntime } from '../cloudrun-ci.recipe.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';

const jobId = 'cron-7e22b6c2dc';
const jobName = `projects/gcp-project/locations/us-central1/jobs/${jobId}`;
const runtimeIdentity = 'runtime@gcp-project.iam.gserviceaccount.com';
const holdingImage = `us-central1-docker.pkg.dev/gcp-project/hypervibe/staging-cron-bootstrap@sha256:${'d'.repeat(64)}`;
const candidateImage = `us-central1-docker.pkg.dev/gcp-project/hypervibe/app@sha256:${'e'.repeat(64)}`;
const scheduleActivation = { version: 1 as const, state: 'pending' as const, jobName: jobId, jobUid: '11111111-1111-4111-8111-111111111111', holdingImage };
const now = new Date();
const service: Service = {
  id: 'cron', projectId: 'project-1', name: 'cron',
  buildConfig: { builder: 'dockerfile', workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' },
  envVarSpec: {}, createdAt: now, updatedAt: now,
};
const environment: Environment = {
  id: 'env-1', projectId: 'project-1', name: 'staging',
  platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
  createdAt: now, updatedAt: now,
};
const pendingEnvironment: Environment = { ...environment, platformBindings: {
  ...environment.platformBindings,
  services: { cron: { serviceId: jobId, jobName: jobId, resourceType: 'scheduledJob', scheduleActivation } },
} };
const retainedJobMetadata = {
  annotations: { 'example.com/owner': 'operations' }, client: 'reviewed-client', clientVersion: '1.2.3',
  launchStage: 'BETA', binaryAuthorization: { useDefault: true },
};

// REST v2 Job is configuration. Only an execution token or :run starts work;
// Scheduler's state is output-only, so a create-then-pause is not a safe hold.
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs
// https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs
function readyHoldingJob() {
  return {
    name: jobName, uid: '11111111-1111-4111-8111-111111111111', etag: 'job-etag',
    generation: '1', observedGeneration: '1', reconciling: false, executionCount: 0,
    labels: { 'infraprint-environment': 'staging', 'infraprint-service': 'cron', 'infraprint-resource': 'scheduled-job' },
    terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
    template: { template: {
      serviceAccount: runtimeIdentity, maxRetries: 1, timeout: '3600s',
      containers: [{ image: holdingImage, command: ['/bin/sh'], args: ['-lc', 'npm run cron'], env: [], resources: { limits: { cpu: '1', memory: '512Mi' } } }],
    } },
  };
}

async function fixture(options: {
  readFailureAfterCreate?: boolean;
  raceAtFinalRead?: boolean;
  existingImage?: string;
  changedUid?: boolean;
  changedUidAfterPatch?: boolean;
  schedulerWriteTimeout?: boolean;
  schedulerReadUnknown?: boolean;
  wrongCommand?: boolean;
  schedulerExists?: boolean;
  wrongSchedulerTarget?: boolean;
  missingInvoker?: boolean;
  iamReadUnknown?: boolean;
  iamWriteConflict?: boolean;
  iamReadbackMissing?: boolean;
  jobMetadata?: boolean;
} = {}) {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-central1', runtimeServiceAccountEmail: runtimeIdentity,
    credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'token', tokenExpiry: new Date(Date.now() + 60_000) });
  let created = Boolean(options.existingImage);
  let currentImage = options.existingImage ?? holdingImage;
  let jobPatched = false;
  let schedulerCreated = Boolean(options.schedulerExists);
  let invokerGranted = !options.missingInvoker;
  let jobReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('artifactregistry.googleapis.com') && method === 'GET') {
      return Response.json({ name: 'projects/gcp-project/locations/us-central1/repositories/hypervibe', format: 'DOCKER' });
    }
    if (url === 'https://cloudbuild.googleapis.com/v1/projects/gcp-project/builds' && method === 'POST') {
      return Response.json({ id: 'holding-build', status: 'SUCCESS', results: { images: [{ name: 'us-central1-docker.pkg.dev/gcp-project/hypervibe/staging-cron-bootstrap:holding-v1', digest: `sha256:${'d'.repeat(64)}` }] } });
    }
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic' });
    const conditionalBinding = { role: 'roles/run.invoker', members: ['serviceAccount:other@example.test'], condition: { title: 'temporary', expression: 'request.time < timestamp("2027-01-01T00:00:00Z")' } };
    if (url === `https://run.googleapis.com/v2/${jobName}:getIamPolicy?options.requestedPolicyVersion=3` && method === 'GET') {
      if (options.iamReadUnknown) return new Response('', { status: 403 });
      return Response.json({ version: 3, etag: 'policy-etag', bindings: [conditionalBinding,
        ...(invokerGranted ? [{ role: 'roles/run.invoker', members: [`serviceAccount:${runtimeIdentity}`] }] : [])] });
    }
    if (url === `https://run.googleapis.com/v2/${jobName}:setIamPolicy` && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ updateMask: 'bindings,etag,version', policy: { version: 3, etag: 'policy-etag', bindings: [conditionalBinding, { role: 'roles/run.invoker', members: [`serviceAccount:${runtimeIdentity}`] }] } });
      if (options.iamWriteConflict) return new Response('', { status: 409 });
      if (!options.iamReadbackMissing) invokerGranted = true;
      return Response.json(body.policy);
    }
    // Job UpdateJobRequest has no update_mask; Services have a different RPC.
    // https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch
    if (url.startsWith(`https://run.googleapis.com/v2/${jobName}?`) && method === 'PATCH') {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown query parameter updateMask' } }, { status: 400 });
    }
    if (url === `https://run.googleapis.com/v2/${jobName}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      expect(body.template.template.containers[0]).toMatchObject({ image: candidateImage, command: ['/bin/sh'], args: ['-lc', 'npm run cron'] });
      expect(body.etag).toBe('job-etag');
      currentImage = candidateImage;
      jobPatched = true;
      return Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/update-cron', done: true, response: { name: jobName } });
    }
    const scheduler = {
      name: `projects/gcp-project/locations/us-central1/jobs/${jobId}-schedule`,
      schedule: '0 8 * * *', timeZone: 'Etc/UTC', state: 'ENABLED',
      httpTarget: { uri: `https://run.googleapis.com/v2/${options.wrongSchedulerTarget ? 'another-job' : jobName}:run`, httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: 'e30=',
        oauthToken: { serviceAccountEmail: runtimeIdentity, scope: 'https://www.googleapis.com/auth/cloud-platform' } },
    };
    if (url.includes('cloudscheduler.googleapis.com') && method === 'GET') {
      if (options.schedulerReadUnknown) return new Response('', { status: 503 });
      return schedulerCreated ? Response.json(scheduler) : new Response('', { status: 404 });
    }
    if (url === 'https://cloudscheduler.googleapis.com/v1/projects/gcp-project/locations/us-central1/jobs' && method === 'POST') {
      schedulerCreated = true;
      if (options.schedulerWriteTimeout) throw new Error('network response lost');
      return Response.json(scheduler);
    }
    if (url.startsWith(`https://cloudscheduler.googleapis.com/v1/projects/gcp-project/locations/us-central1/jobs/${jobId}-schedule?updateMask=`) && method === 'PATCH') return Response.json(scheduler);
    if (url.includes('/services/') && method === 'GET') return new Response('', { status: 404 });
    if (url === `https://run.googleapis.com/v2/${jobName}` && method === 'GET') {
      jobReads++;
      if (created && options.readFailureAfterCreate) return new Response('', { status: 503 });
      if (created || (options.raceAtFinalRead && jobReads >= 3)) {
        const job = readyHoldingJob();
        job.template.template.containers[0]!.image = currentImage;
        if (options.changedUid || (options.changedUidAfterPatch && jobPatched)) job.uid = 'replacement-uid';
        if (options.wrongCommand) job.template.template.containers[0]!.args = ['-lc', 'npm run unrelated'];
        if (options.jobMetadata) return Response.json({ ...job, ...retainedJobMetadata,
          labels: { ...job.labels, 'example-owner': 'operations' },
          startExecutionToken: 'previous-execution-token',
          template: { ...job.template, parallelism: 2, taskCount: 3, annotations: { 'example.com/task': 'retained' } },
        });
        return Response.json(job);
      }
      return new Response('', { status: 404 });
    }
    if (url.includes('/domainmappings') && method === 'GET') return Response.json({ items: [] });
    if (url.endsWith('/services?pageSize=100') && method === 'GET') return Response.json({ services: [] });
    if (url.endsWith('/jobs?pageSize=100') && method === 'GET') {
      const job = readyHoldingJob();
      job.template.template.containers[0]!.image = currentImage;
      if (options.changedUid) job.uid = 'replacement-uid';
      return Response.json({ jobs: [job] });
    }
    if (url === `https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?jobId=${jobId}` && method === 'POST') {
      created = true;
      return Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/create-cron', done: true, response: { name: jobName, uid: readyHoldingJob().uid } });
    }
    throw new Error(`Unexpected transport: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { adapter, fetchMock };
}

async function runCi(kind: 'github' | 'portable', fetchImpl: typeof fetch) {
  const runtimeResources = [{ logicalName: 'cron' as const, workloadKind: 'cron' as const, providerResourceType: 'job' as const, providerResourceId: jobId,
    providerResourceUid: scheduleActivation.jobUid, startCommand: 'npm run cron', healthCheckPath: null }];
  const generated = buildCloudRunGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: false,
    serviceNames: ['cron'], providerServiceIds: [], providerJobNames: [jobId], providerScope: { projectId: 'gcp-project', region: 'us-central1' }, providerRegion: 'us-central1', runtimeResources });
  const script = kind === 'portable' ? buildCloudRunPortableRuntime().replace(/^import .*;\n/gm, '')
    : extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + generated.steps, 'Deploy image to Cloud Run');
  const credentials = { client_email: 'ci@example.test', private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const env = {
    GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials), GCP_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify(credentials)).toString('base64'),
    GCP_PROJECT_ID: 'gcp-project', GCP_BOUND_PROJECT_ID: 'gcp-project', GCP_REGION: 'us-central1', GCP_ARTIFACT_REPOSITORY: 'hypervibe',
    CLOUDRUN_SERVICE_NAMES: '', CLOUDRUN_JOB_NAMES: jobId, IMAGE_URI: candidateImage, DEPLOY_OPERATION: 'deploy', HYPERVIBE_ROLLBACK: 'false',
    CLOUDRUN_RELEASE_COMMANDS_B64: Buffer.from('[]').toString('base64'),
    CLOUDRUN_RUNTIME_RESOURCES_B64: Buffer.from(JSON.stringify(runtimeResources)).toString('base64'),
    CI_REGISTRY: 'gitlab.example.test', CI_REGISTRY_USER: 'ci', CI_REGISTRY_PASSWORD: 'synthetic', CI_PROJECT_PATH: 'app',
    HYPERVIBE_REPOSITORY: 'owner/app', HYPERVIBE_ENVIRONMENT: 'staging', HYPERVIBE_PROGRAM_FINGERPRINT: 'program',
    HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT: 'contract', HYPERVIBE_RELEASE_SERVICES: JSON.stringify(['cron']),
    HYPERVIBE_RELEASE_PROVIDER_IDENTITY: JSON.stringify({ scope: { projectId: 'gcp-project', region: 'us-central1' }, region: 'us-central1' }),
    HYPERVIBE_RELEASE_PROVIDER_RESOURCES: JSON.stringify([`job:${jobId}`]),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('require', 'process', 'fetch', 'Buffer', 'core', 'createSign', 'execFileSync', 'readFile', 'writeFile', script)(
    () => crypto, { env, stdout: { write: vi.fn() } }, fetchImpl, Buffer, { info: vi.fn() }, crypto.createSign,
    (_file: string, args: string[]) => args[0] === 'push' ? 'digest: sha256:' + 'e'.repeat(64) : '',
    async (file: string) => file === '.hypervibe-deploy-sha' ? 'a'.repeat(40) : 'registry.example.test/source:tag', vi.fn());
}

describe('Cloud Run managed-CI cron bootstrap', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('creates an exact immutable Job without creating a trigger or executing work', async () => {
    const { adapter, fetchMock } = await fixture();
    const result = await adapter.deploy(service, environment, {}, { deferDeployment: true, expectedSourceCommitSha: 'a'.repeat(40) });

    expect(result).toMatchObject({ status: 'configured', externalId: jobId, receipt: { success: true, data: {
      jobName: jobId, imageUri: holdingImage, createdJob: true,
      scheduleActivation: { version: 1, state: 'pending', jobName: jobId, jobUid: readyHoldingJob().uid, holdingImage },
    } } });
    const create = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(`/jobs?jobId=${jobId}`) && init?.method === 'POST');
    expect(create).toBeDefined();
    const body = JSON.parse(String(create![1]?.body));
    expect(body.template.template.containers[0].image).toBe(holdingImage);
    expect(body).not.toHaveProperty('startExecutionToken');
    expect(body).not.toHaveProperty('runExecutionToken');
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET').map(([url]) => String(url)))
      .toEqual(['https://cloudbuild.googleapis.com/v1/projects/gcp-project/builds', `https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?jobId=${jobId}`]);
  });

  it('hands the real bootstrap binding through emitted CI image update before reviewed activation', async () => {
    const { adapter, fetchMock } = await fixture();
    const prepared = await adapter.deploy(service, environment, {}, { deferDeployment: true, expectedSourceCommitSha: 'a'.repeat(40) });
    expect(prepared.receipt.success).toBe(true);
    const bound: Environment = { ...environment, platformBindings: { ...environment.platformBindings, services: { cron: {
      serviceId: prepared.externalId, jobName: prepared.receipt.data!.jobName,
      resourceType: prepared.receipt.data!.resourceType, scheduleActivation: prepared.receipt.data!.scheduleActivation,
    } } } };
    expect((await adapter.observe(bound)).services[0]?.scheduleActivationPending).toBe(true);
    const generated = buildCloudRunGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: false,
      serviceNames: ['cron'], providerServiceIds: [], providerJobNames: [prepared.externalId!], providerScope: { projectId: 'gcp-project', region: 'us-central1' }, providerRegion: 'us-central1',
      runtimeResources: [{ logicalName: 'cron', workloadKind: 'cron', providerResourceType: 'job', providerResourceId: prepared.externalId!, startCommand: 'npm run cron', healthCheckPath: null }],
    });
    const script = extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + generated.steps, 'Deploy image to Cloud Run');
    const credentials = { client_email: 'ci@example.test', private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('require', 'process', 'fetch', 'Buffer', 'core', script)(() => crypto, { env: {
      GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials), GCP_PROJECT_ID: 'gcp-project', GCP_BOUND_PROJECT_ID: 'gcp-project', GCP_REGION: 'us-central1',
      CLOUDRUN_SERVICE_NAMES: '', CLOUDRUN_JOB_NAMES: prepared.externalId, IMAGE_URI: candidateImage, DEPLOY_OPERATION: 'deploy',
      CLOUDRUN_RELEASE_COMMANDS_B64: Buffer.from('[]').toString('base64'),
      CLOUDRUN_RUNTIME_RESOURCES_B64: Buffer.from(JSON.stringify([{ logicalName: 'cron', workloadKind: 'cron', providerResourceType: 'job', providerResourceId: prepared.externalId!, startCommand: 'npm run cron', healthCheckPath: null }])).toString('base64'),
    } }, fetchMock, Buffer, { info: vi.fn() });
    const beforeActivation = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('cloudscheduler.googleapis.com') && (init?.method ?? 'GET') !== 'GET');
    expect(beforeActivation).toHaveLength(0);
    expect((await adapter.activateSchedule(service, bound, { expectedImage: candidateImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) })).receipt.success).toBe(true);
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/jobs?jobId=') && init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(':run'))).toBe(false);
  });

  it.each(['github', 'portable'] as const)('%s CI rejects a same-name replacement before any Job PATCH', async (kind) => {
    const { fetchMock } = await fixture({ existingImage: holdingImage, changedUid: true });
    await expect(runCi(kind, fetchMock)).rejects.toThrow(/identity|UID/i);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('run.googleapis.com') && (init?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it.each(['github', 'portable'] as const)('%s CI updates the bound UID without creating infrastructure', async (kind) => {
    const { fetchMock } = await fixture({ existingImage: holdingImage });
    await runCi(kind, fetchMock);
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('run.googleapis.com') && (init?.method ?? 'GET') !== 'GET').map(([, init]) => init?.method)).toEqual(['PATCH']);
  });

  it.each(['github', 'portable'] as const)('%s CI uses the Job PATCH contract and retains writable metadata', async (kind) => {
    const { fetchMock } = await fixture({ existingImage: holdingImage, jobMetadata: true });
    await runCi(kind, fetchMock);
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === `https://run.googleapis.com/v2/${jobName}` && init?.method === 'PATCH');
    const body = JSON.parse(String(patch?.[1]?.body));
    expect(body).toMatchObject({ name: jobName, ...retainedJobMetadata, labels: { 'example-owner': 'operations' },
      etag: 'job-etag', template: { parallelism: 2, taskCount: 3, annotations: { 'example.com/task': 'retained' } } });
    for (const outputOnly of ['uid', 'generation', 'observedGeneration', 'reconciling', 'executionCount', 'terminalCondition', 'startExecutionToken', 'runExecutionToken']) {
      expect(body).not.toHaveProperty(outputOnly);
    }
  });

  it('preserves writable Job metadata in ordinary adapter PATCH as well', async () => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage, schedulerExists: true, jobMetadata: true });
    const activeEnvironment = { ...environment, platformBindings: { ...environment.platformBindings, services: { cron: {
      serviceId: jobId, jobName: jobId, resourceUid: scheduleActivation.jobUid, schedulerJobName: `${jobId}-schedule`, resourceType: 'scheduledJob',
    } } } };
    const result = await adapter.deploy(service, activeEnvironment, {}, { deferDeployment: true });
    expect(result.receipt.success, result.receipt.error).toBe(true);
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === `https://run.googleapis.com/v2/${jobName}` && init?.method === 'PATCH');
    const body = JSON.parse(String(patch?.[1]?.body));
    expect(body).toMatchObject({ name: jobName, ...retainedJobMetadata, labels: { 'example-owner': 'operations' },
      etag: 'job-etag', template: { parallelism: 2, taskCount: 3, annotations: { 'example.com/task': 'retained' } } });
    expect(body).not.toHaveProperty('startExecutionToken');
    expect(body).not.toHaveProperty('uid');
  });

  it('keeps the Job binding identity during ordinary reconfiguration after activation', async () => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage, schedulerExists: true });
    const activeEnvironment = { ...environment, platformBindings: { ...environment.platformBindings, services: { cron: {
      serviceId: jobId, jobName: jobId, resourceUid: scheduleActivation.jobUid, schedulerJobName: `${jobId}-schedule`, resourceType: 'scheduledJob',
    } } } };
    const configured = await adapter.deploy(service, activeEnvironment, {}, { deferDeployment: true });
    expect(configured.receipt.success, configured.receipt.error).toBe(true);
    expect(configured).toMatchObject({ externalId: jobId, receipt: { success: true, data: { resourceUid: scheduleActivation.jobUid } } });
    expect((await adapter.observe(activeEnvironment)).services[0]).toMatchObject({ externalId: jobId, status: 'running', config: { cronSchedule: '0 8 * * *' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/services/'))).toBe(false);
  });

  it('rejects an adapter reconfiguration whose terminal Job read has a replacement UID', async () => {
    const { adapter } = await fixture({ existingImage: candidateImage, schedulerExists: true, changedUidAfterPatch: true });
    const activeEnvironment = { ...environment, platformBindings: { ...environment.platformBindings, services: { cron: {
      serviceId: jobId, jobName: jobId, resourceUid: scheduleActivation.jobUid, schedulerJobName: `${jobId}-schedule`, resourceType: 'scheduledJob',
    } } } };
    const result = await adapter.deploy(service, activeEnvironment, {}, { deferDeployment: true });
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toMatch(/identity|UID/i);
  });

  it('retains exact partial creation evidence when the ready read fails', async () => {
    const { adapter } = await fixture({ readFailureAfterCreate: true });
    const result = await adapter.deploy(service, environment, {}, { deferDeployment: true, expectedSourceCommitSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ status: 'failed', externalId: jobId, receipt: { success: false, data: {
      serviceCreateRecovery: { provider: 'cloudrun', operation: 'create', resourceName: jobId, state: 'identified', serviceId: jobId, returnedName: jobId },
    } } });
  });

  it('does not adopt a same-name Job that appears before the final create read', async () => {
    const { adapter, fetchMock } = await fixture({ raceAtFinalRead: true });
    const result = await adapter.deploy(service, environment, {}, { deferDeployment: true, expectedSourceCommitSha: 'a'.repeat(40) });
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toMatch(/adoption/i);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('run.googleapis.com') && (init?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it.each([{ schedulerExists: true }, { schedulerReadUnknown: true }])('stops before building when the fresh trigger namespace is not proven absent %j', async (options) => {
    const { adapter, fetchMock } = await fixture(options);
    const outcome = await adapter.deploy(service, environment, {}, { deferDeployment: true, expectedSourceCommitSha: 'a'.repeat(40) }).catch(() => null);
    expect(outcome?.receipt.success).not.toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('activates only the exact released Job and verifies the scheduler target without executing the Job', async () => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage });
    const result = await adapter.activateSchedule(service, pendingEnvironment, { expectedImage: candidateImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) });
    expect(result).toMatchObject({ status: 'configured', externalId: jobId, receipt: { success: true, data: { schedulerJobName: `${jobId}-schedule`, scheduleActivated: true } } });
    const mutations = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET');
    expect(mutations).toHaveLength(1);
    const body = JSON.parse(String(mutations[0]![1]?.body));
    expect(body).toMatchObject({ schedule: '0 8 * * *', httpTarget: { uri: `https://run.googleapis.com/v2/${jobName}:run`, oauthToken: { serviceAccountEmail: runtimeIdentity } } });
    expect(body).not.toHaveProperty('state');
  });

  it('grants and verifies only the exact Job invoker permission before creating the trigger', async () => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage, missingInvoker: true });
    const result = await adapter.activateSchedule(service, pendingEnvironment, { expectedImage: candidateImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) });
    expect(result.receipt).toMatchObject({ success: true, data: { invokerPermissionVerified: true, invokerGrantApplied: true } });
    const mutations = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET').map(([url]) => String(url));
    expect(mutations).toEqual([`https://run.googleapis.com/v2/${jobName}:setIamPolicy`, 'https://cloudscheduler.googleapis.com/v1/projects/gcp-project/locations/us-central1/jobs']);
  });

  it.each([
    { name: 'unknown IAM read', iamReadUnknown: true, writes: 0 },
    { name: 'IAM etag conflict', iamWriteConflict: true, writes: 1 },
    { name: 'unverified IAM write', iamReadbackMissing: true, writes: 1 },
  ])('does not create a trigger after $name', async ({ writes, ...options }) => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage, missingInvoker: true, ...options });
    expect((await adapter.activateSchedule(service, pendingEnvironment, { expectedImage: candidateImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) })).receipt.success).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET')).toHaveLength(writes);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('cloudscheduler.googleapis.com') && (init?.method ?? 'GET') !== 'GET')).toBe(false);
  });

  it.each([
    { name: 'holding image', existingImage: holdingImage, expectedImage: holdingImage },
    { name: 'wrong image', existingImage: holdingImage, expectedImage: candidateImage },
    { name: 'replacement UID', existingImage: candidateImage, expectedImage: candidateImage, changedUid: true },
    { name: 'wrong command', existingImage: candidateImage, expectedImage: candidateImage, wrongCommand: true },
    { name: 'unknown scheduler read', existingImage: candidateImage, expectedImage: candidateImage, schedulerReadUnknown: true },
    { name: 'mismatched existing scheduler', existingImage: candidateImage, expectedImage: candidateImage, schedulerExists: true, wrongSchedulerTarget: true },
  ])('rejects activation with $name without mutation', async ({ expectedImage, ...options }) => {
    const { adapter, fetchMock } = await fixture(options);
    const result = await adapter.activateSchedule(service, pendingEnvironment, { expectedImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) });
    expect(result.receipt.success).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reconciles a lost activation response on reviewed retry without a second mutation', async () => {
    const { adapter, fetchMock } = await fixture({ existingImage: candidateImage, schedulerWriteTimeout: true });
    const options = { expectedImage: candidateImage, expectedJobUid: scheduleActivation.jobUid, sourceCommitSha: 'a'.repeat(40) };
    expect((await adapter.activateSchedule(service, pendingEnvironment, options)).receipt.success).toBe(false);
    const observed = await adapter.observe(pendingEnvironment);
    expect(observed.completeness?.services).toBe('complete');
    expect(observed.services[0]).toMatchObject({ externalId: jobId, scheduleActivationPending: true, config: { cronSchedule: '0 8 * * *' } });
    expect((await adapter.activateSchedule(service, pendingEnvironment, options)).receipt.success).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET')).toHaveLength(1);
  });

  it('observes a prepared Job as pending with no invented schedule', async () => {
    const { adapter } = await fixture({ existingImage: holdingImage });
    const observed = await adapter.observe(pendingEnvironment);
    expect(observed.completeness?.services).toBe('complete');
    expect(observed.services[0]).toMatchObject({ externalId: jobId, scheduleActivationPending: true, status: 'empty' });
    expect(observed.services[0]?.config).not.toHaveProperty('cronSchedule');
  });

  it.each([{ schedulerReadUnknown: true }, { changedUid: true }])('does not trust pending identity under unknown or changed observation %j', async (options) => {
    const { adapter } = await fixture({ existingImage: holdingImage, ...options });
    const observed = await adapter.observe(pendingEnvironment);
    expect(observed.completeness?.services).toBe('unknown');
    expect(observed.services[0]?.scheduleActivationPending).not.toBe(true);
  });
});
