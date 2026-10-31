import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import type { CloudDeploymentConnectionV1 } from '../../../../domain/ports/cloud-deployment.port.js';
import type { CloudRunAdapter } from '../cloudrun.adapter.js';
import '../cloudrun.adapter.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../../../domain/services/runtime-access.service.js';
import { resourceName } from '../../../../domain/services/resource-names.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { completePreparedDirectRelease, createPreparedDirectReleaseControl, reviewPreparedDirectReleaseActions } from '../../../../domain/services/prepared-direct-release.service.js';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { buildCloudRunGitHubActionsSteps } from '../cloudrun-ci.workflow.js';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';

// Reconstructed Cloud Run v2 HTTP responses, not live evidence. Independent
// contracts: projects.locations.services.patch updates one revision template;
// Service.uid/etag identify its lifetime/concurrent version; service identity
// belongs to that template. The user requires the real candidate, runtime reader
// and immutable references together; an operator holding image must get none.
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// https://docs.cloud.google.com/run/docs/configuring/services/service-identity
const projectId = 'customer-project', projectNumber = '987654321', region = 'us-central1';
const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parts = ['customer-a', 'app-a', 'production', installationId];
const owner = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const nativeServiceName = resourceName('web', { maxLength: 49, scope: [projectId, 'production'] });
const registryName = resourceName('images', { scope: parts.slice(0, 3) });
const resource = `projects/${projectId}/locations/${region}/services/${nativeServiceName}`;
const resourceUid = 'be22d91a-f126-4e44-8962-9f347d40fa69';
const holdingImage = `us-central1-docker.pkg.dev/operator-public/images/holding@sha256:${'e'.repeat(64)}`;
const candidateImage = `us-central1-docker.pkg.dev/${projectId}/${registryName}/web@sha256:${'f'.repeat(64)}`;
const principal = (name: string, uniqueId: string) => ({ kind: 'gcp-service-account' as const, projectId, projectNumber,
  serviceAccountEmail: `${resourceName(name, { scope: parts, maxLength: 30 })}@${projectId}.iam.gserviceaccount.com`, serviceAccountUniqueId: uniqueId });
const provision = principal('provision', '111111111111111111111');
const release = principal('release', '222222222222222222222');
const runtime = principal('runtime-web', '333333333333333333333');
const holding = principal('holding', '444444444444444444444');
const reference = { destination: { provider: 'gcp-secret-manager' as const, projectId, projectNumber, secretId: 'production-api' }, version: '7' };
const holdingConfiguration = {
  ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', invokerIamDisabled: false,
  template: { serviceAccount: holding.serviceAccountEmail, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 }, timeout: '300s', maxInstanceRequestConcurrency: 1,
    containers: [{ image: holdingImage, ports: [{ containerPort: 8080 }],
      resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true, startupCpuBoost: false },
      startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] },
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Full first application configuration, with image outside this configuration
// digest because managed CI has not built the exact candidate during plan/apply.
const applicationConfiguration = {
  ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY', invokerIamDisabled: false,
  template: { serviceAccount: runtime.serviceAccountEmail, executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    scaling: { minInstanceCount: 0, maxInstanceCount: 100 }, timeout: '300s', maxInstanceRequestConcurrency: 80,
    containers: [{ ports: [{ containerPort: 8080 }],
      env: [{ name: 'API_TOKEN', valueSource: { secretKeyRef: { secret: `projects/${projectNumber}/secrets/production-api`, version: '7' } } },
        { name: 'SETTING', value: 'reviewed-nonsecret' }],
      resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true, startupCpuBoost: false },
      startupProbe: { tcpSocket: { port: 8080 }, periodSeconds: 240, timeoutSeconds: 240, failureThreshold: 1 } }] },
};
function fixture(options: { revokeBeforeJobCreate?: boolean; releaseCommand?: boolean; jobOutcome?: 'success' | 'failed' | 'lost-run' | 'lost-create' | 'pending-ack'; bounds?: boolean; secretCreateTime?: string; finalResponse?: (value: any) => any; rejectWrite?: boolean; loseAcknowledgment?: boolean; operationError?: string } = {}) {
  const expectedApplication = { ingress: applicationConfiguration.ingress, invokerIamDisabled: false,
    ...(options.bounds ? { scaling: { scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 } } : {}),
    template: applicationConfiguration.template };
  const connection: CloudDeploymentConnectionV1 = {
    schemaVersion: 1, purpose: 'deployment', provider: 'gcp', hostingProvider: 'cloudrun', installationId, planDigest: 'c'.repeat(64),
    customerId: 'customer-a', appId: 'app-a', environment: 'production',
    source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
    nativeScope: { projectId, projectNumber },
    deployment: { hostingProvider: 'cloudrun', region, preparation: { kind: 'holding-workloads', image: holdingImage },
      workloads: [{ name: 'web', kind: 'web', public: false, runtimeSecrets: [{ key: 'API_TOKEN', reference }] }] },
    hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
      serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
    principals: { provision, release }, runtimeIdentities: [{ workload: 'web', installationId, owner, principal: runtime }],
    preparedResources: { schemaVersion: 1, project: { id: `projects/${projectNumber}`, lifetimeId: '2026-10-24T10:00:00Z' },
      registry: { id: `projects/${projectId}/locations/${region}/repositories/${registryName}`, lifetimeId: '2026-10-24T11:00:00Z', owner },
      secretTargets: [{ id: `projects/${projectNumber}/secrets/production-api`, lifetimeId: '2026-10-24T11:00:00Z' }],
      workloads: [{ workload: 'web', kind: 'service', id: resource, lifetimeId: resourceUid, owner,
        holding: { image: holdingImage, principal: holding, configurationDigest: digest(holdingConfiguration),
          revision: `${resource}/revisions/web-production-00001-hld`, generation: '1' } }] },
  };
  const now = new Date();
  const environment = { id: 'local-environment', projectId: 'local-app', name: 'production', createdAt: now, updatedAt: now,
    platformBindings: { provider: 'cloudrun', projectId, environmentId: region,
      services: { web: { serviceId: nativeServiceName, resourceUid, imageUri: holdingImage, workloadKind: 'web', resourceType: 'service' } },
      preparedHosting: { schemaVersion: 1, installationId, planDigest: connection.planDigest, receiptDigest: canonicalJsonSha256(connection),
        pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: digest(expectedApplication) } } } as Record<string, any> };
  const service = { id: 'local-web', projectId: 'local-app', name: 'web', buildConfig: { builder: 'dockerfile' as const, public: false,
    ...(options.bounds ? { instanceBounds: { min: 0, max: 1 } } : {}),
    ...(options.releaseCommand ? { releaseCommand: 'npm run db:migrate:production' } : {}) },
    envVarSpec: {}, createdAt: now, updatedAt: now };
  const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun', region }, services: { web: { public: false,
    ...(options.bounds ? { instanceBounds: { min: 0, max: 1 } } : {}) } },
    envVars: { SETTING: 'reviewed-nonsecret' }, secretDestinations: { API_TOKEN: reference }, deploy: { strategy: 'branch', trigger: 'ci' } });
  let current: any = { name: resource, uid: resourceUid, etag: 'holding-etag', generation: '1', observedGeneration: '1',
    createTime: '2026-10-24T12:00:00Z', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: `${resource}/revisions/web-production-00001-hld`, latestReadyRevision: `${resource}/revisions/web-production-00001-hld`,
    ...structuredClone(holdingConfiguration) };
  const writes: Array<{ url: string; body: any }> = [];
  const taskWrites: Array<{ url: string; body: any }> = [];
  const taskResource = `projects/${projectId}/locations/${region}/jobs/${nativeServiceName}-migration`;
  // Reconstructed independently from the Cloud Run v2 Job/Execution contracts.
  const taskTemplate = { containers: [{ image: candidateImage, command: ['/bin/sh'], args: ['-lc', 'npm run db:migrate:production'],
    env: structuredClone(applicationConfiguration.template.containers[0].env), resources: { limits: { cpu: '1', memory: '512Mi' } } }],
    serviceAccount: runtime.serviceAccountEmail, maxRetries: 0, timeout: '3600s' };
  const job = { name: taskResource, uid: 'native-migration-job-uid', etag: 'job-etag', generation: '1', observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: { template: structuredClone(taskTemplate) } };
  const execution = { name: `${taskResource}/executions/exact-migration`, uid: 'native-execution-uid', job: taskResource,
    template: taskTemplate, taskCount: 1, succeededCount: options.jobOutcome === 'failed' ? 0 : 1,
    failedCount: options.jobOutcome === 'failed' ? 1 : 0, completionTime: '2026-10-31T12:02:00Z',
    conditions: [{ type: 'Completed', state: options.jobOutcome === 'failed' ? 'CONDITION_FAILED' : 'CONDITION_SUCCEEDED' }] };
  let jobCreated = false;
  let authorized = true;
  let operationReads = 0;
  const token = 'synthetic-prepared-token';
  const request = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    if (url === 'https://oauth2.googleapis.com/tokeninfo') return Response.json({ azp: provision.serviceAccountUniqueId,
      aud: provision.serviceAccountUniqueId, scope: 'https://www.googleapis.com/auth/cloud-platform', expires_in: '899', exp: String(Math.floor(Date.now() / 1000) + 899) });
    if (url === `https://cloudresourcemanager.googleapis.com/v3/projects/${projectNumber}`)
      return Response.json({ name: `projects/${projectNumber}`, projectId, state: 'ACTIVE', createTime: '2026-10-24T10:00:00Z' });
    for (const p of [provision, runtime, holding]) if (url === `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${p.serviceAccountUniqueId}`)
      return Response.json({ name: `projects/${projectId}/serviceAccounts/${p.serviceAccountEmail}`, email: p.serviceAccountEmail, projectId,
        uniqueId: p.serviceAccountUniqueId, description: `hypervibe:deployment:v1:${owner}:${installationId}` });
    if (url.endsWith(`${runtime.serviceAccountUniqueId}:getIamPolicy`)) return Response.json({ etag: 'sa-policy', bindings: [{ role: 'roles/iam.serviceAccountUser',
      members: [provision, release].map(p => `serviceAccount:${p.serviceAccountEmail}`) }] });
    const secret = `https://secretmanager.googleapis.com/v1/projects/${projectNumber}/secrets/production-api`;
    if (url === secret) return Response.json({ name: `projects/${projectNumber}/secrets/production-api`, createTime: options.secretCreateTime ?? '2026-10-24T11:00:00Z' });
    if (url === `${secret}/versions/7`) return Response.json({ name: `projects/${projectNumber}/secrets/production-api/versions/7`, state: 'ENABLED' });
    if (url === `${secret}:getIamPolicy?options.requestedPolicyVersion=3`) return Response.json({ etag: 'reader-policy', bindings: [
      { role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${runtime.serviceAccountEmail}`] }] });
    if (url.endsWith('/operations/migration-run') && method === 'GET') {
      if (options.jobOutcome === 'pending-ack' && ++operationReads === 1) throw new Error('Synthetic interruption observing acknowledged operation');
      return Response.json({ name: `projects/${projectId}/locations/${region}/operations/migration-run`, done: true, response: execution });
    }
    if (options.releaseCommand && url.includes('/jobs')) {
      if (method === 'PATCH' && url === `https://run.googleapis.com/v2/${taskResource}`) {
        job.template.template = { ...structuredClone(taskTemplate), maxRetries: 1,
          containers: [{ ...structuredClone(taskTemplate.containers[0]!), args: ['-lc', 'npm run db:seed:production'] }] };
        job.etag = 'seed-job-etag';
        return Response.json({ name: `projects/${projectId}/locations/${region}/operations/seed-update`, done: true, response: job });
      }
      if (method === 'GET' && url.endsWith('/executions/exact-migration')) return Response.json(execution);
      if (method === 'GET' && url === `https://run.googleapis.com/v2/${taskResource}`) {
        if (options.revokeBeforeJobCreate) authorized = false;
        return jobCreated ? Response.json(job) : Response.json({}, { status: 404 });
      }
      if (method === 'POST') {
        taskWrites.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith(':run')) {
          if (job.etag === 'seed-job-etag') return Response.json({ name: `projects/${projectId}/locations/${region}/operations/seed-run`, done: true,
            response: { ...execution, name: `${taskResource}/executions/exact-seed`, uid: 'native-seed-execution-uid', template: structuredClone(job.template.template) } });
          if (options.jobOutcome === 'lost-run') throw new Error('Synthetic lost run acknowledgment');
          if (options.jobOutcome === 'pending-ack') return Response.json({ name: `projects/${projectId}/locations/${region}/operations/migration-run`, done: false });
          return Response.json({ name: `projects/${projectId}/locations/${region}/operations/migration-run`, done: true, response: execution });
        }
        jobCreated = true;
        if (options.jobOutcome === 'lost-create') throw new Error('Synthetic lost job creation acknowledgment');
        return Response.json({ name: `projects/${projectId}/locations/${region}/operations/migration-create`, done: true, response: job });
      }
    }
    if (url.startsWith(`https://run.googleapis.com/v2/${resource}`)) {
      if (method === 'GET') return Response.json(current);
      if (method === 'PATCH') {
        if (environment.platformBindings.preparedDirectReleaseAttempts) expect(['attempted', 'uncertain']).toContain(environment.platformBindings.preparedDirectReleaseAttempts.web.status);
        writes.push({ url, body: JSON.parse(String(init.body)) });
        if (options.rejectWrite) return Response.json({ error: { code: 409, status: 'ABORTED' } }, { status: 409 });
        // Independent final native response; not an echo of the submitted body.
        if (options.releaseCommand) expect(taskWrites.filter(write => write.url.endsWith(':run'))).toHaveLength(1);
        current = { ...current, etag: 'application-etag', generation: '2', observedGeneration: '2',
          ...(options.releaseCommand ? { annotations: { 'hypervibe.dev/release-command-sha256-v1': createHash('sha256').update('npm run db:migrate:production').digest('hex') } } : {}),
          ...structuredClone(expectedApplication), template: { ...structuredClone(applicationConfiguration.template),
            containers: [{ ...structuredClone(applicationConfiguration.template.containers[0]), image: candidateImage }] },
          latestCreatedRevision: `${resource}/revisions/web-production-00002-app`, latestReadyRevision: `${resource}/revisions/web-production-00002-app` };
        if (options.finalResponse) current = options.finalResponse(current);
        if (options.loseAcknowledgment) throw new Error('Synthetic transport interruption after the server accepted the update');
        if (options.operationError) return Response.json({ name: `projects/${projectId}/locations/${region}/operations/first-release`, done: true,
          error: { code: 13, message: options.operationError } });
        return Response.json({ name: `projects/${projectId}/locations/${region}/operations/first-release`, done: true,
          response: { name: resource, uid: resourceUid } });
      }
    }
    throw new Error('Unexpected reconstructed native request');
  });
  vi.stubGlobal('fetch', request);
  const create = () => providerRegistry.createTransientAdapter<CloudRunAdapter>('cloudrun', { connection, capability: 'provision',
    authentication: { kind: 'gcp-impersonation', principal: provision, getAccessToken: async () => ({ token, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } });
  const makeControl = (planRunId = 'reviewed-plan') => createPreparedDirectReleaseControl({ planRunId, expectedImage: candidateImage, confirmed: true,
    action: reviewPreparedDirectReleaseActions([{ id: 'service:web', type: 'update', verified: true, requiresConfirm: true, resource: { kind: 'service', provider: 'cloudrun', name: 'web' }, reason: 'Reviewed first application release',
      ...(options.releaseCommand ? { diff: [{ field: 'releaseCommand', to: 'npm run db:migrate:production' }] } : {}) }], environment, { web: candidateImage })[0]!,
    load: () => environment, save: (before, next) => { if (before.platformBindings !== environment.platformBindings) return false; environment.platformBindings = next; return true; }, authorize: () => authorized });
  const control = makeControl();
  return { create, connection, environment, service, environmentSpec, request, writes, taskWrites, taskTemplate, control, makeControl, execution, job, current: () => current };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('prepared Cloud Run first application release', () => {
  it('seeds through the retained migration job using its current update and execution preconditions', async () => {
    const f = fixture({ releaseCommand: true }), adapter = await f.create();
    const deployed = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(deployed.receipt.success).toBe(true);
    f.environment.platformBindings = completePreparedDirectRelease(f.environment, deployed.receipt.data!.preparedRelease);
    f.request.mockClear();
    const result = await adapter.runJob(f.environment, f.service, 'npm run db:seed:production');
    expect(result.receipt.success).toBe(true);
    const update = f.request.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(update?.[1]?.body)).etag).toBe('job-etag');
    const run = f.request.mock.calls.find(([url, init]) => String(url).endsWith(':run') && init?.method === 'POST');
    expect(JSON.parse(String(run?.[1]?.body))).toEqual({ etag: 'seed-job-etag' });
    expect(result.jobId).toMatch(/\/executions\/exact-seed$/);
  });
  it('does not let a later seed task update a replacement migration job with the same name', async () => {
    const f = fixture({ releaseCommand: true }), adapter = await f.create();
    const deployed = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(deployed.receipt.success).toBe(true);
    f.environment.platformBindings = completePreparedDirectRelease(f.environment, deployed.receipt.data!.preparedRelease);
    f.job.uid = 'replacement-job-uid'; f.request.mockClear();
    expect((await adapter.runJob(f.environment, f.service, 'npm run db:seed:production')).receipt.success).toBe(false);
    expect(f.request.mock.calls.filter(([url, init]) => String(url).includes('/jobs') && ['PATCH', 'POST'].includes(init?.method ?? 'GET'))).toEqual([]);
  });
  it('stops before job creation if authorization changes during native absence observation', async () => {
    const f = fixture({ releaseCommand: true, revokeBeforeJobCreate: true }), adapter = await f.create();
    expect((await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control })).receipt.success).toBe(false);
    expect(f.taskWrites).toEqual([]); expect(f.writes).toEqual([]);
  });
  it('runs the candidate migration with its final identity and references before the first service update', async () => {
    const f = fixture({ releaseCommand: true }), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(true);
    expect(f.taskWrites).toHaveLength(2);
    expect(f.taskWrites[0]!.body.template.template).toEqual(f.taskTemplate);
    expect(f.taskWrites[1]!.body).toEqual({ etag: 'job-etag' });
    expect(f.writes).toHaveLength(1);
  });
  it('resumes an acknowledged migration after a process restart without another create or run', async () => {
    const f = fixture({ releaseCommand: true, jobOutcome: 'pending-ack' }), first = await f.create();
    const values = { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' };
    expect((await first.deploy(f.service, f.environment, values,
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control })).receipt.success).toBe(false);
    expect(f.environment.platformBindings.preparedDirectReleaseAttempts.web.releaseTask.phase).toBe('run-acknowledged');
    expect(f.writes).toEqual([]);
    const restarted = await f.create();
    expect((await restarted.deploy(f.service, f.environment, values,
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.makeControl('continuation-plan') })).receipt.success).toBe(true);
    expect(f.taskWrites).toHaveLength(2); expect(f.writes).toHaveLength(1);
  });
  it('recovers a lost rollout acknowledgment only with the original verified migration execution', async () => {
    const f = fixture({ releaseCommand: true, loseAcknowledgment: true }), adapter = await f.create();
    expect((await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control })).receipt.success).toBe(false);
    const inspect = () => adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect((await inspect()).receipt.success).toBe(true);
    f.execution.uid = 'different-execution';
    expect((await inspect()).receipt.success).toBe(false);
    expect(f.taskWrites).toHaveLength(2); expect(f.writes).toHaveLength(1);
  });
  it.each(['failed', 'lost-run', 'lost-create'] as const)('preserves a %s migration attempt without rollout or blind resubmission', async jobOutcome => {
    const f = fixture({ releaseCommand: true, jobOutcome }), adapter = await f.create();
    const deploy = () => adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect((await deploy()).receipt.success).toBe(false);
    expect(f.writes).toEqual([]);
    const attempted = f.taskWrites.length;
    expect(attempted).toBe(jobOutcome === 'lost-create' ? 1 : 2);
    expect((await deploy()).receipt.success).toBe(false);
    expect(f.taskWrites).toHaveLength(attempted);
  });
  it('does not roll out an empty-database application when its release command has not succeeded', async () => {
    // DG-050 requires migrations from the candidate before any runtime change.
    // The transport has no successful job execution; a service PATCH alone is
    // not evidence of a migration. This counterexample used to deploy anyway.
    const f = fixture(), adapter = await f.create();
    const service = { ...f.service, buildConfig: { ...f.service.buildConfig, releaseCommand: 'npm run db:migrate:production' } };
    const result = await adapter.deploy(service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect.soft(result.receipt.success).toBe(false);
    expect(f.writes).toEqual([]);
  });
  it('requires a durable reviewed direct-release attempt before sending the first PATCH', async () => {
    const f = fixture(), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference } });
    expect.soft(result.receipt.success).toBe(false);
    expect(f.writes).toEqual([]);
  });
  it('rejects a recreated secret container even when its name, version and reader policy match', async () => {
    const f = fixture({ secretCreateTime: '2026-10-25T11:00:00Z' }), hosting = await f.create();
    const observation = await observeRuntimeAccess({ hosting, environment: f.environment, environmentSpec: f.environmentSpec, storageAdapters: {} });
    expect(planRuntimeAccess(observation).some(item => item.verified)).toBe(false);
    const receipt = await hosting.setEnvVars(f.environment, f.service, { SETTING: 'reviewed-nonsecret' },
      { deferDeployment: true, secretVersionRefs: { API_TOKEN: reference } });
    expect(receipt.success).toBe(false); expect(f.writes).toEqual([]);
  });
  it('does not rearm a holding workload after a final image was durably bound', async () => {
    const f = fixture(), adapter = await f.create();
    f.environment.platformBindings.services.web.imageUri = candidateImage;
    const receipt = await adapter.setEnvVars(f.environment, f.service, { SETTING: 'reviewed-nonsecret' },
      { deferDeployment: true, secretVersionRefs: { API_TOKEN: reference } });
    expect(receipt.success).toBe(false); expect(f.writes).toEqual([]);
  });
  it('rejects a later holding revision even when its UID, principal and full configuration are unchanged', async () => {
    const f = fixture(), adapter = await f.create();
    Object.assign(f.current(), { generation: '3', observedGeneration: '3',
      latestCreatedRevision: `${resource}/revisions/web-production-00003-hld`, latestReadyRevision: `${resource}/revisions/web-production-00003-hld` });
    const receipt = await adapter.setEnvVars(f.environment, f.service, { SETTING: 'reviewed-nonsecret' },
      { deferDeployment: true, secretVersionRefs: { API_TOKEN: reference } });
    expect(receipt.success).toBe(false); expect(f.writes).toEqual([]);
  });
  it('binds the installed final reader while the verified holding account remains on the workload', async () => {
    const f = fixture(), hosting = await f.create();
    const observation = await observeRuntimeAccess({ hosting, environment: f.environment, environmentSpec: f.environmentSpec, storageAdapters: {} });
    expect(planRuntimeAccess(observation)).toEqual([expect.objectContaining({ id: 'runtime-identity:web', verified: true })]);
    expect(f.writes).toEqual([]);
  });
  it('rejects prepared receipts without an explicit reviewed public-access choice', async () => {
    const f = fixture(); delete f.connection.deployment.workloads[0]!.public;
    f.environment.platformBindings.preparedHosting.receiptDigest = canonicalJsonSha256(f.connection);
    await expect(f.create()).rejects.toThrow('invalid_contract'); expect(f.writes).toEqual([]);
  });
  it.each(['deploy', 'setEnvVars'] as const)('keeps holding code secret-free during deferred %s and reports a pending rollout', async operation => {
    const f = fixture(), adapter = await f.create();
    const options = { deferDeployment: true, secretVersionRefs: { API_TOKEN: reference } };
    const receipt = operation === 'deploy'
      ? (await adapter.deploy(f.service, f.environment, { SETTING: 'reviewed-nonsecret' }, options)).receipt
      : await adapter.setEnvVars(f.environment, f.service, { SETTING: 'reviewed-nonsecret' }, options);
    expect(receipt).toMatchObject({ success: true, data: { deploymentDeferred: true, runtimeRolloutRequired: true,
      rolloutBaseline: { state: 'present', deploymentId: `${resource}/revisions/web-production-00001-hld` } } });
    expect(f.writes).toEqual([]);
    expect(f.current().template.serviceAccount).toBe(holding.serviceAccountEmail);
    expect(f.current().template.containers[0].env).toBeUndefined();
  });
  it('rejects undeclared local values before acknowledging deferred configuration', async () => {
    const f = fixture(), adapter = await f.create();
    const receipt = await adapter.setEnvVars(f.environment, f.service, { SETTING: 'changed-local-input', UNREVIEWED: 'synthetic-value' },
      { deferDeployment: true, secretVersionRefs: { API_TOKEN: reference } });
    expect(receipt.success).toBe(false); expect(f.writes).toEqual([]);
    expect(JSON.stringify(receipt)).not.toMatch(/changed-local-input|synthetic-value/);
  });
  it.each([false, true])('applies the exact candidate, final reader and immutable reference with reviewed bounds=%s', async bounds => {
    const f = fixture({ bounds }), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.body).toMatchObject({ etag: 'holding-etag', template: { serviceAccount: runtime.serviceAccountEmail,
      containers: [expect.objectContaining({ image: candidateImage, env: applicationConfiguration.template.containers[0].env })] } });
    expect(new URL(f.writes[0]!.url).searchParams.get('updateMask')).toContain('template');
    expect(f.writes[0]!.url).not.toContain('allowMissing=true');
    if (bounds) {
      expect(f.writes[0]!.body.scaling).toEqual({ scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 });
      expect(new URL(f.writes[0]!.url).searchParams.get('updateMask')).toContain('scaling');
    }
  });
  it('preserves revision labels during the reviewed first release', async () => {
    const f = fixture(), adapter = await f.create();
    f.current().template.labels = { 'customer-label': 'keep' };
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(true);
    expect(f.writes[0]!.body.template.labels).toEqual({ 'customer-label': 'keep' });
  });
  it('accepts published empty traffic and explicit false revision defaults in native final responses', async () => {
    const f = fixture({ finalResponse: value => ({ ...value, traffic: [], template: { ...value.template,
      sessionAffinity: false, healthCheckDisabled: false, gpuZonalRedundancyDisabled: false } }) }), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(true); expect(f.writes).toHaveLength(1);
  });
  it.each(['rejected', 'acknowledgment-lost'] as const)('does not retry an %s first release', async outcome => {
    const f = fixture({ rejectWrite: outcome === 'rejected', loseAcknowledgment: outcome === 'acknowledgment-lost' }), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(false); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Synthetic transport');
  });
  it('recovers a lost first-release acknowledgment by exact native readback without another PATCH', async () => {
    const f = fixture({ loseAcknowledgment: true }), adapter = await f.create();
    const options = { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control };
    expect((await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' }, options)).receipt.success).toBe(false);
    expect(f.environment.platformBindings.preparedDirectReleaseAttempts.web.status).toBe('uncertain');
    const recovered = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' }, options);
    expect(recovered.receipt).toMatchObject({ success: true, data: { preparedRelease: { kind: 'native-direct',
      attemptId: f.environment.platformBindings.preparedDirectReleaseAttempts.web.id } } });
    expect(f.writes).toHaveLength(1);
  });
  it('does not recover a changed native image after losing the first-release acknowledgment', async () => {
    const f = fixture({ loseAcknowledgment: true }), adapter = await f.create();
    const options = { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control };
    await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' }, options);
    f.current().template.containers[0].image = candidateImage.replace('f'.repeat(64), 'a'.repeat(64));
    expect((await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' }, options)).receipt.success).toBe(false);
    expect(f.writes).toHaveLength(1);
  });
  it.each([
    ['wrong-reference', (native: any) => { native.template.containers[0].env[0].valueSource.secretKeyRef.version = '8'; return native; }],
    ['extra-container', (native: any) => { native.template.containers.push({ image: candidateImage }); return native; }],
    ['extra-template-field', (native: any) => { native.template.encryptionKey = 'unreviewed'; return native; }],
    ['changed-scaling', (native: any) => { native.template.scaling.maxInstanceCount = 1000; return native; }],
    ['missing-generation', (native: any) => { delete native.generation; return native; }],
    ['missing-ready-condition', (native: any) => { delete native.terminalCondition; native.uri = 'https://example.run.app'; return native; }],
    ['holding-traffic', (native: any) => { native.traffic = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'web-production-00001-hld', percent: 100 }]; return native; }],
  ] as const)('does not report a converged first release with %s', async (_name, finalResponse) => {
    const f = fixture({ finalResponse }), adapter = await f.create();
    const result = await adapter.deploy(f.service, f.environment, { IMAGE_URI: candidateImage, SETTING: 'reviewed-nonsecret' },
      { secretVersionRefs: { API_TOKEN: reference }, preparedRelease: f.control });
    expect(result.receipt.success).toBe(false); expect(f.writes).toHaveLength(1);
  });
  it.each(['first-release', 'first-release-bounds', 'holding-service-scaling', 'bounds-lost', 'reverted-holding', 'operation-error', 'terminal-error'] as const)('executes the emitted CI %s with native first-release authority', async scenario => {
    const echoedValue = 'synthetic-provider-echoed-submission';
    const bounds = scenario === 'first-release-bounds' || scenario === 'holding-service-scaling' || scenario === 'bounds-lost';
    const f = fixture({ bounds, ...(scenario === 'bounds-lost' ? { finalResponse: (value: any) => ({ ...value, scaling: { maxInstanceCount: 5 } }) } : {}),
      ...(scenario === 'operation-error' ? { operationError: echoedValue } : {}),
      ...(scenario === 'terminal-error' ? { finalResponse: (value: any) => ({ ...value,
        terminalCondition: { state: 'CONDITION_FAILED', reason: echoedValue, message: echoedValue } }) } : {}) });
    if (scenario === 'holding-service-scaling') f.current().scaling = { maxInstanceCount: 20 };
    if (scenario === 'reverted-holding') Object.assign(f.current(), { generation: '3', observedGeneration: '3',
      latestCreatedRevision: `${resource}/revisions/web-production-00003-hld`, latestReadyRevision: `${resource}/revisions/web-production-00003-hld` });
    const target: BranchDeployTarget = { environmentName: 'production', kind: 'production', branch: 'main', autoDeployOnPush: true,
      serviceNames: ['web'], providerProjectId: projectId, providerEnvironmentId: region, providerRegion: region,
      providerScope: { projectId, region, artifactRepository: registryName, artifactRepositoryCreateTime: '2026-10-24T11:00:00Z' },
      providerServiceIds: [nativeServiceName], runtimeResources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service',
        providerResourceId: nativeServiceName, providerResourceUid: resourceUid, startCommand: null, healthCheckPath: null,
        ...(bounds ? { instanceBounds: { min: 0, max: 1 } } : {}) }],
      deploymentAccess: { origin: 'https://hypervibe.dev', projectId: 'app-a', connectionId: installationId, environment: 'production', sourceBranch: 'main', connection: f.connection },
      preparedRuntime: { envVars: { SETTING: 'reviewed-nonsecret' }, preparation: f.environment.platformBindings.preparedHosting },
    } as BranchDeployTarget;
    const steps = parse('steps:\n' + buildCloudRunGitHubActionsSteps(target).steps).steps;
    const step = steps.find((item: any) => item.name === 'Deploy image to Cloud Run');
    const env = { ...step.env, GCP_PROJECT_ID: projectId, GCP_BOUND_PROJECT_ID: projectId, GCP_REGION: region,
      IMAGE_URI: candidateImage, DEPLOY_OPERATION: 'deploy' };
    const outputs: unknown[] = [], AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const core = { getIDToken: async () => 'synthetic-oidc', setSecret: () => {}, setOutput: (...args: unknown[]) => outputs.push(args), info: () => {} };
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } }) } } };
    const fetch = async (url: string, init: RequestInit) => url.startsWith('https://hypervibe.dev/')
      ? Response.json({ kind: 'gcp-impersonation', principal: release, token: 'synthetic-prepared-token', expiresAt: new Date(Date.now() + 900_000).toISOString() })
      : f.request(url, init);
    const failure = await new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', step.with.script)(
      createRequire(import.meta.url), core, github, { repo: { owner: 'example', repo: 'app' }, sha: 'a'.repeat(40), ref: 'refs/heads/main' }, fetch, { env }).catch((error: unknown) => error);
    if (scenario === 'reverted-holding') {
      expect(f.writes).toEqual([]); expect(failure).toBeInstanceOf(Error); expect(outputs).toEqual([]); return;
    }
    if (scenario === 'operation-error' || scenario === 'terminal-error' || scenario === 'bounds-lost') {
      expect(f.writes).toHaveLength(1); expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain(echoedValue); expect(outputs).toEqual([]); return;
    }
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.body).toMatchObject({ etag: 'holding-etag', template: { serviceAccount: runtime.serviceAccountEmail,
      containers: [expect.objectContaining({ image: candidateImage, env: applicationConfiguration.template.containers[0].env })] } });
    expect(new URL(f.writes[0]!.url).searchParams.get('updateMask')).toContain('template');
    expect(failure).toBeUndefined();
    if (bounds) expect(f.writes[0]!.body.scaling).toEqual({ scalingMode: 'AUTOMATIC', minInstanceCount: 0, maxInstanceCount: 1 });
    expect(outputs).toEqual([['credential_deployments', JSON.stringify([{
      serviceId: nativeServiceName, deploymentIds: [`${resource}/revisions/web-production-00002-app`],
    }])]]);
  });
});
