import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityRequest, RuntimeIdentityBinding } from '../../../../domain/ports/runtime-identity.port.js';
import { CloudRunRuntimeIdentities } from '../cloudrun-runtime-identities.js';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction } from '../../../../domain/services/runtime-access.service.js';
import type { IProviderAdapter } from '../../../../domain/ports/provider.port.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';

// Reconstructed IAM v1 and Cloud Run v2 responses from their published REST
// contracts. Only fetch is replaced; request serialization and driver run.
// https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts
// https://cloud.google.com/resource-manager/reference/rest/v1/projects/getIamPolicy
const projectId = 'cloud-project';
const deployEmail = `deploy@${projectId}.iam.gserviceaccount.com`;
const now = new Date();
const request: RuntimeIdentityRequest = { mode: 'ensure', service: { name: 'web', buildConfig: {} },
  environment: { id: 'env-production', projectId: 'local-project', name: 'production',
    platformBindings: { projectId, environmentId: 'us-central1' }, createdAt: now, updatedAt: now } };
const attemptId = 'attempt-1';
function fixture() {
  let account: Record<string, unknown> | undefined;
  let accountPolicy: Record<string, unknown> = { etag: 'sa-etag', bindings: [] };
  let projectPolicy: Record<string, unknown> = { etag: 'project-etag', bindings: [] };
  let workload: Record<string, any> | undefined;
  let releaseWorkload: Record<string, any> | undefined;
  let revisions: Record<string, unknown>[] = [];
  let loseCreate = false;
  let loseDelete = false;
  let loseQueueGrant = false;
  let loseSecretGrant = false;
  const secrets = new Map<string, Record<string, unknown>>();
  const secretPolicies = new Map<string, Record<string, unknown>>();
  const queues = new Map<string, Record<string, unknown>>();
  const queuePolicies = new Map<string, Record<string, unknown>>();
  const writes: Array<{ url: string; body: any }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === 'https://cloudresourcemanager.googleapis.com/v3/projects/123456789012') return Response.json({ name: 'projects/123456789012', projectId, state: 'ACTIVE' });
    if (url.includes('secretmanager.googleapis.com')) {
      const path = new URL(url).pathname.slice('/v1/'.length); const name = path.split(':')[0]!;
      if (path.endsWith(':getIamPolicy')) return Response.json(secretPolicies.get(name) ?? { etag: 'secret-etag' });
      if (path.endsWith(':setIamPolicy')) {
        writes.push({ url, body }); secretPolicies.set(name, { ...body.policy, etag: 'secret-next' });
        if (loseSecretGrant) { loseSecretGrant = false; throw new Error('lost IAM response synthetic-access-token'); }
        return Response.json(secretPolicies.get(name));
      }
      if (path.endsWith('/versions/7') && secrets.has(name.split('/versions/')[0]!)) return Response.json({ name, state: 'ENABLED', createTime: '2026-10-24T12:00:01Z' });
      return secrets.has(name) ? Response.json(secrets.get(name)) : Response.json({}, { status: 404 });
    }
    if (url.includes('pubsub.googleapis.com')) {
      const parsed = new URL(url); const path = decodeURIComponent(parsed.pathname.slice('/v1/'.length));
      const name = path.split(':')[0]!;
      if (path.endsWith(':getIamPolicy')) return Response.json(queuePolicies.get(name) ?? { etag: 'queue-etag' });
      if (path.endsWith(':setIamPolicy')) {
        writes.push({ url, body }); queuePolicies.set(name, { ...body.policy, etag: 'next-queue-etag' });
        if (loseQueueGrant) { loseQueueGrant = false; throw new Error('lost queue response synthetic-access-token'); }
        return Response.json(queuePolicies.get(name));
      }
      return queues.has(name) ? Response.json(queues.get(name)) : Response.json({}, { status: 404 });
    }
    if (url.includes('run.googleapis.com')) {
      if (new URL(url).pathname.endsWith('/revisions')) return Response.json({ revisions });
      if (new URL(url).pathname.endsWith('/executions')) return Response.json({ executions: [] });
      const release = url.includes('/jobs/release');
      const selected = release ? releaseWorkload : workload;
      if (init?.method === 'PATCH') {
        writes.push({ url, body });
        const updated = { ...selected, etag: 'after-activation', generation: '2', observedGeneration: '2',
          template: { ...selected!.template, ...body.template } };
        if (release) releaseWorkload = updated; else workload = updated;
        return Response.json({ name: `projects/${projectId}/locations/us-central1/operations/activation-1`, done: true, response: updated });
      }
      return selected?.name === new URL(url).pathname.slice('/v2/'.length) ? Response.json(selected) : Response.json({}, { status: 404 });
    }
    if (url.endsWith('/serviceAccounts') && init?.method === 'POST') {
      writes.push({ url, body });
      account = { name: `projects/${projectId}/serviceAccounts/${body.accountId}@${projectId}.iam.gserviceaccount.com`,
        projectId, uniqueId: '123456789012345678901', email: `${body.accountId}@${projectId}.iam.gserviceaccount.com`, ...body.serviceAccount };
      if (loseCreate) throw new Error('provider echoed synthetic-access-token');
      return Response.json(account);
    }
    if (url.includes(':getIamPolicy')) return Response.json(url.includes('serviceAccounts') ? accountPolicy : projectPolicy);
    if (url.includes(':setIamPolicy')) {
      writes.push({ url, body });
      if (url.includes('serviceAccounts')) accountPolicy = { ...body.policy, etag: 'sa-next' };
      else projectPolicy = { ...body.policy, etag: 'project-next' };
      return Response.json(url.includes('serviceAccounts') ? accountPolicy : projectPolicy);
    }
    if (init?.method === 'DELETE') { writes.push({ url, body }); account = undefined; if (loseDelete) throw new Error('lost deletion response'); return Response.json({}); }
    return account ? Response.json(account) : Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const driver = new CloudRunRuntimeIdentities(() => ({ projectId, region: 'us-central1', deployEmail }),
    async () => 'synthetic-access-token', (_env, name, boundId) => boundId ?? name, async () => 'synthetic-native-token');
  return { driver, fetcher, writes, setAccount(value: Record<string, unknown>) { account = value; },
    loseCreate() { loseCreate = true; }, getAccount: () => account,
    loseDelete() { loseDelete = true; },
    setProjectPolicy(value: Record<string, unknown>) { projectPolicy = value; },
    setQueue(value: Record<string, unknown>) { queues.set(String(value.name), value); },
    setQueuePolicy(name: string, value: Record<string, unknown>) { queuePolicies.set(name, value); },
    loseQueueGrant() { loseQueueGrant = true; },
    setSecret(value: Record<string, unknown>) { secrets.set(String(value.name), value); },
    setSecretPolicy(name: string, value: Record<string, unknown>) { secretPolicies.set(name, value); },
    loseSecretGrant() { loseSecretGrant = true; },
    setWorkload(value: Record<string, unknown>) { workload = value; }, getWorkload: () => workload, setRevisions(value: Record<string, unknown>[]) { revisions = value; },
    setReleaseWorkload(value: Record<string, unknown>) { releaseWorkload = value; } };
}
async function apply(driver: CloudRunRuntimeIdentities, input: Parameters<CloudRunRuntimeIdentities['apply']>[0]) {
  return driver.apply({ ...input, binding: { provider: 'cloudrun', evidence: input.binding?.evidence ?? {}, pending: { attemptId: input.attemptId, step: input.step } } });
}
afterEach(() => vi.unstubAllGlobals());

const queueNames = { topicName: `projects/${projectId}/topics/events-production`, subscriptionName: `projects/${projectId}/subscriptions/events-production` };
function queueInput() {
  return { ...request, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} }, queues: { events: {} } }),
    environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings, queues: {
      events: { backend: 'pubsub', providerScope: { projectId }, ...queueNames },
    } } } };
}
function setQueueFixture(f: ReturnType<typeof fixture>) {
  const labels = { 'infraprint-environment': 'production', 'infraprint-queue': 'events' };
  f.setQueue({ name: queueNames.topicName, labels });
  f.setQueue({ name: queueNames.subscriptionName, topic: queueNames.topicName, labels });
}
async function prepare(f: ReturnType<typeof fixture>, input: RuntimeIdentityRequest) {
  const create = await f.driver.inspect(input); if (create.state !== 'action') throw new Error('create');
  const created = await apply(f.driver, { ...input, step: create.step, attemptId });
  const permission = await f.driver.inspect({ ...input, binding: created.binding }); if (permission.state !== 'action') throw new Error('permission');
  return apply(f.driver, { ...input, binding: created.binding, step: permission.step, attemptId: 'base-permissions' });
}

describe('Cloud Run service-owned runtime identities', () => {
  // Secret Manager metadata and etag policy shapes are reconstructed from:
  // docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets
  // docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/get
  it('converges first-deployment secret readers through the shared persisted runtime frontier', async () => {
    const f = fixture(); const resource = 'projects/123456789012/secrets/production-api';
    f.setSecret({ name: resource, createTime: '2026-10-24T12:00:00Z' });
    const environment = structuredClone(request.environment);
    const input = { environment, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} },
      secretDestinations: { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId, projectNumber: '123456789012', secretId: 'production-api' }, version: '7' } } }),
      hosting: { runtimeIdentities: f.driver } as unknown as IProviderAdapter, storageAdapters: {} };
    for (let stage = 0; stage < 3; stage++) {
      const actions = planRuntimeAccess(await observeRuntimeAccess(input));
      expect(actions, JSON.stringify(actions)).toEqual([expect.objectContaining({ id: 'runtime-identity:web', verified: true })]);
      const result = await applyRuntimeAccessAction({ ...input, action: actions[0]!, confirmedActionIds: new Set([actions[0]!.id]),
        save: async bindings => { environment.platformBindings = { ...environment.platformBindings, ...bindings }; } });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    }
    const before = f.writes.length;
    expect(planRuntimeAccess(await observeRuntimeAccess(input))).toEqual([]);
    // Read-only callers without desired-state input must preserve accepted grants.
    expect(await f.driver.inspect({ ...request, environment, binding: (environment.platformBindings.runtimeIdentities as Record<string, RuntimeIdentityBinding>).web }))
      .toMatchObject({ state: 'ready' });
    expect(f.writes).toHaveLength(before);
    expect(f.writes.filter(call => call.url.includes('secretmanager'))).toHaveLength(1);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes(':access'))).toBe(false);
  });

  it('plans and grants an exact immutable secret reader before first deployment, preserving unrelated IAM', async () => {
    const f = fixture(); const resource = 'projects/123456789012/secrets/production-api';
    const input = { ...request, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} },
      secretDestinations: { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId, projectNumber: '123456789012', secretId: 'production-api' }, version: '7' } } }) };
    f.setSecret({ name: resource, createTime: '2026-10-24T12:00:00Z' });
    const unrelated = { role: 'roles/secretmanager.viewer', members: ['user:owner@example.test'] };
    f.setSecretPolicy(resource, { etag: 'secret-etag', bindings: [unrelated] });
    const prepared = await prepare(f, input);
    const next = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(next).toMatchObject({ state: 'action', step: { operation: 'attach', target: { phase: 'secrets', readerResource: resource, readerOperation: 'grant' } } });
    if (next.state !== 'action') throw new Error('missing reader action');
    const granted = await apply(f.driver, { ...input, binding: prepared.binding, step: next.step, attemptId: 'secret-reader' });
    expect(granted.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes('secretmanager'))).toEqual([{ url: `https://secretmanager.googleapis.com/v1/${resource}:setIamPolicy`, body: {
      policy: { etag: 'secret-etag', version: 3, bindings: [unrelated, { role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${prepared.binding!.evidence.email}`] }] },
    } }]);
    expect(await f.driver.inspect({ ...input, binding: granted.binding })).toMatchObject({ state: 'ready' });
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes(':access') || String(url).includes(':addVersion'))).toBe(false);
  });

  it.each(['environment', 'volume', 'revision', 'release', 'duplicate-revision', 'foreign-revision', 'missing-revision-uid'])('preserves reader access while the retained %s still consumes the reference', async consumer => {
    const f = fixture(); const resource = 'projects/123456789012/secrets/production-api';
    const input = { ...request, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} },
      secretDestinations: { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId, projectNumber: '123456789012', secretId: 'production-api' }, version: '7' } } }) };
    f.setSecret({ name: resource, createTime: '2026-10-24T12:00:00Z' });
    const prepared = await prepare(f, input); const step = await f.driver.inspect({ ...input, binding: prepared.binding });
    if (step.state !== 'action') throw new Error('reader');
    const granted = await apply(f.driver, { ...input, binding: prepared.binding, step: step.step, attemptId: 'reader-1' });
    const template = { serviceAccount: granted.binding!.evidence.email, containers: [{ image: `registry.example/app@sha256:${'a'.repeat(64)}` }] };
    const withReference = { ...template, containers: [{ ...template.containers[0], env: [{ name: 'API_TOKEN', valueSource: { secretKeyRef: { secret: resource, version: '7' } } }] }] };
    const name = `projects/${projectId}/locations/us-central1/services/web`;
    f.setWorkload({ name, uid: 'workload-1', template: consumer === 'environment' ? withReference : consumer === 'volume'
      ? { ...template, volumes: [{ name: 'mounted-secret', secret: { secret: 'production-api' } }] } : template });
    if (consumer === 'revision') f.setRevisions([{ name: name + '/revisions/old-web', uid: 'revision-1', service: name, ...withReference }]);
    if (consumer === 'release') f.setReleaseWorkload({ name: `projects/${projectId}/locations/us-central1/jobs/release`, uid: 'release-1', template: { template: withReference } });
    if (consumer === 'duplicate-revision') f.setRevisions([1, 2].map(() => ({ name: name + '/revisions/old-web', uid: 'revision-1', ...template })));
    if (consumer === 'foreign-revision') f.setRevisions([{ name: name.replace('/web', '/another') + '/revisions/old-web', uid: 'revision-1', ...template }]);
    if (consumer === 'missing-revision-uid') f.setRevisions([{ name: name + '/revisions/old-web', ...template }]);
    const changed = { ...input, binding: granted.binding, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} } }),
      environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings, services: { web: { serviceId: 'web', ...(consumer === 'release' ? { releaseJobName: 'release' } : {}) } } } } };
    const before = f.writes.length;
    expect(await f.driver.inspect(changed)).toMatchObject({ state: ['duplicate-revision', 'foreign-revision', 'missing-revision-uid'].includes(consumer) ? 'unknown' : 'waiting' });
    expect(f.writes).toHaveLength(before);
    f.setWorkload({ name, uid: 'workload-1', template }); f.setRevisions([]);
    if (consumer === 'release') f.setReleaseWorkload({ name: `projects/${projectId}/locations/us-central1/jobs/release`, uid: 'release-1', template: { template } });
    const removal = await f.driver.inspect(changed);
    expect(removal).toMatchObject({ state: 'action', step: { target: { readerOperation: 'revoke' } } });
    if (removal.state !== 'action') throw new Error('remove');
    expect((await apply(f.driver, { ...changed, step: removal.step, attemptId: 'remove-reader' })).receipt.success).toBe(true);
  });

  it('recovers an uncertain reader grant by metadata only and blocks a replaced secret lifetime', async () => {
    const f = fixture(); const resource = 'projects/123456789012/secrets/production-api';
    const input = { ...request, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} },
      secretDestinations: { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId, projectNumber: '123456789012', secretId: 'production-api' }, version: '7' } } }) };
    f.setSecret({ name: resource, createTime: '2026-10-24T12:00:00Z' });
    const prepared = await prepare(f, input); const next = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(next.state).toBe('action'); if (next.state !== 'action') throw new Error('missing reader action');
    f.loseSecretGrant();
    const failed = await apply(f.driver, { ...input, binding: prepared.binding, step: next.step, attemptId: 'secret-reader' });
    expect(failed.receipt.success).toBe(false);
    const pending = { ...prepared.binding!, pending: { attemptId: 'secret-reader', step: next.step } };
    const recovery = await f.driver.inspect({ ...input, binding: pending });
    if (recovery.state !== 'action') throw new Error('missing recovery');
    const recovered = await apply(f.driver, { ...input, binding: pending, step: recovery.step, attemptId: 'recover-reader' });
    expect(recovered.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes('secretmanager'))).toHaveLength(1);
    f.setSecret({ name: resource, createTime: '2026-10-25T12:00:00Z' });
    expect(await f.driver.inspect({ ...input, binding: recovered.binding })).toMatchObject({ state: 'unknown' });
  });
  it('waits for exact queue lifecycle bindings before declaring a queue consumer ready', async () => {
    const f = fixture(); const input = { ...queueInput(), environment: request.environment };
    const prepared = await prepare(f, input);
    expect(await f.driver.inspect({ ...input, binding: prepared.binding })).toMatchObject({ state: 'waiting' });
    expect(f.writes.filter(value => value.url.includes('pubsub'))).toHaveLength(0);
  });

  it('plans exact-topic publisher and exact-subscription subscriber permissions and independently verifies them', async () => {
    const f = fixture(); const input = queueInput(); setQueueFixture(f);
    const unrelated = { role: 'roles/pubsub.viewer', members: ['user:owner@example.com'] };
    f.setQueuePolicy(queueNames.topicName, { etag: 'topic-etag', bindings: [unrelated] });
    const prepared = await prepare(f, input);
    const next = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(next).toMatchObject({ state: 'action', step: { operation: 'attach', requiresConfirm: true, target: { phase: 'queues' } } });
    if (next.state !== 'action') throw new Error('queue permissions');
    const result = await apply(f.driver, { ...input, binding: prepared.binding, step: next.step, attemptId: 'queue-grant' });
    expect(result.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes('pubsub'))).toHaveLength(1);
    const remaining = await f.driver.inspect({ ...input, binding: result.binding });
    expect(remaining).toMatchObject({ state: 'action', step: { target: { phase: 'queues', queueResource: queueNames.subscriptionName, queueRole: 'roles/pubsub.subscriber' } } });
    if (remaining.state !== 'action') throw new Error('subscription grant');
    const complete = await apply(f.driver, { ...input, binding: result.binding, step: remaining.step, attemptId: 'subscription-grant' });
    expect(complete.receipt.success).toBe(true);
    const grants = f.writes.filter(value => value.url.includes('pubsub'));
    expect(grants.map(value => [new URL(value.url).pathname, value.body.policy.bindings])).toEqual([
      [`/v1/${queueNames.topicName}:setIamPolicy`, [unrelated, { role: 'roles/pubsub.publisher', members: [`serviceAccount:${prepared.binding!.evidence.email}`] }]],
      [`/v1/${queueNames.subscriptionName}:setIamPolicy`, [{ role: 'roles/pubsub.subscriber', members: [`serviceAccount:${prepared.binding!.evidence.email}`] }]],
    ]);
    expect(grants[0]!.body.policy.etag).toBe('topic-etag');
    expect(f.writes.some(value => value.url.includes('cloudresourcemanager'))).toBe(false);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes(':getIamPolicy') && String(url).includes('pubsub'))
      .every(([, init]) => !init?.body && (init?.method === undefined || init.method === 'GET'))).toBe(true);
    expect(await f.driver.inspect({ ...input, binding: complete.binding })).toMatchObject({ state: 'ready' });
  });

  it.each(['denied', 'wrong-topic', 'wrong-environment', 'empty-policy'])('keeps %s queue permission evidence unknown without mutation', async failure => {
    const f = fixture(); const input = queueInput(); setQueueFixture(f);
    const prepared = await prepare(f, input); const writeCount = f.writes.length;
    if (failure === 'wrong-topic') f.setQueue({ name: queueNames.subscriptionName, topic: `projects/${projectId}/topics/another-topic`, labels: { 'infraprint-environment': 'production', 'infraprint-queue': 'events' } });
    if (failure === 'wrong-environment') f.setQueue({ name: queueNames.topicName, labels: { 'infraprint-environment': 'staging', 'infraprint-queue': 'events' } });
    if (failure === 'empty-policy') f.setQueuePolicy(queueNames.topicName, {});
    if (failure === 'denied') {
      const transport = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init) => String(url).includes('pubsub')
        ? Response.json({ error: { message: 'synthetic-access-token' } }, { status: 403 }) : transport(url, init));
    }
    const result = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(result).toMatchObject({ state: 'unknown' }); expect(JSON.stringify(result)).not.toContain('synthetic-access-token');
    expect(f.writes).toHaveLength(writeCount);
  });

  it('recovers a lost queue grant acknowledgement without repeating it and finishes the remaining exact grant', async () => {
    const f = fixture(); const input = queueInput(); setQueueFixture(f); const prepared = await prepare(f, input);
    const next = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(next.state).toBe('action'); if (next.state !== 'action') throw new Error('queue permissions');
    f.loseQueueGrant(); const lost = await apply(f.driver, { ...input, binding: prepared.binding, step: next.step, attemptId: 'queue-grant' });
    expect(lost.receipt.success).toBe(false); expect(JSON.stringify(lost)).not.toContain('synthetic-access-token');
    const pending = { ...prepared.binding!, pending: { attemptId: 'queue-grant', step: next.step } };
    const observed = await f.driver.inspect({ ...input, binding: pending }); if (observed.state !== 'action') throw new Error('recover');
    const recovered = await apply(f.driver, { ...input, binding: pending, step: observed.step, attemptId: 'queue-recover' });
    expect(recovered.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes('pubsub'))).toHaveLength(1);
    const remaining = await f.driver.inspect({ ...input, binding: recovered.binding }); if (remaining.state !== 'action') throw new Error('remaining');
    const complete = await apply(f.driver, { ...input, binding: recovered.binding, step: remaining.step, attemptId: 'queue-finish' });
    expect(complete.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes('pubsub'))).toHaveLength(2);
  });

  it('removes queue grants one exact policy at a time before deleting the owned account', async () => {
    const f = fixture(); const input = queueInput(); setQueueFixture(f); let result = await prepare(f, input);
    for (let index = 0; index < 2; index++) {
      const next = await f.driver.inspect({ ...input, binding: result.binding }); if (next.state !== 'action') throw new Error('grant');
      result = await apply(f.driver, { ...input, binding: result.binding, step: next.step, attemptId: `grant-${index}` });
      expect(result.receipt.success).toBe(true);
    }
    const destroy = { ...input, mode: 'destroy' as const };
    for (let index = 0; index < 2; index++) {
      const next = await f.driver.inspect({ ...destroy, binding: result.binding });
      expect(next).toMatchObject({ state: 'action', step: { operation: 'attach', target: { queueOperation: 'revoke',
        queueResource: index === 0 ? queueNames.topicName : queueNames.subscriptionName } } });
      if (next.state !== 'action') throw new Error('revoke');
      result = await apply(f.driver, { ...destroy, binding: result.binding, step: next.step, attemptId: `revoke-${index}` });
      expect(result.receipt.success).toBe(true);
      expect(f.getAccount()).toBeDefined();
      expect(f.writes.filter(value => value.url.includes('pubsub'))).toHaveLength(3 + index);
    }
    const finalize = await f.driver.inspect({ ...destroy, binding: result.binding });
    expect(finalize).toMatchObject({ state: 'action', step: { target: { queueOperation: 'record' } } });
    if (finalize.state !== 'action') throw new Error('record');
    const writeCount = f.writes.length;
    result = await apply(f.driver, { ...destroy, binding: result.binding, step: finalize.step, attemptId: 'queue-record' });
    expect(result.receipt.success).toBe(true); expect(f.writes).toHaveLength(writeCount);
    const removal = await f.driver.inspect({ ...destroy, binding: result.binding });
    expect(removal).toMatchObject({ state: 'action', step: { operation: 'destroy' } });
  });

  it('finishes both exact queue grants before offering a legacy workload activation', async () => {
    const f = fixture(); setQueueFixture(f); const original = queueInput();
    const input = { ...original, environment: { ...original.environment, platformBindings: { ...original.environment.platformBindings,
      services: { web: { serviceId: 'web' } } } } };
    f.setWorkload({ name: `projects/${projectId}/locations/us-central1/services/web`, uid: 'legacy-uid', etag: 'legacy-etag',
      generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      template: { serviceAccount: `legacy@${projectId}.iam.gserviceaccount.com`, containers: [{ image: `registry.example/app@sha256:${'a'.repeat(64)}` }] } });
    let result = await prepare(f, input);
    for (let index = 0; index < 2; index++) {
      const next = await f.driver.inspect({ ...input, binding: result.binding });
      expect(next).toMatchObject({ state: 'action', step: { target: { phase: 'queues' } } });
      expect(next).not.toHaveProperty('preparedIdentity');
      if (next.state !== 'action') throw new Error('queue');
      result = await apply(f.driver, { ...input, binding: result.binding, step: next.step, attemptId: `queue-${index}` });
    }
    expect(await f.driver.inspect({ ...input, binding: result.binding })).toMatchObject({ state: 'action', requiresStorageAccess: true,
      step: { target: { phase: 'activate' }, restartsWorkload: true } });
    expect(f.writes.some(value => value.url.includes('run.googleapis.com'))).toBe(false);
  });

  it.each(['cross-project', 'null-binding', 'replaced-scope'])('rejects %s queue authority before granting permission', async failure => {
    const f = fixture(); const input = queueInput(); setQueueFixture(f); const prepared = await prepare(f, input);
    const next = await f.driver.inspect({ ...input, binding: prepared.binding }); if (next.state !== 'action') throw new Error('preview');
    const changed = structuredClone(input);
    const queues = changed.environment.platformBindings.queues as Record<string, any>;
    if (failure === 'null-binding') queues.events = null;
    if (failure === 'cross-project') queues.events.topicName = queueNames.topicName.replace(projectId, 'another-project');
    if (failure === 'replaced-scope') queues.events.subscriptionName = `projects/${projectId}/subscriptions/replaced-subscription`;
    const count = f.writes.length;
    const result = await apply(f.driver, { ...changed, binding: prepared.binding, step: next.step, attemptId: 'stale-queue-grant' });
    expect(result.receipt).toMatchObject({ success: false, data: { mutationAttempted: false } }); expect(f.writes).toHaveLength(count);
  });

  it('plans, creates and separately grants exact-SA actAs without a runtime secret or project IAM administration grant', async () => {
    const f = fixture();
    const preview = await f.driver.inspect(request);
    expect(preview.state).toBe('action'); if (preview.state !== 'action') return;
    expect(preview.step.operation).toBe('create'); expect(f.writes).toHaveLength(0);
    const created = await apply(f.driver, { ...request, step: preview.step, attemptId });
    expect(created.receipt.success).toBe(true); expect(created.binding?.evidence.uniqueId).toBe('123456789012345678901');
    const next = { ...request, binding: created.binding };
    const grant = await f.driver.inspect(next);
    expect(grant.state).toBe('action'); if (grant.state !== 'action') return;
    expect(grant.step.operation).toBe('attach'); expect(grant.step.requiresConfirm).toBe(true);
    const applied = await apply(f.driver, { ...next, step: grant.step, attemptId: 'grant-1' });
    expect(applied.receipt.success).toBe(true);
    expect(f.writes.filter(value => value.url.includes(':setIamPolicy'))).toEqual([expect.objectContaining({ body: {
      policy: { etag: 'sa-etag', version: 3, bindings: [{ role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${deployEmail}`] }] },
    } })]);
    expect(await f.driver.inspect({ ...next, binding: applied.binding })).toMatchObject({ state: 'ready', identity: {
      source: 'configured', scope: { environmentId: request.environment.id, serviceName: 'web', serviceAccountUniqueId: '123456789012345678901' },
    } });
    expect(JSON.stringify(f.writes)).not.toContain('secretAccessor');
  });

  it('retains a lost-create attempt for exact ownership reconciliation without another create', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    f.loseCreate();
    const result = await apply(f.driver, { ...request, step: preview.step, attemptId });
    expect(result.receipt.success).toBe(false); expect(JSON.stringify(result)).not.toContain('synthetic-access-token');
    const recovered = await f.driver.inspect({ ...request, binding: { provider: 'cloudrun', evidence: {}, pending: { attemptId, step: preview.step } } });
    expect(recovered).toMatchObject({ state: 'action', step: { operation: 'recover' } });
    if (recovered.state !== 'action') throw new Error('recovery');
    expect((await apply(f.driver, { ...request, binding: { provider: 'cloudrun', evidence: {}, pending: { attemptId, step: preview.step } }, step: recovered.step, attemptId: 'recovery-1' })).receipt.success).toBe(true);
    expect(f.writes).toHaveLength(1);
  });

  it('blocks an existing same-name account without owned creation evidence', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    f.setAccount({ name: preview.step.target.name, email: preview.step.target.email, projectId, uniqueId: '123456789012345678901', description: 'somebody else' });
    expect(await f.driver.inspect(request)).toMatchObject({ state: 'unknown' }); expect(f.writes).toHaveLength(0);
  });

  it('uses different native account targets for two environments', async () => {
    const f = fixture(); const first = await f.driver.inspect(request);
    const second = await f.driver.inspect({ ...request, environment: { ...request.environment, id: 'env-staging', name: 'staging' } });
    expect(first.state).toBe('action'); expect(second.state).toBe('action');
    if (first.state === 'action' && second.state === 'action') expect(first.step.target.email).not.toBe(second.step.target.email);
  });

  it('grants Cloud SQL client only for declared Cloud SQL and preserves unrelated conditional project grants', async () => {
    const f = fixture();
    const input = { ...request, environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'cloudrun' }, services: { web: {} }, database: { provider: 'cloudsql' } }) };
    const unrelated = { role: 'roles/viewer', members: ['user:owner@example.com'], condition: { title: 'limited', expression: "request.time < timestamp('2030-01-01T00:00:00Z')" } };
    f.setProjectPolicy({ version: 3, etag: 'original-project-etag', bindings: [unrelated] });
    const create = await f.driver.inspect(input); if (create.state !== 'action') throw new Error('create');
    const created = await apply(f.driver, { ...input, step: create.step, attemptId });
    const permission = await f.driver.inspect({ ...input, binding: created.binding }); if (permission.state !== 'action') throw new Error('permissions');
    const granted = await apply(f.driver, { ...input, binding: created.binding, step: permission.step, attemptId: 'permissions-1' });
    expect(granted.receipt.success).toBe(true);
    expect(f.writes.find(value => value.url.includes('cloudresourcemanager'))?.body.policy).toEqual({ version: 3, etag: 'original-project-etag', bindings: [unrelated,
      { role: 'roles/cloudsql.client', members: [`serviceAccount:${created.binding!.evidence.email}`] },
    ] });
  });

  it('rejects mutation without the exact persisted intent and does not read or write a provider', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    f.fetcher.mockClear();
    const result = await f.driver.apply({ ...request, step: preview.step, attemptId });
    expect(result.receipt).toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([403, 429, 503])('preserves unknown account lookup HTTP %s and never plans creation', async status => {
    const f = fixture(); const transport = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes('iam.googleapis.com')
      ? Response.json({ error: { message: 'echo synthetic-access-token' } }, { status }) : transport(url, init));
    const observed = await f.driver.inspect(request); expect(observed.state).toBe('unknown');
    expect(JSON.stringify(observed)).not.toContain('synthetic-access-token'); expect(f.writes).toHaveLength(0);
  });

  it('does not retain an uncertain create marker after an explicit IAM permission rejection', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    const transport = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/serviceAccounts') && init?.method === 'POST'
      ? Response.json({ error: { message: 'permission denied synthetic-access-token' } }, { status: 403 }) : transport(url, init));
    const result = await apply(f.driver, { ...request, step: preview.step, attemptId });
    expect(result.receipt).toMatchObject({ success: false, data: { mutationAttempted: true, mutationRejected: true } });
    expect(JSON.stringify(result)).not.toContain('synthetic-access-token');
    expect(await f.driver.inspect(request)).toMatchObject({ state: 'action', step: { operation: 'create' } });
  });

  it('retains acknowledged creation when its independent account read is forbidden', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    const transport = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes('iam.googleapis.com') && (init?.method ?? 'GET') === 'GET' && f.getAccount()
      ? Response.json({ error: { message: 'forbidden' } }, { status: 403 }) : transport(url, init));
    const result = await apply(f.driver, { ...request, step: preview.step, attemptId });
    expect(result.receipt.success).toBe(false); expect(result.receipt.data).not.toHaveProperty('mutationRejected');
    expect(f.writes).toHaveLength(1);
  });

  it('blocks a missing bound workload without creating a replacement identity', async () => {
    const f = fixture();
    expect(await f.driver.inspect({ ...request, environment: { ...request.environment, platformBindings: {
      ...request.environment.platformBindings, services: { web: { serviceId: 'bound-web' } },
    } } })).toMatchObject({ state: 'unknown' });
    expect(f.writes).toHaveLength(0);
  });

  it('blocks a replaced immutable account ID before granting any permissions', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    const created = await apply(f.driver, { ...request, step: preview.step, attemptId });
    f.setAccount({ ...f.getAccount(), uniqueId: '999999999999999999999' });
    expect(await f.driver.inspect({ ...request, binding: created.binding })).toMatchObject({ state: 'unknown' });
    expect(f.writes).toHaveLength(1);
  });

  it('keeps an empty policy without an etag unknown because no safe update precondition was observed', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    const created = await apply(f.driver, { ...request, step: preview.step, attemptId });
    f.setProjectPolicy({});
    expect(await f.driver.inspect({ ...request, binding: created.binding })).toMatchObject({ state: 'unknown' });
    expect(f.writes).toHaveLength(1);
  });

  it('deletes only the immutable owned account after terminal workload absence and verifies account absence', async () => {
    const f = fixture(); const preview = await f.driver.inspect(request); if (preview.state !== 'action') throw new Error('preview');
    const created = await apply(f.driver, { ...request, step: preview.step, attemptId });
    const input = { ...request, mode: 'destroy' as const, binding: created.binding };
    const removal = await f.driver.inspect(input); if (removal.state !== 'action') throw new Error('remove');
    expect((await apply(f.driver, { ...input, step: removal.step, attemptId: 'destroy-1' })).receipt.success).toBe(true);
    expect(f.writes.at(-1)?.url).toBe(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/123456789012345678901`);
    const finalize = await f.driver.inspect(input);
    expect(finalize).toMatchObject({ state: 'action', step: { operation: 'destroy' } });
    if (finalize.state !== 'action') throw new Error('finalize');
    expect(await apply(f.driver, { ...input, step: finalize.step, attemptId: 'finalize-1' })).toMatchObject({ receipt: { success: true } });
    expect(f.writes.filter(value => value.url.endsWith('123456789012345678901'))).toHaveLength(1);
  });

  it('recovers a lost delete from exact terminal account and workload absence', async () => {
    const f = fixture(); const create = await f.driver.inspect(request); if (create.state !== 'action') throw new Error('create');
    const created = await apply(f.driver, { ...request, step: create.step, attemptId });
    const input = { ...request, mode: 'destroy' as const, binding: created.binding };
    const removal = await f.driver.inspect(input); if (removal.state !== 'action') throw new Error('remove');
    f.loseDelete(); expect((await apply(f.driver, { ...input, step: removal.step, attemptId: 'destroy-1' })).receipt.success).toBe(false);
    const pending = { ...created.binding!, pending: { attemptId: 'destroy-1', step: removal.step } };
    const recovery = await f.driver.inspect({ ...input, binding: pending }); if (recovery.state !== 'action') throw new Error('recovery');
    const result = await apply(f.driver, { ...input, binding: pending, step: recovery.step, attemptId: 'recover-delete-1' });
    expect(result.receipt.success).toBe(true); expect(result.binding).toBeUndefined(); expect(f.writes).toHaveLength(2);
  });

  it('retains the exact legacy workload resource and blocks account deletion after its hosting binding is removed', async () => {
    const f = fixture();
    const resource = `projects/${projectId}/locations/us-central1/services/original-web`;
    f.setWorkload({ name: resource, uid: 'original-workload-uid', etag: 'original-etag', generation: '1', observedGeneration: '1',
      terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: { serviceAccount: `legacy@${projectId}.iam.gserviceaccount.com`,
        containers: [{ image: `registry.example/app@sha256:${'a'.repeat(64)}` }] } });
    const input = { ...request, environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings,
      services: { web: { serviceId: 'original-web' } } } } };
    const create = await f.driver.inspect(input); if (create.state !== 'action') throw new Error('create');
    const created = await apply(f.driver, { ...input, step: create.step, attemptId });
    expect(created.receipt.success).toBe(true);
    expect(await f.driver.inspect({ ...request, mode: 'destroy', binding: created.binding })).toMatchObject({ state: 'waiting' });
    expect(created.binding?.evidence.workloadResource).toBe(resource);
    expect(f.writes).toHaveLength(1);
  });

  it('retains a bound release job as a deletion prerequisite after the local hosting binding is removed', async () => {
    const f = fixture();
    const resource = `projects/${projectId}/locations/us-central1/jobs/release`;
    const input = { ...request, environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings,
      services: { web: { serviceId: 'web', releaseJobName: 'release' } } } } };
    const binding = { provider: 'cloudrun', evidence: { projectId, region: 'us-central1', environmentId: request.environment.id,
      serviceName: 'web', accountId: 'runtime-legacy', email: `runtime-legacy@${projectId}.iam.gserviceaccount.com`,
      name: `projects/${projectId}/serviceAccounts/runtime-legacy@${projectId}.iam.gserviceaccount.com`, uniqueId: '123456789012345678901',
      attemptId, workloadResource: `projects/${projectId}/locations/us-central1/services/web`, releaseJobResource: resource } };
    f.setReleaseWorkload({ name: resource, uid: 'release-uid', template: { template: { serviceAccount: binding.evidence.email } } });
    expect(await f.driver.inspect({ ...request, mode: 'destroy', binding })).toMatchObject({ state: 'waiting' });
    expect(f.writes).toHaveLength(0);
    // The retained resource is scope-bound even when all local hosting records are gone.
    expect(await f.driver.inspect({ ...input, mode: 'destroy', binding: { ...binding, evidence: { ...binding.evidence,
      releaseJobResource: resource.replace(projectId, 'another-project') } } })).toMatchObject({ state: 'unknown' });
  });

  it('prepares a legacy identity transition without restarting the workload until its grant frontier is reviewed', async () => {
    const f = fixture();
    const legacy = `legacy@${projectId}.iam.gserviceaccount.com`;
    const workload = { name: `projects/${projectId}/locations/us-central1/services/web`, uid: 'native-workload-uid', etag: 'before-activation',
      generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      template: { serviceAccount: legacy, containers: [{ image: `registry.example/app@sha256:${'a'.repeat(64)}`, env: [{ name: 'APP_SETTING', value: 'retained' }] }] } };
    f.setWorkload(workload);
    const input = { ...request, environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings, services: { web: { serviceId: 'web' } } } } };
    const preview = await f.driver.inspect(input);
    expect(preview).toMatchObject({ state: 'action', step: { operation: 'create' } }); if (preview.state !== 'action') throw new Error('create');
    const created = await apply(f.driver, { ...input, step: preview.step, attemptId });
    const permission = await f.driver.inspect({ ...input, binding: created.binding }); if (permission.state !== 'action') throw new Error('permission');
    const prepared = await apply(f.driver, { ...input, binding: created.binding, step: permission.step, attemptId: 'permission-1' });
    const activation = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(activation).toMatchObject({ state: 'action', requiresStorageAccess: true, step: { operation: 'attach', restartsWorkload: true, target: { phase: 'activate' } },
      preparedIdentity: { source: 'configured', principal: created.binding!.evidence.email, activation: { previousPrincipal: legacy, workloadEtag: 'before-activation' } } });
    expect(f.writes.some(value => value.url.includes('run.googleapis.com'))).toBe(false);
    if (activation.state !== 'action') throw new Error('activate');
    const activated = await apply(f.driver, { ...input, binding: prepared.binding, step: activation.step, attemptId: 'activate-1' });
    expect(activated.receipt.success).toBe(true);
    const patch = f.writes.find(value => value.url.includes('run.googleapis.com'))!;
    expect(patch.url).toContain('updateMask=template.serviceAccount');
    expect(patch.body).toEqual({ name: workload.name, etag: 'before-activation', template: { serviceAccount: created.binding!.evidence.email } });
    expect(f.getWorkload()!.template.containers).toEqual(workload.template.containers);
    f.setProjectPolicy({ etag: 'retained-project-policy', bindings: [{ role: 'roles/storage.objectUser', members: [`serviceAccount:${legacy}`] }] });
    expect(await f.driver.inspect({ ...input, binding: activated.binding })).toMatchObject({ state: 'ready', identity: { source: 'observed', principal: created.binding!.evidence.email },
      warnings: [expect.stringContaining(`roles/storage.objectUser for ${legacy} on project ${projectId}`)] });
  });

  it('transitions the exact bound release job before the service without executing it or losing its candidate configuration', async () => {
    const f = fixture(); const legacy = `legacy@${projectId}.iam.gserviceaccount.com`;
    const task = { serviceAccount: legacy, containers: [{ image: `registry.example/app@sha256:${'a'.repeat(64)}`, env: [{ name: 'APP_SETTING', value: 'retained' }] }] };
    const common = { etag: 'before', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' } };
    f.setWorkload({ ...common, name: `projects/${projectId}/locations/us-central1/services/web`, uid: 'service-uid', template: task });
    const release = { ...common, name: `projects/${projectId}/locations/us-central1/jobs/release`, uid: 'release-uid',
      labels: { owner: 'keep' }, annotations: { reviewed: 'keep' }, template: { taskCount: 1, template: { ...task, maxRetries: 0, timeout: '1800s' } }, startExecutionToken: 'must-not-replay' };
    f.setReleaseWorkload(release);
    const input = { ...request, environment: { ...request.environment, platformBindings: { ...request.environment.platformBindings,
      services: { web: { serviceId: 'web', releaseJobName: 'release' } } } } };
    const create = await f.driver.inspect(input); if (create.state !== 'action') throw new Error('create');
    const created = await apply(f.driver, { ...input, step: create.step, attemptId });
    const permissions = await f.driver.inspect({ ...input, binding: created.binding }); if (permissions.state !== 'action') throw new Error('permissions');
    const prepared = await apply(f.driver, { ...input, binding: created.binding, step: permissions.step, attemptId: 'permissions-1' });
    const first = await f.driver.inspect({ ...input, binding: prepared.binding });
    expect(first).toMatchObject({ state: 'action', step: { target: { workloadResource: release.name, resourceKind: 'job' } } });
    if (first.state !== 'action') throw new Error('first');
    const changed = await apply(f.driver, { ...input, binding: prepared.binding, step: first.step, attemptId: 'release-transition' });
    expect(changed.receipt.success).toBe(true);
    const patch = f.writes.find(value => value.url.includes('/jobs/release'))!;
    expect(patch.body).not.toHaveProperty('startExecutionToken'); expect(patch.url).not.toContain('updateMask');
    expect(patch.body).toMatchObject({ labels: release.labels, annotations: release.annotations, template: { taskCount: 1,
      template: { containers: task.containers, maxRetries: 0, timeout: '1800s', serviceAccount: created.binding!.evidence.email } } });
    expect(await f.driver.inspect({ ...input, binding: changed.binding })).toMatchObject({ state: 'action', step: { target: { workloadResource: `projects/${projectId}/locations/us-central1/services/web` } } });
  });
});
