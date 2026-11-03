import { describe, expect, it } from 'vitest';
import type { IProviderAdapter } from '../../../../domain/ports/provider.port.js';
import { CloudRunRuntimeIdentities, gcpRuntimeAccount, gcpRuntimeOwner } from '../cloudrun-runtime-identities.js';
import type { RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../../domain/ports/runtime-identity.port.js';
import { applyRuntimeAccessAction, observeRuntimeAccess, planRuntimeAccess } from '../../../../domain/services/runtime-access.service.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';

// Reconstructed Cloud Run v2 transport, from jobs.delete (etag + Operation),
// executions.list pagination, and immutable native UID contracts. Job deletion
// terminates active executions: https://docs.cloud.google.com/run/docs/managing/jobs
const projectId = 'retirement-project';
const region = 'us-central1';
const prefix = `projects/${projectId}/locations/${region}`;
const workload = `${prefix}/services/web`;
const jobName = `${prefix}/jobs/web-migration`;
const jobUid = 'd94aee1a-3461-4afa-b231-7e83c55188ef';
const runName = `${jobName}/executions/web-migration-run`;
const releaseAttempt = '67257ca2-ec94-4c26-8489-2e94159ab8e5';
const installationId = 'b3ac6878-688f-4c8c-b49d-7348428b11b5';
const digest = 'a'.repeat(64);
const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: {} });

function fixture() {
  const environment: RuntimeIdentityRequest['environment'] = { id: 'environment-id', projectId: 'local-project', name: 'test',
    createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'cloudrun', projectId, environmentId: region, services: {} } };
  const accountId = gcpRuntimeAccount(projectId, environment, 'web');
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
  const account = { name: `projects/${projectId}/serviceAccounts/${email}`, projectId, email, uniqueId: '123456789012345678901',
    description: gcpRuntimeOwner(projectId, environment, 'web') + 'create-attempt' };
  const target = { schemaVersion: 1, installationId, planDigest: digest, receiptDigest: digest, workload: 'web', provider: 'cloudrun',
    projectId, environmentId: region, resourceId: 'web', resourceUid: '818eea78-77b3-47af-92e8-60762e09d0da',
    holdingRevision: `${workload}/revisions/holding`, configurationDigest: digest, imageUri: `us-central1-docker.pkg.dev/${projectId}/app/image@sha256:${digest}`,
    releaseCommandHash: digest };
  environment.platformBindings.preparedHosting = { schemaVersion: 1, installationId, planDigest: digest, receiptDigest: digest, pendingFirstRelease: [] };
  environment.platformBindings.preparedDirectReleaseAttempts = { web: { id: releaseAttempt, planRunId: 'reviewed-release', actionId: 'service:web', status: 'completed', target,
    rolloutAttempted: true, releaseTask: { phase: 'completed', jobName, jobUid, jobEtag: 'original-etag', operationName: `${prefix}/operations/run`,
      executionName: runName, executionUid: '1cd94b8d-79c1-416e-9ba3-5cf2b2d3cb39' } } };
  environment.platformBindings.preparedDirectReleaseEvidence = { web: { schemaVersion: 1, kind: 'native-direct', attemptId: releaseAttempt, target,
    revision: `${workload}/revisions/application`, generation: '2' } };
  const binding = { provider: 'cloudrun', evidence: { projectId, region, accountId, email, name: account.name, uniqueId: account.uniqueId,
    attemptId: 'create-attempt', environmentId: environment.id, serviceName: 'web', cloudsqlClient: 'not-required', workloadResource: workload, releaseJobResource: jobName } };
  environment.platformBindings.runtimeIdentities = { web: binding };
  const request: RuntimeIdentityRequest = { environment, environmentSpec, service: { name: 'web', buildConfig: {} }, binding, mode: 'destroy' };
  const state = { job: { name: jobName, uid: jobUid, etag: '"opaque/job etag"', generation: '3', observedGeneration: '3', reconciling: false,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: { template: { serviceAccount: email } } } as Record<string, any> | null,
    executions: [{ name: runName, uid: '1cd94b8d-79c1-416e-9ba3-5cf2b2d3cb39', job: jobName, completionTime: '2026-11-03T01:00:00Z',
      conditions: [{ type: 'Completed', state: 'CONDITION_SUCCEEDED' }], runningCount: 0 }], jobStatus: 200,
    listStatus: 200, nextPageToken: '', secondPage: undefined as unknown, loseDelete: false, deletionConverged: true, deleteStatus: 200, primaryPresent: false,
    malformedJobRead: undefined as unknown, postDeleteReadStatus: 200 };
  const reads: string[] = []; const writes: Array<{ url: string; method: string; body: unknown }> = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    if (method === 'GET') reads.push(String(url));
    else writes.push({ url: String(url), method, body: init?.body });
    if (url.origin === 'https://run.googleapis.com') {
      if (url.pathname === `/v2/${workload}`) return state.primaryPresent ? Response.json({ name: workload, template: { serviceAccount: email } }) : Response.json({}, { status: 404 });
      if (url.pathname === `/v2/${jobName}/executions`) return state.listStatus === 200
        ? Response.json(url.searchParams.has('pageToken') && state.secondPage !== undefined ? state.secondPage : { executions: state.executions, ...(state.nextPageToken ? { nextPageToken: state.nextPageToken } : {}) })
        : Response.json({}, { status: state.listStatus });
      if (url.pathname === `/v2/${jobName}`) {
        if (method === 'DELETE') {
          expect(url.searchParams.get('etag')).toBe(state.job?.etag); expect(init?.body).toBeUndefined();
          if (state.deleteStatus !== 200) return Response.json({}, { status: state.deleteStatus });
          if (state.deletionConverged) state.job = null;
          state.jobStatus = state.postDeleteReadStatus;
          if (state.loseDelete) throw new Error('lost native acknowledgement');
          return Response.json({ name: `${prefix}/operations/delete-job`, done: true, response: {} });
        }
        if (state.malformedJobRead !== undefined) return Response.json(state.malformedJobRead);
        return state.jobStatus !== 200 ? Response.json({}, { status: state.jobStatus }) : state.job ? Response.json(state.job) : Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected Cloud Run request: ${method} ${url.pathname}`);
    }
    if (url.pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'policy', bindings: [] });
    if (url.origin === 'https://iam.googleapis.com' && method === 'GET') return Response.json(account);
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };
  const driver = new CloudRunRuntimeIdentities(() => ({ projectId, region, deployEmail: `deploy@${projectId}.iam.gserviceaccount.com` }),
    async () => 'synthetic-token', (_env, name, boundId) => boundId ?? name, async () => 'synthetic-admin', transport);
  const apply = async (step: RuntimeIdentityStep, attemptId = 'delete-attempt') => driver.apply({ ...request, step, attemptId,
    binding: { ...binding, pending: { step, attemptId } } });
  return { request, driver, state, reads, writes, apply, environment, binding };
}

describe('Cloud Run owned release-job retirement', () => {
  it('reviews and removes the exact completed release job before retiring its runtime identity', async () => {
    const f = fixture();
    const observed = await f.driver.inspect(f.request);
    expect(observed).toMatchObject({ state: 'action', step: { operation: 'attach', requiresConfirm: true,
      target: { phase: 'release-job-delete', workloadResource: jobName, workloadUid: jobUid } } });
    if (observed.state !== 'action') throw new Error('missing release job cleanup');
    const result = await f.apply(observed.step);
    expect(result.receipt.success).toBe(true); expect(result.binding).toEqual(f.binding);
    expect(f.writes).toEqual([{ url: `https://run.googleapis.com/v2/${jobName}?etag=${encodeURIComponent('"opaque/job etag"')}`, method: 'DELETE', body: undefined }]);
    expect(await f.driver.inspect({ ...f.request, binding: result.binding })).toMatchObject({ state: 'action', step: { operation: 'destroy' } });
  });

  it('retains migration-job cleanup authority from the completed first release after an older runtime identity loses its service binding', async () => {
    const f = fixture(); delete (f.binding.evidence as Record<string, string>).releaseJobResource;
    // Observed operator shape: runtime identity predates the migration job;
    // ordinary service removal keeps first-release journals but removes services.web.
    expect(f.environment.platformBindings.services).toEqual({});
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'action', step: { operation: 'attach',
      target: { phase: 'release-job-delete', workloadResource: jobName, workloadUid: jobUid } } });
    expect(f.writes).toHaveLength(0);
  });

  it.each(['primary-live', 'missing-proof', 'foreign-parent', 'incomplete-release', 'wrong-job-uid', 'wrong-runtime', 'reconciling',
    'active-execution', 'malformed-execution', 'execution-read-denied', 'job-read-denied', 'repeated-page', 'partial-second-page', 'active-second-page'])(
    'does not admit cleanup with %s', async problem => {
      const f = fixture(); const record = f.environment.platformBindings.preparedDirectReleaseAttempts as any;
      if (problem === 'primary-live') f.state.primaryPresent = true;
      if (problem === 'missing-proof') delete f.environment.platformBindings.preparedDirectReleaseEvidence;
      if (problem === 'foreign-parent') (f.environment.platformBindings.preparedHosting as any).installationId = 'a3ac6878-688f-4c8c-b49d-7348428b11b5';
      if (problem === 'incomplete-release') record.web.status = 'uncertain';
      if (problem === 'wrong-job-uid') f.state.job!.uid = 'replacement-uid';
      if (problem === 'wrong-runtime') f.state.job!.template.template.serviceAccount = `other@${projectId}.iam.gserviceaccount.com`;
      if (problem === 'reconciling') f.state.job!.reconciling = true;
      if (problem === 'active-execution') f.state.executions[0]!.runningCount = 1;
      if (problem === 'malformed-execution') f.state.executions[0]!.completionTime = '';
      if (problem === 'execution-read-denied') f.state.listStatus = 403;
      if (problem === 'job-read-denied') f.state.jobStatus = 403;
      if (problem.endsWith('page')) f.state.nextPageToken = 'page-2';
      if (problem === 'partial-second-page') f.state.secondPage = { executions: null };
      if (problem === 'active-second-page') f.state.secondPage = { executions: [{ ...f.state.executions[0], name: runName + '-2', runningCount: 1 }] };
      const observed = await f.driver.inspect(f.request);
      expect(observed.state).toBe(problem === 'primary-live' ? 'waiting' : 'unknown'); expect(f.writes).toEqual([]);
    });

  it('reads every terminal execution page and does not require the old release image or etag', async () => {
    const f = fixture(); f.state.nextPageToken = 'opaque+page';
    f.state.secondPage = { executions: [{ ...f.state.executions[0], name: runName + '-later', uid: 'later-execution-uid',
      conditions: [{ type: 'Completed', state: 'CONDITION_FAILED' }] }] };
    f.state.job!.template.template.containers = [{ image: 'later-legitimate-image' }];
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'action', step: { target: { workloadEtag: '"opaque/job etag"' } } });
    expect(f.reads.some(url => url.endsWith('pageSize=100&pageToken=opaque%2Bpage'))).toBe(true); expect(f.writes).toEqual([]);
  });

  it('admits the native short execution parent only beside the exact full child scope', async () => {
    const f = fixture(); f.state.executions[0]!.job = 'web-migration';
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'action', step: { target: { phase: 'release-job-delete' } } });
    f.state.executions[0]!.name = runName.replace(projectId, 'foreign-project');
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'unknown' });
  });

  it('rejects a reconciling execution even if it retains old terminal fields', async () => {
    const f = fixture(); (f.state.executions[0] as any).reconciling = true;
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'unknown' }); expect(f.writes).toHaveLength(0);
  });

  it.each(['replaced', 'active', 'etag-changed'])('rechecks %s between review and apply before any mutation', async change => {
    const f = fixture(); const observed = await f.driver.inspect(f.request); if (observed.state !== 'action') throw new Error('no action');
    if (change === 'replaced') f.state.job!.uid = 'replacement';
    if (change === 'active') f.state.executions[0]!.runningCount = 1;
    if (change === 'etag-changed') f.state.job!.etag = 'changed';
    const result = await f.apply(observed.step);
    expect(result.receipt.success).toBe(false); expect(result.receipt.data?.mutationAttempted).toBe(false); expect(f.writes).toEqual([]);
  });

  it.each([false, true])('retains an uncertain deletion and only reobserves it; native absence=%s', async absent => {
    const f = fixture(); f.state.loseDelete = true; f.state.deletionConverged = absent;
    const observed = await f.driver.inspect(f.request); if (observed.state !== 'action') throw new Error('no action');
    const result = await f.apply(observed.step);
    expect(result.receipt.success).toBe(false); expect(result.receipt.data?.mutationAttempted).toBe(true);
    f.request.binding = { ...f.binding, pending: { attemptId: 'delete-attempt', step: observed.step } };
    const recovery = await f.driver.inspect(f.request);
    expect(recovery).toMatchObject({ state: 'action', step: { operation: 'recover', requiresConfirm: false } });
    if (recovery.state !== 'action') throw new Error('no recovery');
    const recovered = await f.apply(recovery.step);
    expect(recovered.receipt.success).toBe(absent); expect(f.writes).toHaveLength(1);
    if (absent) expect(recovered.binding).toEqual(f.binding);
  });

  it('retains acknowledged but incomplete deletion and treats denied readback as unknown', async () => {
    const f = fixture(); f.state.deletionConverged = false;
    const observed = await f.driver.inspect(f.request); if (observed.state !== 'action') throw new Error('no action');
    expect((await f.apply(observed.step)).receipt.success).toBe(false);
    f.request.binding = { ...f.binding, pending: { attemptId: 'delete-attempt', step: observed.step } };
    f.state.jobStatus = 403;
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'unknown' }); expect(f.writes).toHaveLength(1);
  });

  it.each([null, false, 0, []])('never treats malformed HTTP200 body %j as release-job absence', async body => {
    const f = fixture(); f.state.malformedJobRead = body;
    expect(await f.driver.inspect(f.request)).toMatchObject({ state: 'unknown' }); expect(f.writes).toHaveLength(0);
  });

  it('distinguishes a definite delete rejection so a new reviewed attempt can proceed', async () => {
    const f = fixture(); f.state.deleteStatus = 403;
    const observed = await f.driver.inspect(f.request); if (observed.state !== 'action') throw new Error('no action');
    const rejected = await f.apply(observed.step);
    expect(rejected.receipt).toMatchObject({ success: false, data: { mutationAttempted: true, mutationRejected: true } });
    expect(f.state.job?.uid).toBe(jobUid); expect(f.writes).toHaveLength(1);
    f.state.deleteStatus = 200;
    const next = await f.driver.inspect(f.request); if (next.state !== 'action') throw new Error('no reviewed retry');
    expect(next.step.requiresConfirm).toBe(true);
    expect((await f.apply(next.step, 'new-reviewed-attempt')).receipt.success).toBe(true); expect(f.writes).toHaveLength(2);
  });

  it('does not classify denied readback after an acknowledged deletion as a rejected delete', async () => {
    const f = fixture(); f.state.postDeleteReadStatus = 403;
    const observed = await f.driver.inspect(f.request); if (observed.state !== 'action') throw new Error('no action');
    const result = await f.apply(observed.step);
    expect(result.receipt.success).toBe(false); expect(result.receipt.data?.mutationAttempted).toBe(true);
    expect(result.receipt.data?.mutationRejected).not.toBe(true); expect(f.writes).toHaveLength(1);
  });

  it('requires the exact action confirmation, persists intent, and preserves unrelated bindings through shared plan/apply recovery', async () => {
    const f = fixture(); f.state.loseDelete = true;
    const retained = structuredClone(f.environment.platformBindings);
    const input = { environment: f.environment, environmentSpec, storageAdapters: {},
      hosting: { name: 'cloudrun', runtimeIdentities: f.driver } as unknown as IProviderAdapter };
    const actions = planRuntimeAccess(await observeRuntimeAccess(input));
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ id: 'runtime-identity:web', requiresConfirm: true,
      metadata: { step: { target: { phase: 'release-job-delete' } } } });
    const saves: unknown[] = [];
    const save = async (patch: any) => { saves.push(structuredClone(patch)); Object.assign(f.environment.platformBindings, patch); };
    expect((await applyRuntimeAccessAction({ ...input, action: actions[0]!, confirmedActionIds: new Set(), save })).success).toBe(false);
    expect(saves).toHaveLength(0); expect(f.writes).toHaveLength(0);
    expect((await applyRuntimeAccessAction({ ...input, action: actions[0]!, confirmedActionIds: new Set([actions[0]!.id]), save })).success).toBe(false);
    expect(saves[0]).toMatchObject({ runtimeIdentities: { web: { pending: { step: { target: { workloadUid: jobUid } } } } } });
    expect(f.writes).toHaveLength(1);
    const recovered = planRuntimeAccess(await observeRuntimeAccess(input));
    expect(recovered[0]).toMatchObject({ metadata: { step: { operation: 'recover', requiresConfirm: false } } });
    expect(recovered[0]!.requiresConfirm).not.toBe(true);
    expect((await applyRuntimeAccessAction({ ...input, action: recovered[0]!, confirmedActionIds: new Set(), save })).success).toBe(true);
    expect(f.environment.platformBindings).toEqual(retained); expect(f.writes).toHaveLength(1);
  });
});
