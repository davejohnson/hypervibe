import { gcpAccountPolicyGetContractResponse } from '../../src/test/gcp-iam-policy-contract.js';
import { gcpRoleGetContractResponse } from '../../src/test/gcp-iam-role-contract.js';
import { serviceUsageResponse } from './helpers/gcp-service-usage.js';
import { describe, expect, it, vi } from 'vitest';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';
import { prepareCloudDeploymentIntentV1, issueCloudDeploymentSessionV1, verifyCloudDeploymentReleaseTargetsV1, prepareCloudDeploymentSourceAuthorizationV1 } from '../../src/application/hosted/cloud-deployment-session.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import type { CloudInstallationIntent } from '../../src/domain/ports/cloud-installation.port.js';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1, cloudInstallationDeploymentConnectionV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed native JSON, not live capture. Only serialized transport is replaced.
// Run create is parent-authorized POST and returns an operation; UID lasts until deletion:
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/create
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
// Repository create returns a long-running operation, not immediate convergence:
// https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/create
// Native no-parent protobuf default is distinct from unreadable ancestor authority.
const image = `us-west1-docker.pkg.dev/holding-project/public/holding@sha256:${'f'.repeat(64)}`;
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', purpose: 'deployment', stage: 'deployment',
  customerId: 'customer', appId: 'app', environment: 'staging', provider: 'gcp', mode: 'connect', keys: [],
  nativeScope: { projectId: 'customer-project', projectNumber: '123456789012' },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '987654321098',
    serviceAccountEmail: 'host@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
};
const spec = projectSpecSchema.parse({ project: 'app', version: 1,
  secrets: { API_KEY: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } }, environments: { staging: {
  hosting: { provider: 'cloudrun', region: 'us-west1' }, services: {
    web: { workloadKind: 'web', startCommand: 'node server.js', public: true },
    worker: { workloadKind: 'worker', startCommand: 'node worker.js', public: false },
  }, secretDestinations: { API_KEY: { destination: { provider: 'gcp-secret-manager', projectId: 'customer-project',
    projectNumber: '123456789012', secretId: 'api-key' }, version: '7' } },
} } });
const nativeAdministratorPermissions = [
  'resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
  'iam.roles.create', 'iam.roles.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccounts.actAs',
  'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'secretmanager.secrets.create',
  'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy', 'secretmanager.secrets.setIamPolicy',
  'secretmanager.versions.get',
  'serviceusage.services.get', 'serviceusage.services.enable', 'run.services.create', 'run.services.get',
  'run.services.getIamPolicy', 'run.services.setIamPolicy', 'artifactregistry.repositories.create',
  'artifactregistry.repositories.get', 'artifactregistry.repositories.getIamPolicy', 'artifactregistry.repositories.setIamPolicy',
];
function nativeFixture(callLimit = Number.POSITIVE_INFINITY) {
  const calls: Array<{ url: string; method: string; body: any; authorization?: string }> = [];
  const resources = new Map<string, any>(), policies = new Map<string, any>(); let serial = 0;
  const state = { parent: '', lostServiceAcknowledgment: false, deniedPath: '', issued: 0, callLimit, policyReadHook: undefined as ((name: string) => void) | undefined };
  const tokens = new Map<string, { uid: string; expiresAt: string }>();
  const alias = (name: string) => [...resources.values()].find(item => item.uniqueId === name.split('/').at(-1))?.name ?? name;
  const policy = (name: string) => policies.get(alias(name)) ?? { etag: 'original', version: 3, bindings: [{ role: 'roles/viewer', members: ['user:administrator@example.test'],
    condition: { title: 'preserved', expression: 'true' } }], auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }] };
  resources.set('projects/123456789012/secrets/api-key', { name: 'projects/123456789012/secrets/api-key', createTime: '2026-10-20T00:00:00Z' });
  const request = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), parsed = new URL(url), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, authorization: new Headers(init.headers).get('Authorization') ?? undefined });
    const invalidRoleGet = gcpRoleGetContractResponse(parsed, method, init.body);
    if (invalidRoleGet) return invalidRoleGet;
    const invalidPolicyRead = gcpAccountPolicyGetContractResponse(parsed, method, init.body);
    if (invalidPolicyRead) return invalidPolicyRead;
    if (calls.length > state.callLimit) throw new Error('Reconstructed transport exceeded its finite phase call budget');
    if (state.deniedPath && parsed.pathname.includes(state.deniedPath)) return new Response(null, { status: 403 });
    const native = decodeURIComponent(parsed.pathname.replace(/^\/v[123]\//, ''));
    if (native.endsWith(':getIamPolicy')) {
      const name = native.replace(/:getIamPolicy$/, ''), response = Response.json(policy(name));
      state.policyReadHook?.(name); return response;
    }
    if (native.endsWith(':setIamPolicy')) {
      const name = alias(native.replace(/:setIamPolicy$/, ''));
      if (body.policy.etag !== policy(name).etag) return new Response(null, { status: 412 });
      policies.set(name, { ...body.policy, etag: `revision-${++serial}` }); return Response.json(policies.get(name));
    }
    if (parsed.hostname === 'cloudresourcemanager.googleapis.com') {
      if (parsed.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: nativeAdministratorPermissions });
      if (parsed.pathname.endsWith(':getIamPolicy')) return Response.json({ etag: 'project-etag', version: 3,
        bindings: [{ role: 'roles/owner', members: ['user:administrator@example.test'] }] });
      return Response.json({ name: 'projects/123456789012', projectId: 'customer-project', state: 'ACTIVE', createTime: '2026-10-24T00:00:00Z', ...(state.parent ? { parent: state.parent } : {}) });
    }
    if (parsed.hostname === 'serviceusage.googleapis.com') return serviceUsageResponse(parsed, parsed.pathname.replace(/^\/v1\//, ''), 'ENABLED');
    if (parsed.hostname === 'artifactregistry.googleapis.com' && parsed.pathname.includes('/dockerImages/')) {
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      return Response.json({ name: `projects/holding-project/locations/us-west1/repositories/public/dockerImages/holding@sha256:${'f'.repeat(64)}`, uri: image });
    }
    if (parsed.hostname === 'iam.googleapis.com') {
      if (method === 'POST' && native.endsWith('/roles')) {
        const name = `${native}/${body.roleId}`; if (resources.has(name)) return new Response(null, { status: 409 });
        resources.set(name, { ...body.role, name }); return Response.json(resources.get(name));
      }
      if (method === 'POST' && native.endsWith('/serviceAccounts')) {
        const email = `${body.accountId}@customer-project.iam.gserviceaccount.com`, name = `${native}/${email}`;
        if (resources.has(name)) return new Response(null, { status: 409 });
        resources.set(name, { ...body.serviceAccount, name, email, projectId: 'customer-project', uniqueId: String(222222222222222220000n + BigInt(++serial)) });
        return Response.json(resources.get(name));
      }
      const found = resources.get(native) ?? [...resources.values()].find(item => item.uniqueId === native.split('/').at(-1));
      return found ? Response.json(found) : new Response(null, { status: 404 });
    }
    if (parsed.hostname === 'iamcredentials.googleapis.com') {
      const uid = native.split('/').at(-1)!.replace(':generateAccessToken', '');
      if (![...resources.values()].some(item => item.uniqueId === uid)) return new Response(null, { status: 404 });
      expect(body).toEqual({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '900s' });
      const token = `synthetic-issued-${++state.issued}`, expiresAt = new Date(Date.now() + 900000).toISOString(); tokens.set(token, { uid, expiresAt });
      return Response.json({ accessToken: token, expireTime: expiresAt });
    }
    if (parsed.hostname === 'oauth2.googleapis.com') {
      const found = tokens.get(new Headers(init.headers).get('Authorization')?.replace('Bearer ', '') ?? '');
      if (!found) return new Response(null, { status: 401 });
      return Response.json({ aud: found.uid, azp: found.uid, scope: 'https://www.googleapis.com/auth/cloud-platform', exp: String(Math.floor(Date.parse(found.expiresAt) / 1000)) });
    }
    if (parsed.hostname === 'secretmanager.googleapis.com') {
      if (native.endsWith('/versions/7')) return Response.json({ name: native, state: 'ENABLED', createTime: '2026-10-21T00:00:00Z' });
      return resources.has(native) ? Response.json(resources.get(native)) : new Response(null, { status: 404 });
    }
    if (['run.googleapis.com', 'artifactregistry.googleapis.com'].includes(parsed.hostname)) {
      if (method === 'POST') {
        const key = parsed.searchParams.get('serviceId') ?? parsed.searchParams.get('repositoryId'), name = `${native}/${key}`;
        if (resources.has(name)) return new Response(null, { status: 409 });
        const service = native.endsWith('/services');
        const result = { ...body, name, createTime: '2026-10-24T01:00:00Z', ...(service ? {
          uid: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, etag: `native-${serial}`, generation: '1', observedGeneration: '1',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          latestCreatedRevision: `${name}/revisions/${key}-00001-abc`, latestReadyRevision: `${name}/revisions/${key}-00001-abc`,
        } : {}) };
        if (service) { expect(result.template.containers).toHaveLength(1); expect(result.template.containers[0].env).toBeUndefined(); expect(result.template.serviceAccount).not.toContain('runtime'); }
        resources.set(name, result);
        if (service && state.lostServiceAcknowledgment) { state.lostServiceAcknowledgment = false; throw new Error('Synthetic lost native acknowledgment'); }
        return Response.json({ name: `projects/customer-project/locations/us-west1/operations/operation-${serial}`, done: true, response: result });
      }
      return resources.has(native) ? Response.json(resources.get(native)) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected native fixture route ${method} ${parsed.hostname}${parsed.pathname}`);
  });
  return { request, calls, resources, policies, state };
}
const authentication = { administrator: { getAccessToken: async () => 'synthetic-admin-token' },
  host: { verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => 'synthetic-host-token',
    getIdToken: async () => { throw new Error('No Google web identity exchange is needed'); } } };
async function setupNative(callLimit?: number) {
  const f = nativeFixture(callLimit), driver = createGcpCloudInstallationDriver({ fetch: f.request, holdingImage: image });
  const records = new Map<string, CloudInstallationRecord>();
  const store = { read: async (id: string) => structuredClone(records.get(id) ?? null),
    compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true;
    } };
  const shared = { driver, store, authentication, authorize: async () => true };
  const prepared = prepareCloudDeploymentIntentV1(spec, intent, driver), plan = await planCloudInstallationV1({ ...shared, intent: prepared });
  const apply = () => applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
    confirmActions: plan.plan.actions.map(action => action.id) });
  return { f, driver, shared, plan, apply };
}

describe('native Google prepared deployment installation', () => {
  it('prepares exact reviewed topology with a pinned operator holding image and no secret values', () => {
    const request = vi.fn();
    const driver = createGcpCloudInstallationDriver({ fetch: request, holdingImage: image } as any);
    const prepared = prepareCloudDeploymentIntentV1(spec, intent, driver);
    expect(prepared.deployment).toMatchObject({ hostingProvider: 'cloudrun', region: 'us-west1',
      preparation: { kind: 'holding-workloads', image }, workloads: [
        { name: 'web', kind: 'web', public: true, runtimeSecrets: [{ key: 'API_KEY', reference: { version: '7' } }] },
        { name: 'worker', kind: 'worker', public: false },
      ] });
    expect(request).not.toHaveBeenCalled();
  });

  it('requires an explicitly configured immutable public holding image for a new review', () => {
    for (const holdingImage of [undefined, image.replace(/@sha256:.+/, ':latest'), 'https://arbitrary.example/holding']) {
      const request = vi.fn(), driver = createGcpCloudInstallationDriver({ fetch: request, holdingImage } as any);
      expect(() => prepareCloudDeploymentIntentV1(spec, intent, driver)).toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('plans distinct reviewed native holding resources through injected browser authority', async () => {
    const f = nativeFixture(), driver = createGcpCloudInstallationDriver({ fetch: f.request, holdingImage: image } as any);
    const deployment = { hostingProvider: 'cloudrun', region: 'us-west1', preparation: { kind: 'holding-workloads', image },
      workloads: [{ name: 'web', kind: 'web', public: true, runtimeSecrets: [] }] };
    const plan = await driver.plan({ intent: { ...intent, deployment } as any, authentication,
      signal: AbortSignal.timeout(1000), completed: {}, beforeMutation: async () => { throw new Error('Planning cannot mutate'); } });
    expect(plan.actions.filter(action => action.metadata.operation === 'create-service')).toHaveLength(1);
    expect(plan.actions.filter(action => action.metadata.operation === 'create-registry')).toHaveLength(1);
    expect(plan.review.permissions).not.toEqual([]);
    expect(f.calls.every(call => call.method === 'GET' || new URL(call.url).pathname.endsWith(':getIamPolicy') || call.url.endsWith(':testIamPermissions'))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('synthetic-admin-token');
  });
  // This compound case reviews 62 actions and exercises the real journal plus
  // a final reconciliation. Profiling recorded 7/1724/516 serialized requests
  // and all 235 deadline timers cleared. A bounded 5ms/read transport reproduced
  // the CI 10s timeout; 30s passes without changing provider phase deadlines.
  // These are offline fixture costs, not live latency or provider support proof.
  it('runs the real shared installation journal to private prepared resources without launching app configuration', { timeout: 30_000 }, async () => {
    const f = nativeFixture(16), driver = createGcpCloudInstallationDriver({ fetch: f.request, holdingImage: image });
    const records = new Map<string, CloudInstallationRecord>();
    const store = { read: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true;
      } };
    const shared = { driver, store, authentication, authorize: async () => true };
    const prepared = prepareCloudDeploymentIntentV1(spec, intent, driver), plan = await planCloudInstallationV1({ ...shared, intent: prepared });
    const plannedCalls = f.calls.length;
    expect(plannedCalls).toBeLessThanOrEqual(16);
    f.state.callLimit = plannedCalls + 2000;
    const ready = await applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    const appliedCalls = f.calls.length;
    expect(appliedCalls - plannedCalls).toBeLessThanOrEqual(2000);
    expect(ready.status).toBe('ready');
    const connection = cloudInstallationDeploymentConnectionV1(ready, driver);
    expect(connection.preparedResources?.workloads).toHaveLength(2);
    expect(connection.principals.provision).not.toEqual(connection.principals.release);
    expect(connection.runtimeIdentities).toHaveLength(2);
    for (const item of connection.preparedResources!.workloads) {
      const native = f.resources.get(item.id); expect(native.uid).toBe(item.lifetimeId);
      expect(item.holding.revision).toBe(native.latestReadyRevision);
      expect(item.holding.generation).toBe(native.generation);
      expect(native.template.containers[0].env).toBeUndefined();
      expect(native.template.containers[0].image).toBe(image);
      expect(native.template.scaling.minInstanceCount).toBe(0);
    }
    expect(f.calls.some(call => call.url.includes('cloudbuild.googleapis.com') || call.url.endsWith(':access'))).toBe(false);
    expect(f.calls.some(call => call.authorization === 'Bearer synthetic-host-token' && call.url.includes('run.googleapis.com'))).toBe(true);
    // A final proof reads each native resource/policy once, rather than replaying
    // the full action graph through nested per-grant prerequisite reads.
    expect(f.calls.filter(call => call.authorization === 'Bearer synthetic-host-token').length).toBeLessThanOrEqual(60);
    expect(f.calls.filter(call => call.method === 'POST' && call.url.includes('iam.googleapis.com') && call.url.endsWith(':setIamPolicy'))
      .every(call => /\/serviceAccounts\/[1-9]\d+:setIamPolicy$/.test(call.url))).toBe(true);
    for (const current of f.policies.values()) expect(current.auditConfigs).toEqual([{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }]);
    const writes = () => f.calls.filter(call => call.method !== 'GET' && !/:getIamPolicy|:testIamPermissions/.test(call.url)).length;
    const before = writes();
    f.state.callLimit = appliedCalls + 600;
    expect((await reconcileCloudInstallationV1({ ...shared, installationId: ready.installationId, planDigest: ready.plan.digest })).status).toBe('ready');
    expect(f.calls.length - appliedCalls).toBeLessThanOrEqual(600);
    expect(writes()).toBe(before);
  });
  it('recovers the exact accepted native service attempt after a lost response without repeating create', async () => {
    const t = await setupNative(); t.f.state.lostServiceAcknowledgment = true;
    const pending = await t.apply(); expect(pending.status).not.toBe('ready');
    const creates = () => t.f.calls.filter(call => call.method === 'POST' && call.url.includes('/services?')).length;
    expect(creates()).toBe(1);
    await reconcileCloudInstallationV1({ ...t.shared, installationId: t.plan.installationId, planDigest: t.plan.plan.digest });
    expect((await t.apply()).status).toBe('ready');
    expect(creates()).toBe(2); // exactly one each for the two declared workloads
  });
  it('blocks unreadable ancestry and broad potentially inherited authority before any native writes', async () => {
    for (const member of ['allAuthenticatedUsers', 'group:unknown@example.test']) {
      const f = nativeFixture(); f.policies.set('projects/123456789012', { version: 3, etag: 'broad', bindings: [{ role: 'roles/editor', members: [member] }] });
      const driver = createGcpCloudInstallationDriver({ fetch: f.request, holdingImage: image });
      const prepared = prepareCloudDeploymentIntentV1(spec, intent, driver);
      await expect(driver.plan({ intent: prepared, authentication, signal: AbortSignal.timeout(1000), completed: {}, beforeMutation: async () => {} })).rejects.toThrow();
      expect(f.calls.some(call => call.url.endsWith(':setIamPolicy'))).toBe(false);
    }
    const f = nativeFixture(); f.state.parent = 'organizations/999999999999';
    const driver = createGcpCloudInstallationDriver({ fetch: f.request, holdingImage: image });
    await expect(driver.plan({ intent: prepareCloudDeploymentIntentV1(spec, intent, driver), authentication,
      signal: AbortSignal.timeout(1000), completed: {}, beforeMutation: async () => {} })).rejects.toThrow();
  });
  it('issues only the selected native short-lived principal and verifies exact release target lifetimes', async () => {
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const session = await issueCloudDeploymentSessionV1({ connection, driver: t.driver, capability: 'release',
      authentication: { host: authentication.host }, authorize: async () => true, signal: AbortSignal.timeout(5000) });
    expect(session).toMatchObject({ kind: 'gcp-impersonation', principal: connection.principals.release }); expect(t.f.state.issued).toBe(1);
    const prepared = connection.preparedResources!;
    const bindings = { version: 1, project: 'app', environments: { staging: { platformBindings: { provider: 'cloudrun',
      projectId: 'customer-project', environmentId: 'us-west1', providerScope: { projectId: 'customer-project', region: 'us-west1',
        artifactRepository: prepared.registry.id.split('/').at(-1), artifactRepositoryCreateTime: prepared.registry.lifetimeId },
      services: Object.fromEntries(prepared.workloads.map(item => [item.workload, { serviceId: item.id.split('/').at(-1),
        resourceUid: item.lifetimeId, resourceType: 'service', workloadKind: item.workload === 'web' ? 'web' : 'worker' }])) } } } };
    const targets = await verifyCloudDeploymentReleaseTargetsV1({ connection, driver: t.driver, spec, bindings, source: intent.source,
      authentication: { host: authentication.host }, authorize: async () => true, signal: AbortSignal.timeout(5000) });
    expect(targets.targets).toHaveLength(2); expect(t.f.state.issued).toBe(1); // native read proof never mints another token
    t.f.resources.get(prepared.workloads[0].id).uid = '99999999-9999-4999-8999-999999999999';
    await expect(issueCloudDeploymentSessionV1({ connection, driver: t.driver, capability: 'provision', authentication: { host: authentication.host },
      authorize: async () => true, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(t.f.state.issued).toBe(1);
  });
  // This compound test executes both complete native action graphs. Remote CI
  // took 12.285s against the global 10s limit. The larger test-only budget does
  // not relax production deadlines; finite phase transport caps reject loops.
  it('disconnects exact hosted grants while retaining resources and separately authorized runtime readers', { timeout: 30_000 }, async () => {
    const t = await setupNative(16), plannedCalls = t.f.calls.length;
    t.f.state.callLimit = plannedCalls + 2000;
    const ready = await t.apply(), createdCalls = t.f.calls.length;
    expect(ready.status).toBe('ready'); expect(createdCalls - plannedCalls).toBeLessThanOrEqual(2000);
    t.f.state.callLimit = createdCalls + 16;
    const cleanup = await planCloudInstallationV1({ ...t.shared, intent: { ...ready.intent, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      mode: 'disconnect', installed: Object.values(ready.completed) } });
    const cleanupPlannedCalls = t.f.calls.length;
    expect(cleanupPlannedCalls - createdCalls).toBeLessThanOrEqual(16);
    t.f.state.callLimit = cleanupPlannedCalls + 1200;
    const count = t.f.resources.size;
    const removed = await applyCloudInstallationV1({ ...t.shared, installationId: cleanup.installationId, planDigest: cleanup.plan.digest,
      confirmActions: cleanup.plan.actions.map(action => action.id) });
    expect(removed.status).toBe('disconnected'); expect(t.f.resources.size).toBe(count);
    expect(t.f.calls.length - cleanupPlannedCalls).toBeLessThanOrEqual(1200);
    const secretPolicy = t.f.policies.get('projects/123456789012/secrets/api-key');
    expect(secretPolicy.bindings.some((item: any) => item.role === 'roles/secretmanager.secretAccessor')).toBe(true);
    expect(t.f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
  it('observes an explicit prepared binding frontier with pending first rollout and no native writes', async () => {
    const { CloudRunPreparedHosting } = await import('../../src/adapters/providers/gcp/cloudrun-prepared-hosting.js');
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const capability = new CloudRunPreparedHosting(() => connection, async () => 'synthetic-provision-token', t.f.request);
    const environment = { id: 'local-staging', projectId: 'local-project', name: 'staging', platformBindings: { provider: 'cloudrun', projectId: 'customer-project' } } as any;
    const before = t.f.calls.length;
    const observed = await capability.inspect({ environment, environmentSpec: spec.environments.staging });
    expect(observed.state).toBe('verified'); if (observed.state !== 'verified') return;
    expect(observed.preparation.pendingFirstRelease).toEqual(['web', 'worker']);
    expect(Object.keys(observed.preparation.firstReleaseConfigurationDigests!)).toEqual(['web', 'worker']);
    expect(observed.bindings.services.web.resourceUid).toBe(connection.preparedResources!.workloads[0].lifetimeId);
    expect(observed.bindings.services.web.imageUri).toBe(image);
    expect(t.f.calls.slice(before).every(call => call.method === 'GET' || new URL(call.url).pathname.endsWith(':getIamPolicy'))).toBe(true);
  });
  it('preserves exact historical installation proof after a legitimate first application rollout', async () => {
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const item = connection.preparedResources!.workloads[0], native = t.f.resources.get(item.id);
    const runtime = connection.runtimeIdentities.find(value => value.workload === item.workload)!.principal;
    if (runtime.kind !== 'gcp-service-account') throw new Error('Wrong fixture principal');
    native.template.serviceAccount = runtime.serviceAccountEmail;
    native.template.containers[0].image = `us-west1-docker.pkg.dev/customer-project/${connection.preparedResources!.registry.id.split('/').at(-1)}/app@sha256:${'c'.repeat(64)}`;
    native.generation = native.observedGeneration = '2';
    native.latestCreatedRevision = native.latestReadyRevision = `${item.id}/revisions/app-00002-abc`;
    const before = t.f.calls.length;
    expect((await reconcileCloudInstallationV1({ ...t.shared, installationId: ready.installationId, planDigest: ready.plan.digest })).status).toBe('ready');
    expect(t.f.calls.slice(before).every(call => call.method === 'GET' || new URL(call.url).pathname.endsWith(':getIamPolicy'))).toBe(true);
  });
  it('verifies installed runtime binding, restart recovery and retention using read-only account policy requests', async () => {
    const { CloudRunPreparedHosting } = await import('../../src/adapters/providers/gcp/cloudrun-prepared-hosting.js');
    const { CloudRunInstalledRuntimeIdentities } = await import('../../src/adapters/providers/gcp/cloudrun-installed-runtime.js');
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const environment = { id: 'local-staging', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(),
      platformBindings: { provider: 'cloudrun', projectId: 'customer-project' } };
    const prepared = await new CloudRunPreparedHosting(() => connection, async () => 'synthetic-token', t.f.request)
      .inspect({ environment, environmentSpec: spec.environments.staging });
    expect(prepared.state).toBe('verified'); if (prepared.state !== 'verified') throw new Error('Fixture preparation failed');
    const runtime = new CloudRunInstalledRuntimeIdentities(() => connection, async () => 'synthetic-token');
    const request = { mode: 'ensure' as const, environment: { ...environment, platformBindings: { ...prepared.bindings, preparedHosting: prepared.preparation } },
      environmentSpec: spec.environments.staging, service: { name: 'web', buildConfig: {} } };
    const before = t.f.calls.length;
    vi.stubGlobal('fetch', t.f.request);
    try {
      const observed = await runtime.inspect(request);
      const accountReads = t.f.calls.slice(before).filter(call => new URL(call.url).hostname === 'iam.googleapis.com'
        && new URL(call.url).pathname.endsWith(':getIamPolicy'));
      expect(accountReads).toHaveLength(1);
      expect(accountReads[0]).toMatchObject({ method: 'POST', body: undefined });
      expect(new URL(accountReads[0].url).search).toBe('?options.requestedPolicyVersion=3');
      expect(observed.state).toBe('action'); if (observed.state !== 'action') return;
      const applied = await runtime.apply({ ...request, step: observed.step, attemptId: 'synthetic-attempt' });
      expect(applied.receipt.success).toBe(true);
      expect(await runtime.inspect({ ...request, binding: applied.binding })).toMatchObject({ state: 'ready' });
      const pending = { provider: 'cloudrun', evidence: {}, pending: { attemptId: 'synthetic-attempt', step: observed.step } };
      expect(await runtime.inspect({ ...request, binding: pending })).toMatchObject({ state: 'action', step: { operation: 'recover' } });
      expect(await runtime.inspect({ ...request, binding: applied.binding, mode: 'destroy' })).toMatchObject({ state: 'ready' });
      expect(t.f.calls.slice(before).every(call => call.method === 'GET' || new URL(call.url).pathname.endsWith(':getIamPolicy'))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('preserves independently verified existing collection read authority on the same project', async () => {
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const role = 'projects/customer-project/roles/existingCollectionVerifier';
    t.f.resources.set(role, { name: role, title: 'Existing collection verifier', description: 'Existing installation', stage: 'GA',
      includedPermissions: ['resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'iam.roles.get'] });
    t.f.policies.get('projects/123456789012').bindings.push({ role, members: [`serviceAccount:${intent.hostIdentity.serviceAccountEmail}`] });
    const before = t.f.calls.length;
    const session = await issueCloudDeploymentSessionV1({ connection, driver: t.driver, capability: 'provision', authentication: { host: authentication.host },
      authorize: async () => true, signal: AbortSignal.timeout(5000) });
    expect(session.kind).toBe('gcp-impersonation');
    expect(t.f.calls.slice(before).some(call => call.url.endsWith(':setIamPolicy'))).toBe(false);
  });
  it('pins existing secret container lifetime at review before any runtime reader grant', async () => {
    const t = await setupNative();
    t.f.resources.get('projects/123456789012/secrets/api-key').createTime = '2026-10-25T00:00:00Z';
    const before = t.f.calls.length, result = await t.apply();
    expect(result.status).toBe('blocked');
    expect(t.f.calls.slice(before).some(call => call.url.endsWith(':setIamPolicy'))).toBe(false);
  });
  it('rejects a service replacement during the final policy read before changing IAM', async () => {
    const t = await setupNative(); let reads = 0, replaced = '';
    t.f.state.policyReadHook = name => {
      if (!name.includes('/services/') || ++reads !== 3) return;
      replaced = name; t.f.resources.get(name).uid = '99999999-9999-4999-8999-999999999999';
    };
    const result = await t.apply();
    expect(replaced).not.toBe(''); expect(result.status).not.toBe('ready');
    expect(t.f.calls.some(call => call.url === `https://run.googleapis.com/v2/${replaced}:setIamPolicy`)).toBe(false);
  });
  it.each([false, true])('retires first rollout only with verified effective-source provenance and prior native configuration (transferred: %s)', async transferred => {
    const { CloudRunPreparedHosting } = await import('../../src/adapters/providers/gcp/cloudrun-prepared-hosting.js');
    const { gcpPreparedApplicationConfiguration } = await import('../../src/adapters/providers/gcp/gcp-prepared-release.js');
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const original = structuredClone(connection);
    const sourceAuthorization = transferred ? prepareCloudDeploymentSourceAuthorizationV1({ connection, driver: t.driver, spec,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source: { ...connection.source, branch: 'trunk', revision: 'c'.repeat(40) } }) : undefined;
    const capability = new CloudRunPreparedHosting(() => connection, async () => 'synthetic-provision-token', t.f.request, () => sourceAuthorization);
    const environment = { id: 'local-staging', projectId: 'local-project', name: 'staging', platformBindings: { provider: 'cloudrun', projectId: 'customer-project' } } as any;
    const initial = await capability.inspect({ environment, environmentSpec: spec.environments.staging });
    expect(initial.state).toBe('verified'); if (initial.state !== 'verified') return;
    environment.platformBindings = { ...initial.bindings, preparedHosting: initial.preparation };
    const item = connection.preparedResources!.workloads[0], native = t.f.resources.get(item.id), runtime = connection.runtimeIdentities.find(value => value.workload === item.workload)!.principal;
    if (runtime.kind !== 'gcp-service-account') throw new Error('Wrong fixture principal');
    const imageUri = `us-west1-docker.pkg.dev/customer-project/${connection.preparedResources!.registry.id.split('/').at(-1)}/app@sha256:${'c'.repeat(64)}`;
    Object.assign(native, gcpPreparedApplicationConfiguration({ workloadKind: 'web', publicAccess: true, serviceAccountEmail: runtime.serviceAccountEmail,
      envVars: spec.environments.staging.envVars, secretVersionRefs: spec.environments.staging.secretDestinations!, startCommand: 'node server.js', healthCheckPath: null }));
    native.template.containers[0].image = imageUri; native.generation = native.observedGeneration = '2';
    native.latestCreatedRevision = native.latestReadyRevision = `${item.id}/revisions/web-00002-app`;
    const absent = await capability.inspect({ environment, environmentSpec: spec.environments.staging });
    expect(absent.state === 'verified' && absent.preparation.pendingFirstRelease).toEqual(['web', 'worker']);
    const releaseEvidence = { schemaVersion: 1 as const, repository: intent.source.repository, workflow: '.github/workflows/hypervibe.yml', branch: transferred ? 'trunk' : 'main',
      sourceCommitSha: 'a'.repeat(40), workflowSourceCommitSha: 'a'.repeat(40), runId: 123, runAttempt: 1 as const, artifactId: 456,
      workflowInputHash: '1'.repeat(64), workflowContentHash: '2'.repeat(64), programFingerprint: '3'.repeat(64), deploymentContractFingerprint: '4'.repeat(64),
      imageUri, targets: [{ workload: 'web', kind: 'service' as const, resourceId: item.id.split('/').at(-1)!, resourceUid: item.lifetimeId }] };
    const observed = await capability.inspect({ environment, environmentSpec: spec.environments.staging, releaseEvidence });
    expect(observed.state === 'verified' && observed.preparation.pendingFirstRelease).toEqual(['worker']);
    expect(connection).toEqual(original); expect(observed.state === 'verified' && observed.preparation.receiptDigest).toBe(initial.preparation.receiptDigest);
    if (transferred) expect((await capability.inspect({ environment, environmentSpec: spec.environments.staging,
      releaseEvidence: { ...releaseEvidence, branch: 'main' } })).state).toBe('unknown');
    const changed = structuredClone(spec.environments.staging); changed.envVars.EXTRA = 'unreviewed';
    native.template.containers[0].env.push({ name: 'EXTRA', value: 'unreviewed' });
    const drifted = await capability.inspect({ environment, environmentSpec: changed, releaseEvidence });
    expect(drifted.state === 'verified' && drifted.preparation.pendingFirstRelease).toEqual(['web', 'worker']);
  });
  it('rejects replacement lifetimes, changed permissions and reverted holding revisions before issuing credentials', async () => {
    const t = await setupNative(), ready = await t.apply(), connection = cloudInstallationDeploymentConnectionV1(ready, t.driver);
    const baselineResources = structuredClone(t.f.resources), baselinePolicies = structuredClone(t.f.policies);
    const prepared = connection.preparedResources!, principal = connection.principals.provision;
    if (principal.kind !== 'gcp-service-account') throw new Error('Wrong fixture principal');
    const changes = [
      () => { t.f.resources.get(prepared.secretTargets![0].id).createTime = '2026-10-25T00:00:00Z'; },
      () => { t.f.resources.get(prepared.registry.id).createTime = '2026-10-25T00:00:00Z'; },
      () => { t.f.resources.get(`projects/customer-project/serviceAccounts/${principal.serviceAccountEmail}`).uniqueId = '999999999999999999999'; },
      () => { const role = [...t.f.resources.values()].find(item => item.includedPermissions?.includes('run.services.update')); role.includedPermissions.push('run.services.create'); },
      () => { const policy = t.f.policies.get(`projects/customer-project/serviceAccounts/${principal.serviceAccountEmail}`); policy.bindings = []; },
      () => { const native = t.f.resources.get(prepared.workloads[0].id); native.generation = native.observedGeneration = '3';
        native.latestReadyRevision = native.latestCreatedRevision = `${native.name}/revisions/web-00003-reverted`; },
    ];
    for (const change of changes) {
      t.f.resources.clear(); for (const [key, value] of structuredClone(baselineResources)) t.f.resources.set(key, value);
      t.f.policies.clear(); for (const [key, value] of structuredClone(baselinePolicies)) t.f.policies.set(key, value);
      change();
      await expect(issueCloudDeploymentSessionV1({ connection, driver: t.driver, capability: 'provision', authentication: { host: authentication.host },
        authorize: async () => true, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
      expect(t.f.state.issued).toBe(0);
    }
  });
});
