import { describe, expect, it, vi } from 'vitest';
import { createGcpCloudRetirementDriver } from '../gcp-cloud-retirement.js';
import type { CloudInstallationAction, CloudInstallationEvidence, CloudInstallationIntent, CloudInstallationProviderContext, CloudInstallationRecord } from '../../../../domain/ports/cloud-installation.port.js';

// Reconstructed native metadata and independent REST deletion semantics:
// run v2 services/delete and secret-manager secrets/delete accept etag;
// IAM serviceAccounts/delete accepts the immutable unique ID; registry delete
// cascades and has no etag precondition. No fixture reads secret payloads.
const project = 'customer-project', number = '123456789012', date = '2026-11-01T00:00:00Z';
const collectionId = '11111111-1111-4111-8111-111111111111', deploymentId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333', retirementId = '44444444-4444-4444-8444-444444444444';
const service = `projects/${project}/locations/us-central1/services/customer-web`, shared = `projects/${project}/locations/us-central1/services/shared-host`;
const sharedJob = `projects/${project}/locations/us-central1/jobs/shared-migration`;
const secret = `projects/${number}/secrets/customer-secret`, registry = `projects/${project}/locations/us-central1/repositories/customer-images`;
const runtime = `runtime@${project}.iam.gserviceaccount.com`, writer = `writer@${project}.iam.gserviceaccount.com`, host = `shared-host@${project}.iam.gserviceaccount.com`;
const role = `projects/${project}/roles/customerWriter`;
const account = (email: string) => `projects/${project}/serviceAccounts/${email}`;
function fixture(options: { extraConsumer?: 'account' | 'secret' | 'image'; labels?: boolean; shared?: boolean;
  restrictedForeignRegion?: boolean; latencyMs?: number } = {}) {
  const resources = new Map<string, any>(), policies = new Map<string, any>(), calls: Array<{ method: string; url: URL; body?: any }> = [];
  const base: CloudInstallationIntent = { schemaVersion: 1, installationId: collectionId, customerId: 'customer', appId: 'app', environment: 'gcp-test',
    provider: 'gcp', mode: 'connect', keys: ['KEY'], nativeScope: { projectId: project, projectNumber: number },
    source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
    hostIdentity: { kind: 'gcp-service-account', projectId: project, projectNumber: number, serviceAccountEmail: host,
      subject: '999999999999999999999', issuer: 'https://accounts.google.com' } };
  const records = [collectionId, deploymentId].map(id => ({ schemaVersion: 1, installationId: id, revision: 0, intent: { ...base, installationId: id,
    ...(id === deploymentId ? { purpose: 'deployment', stage: 'deployment', keys: [],
      deployment: { hostingProvider: 'cloudrun', region: 'us-central1', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] } } : {}) }, status: 'ready',
    plan: { digest: 'a'.repeat(64), actions: [], review: { permissions: [], costs: [], warnings: [] } }, attempts: [], completed: {} })) as CloudInstallationRecord[];
  function add(record: CloudInstallationRecord, kind: string, name: string, native: any = {}) {
    const owner = record.installationId === collectionId ? 'c'.repeat(64) : 'd'.repeat(64), deployment = record.installationId === deploymentId;
    const identity = { owner, attemptId, ...(kind === 'account' ? { uniqueId: name.includes('runtime@') ? '111111111111111111111' : '222222222222222222222' } : {}),
      ...(['secret', 'registry'].includes(kind) ? { createTime: date } : {}), ...(kind === 'service' ? { uid: '55555555-5555-4555-8555-555555555555' } : {}) };
    const id = `${kind}:${record.plan.actions.length}`, operation = kind === 'grant' ? 'grant' : `create-${kind}`;
    const action = { id, type: 'create', resource: { kind: 'project', name, provider: 'gcp' }, verified: true,
      metadata: { operation, category: 'scope', execution: 'api', native: {} } } as CloudInstallationAction;
    const evidence: CloudInstallationEvidence = { resources: kind === 'grant' ? [] : [{ kind: kind === 'account' && !deployment ? 'serviceAccount' : kind, id: name, identity }],
      native: { operation, owner, installationId: record.installationId, ...native } };
    record.plan.actions.push(action); record.completed[id] = evidence;
    record.attempts.push({ id: attemptId, actionId: id, status: 'succeeded', startedAt: date, updatedAt: date, evidence });
    if (kind === 'grant') return;
    const marker = deployment ? `hypervibe:deployment:v1:${owner}:${record.installationId}${kind === 'account' ? '' : `:${attemptId}`}` : `hypervibe:${owner}:${attemptId}`;
    resources.set(name, { name, etag: 'native-etag', ...(identity.uniqueId ? { uniqueId: identity.uniqueId } : {}),
      ...(identity.createTime ? { createTime: date } : {}), ...(kind === 'service' ? { uid: identity.uid,
        template: { serviceAccount: runtime, containers: [{ image: `us-central1-docker.pkg.dev/${project}/customer-images/app@sha256:${'e'.repeat(64)}` }] },
        ...(options.labels ? { annotations: { 'hypervibe.dev/owner': owner, 'hypervibe.dev/installation': record.installationId, 'hypervibe.dev/attempt': attemptId } } : {}) }
        : kind === 'secret' ? { labels: { 'hv-installation': owner.slice(0, 63), 'hv-attempt': attemptId } } : { description: marker }),
      ...(kind === 'registry' ? { format: 'DOCKER', mode: 'STANDARD_REPOSITORY' } : {}), ...(kind === 'role' ? { stage: 'GA', includedPermissions: ['secretmanager.versions.add'] } : {}) });
  }
  add(records[0], 'account', account(writer)); add(records[0], 'role', role); add(records[0], 'secret', secret);
  add(records[1], 'account', account(runtime)); add(records[1], 'service', service); add(records[1], 'registry', registry);
  const grant = (record: CloudInstallationRecord, policyKind: string, resource: string, grantRole: string, member: string) => {
    add(record, 'grant', resource, record === records[0] ? { policyKind, policyResource: resource, role: grantRole, member }
      : { grant: { policyKind, resource, role: grantRole, member, retained: true } });
    const policy = policies.get(resource) ?? { etag: 'iam-etag', version: 3, bindings: [], auditConfigs: [{ service: 'allServices' }] };
    policy.bindings.push({ role: grantRole, members: [member] }); policies.set(resource, policy);
  };
  grant(records[0], 'secret', secret, role, `serviceAccount:${writer}`);
  grant(records[1], 'secret', secret, 'roles/secretmanager.secretAccessor', `serviceAccount:${runtime}`);
  grant(records[1], 'project', `projects/${number}`, role, `serviceAccount:${host}`);
  const sharedRuntime = options.extraConsumer === 'account' ? runtime : host;
  if (options.shared !== false) resources.set(shared, { name: shared, uid: '66666666-6666-4666-8666-666666666666',
    template: { serviceAccount: sharedRuntime, containers: [{ image: options.extraConsumer === 'image'
      ? `us-central1-docker.pkg.dev/${project}/customer-images/another:latest` : `us-central1-docker.pkg.dev/${project}/host-images/server:latest`,
      ...(options.extraConsumer === 'secret' ? { env: [{ name: 'API_KEY', valueSource: { secretKeyRef: { secret, version: '1' } } }] } : {}) }] } });
  resources.set(account(host), { name: account(host), uniqueId: base.hostIdentity.subject });
  resources.set(sharedJob, { name: sharedJob, uid: '77777777-7777-4777-8777-777777777777',
    template: { template: { serviceAccount: host, containers: [{ image: `us-central1-docker.pkg.dev/${project}/host-images/migration:latest` }] } } });
  const state = { denied: options.restrictedForeignRegion ? '/locations/me-central2/' : '', lostDelete: '', keepDeleted: '', extraVersion: false, replacements: false, operationError: false };
  const alias = (name: string) => [...resources.values()].find(value => value.uniqueId === name.split('/').at(-1))?.name ?? name;
  const request: typeof fetch = async (input, init = {}) => {
    if (options.latencyMs) await new Promise(resolve => setTimeout(resolve, options.latencyMs));
    const url = new URL(String(input)), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body }); const native = decodeURIComponent(url.pathname.replace(/^\/v[123]\//, ''));
    if (state.denied && native.includes(state.denied)) return Response.json({}, { status: 403 });
    if (native.endsWith(':testIamPermissions')) return Response.json({ permissions: ['run.services.delete', 'iam.serviceAccounts.delete', 'iam.roles.delete',
      'secretmanager.secrets.delete', 'artifactregistry.repositories.delete', 'resourcemanager.projects.setIamPolicy', 'iam.serviceAccounts.setIamPolicy',
      'secretmanager.secrets.setIamPolicy', 'run.services.setIamPolicy', 'artifactregistry.repositories.setIamPolicy'] });
    if (native.endsWith(':getIamPolicy')) return Response.json(policies.get(alias(native.replace(':getIamPolicy', ''))) ?? { etag: 'iam-etag', version: 3, bindings: [] });
    if (native.endsWith(':setIamPolicy')) { policies.set(alias(native.replace(':setIamPolicy', '')), body.policy); return Response.json(body.policy); }
    if (native === `projects/${number}`) return Response.json({ name: native, projectId: project, state: 'ACTIVE' });
    if (native === `projects/${project}/locations`) return Response.json({ locations: [
      { name: `projects/${project}/locations/us-central1`, locationId: 'us-central1' },
      ...(options.restrictedForeignRegion ? [{ name: `projects/${project}/locations/me-central2`, locationId: 'me-central2' }] : []),
    ] });
    if (native.endsWith('/operations/delete')) return Response.json({ name: native, done: true,
      ...(state.operationError ? { error: { code: 9, message: 'Synthetic provider refusal' } } : { response: {} }) });
    if (native === `projects/${number}/secrets`) return Response.json({ secrets: [...resources.values()].filter(value => value.name.includes('/secrets/')) });
    if (native === `projects/${project}/serviceAccounts`) return Response.json({ accounts: [...resources.values()].filter(value => value.name.includes('/serviceAccounts/')) });
    if (native.endsWith('/repositories')) return Response.json({ repositories: [...resources.values()].filter(value => value.name.includes('/repositories/')) });
    if (native.endsWith('/services')) return Response.json({ services: [...resources.values()].filter(value => value.name.includes('/services/')) });
    if (native.endsWith('/jobs')) return Response.json({ jobs: [...resources.values()].filter(value => value.name.includes('/jobs/')) });
    if (/\/(workerPools|revisions|executions|packages|files|attachments)$/.test(native)) return Response.json({});
    if (native.endsWith('/versions')) return Response.json({ versions: [{ name: `${secret}/versions/1`, createTime: date, state: 'ENABLED' },
      ...(state.extraVersion ? [{ name: `${secret}/versions/2`, createTime: date, state: 'ENABLED' }] : [])] });
    if (native.endsWith('/dockerImages')) return Response.json({ dockerImages: [{ name: `${registry}/dockerImages/app@sha256:${'e'.repeat(64)}`, uploadTime: date }] });
    const name = alias(native), value = resources.get(name);
    if (method === 'DELETE') {
      if (!value) return Response.json({}, { status: 404 });
      if ([service, secret, role].includes(name) && url.searchParams.get('etag') !== value.etag) return Response.json({}, { status: 412 });
      if (name.includes('/serviceAccounts/') && !/\/\d+$/.test(native)) throw new Error('Account delete must use uniqueId');
      if (name === registry && url.search) throw new Error('Registry delete has no etag parameter');
      if (state.keepDeleted !== name) resources.delete(name);
      if (state.lostDelete === name) throw new Error('Lost acknowledgment');
      return Response.json({ name: `projects/${project}/locations/us-central1/operations/delete`, done: true });
    }
    return value ? Response.json(value) : Response.json({}, { status: 404 });
  };
  const intent: CloudInstallationIntent = { ...base, installationId: retirementId, mode: 'retire', keys: [],
    retirement: { schemaVersion: 1, data: 'delete-owned', records } };
  const context: CloudInstallationProviderContext = { intent, signal: new AbortController().signal, completed: {}, beforeMutation: async () => {},
    authentication: { administrator: { getAccessToken: async () => 'synthetic-admin' }, host: { verifyIdentity: async () => base.hostIdentity,
      getAccessToken: async () => 'synthetic-host', getIdToken: async () => 'synthetic-id' } } };
  const driver = createGcpCloudRetirementDriver({ fetch: request });
  return { driver, context, resources, policies, calls, state };
}
const attempt = (action: CloudInstallationAction) => ({ id: retirementId, actionId: action.id, status: 'attempted' as const, startedAt: date, updatedAt: date });
describe('hosted GCP retirement serialized native contract', () => {
  it('finishes within the planning deadline by reusing metadata reads, then observes later changes afresh', async () => {
    // Native trace: 164 successful reads, 61 unique reads, then 30s expiry.
    // This smaller fixture has 30 unique reads; 900ms native latency makes
    // repeated per-action reads exceed the same deadline while one pass fits.
    vi.useFakeTimers();
    try {
      const f = fixture({ latencyMs: 900 });
      const pending = f.driver.plan(f.context).then(plan => ({ success: true as const, plan }), error => ({ success: false as const, error }));
      await vi.runAllTimersAsync();
      const result = await pending; expect(result.success, result.success ? undefined : result.error.code).toBe(true);
      if (!result.success) throw result.error;
      const keys = f.calls.map(call => `${call.method} ${call.url.href} ${JSON.stringify(call.body)}`);
      expect(new Set(keys).size).toBe(keys.length);
      f.resources.get(service).uid = '88888888-8888-4888-8888-888888888888';
      const observed = f.driver.inspect({ ...f.context, action: result.plan.actions[0] });
      await vi.runAllTimersAsync();
      expect(await observed).toMatchObject({ state: 'unknown', reason: 'identity_mismatch' });
      expect(f.calls.length).toBeGreaterThan(keys.length);
    } finally { vi.useRealTimers(); }
  });
  it('checks only the original installation region when an unrelated region requires separate access', async () => {
    // Native 2026-11-05 evidence: this us-central1 installation was blocked by
    // a me-central2 403. Google documents special Dammam access requirements.
    // That region is outside the reviewed installation, not confirmed empty.
    const f = fixture({ restrictedForeignRegion: true });
    const plan = await f.driver.plan(f.context);
    expect(plan.actions.some(action => action.resource.name === service)).toBe(true);
    const lists = f.calls.filter(call => call.url.hostname === 'run.googleapis.com' && call.url.pathname.startsWith('/v2/'));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every(call => call.url.pathname.startsWith(`/v2/projects/${project}/locations/us-central1/`))).toBe(true);
    expect(f.calls.some(call => call.url.pathname.includes('/me-central2/') || call.url.pathname.endsWith('/locations'))).toBe(false);
    expect(plan.review.warnings.some(warning => warning.includes('us-central1') && warning.includes('Cross-region'))).toBe(true);
    expect(f.calls.some(call => call.method === 'DELETE' || call.url.pathname.endsWith(':setIamPolicy'))).toBe(false);
  });
  it('blocks denied inventory within the original installation region', async () => {
    const f = fixture(); f.state.denied = '/locations/us-central1/services';
    await expect(f.driver.plan(f.context)).rejects.toMatchObject({ code: 'access_denied', status: 403 });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('rejects a caller-proposed regional scope that differs from the original deployment record', async () => {
    const f = fixture(); f.context.intent.deployment = { hostingProvider: 'cloudrun', region: 'me-central2', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] };
    await expect(f.driver.plan(f.context)).rejects.toMatchObject({ reason: 'identity_mismatch' });
    expect(f.calls.some(call => call.url.pathname.includes('/locations/'))).toBe(false);
  });
  it('retires the exact customer lifetime after release dropped holding labels, preserving shared-host workloads and identity', async () => {
    // Independent production counterexample: UID survives a managed release
    // while the original holding annotations/labels are absent.
    const f = fixture(); const plan = await f.driver.plan(f.context);
    for (const action of plan.actions) {
      const before = await f.driver.inspect({ ...f.context, action });
      if (before.state === 'satisfied') continue;
      expect(before.state).toBe('action-required');
      expect(await f.driver.mutate({ ...f.context, action, attempt: attempt(action) })).toMatchObject({ state: 'acknowledged' });
      expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt(action), status: 'acknowledged' } })).toMatchObject({ state: 'satisfied' });
    }
    expect([...f.resources.keys()]).toEqual([shared, account(host), sharedJob]);
    expect(f.calls.some(call => call.url.pathname.includes(':access') || call.url.pathname.includes(':addVersion'))).toBe(false);
    expect(f.calls.filter(call => call.method === 'DELETE')[0].url.pathname).toContain(service);
  });
  it.each(['account', 'secret', 'image'] as const)('blocks a separate workload consuming the selected customer %s', async extraConsumer => {
    const f = fixture({ extraConsumer, labels: true });
    await expect(f.driver.plan(f.context)).rejects.toMatchObject({ reason: 'ownership_mismatch' });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('does not repeat a deletion after a lost response, and only provider absence completes recovery', async () => {
    const f = fixture({ labels: true }); const plan = await f.driver.plan(f.context), action = plan.actions[0];
    f.state.lostDelete = service; f.state.keepDeleted = service;
    expect(await f.driver.mutate({ ...f.context, action, attempt: attempt(action) })).toMatchObject({ state: 'uncertain' });
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt(action), status: 'uncertain' } })).toMatchObject({ state: 'pending' });
    f.resources.delete(service);
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt(action), status: 'uncertain' } })).toMatchObject({ state: 'satisfied' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('persists native deletion operation identity and distinguishes a terminal refusal from missing acknowledgment', async () => {
    const f = fixture({ labels: true }), plan = await f.driver.plan(f.context), action = plan.actions[0];
    f.state.keepDeleted = service;
    const result = await f.driver.mutate({ ...f.context, action, attempt: attempt(action) });
    expect(result).toMatchObject({ state: 'acknowledged', evidence: { native: { absent: false, operationName: expect.stringContaining('/operations/delete') } } });
    if (result.state !== 'acknowledged') throw new Error('Expected acknowledgment');
    expect(() => f.driver.retirement!.validateCompletedEvidence!(result.evidence!, f.context.intent)).toThrow('not_converged');
    f.state.operationError = true;
    expect(await f.driver.recover({ ...f.context, action, attempt: { ...attempt(action), status: 'acknowledged', evidence: result.evidence } }))
      .toMatchObject({ state: 'rejected', reason: 'provider_error' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('blocks a selected custom role newly granted on an unrelated host secret', async () => {
    const f = fixture({ labels: true }), other = `projects/${number}/secrets/shared-host-secret`;
    f.resources.set(other, { name: other, createTime: date });
    f.policies.set(other, { etag: 'iam-etag', version: 3, bindings: [{ role, members: [`serviceAccount:${host}`] }] });
    await expect(f.driver.plan(f.context)).rejects.toMatchObject({ reason: 'ownership_mismatch' });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('blocks replacement UID and changed data inventory before delete', async () => {
    const f = fixture({ labels: true }); const plan = await f.driver.plan(f.context), first = plan.actions[0];
    f.resources.get(service).uid = '77777777-7777-4777-8777-777777777777';
    expect(await f.driver.inspect({ ...f.context, action: first })).toMatchObject({ state: 'unknown', reason: 'identity_mismatch' });
    const secretAction = plan.actions.find(action => action.resource.name === secret && action.type === 'destroy')!;
    f.state.extraVersion = true;
    expect(await f.driver.inspect({ ...f.context, action: secretAction })).toMatchObject({ state: 'conflict', reason: 'identity_mismatch' });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('treats denied reads as unknown rather than absent and preserves unrelated IAM members', async () => {
    const f = fixture({ labels: true }); const plan = await f.driver.plan(f.context);
    const action = plan.actions.find(action => action.resource.name === `projects/${number}`)!;
    f.resources.delete(service); // The dependent grant stage follows verified service deletion.
    f.policies.get(`projects/${number}`).bindings.push({ role: 'roles/viewer', members: ['user:unrelated@example.test'] });
    expect(await f.driver.mutate({ ...f.context, action, attempt: attempt(action) })).toMatchObject({ state: 'acknowledged' });
    expect(f.policies.get(`projects/${number}`).bindings).toContainEqual({ role: 'roles/viewer', members: ['user:unrelated@example.test'] });
    f.state.denied = 'services/customer-web';
    expect(await f.driver.inspect({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'unknown', reason: 'insufficient_permissions' });
  });
  it('rechecks consumers before resumed IAM revocation after the owned service was removed', async () => {
    const f = fixture(), plan = await f.driver.plan(f.context);
    const action = plan.actions.find(action => action.resource.name === secret && action.type === 'update')!;
    f.resources.delete(service);
    f.resources.get(shared).template.serviceAccount = runtime;
    expect(await f.driver.mutate({ ...f.context, action, attempt: attempt(action) })).toMatchObject({ state: 'rejected', reason: 'ownership_mismatch' });
    expect(f.calls.some(call => call.url.pathname.endsWith(':setIamPolicy'))).toBe(false);
    expect(f.resources.has(shared)).toBe(true);
  });
});
