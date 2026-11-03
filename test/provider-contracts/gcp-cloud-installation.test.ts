import { serviceUsageResponse } from './helpers/gcp-service-usage.js';
import { describe, expect, it, vi } from 'vitest';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationProviderContext, CloudInstallationAction } from '../../src/domain/ports/cloud-installation.port.js';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed JSON, not recorded/live evidence. Native shapes and semantics:
// docs.cloud.google.com/resource-manager/reference/rest/v3/projects/search
// docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/create
// docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create
// docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/setIamPolicy
// Search proves projects.get only; create prepares no versions; IAM set replaces
// the policy so the existing etag, unrelated grants and audit configuration matter.
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: 'f905e042-7a75-4bb9-abf3-37975ed820dd',
  customerId: 'customer-one', appId: 'sequence', environment: 'production',
  source: { repository: 'github.com/studio/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  provider: 'gcp', mode: 'connect', nativeScope: { projectId: 'customer-sequence', projectNumber: '123456789012' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hypercloud-host', projectNumber: '222222222222',
    serviceAccountEmail: 'writer@hypercloud-host.iam.gserviceaccount.com', subject: '111111111111111111111', issuer: 'https://accounts.google.com' },
  keys: ['API_TOKEN'],
};
const context = (input = intent): CloudInstallationProviderContext => ({
  intent: structuredClone(input), signal: new AbortController().signal, completed: {}, beforeMutation: async () => {},
  authentication: {
    administrator: { getAccessToken: async () => 'synthetic-admin-access' },
    host: { verifyIdentity: async () => input.hostIdentity, getIdToken: async () => 'synthetic-id-token', getAccessToken: async () => 'synthetic-host-access' },
  },
});
function transport(options: { denyPermissions?: boolean; loseCreateAck?: boolean; servicesDisabled?: boolean; verificationDenied?: 'host' | 'impersonation' | 'writer'; malformedWriterPermissions?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const objects = new Map<string, any>();
  const policies = new Map<string, any>();
  let sequence = 0; const enabled = new Set<string>();
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.href, method, body });
    expect(init.redirect).toBe('error');
    expect(['Bearer synthetic-admin-access', 'Bearer synthetic-host-access', 'Bearer synthetic-writer-access']).toContain(new Headers(init.headers).get('authorization'));
    const path = url.pathname;
    const authorization = new Headers(init.headers).get('authorization');
    if (options.verificationDenied === 'host' && authorization === 'Bearer synthetic-host-access' && method === 'GET')
      return Response.json({ error: { message: 'UNSAFE_native_echo' } }, { status: 403 });
    if (options.verificationDenied === 'impersonation' && path.endsWith(':generateAccessToken'))
      return Response.json({ error: { message: 'UNSAFE_native_echo' } }, { status: 403 });
    if (path === '/v3/projects:search') return Response.json({ projects: [{
      name: 'projects/123456789012', projectId: 'customer-sequence', displayName: 'Sequence', state: 'ACTIVE',
      createTime: '2025-01-01T00:00:00Z', updateTime: '2025-01-01T00:00:00Z',
    }] });
    if (path === '/v1/projects/customer-sequence') return Response.json({
      projectId: 'customer-sequence', projectNumber: '123456789012', lifecycleState: 'ACTIVE',
    });
    if (path === '/v3/projects/123456789012') return Response.json({
      name: 'projects/123456789012', projectId: 'customer-sequence', state: 'ACTIVE',
    });
    if (path === '/v3/projects/123456789012:testIamPermissions') return Response.json({ permissions: options.denyPermissions ? ['resourcemanager.projects.get'] : [
      'resourcemanager.projects.get', 'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
      'iam.roles.create', 'iam.roles.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get',
      'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy',
      'secretmanager.secrets.create', 'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy',
      'secretmanager.secrets.setIamPolicy', 'serviceusage.services.get', 'serviceusage.services.enable',
    ] });
    if (path.endsWith(':generateAccessToken')) return Response.json({ accessToken: 'synthetic-writer-access', expireTime: new Date(Date.now() + 900_000).toISOString() });
    if (path.includes('/secrets/') && path.endsWith(':testIamPermissions')) return Response.json({ permissions: options.malformedWriterPermissions ? 'invalid-native-shape' : options.verificationDenied === 'writer' ? [] : [
      'secretmanager.secrets.get', 'secretmanager.versions.add', 'secretmanager.versions.list',
    ] });
    if (path.includes('/services/')) {
      const name = path.slice(4).replace(':enable', '');
      if (method === 'POST' && path.endsWith(':enable')) {
        enabled.add(name);
        return Response.json({ name: 'operations/acf.601db672-88e6-4f98-8ceb-aa3b5725533c', done: true, response: { '@type': 'type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse' } });
      }
      return serviceUsageResponse(url, name, !options.servicesDisabled || enabled.has(name) ? 'ENABLED' : 'DISABLED');
    }
    if (path.endsWith(':getIamPolicy')) return Response.json(policies.get(path.replace(':getIamPolicy', '')) ?? { etag: 'BwWWja0YfJA=', version: 3, bindings: [
      { role: 'roles/viewer', members: ['user:owner@example.test'], condition: { title: 'keep', expression: 'true' } },
    ], auditConfigs: [{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }] });
    if (path.endsWith(':setIamPolicy')) { policies.set(path.replace(':setIamPolicy', ''), body.policy); return Response.json(body.policy); }
    if (method === 'POST' && path.endsWith('/roles')) {
      const name = `projects/customer-sequence/roles/${body.roleId}`;
      objects.set('/v1/' + name, { ...body.role, name }); return Response.json(objects.get('/v1/' + name));
    }
    if (method === 'POST' && path.endsWith('/serviceAccounts')) {
      const email = `${body.accountId}@customer-sequence.iam.gserviceaccount.com`;
      const name = `projects/customer-sequence/serviceAccounts/${email}`;
      const value = { ...body.serviceAccount, name, email, projectId: 'customer-sequence', uniqueId: String(333333333333333333333n + BigInt(sequence++)) };
      objects.set('/v1/' + name, value);
      if (options.loseCreateAck) throw new Error('synthetic lost response');
      return Response.json(value);
    }
    if (method === 'POST' && path.endsWith('/secrets')) {
      // Secret.labels native contract: <=63 Unicode characters; these generated
      // ASCII labels must fit its documented lower-case/number/_/- alphabet.
      if (Object.entries(body.labels ?? {}).some(([key, value]) => !/^[a-z][a-z0-9_-]{0,62}$/.test(key)
        || typeof value !== 'string' || !/^[a-z0-9_-]{0,63}$/.test(value)))
        return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 });
      expect(body).not.toHaveProperty('payload');
      const name = `projects/123456789012/secrets/${url.searchParams.get('secretId')}`;
      objects.set('/v1/' + name, { name, createTime: '2026-10-24T12:00:00Z', ...body });
      return Response.json(objects.get('/v1/' + name));
    }
    if (method === 'GET' && objects.has(path)) return Response.json(objects.get(path));
    if (method === 'GET') return Response.json({}, { status: 404 });
    throw new Error('Unexpected serialized request');
  };
  return { request, calls, objects, policies };
}
const attempt = (action: CloudInstallationAction) => ({ id: 'ae568066-f1f6-4c23-aefc-69fb8812f35c', actionId: action.id,
  status: 'attempted' as const, startedAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z' });

describe('GCP hosted installation through serialized transport', () => {
  it('plans with a transient browser token and distinguishes view access from installation authority', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const result = await driver.plan(context());
    expect(result.actions.some(action => action.metadata.operation === 'create-secret')).toBe(true);
    expect(result.actions.every(action => action.requiresConfirm)).toBe(true);
    expect(api.calls.filter(call => !call.url.endsWith(':testIamPermissions')).every(call => call.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-admin-access|synthetic-host-access/);
    const denied = createGcpCloudInstallationDriver({ fetch: transport({ denyPermissions: true }).request });
    await expect(denied.plan(context())).rejects.toThrow('insufficient_permissions');
  });

  it('retains the published Service Usage operation identity when enabling a disabled API', async () => {
    // Native operation example from Google's project/cluster setup tutorial.
    const api = transport({ servicesDisabled: true }); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const ctx = context(); const action = (await driver.plan(ctx)).actions.find(action => action.metadata.operation === 'enable-api')!;
    expect(await driver.inspect({ ...ctx, action })).toEqual({ state: 'action-required' });
    const result = await driver.mutate({ ...ctx, action, attempt: attempt(action) });
    expect(result).toMatchObject({ state: 'acknowledged', evidence: { native: { operationName: 'operations/acf.601db672-88e6-4f98-8ceb-aa3b5725533c' } } });
    expect((await driver.recover({ ...ctx, action, attempt: attempt(action) })).state).toBe('satisfied');
    expect(api.calls.filter(call => call.url.endsWith(':enable'))).toHaveLength(1);
  });

  it('creates empty containers and never writes a version or accepts a foreign same-name container', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const ctx = context(); const plan = await driver.plan(ctx);
    const action = plan.actions.find(action => action.metadata.operation === 'create-secret')!;
    expect(await driver.inspect({ ...ctx, action })).toEqual({ state: 'action-required' });
    expect((await driver.mutate({ ...ctx, action, attempt: attempt(action) })).state).toBe('acknowledged');
    expect((await driver.recover({ ...ctx, action, attempt: attempt(action) })).state).toBe('satisfied');
    expect(api.calls.some(call => call.url.includes(':addVersion') || call.url.includes(':access'))).toBe(false);
    const foreign = [...api.objects.values()][0]; foreign.labels = {};
    expect((await driver.recover({ ...ctx, action, attempt: attempt(action) })).state).toBe('conflict');
  });

  it('reconciles a lost service-account response using the exact attempt and immutable uniqueId', async () => {
    const api = transport({ loseCreateAck: true }); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const ctx = context(); const action = (await driver.plan(ctx)).actions.find(action => action.metadata.operation === 'create-account')!;
    expect((await driver.mutate({ ...ctx, action, attempt: attempt(action) })).state).toBe('uncertain');
    const recovered = await driver.recover({ ...ctx, action, attempt: attempt(action) });
    expect(recovered.state).toBe('satisfied');
    if (recovered.state === 'satisfied') expect(recovered.evidence.resources[0].identity.uniqueId).toBe('333333333333333333333');
    expect(api.calls.filter(call => call.method === 'POST' && call.url.endsWith('/serviceAccounts'))).toHaveLength(1);
  });

  it('isolates environments and refuses credential-shaped native scope before a request', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const first = await driver.plan(context()); const second = await driver.plan(context({ ...intent, environment: 'staging' }));
    const names = (actions: CloudInstallationAction[]) => actions.filter(action => action.metadata.operation === 'create-secret').map(action => action.resource.name);
    expect(names(first.actions)).not.toEqual(names(second.actions));
    const before = api.calls.length;
    await expect(driver.plan(context({ ...intent, nativeScope: { ...intent.nativeScope, accessToken: 'DO_NOT_STORE' } }))).rejects.toThrow();
    expect(api.calls).toHaveLength(before);
  });

  it('runs the shared CAS lifecycle, preserves unrelated IAM, re-observes without writes, and disconnects only writer grants', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const records = new Map<string, CloudInstallationRecord>();
    const store = { read: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false;
        records.set(id, structuredClone(next)); return true;
      } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const planned = await planCloudInstallationV1({ ...shared, intent });
    const ready = await applyCloudInstallationV1({ ...shared, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) });
    expect(ready.status).toBe('ready');
    expect(driver.connections(ready)).toHaveLength(1);
    for (const policy of api.policies.values()) {
      expect(policy.etag).toBe('BwWWja0YfJA=');
      expect(policy.bindings).toContainEqual({ role: 'roles/viewer', members: ['user:owner@example.test'], condition: { title: 'keep', expression: 'true' } });
      expect(policy.auditConfigs).toEqual([{ service: 'allServices', auditLogConfigs: [{ logType: 'ADMIN_READ' }] }]);
    }
    const writes = () => api.calls.filter(call => call.method !== 'GET' && !/:getIamPolicy|:testIamPermissions|:generateAccessToken/.test(call.url)).length;
    const before = writes();
    expect((await reconcileCloudInstallationV1({ ...shared, installationId: ready.installationId, planDigest: ready.plan.digest })).status).toBe('ready');
    expect(writes()).toBe(before);
    const disconnect = await planCloudInstallationV1({ ...shared, intent: { ...intent,
      installationId: '113f46e8-c7f3-4e01-bae6-f4db98779c8c', mode: 'disconnect', installed: Object.values(ready.completed) } });
    const removed = await applyCloudInstallationV1({ ...shared, installationId: disconnect.installationId, planDigest: disconnect.plan.digest,
      confirmActions: disconnect.plan.actions.map(action => action.id) });
    expect(removed.status).toBe('disconnected');
    expect(api.calls.some(call => call.method === 'DELETE')).toBe(false);
    for (const policy of api.policies.values()) expect(policy.bindings).toHaveLength(1);
  });

  it.each([
    ['host', 'host_identity_access_unverified'],
    ['impersonation', 'writer_impersonation_unverified'],
    ['writer', 'writer_permissions_unverified'],
  ] as const)('keeps initial %s verification pending and rechecks after restart without repeating setup', async (stage, expectedReason) => {
    // Google IAM grants are eventually consistent. Native incident: setup grants
    // succeeded, final verification rejected, a later read-only check succeeded.
    const options = { verificationDenied: stage as 'host' | 'impersonation' | 'writer' | undefined };
    const api = transport(options); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    let record: CloudInstallationRecord | null = null;
    const store = { read: async () => structuredClone(record),
      compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((record?.revision ?? null) !== revision) return false; record = JSON.parse(JSON.stringify(next)); return true;
      } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...shared, intent });
    const pending = await applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    expect(pending).toMatchObject({ status: 'pending', reason: expectedReason });
    expect(driver.connections(pending)).toEqual([]);
    expect(pending.completed).not.toHaveProperty('gcp:verify');
    const writes = () => api.calls.filter(call => call.method !== 'GET' && !/:getIamPolicy|:testIamPermissions|:generateAccessToken/.test(call.url));
    const before = writes().length;
    const restarted = { ...shared, driver: createGcpCloudInstallationDriver({ fetch: api.request }) };
    expect(await reconcileCloudInstallationV1({ ...restarted, installationId: plan.installationId, planDigest: plan.plan.digest }))
      .toMatchObject({ status: 'pending', reason: expectedReason });
    expect(writes()).toHaveLength(before);
    options.verificationDenied = undefined;
    const ready = await reconcileCloudInstallationV1({ ...restarted, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(ready.status).toBe('ready');
    expect(ready.attempts.map(item => item.id)).toEqual(pending.attempts.map(item => item.id));
    expect(ready.attempts.at(-1)).toMatchObject({ actionId: 'gcp:verify', status: 'succeeded' });
    expect(ready.attempts.at(-1)?.reason).toBeUndefined();
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(ready)).not.toMatch(/synthetic-(?:admin|host|writer)-access|UNSAFE_native_echo/);
  });

  it('bounds waiting from the original attempt and never reopens verified access after revocation', async () => {
    const options = { verificationDenied: 'impersonation' as 'impersonation' | undefined };
    const api = transport(options); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    let record: CloudInstallationRecord | null = null;
    const store = { read: async () => structuredClone(record), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
    } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...shared, intent });
    const pending = await applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    const firstTime = Date.parse(pending.attempts.at(-1)!.startedAt);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(firstTime + 600_001);
    try {
      const blocked = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
      expect(blocked).toMatchObject({ status: 'blocked', reason: 'writer_impersonation_unverified' });
      expect(blocked.attempts.at(-1)).toEqual(pending.attempts.at(-1));
      expect(blocked.attempts.map(item => item.id)).toEqual(pending.attempts.map(item => item.id));
    } finally { clock.mockRestore(); }
    options.verificationDenied = undefined;
    const ready = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(ready.status).toBe('ready');
    options.verificationDenied = 'impersonation';
    const revoked = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(revoked).toMatchObject({ status: 'blocked', reason: 'writer_impersonation_unverified' });
    expect(driver.connections(revoked)).toEqual([]);
    const stillRevoked = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(stillRevoked).toMatchObject({ status: 'blocked', reason: 'writer_impersonation_unverified' });
  });

  it.each(['revoked-grant', 'malformed-permissions'] as const)('does not interpret %s as access propagation', async failure => {
    const options = { verificationDenied: 'host' as 'host' | undefined, malformedWriterPermissions: false };
    const api = transport(options); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    let record: CloudInstallationRecord | null = null;
    const store = { read: async () => structuredClone(record), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
    } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...shared, intent });
    await applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    const writes = () => api.calls.filter(call => call.method !== 'GET' && !/:getIamPolicy|:testIamPermissions|:generateAccessToken/.test(call.url));
    const before = writes().length;
    options.verificationDenied = undefined;
    if (failure === 'revoked-grant') {
      for (const [path, policy] of api.policies) if (path.includes('/serviceAccounts/'))
        policy.bindings = policy.bindings.filter((binding: { role: string }) => binding.role === 'roles/viewer');
      const result = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
      expect(result).toMatchObject({ status: 'blocked', reason: 'identity_mismatch' });
    } else {
      options.malformedWriterPermissions = true;
      const action = plan.plan.actions.find(item => item.id === 'gcp:verify')!;
      const current = (await store.read())!;
      expect(await driver.recover({ ...context(), completed: current.completed, attempts: current.attempts,
        action, attempt: current.attempts.at(-1)! })).toEqual({ state: 'unknown', reason: 'provider_error' });
    }
    expect(writes()).toHaveLength(before);
  });

  it('rechecks legacy rejected verification without issuing a new attempt and clears its stale reason on success', async () => {
    const options = { verificationDenied: undefined as 'host' | undefined };
    const api = transport(options); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    let record: CloudInstallationRecord | null = null;
    const store = { read: async () => structuredClone(record), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
    } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...shared, intent });
    const ready = await applyCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    record = structuredClone(ready); delete record.completed['gcp:verify'];
    record.status = 'blocked'; record.reason = 'insufficient_permissions';
    record.attempts.at(-1)!.status = 'rejected'; record.attempts.at(-1)!.reason = 'insufficient_permissions'; delete record.attempts.at(-1)!.evidence;
    options.verificationDenied = 'host';
    expect(await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest }))
      .toMatchObject({ status: 'pending', reason: 'host_identity_access_unverified' });
    options.verificationDenied = undefined;
    const recovered = await reconcileCloudInstallationV1({ ...shared, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(recovered.status).toBe('ready');
    expect(recovered.attempts.at(-1)?.reason).toBeUndefined();
    expect(recovered.attempts.map(item => item.id)).toEqual(ready.attempts.map(item => item.id));
  });

  it('rejects a forged disconnection targeting an unrelated IAM grant', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const forged = { ...intent, mode: 'disconnect' as const, installed: [{
      resources: [{ kind: 'serviceAccount', id: 'projects/customer-sequence/serviceAccounts/admin@customer-sequence.iam.gserviceaccount.com', identity: { uniqueId: '333333333333333333333' } }],
      native: { operation: 'grant', owner: 'a'.repeat(64), role: 'projects/customer-sequence/roles/ExistingRole',
        member: 'serviceAccount:admin@customer-sequence.iam.gserviceaccount.com', policyKind: 'project', policyResource: 'projects/123456789012' },
    }] };
    await expect(driver.plan(context(forged))).rejects.toThrow();
  });

  it('does not adopt an already present IAM grant without its own retained attempt', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    let record: CloudInstallationRecord | null = null;
    const store = { read: async () => structuredClone(record),
      compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
      } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const planned = await planCloudInstallationV1({ ...shared, intent });
    const ready = await applyCloudInstallationV1({ ...shared, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) });
    expect(ready.status).toBe('ready');
    const completed = { ...ready.completed }; delete completed['gcp:grant:project'];
    const action = ready.plan.actions.find(action => action.id === 'gcp:grant:project')!;
    expect(await driver.inspect({ ...context(), completed, action })).toEqual({ state: 'conflict', reason: 'ownership_mismatch' });
  });
  it.each(['migrate', 'connect-existing'] as const)('%s preserves an exact existing container without requiring container-create permission or an old writer', async mode => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const resource = 'projects/123456789012/secrets/EXISTING_token';
    const original = { name: resource, createTime: '2024-01-01T00:00:00Z', replication: { automatic: {} }, labels: { customer: 'retained' } };
    api.objects.set('/v1/' + resource, structuredClone(original));
    const migration: CloudInstallationIntent = { ...intent, mode, migrationTargets: [{ key: 'API_TOKEN', destination: {
      provider: 'gcp-secret-manager', projectId: 'customer-sequence', projectNumber: '123456789012', secretId: 'EXISTING_token',
    } }] };
    const records = new Map<string, CloudInstallationRecord>();
    const store = { read: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true;
      } };
    const shared = { driver, store, authentication: context().authentication, authorize: async () => true };
    const planned = await planCloudInstallationV1({ ...shared, intent: migration });
    expect(planned.plan.actions.find(action => action.id === 'gcp:secret:API_TOKEN')).toMatchObject({ type: 'noop',
      resource: { name: resource }, metadata: { native: { createTime: original.createTime } } });
    const permissions = api.calls.find(call => call.url.endsWith('/projects/123456789012:testIamPermissions'))!.body.permissions;
    expect(permissions).not.toContain('secretmanager.secrets.create');
    const ready = await applyCloudInstallationV1({ ...shared, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.filter(action => action.type !== 'noop').map(action => action.id) });
    expect(ready.status, JSON.stringify(ready)).toBe('ready');
    expect(driver.connections(ready)[0].destination).toEqual(migration.migrationTargets![0].destination);
    expect(api.objects.get('/v1/' + resource)).toEqual(original);
    const disconnect = await planCloudInstallationV1({ ...shared, intent: { ...migration,
      installationId: '113f46e8-c7f3-4e01-bae6-f4db98779c8c', mode: 'disconnect', installed: Object.values(ready.completed) } });
    const removed = await applyCloudInstallationV1({ ...shared, installationId: disconnect.installationId, planDigest: disconnect.plan.digest,
      confirmActions: disconnect.plan.actions.map(action => action.id) });
    expect(removed.status).toBe('disconnected');
    expect(api.calls.some(call => call.method === 'DELETE' || call.method === 'POST' && /\/secrets(?:\?|$)|:addVersion|:access/.test(call.url))).toBe(false);
    expect(api.objects.get('/v1/' + resource)).toEqual(original);
  });

  it('reviews every native target separately when valid legacy names exceed one display field', async () => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const keys = Array.from({ length: 16 }, (_, index) => `KEY_${index}`);
    const migrationTargets = keys.map((key, index) => ({ key, destination: { provider: 'gcp-secret-manager' as const,
      projectId: 'customer-sequence', projectNumber: '123456789012', secretId: 'a'.repeat(250) + String(index) } }));
    for (const target of migrationTargets) {
      const name = `projects/123456789012/secrets/${target.destination.secretId}`;
      api.objects.set('/v1/' + name, { name, createTime: '2024-01-01T00:00:00Z' });
    }
    let record: CloudInstallationRecord | null = null;
    const planned = await planCloudInstallationV1({ driver, intent: { ...intent, mode: 'migrate', keys, migrationTargets },
      authentication: context().authentication, authorize: async () => true, store: { read: async () => record,
        compareAndSwap: async (_id, _revision, next) => { record = next; return true; } } });
    expect(planned.plan.review.permissions.filter(item => item.actions.includes('secretmanager.versions.add'))).toHaveLength(16);
  });

  it.each(['migrate', 'connect-existing'] as const)('%s rejects a recreated container between review and inspection', async mode => {
    const api = transport(); const driver = createGcpCloudInstallationDriver({ fetch: api.request });
    const name = 'projects/123456789012/secrets/EXISTING_token';
    api.objects.set('/v1/' + name, { name, createTime: '2024-01-01T00:00:00Z' });
    const ctx = context({ ...intent, mode, migrationTargets: [{ key: 'API_TOKEN', destination: {
      provider: 'gcp-secret-manager', projectId: 'customer-sequence', projectNumber: '123456789012', secretId: 'EXISTING_token',
    } }] });
    const plan = await driver.plan(ctx);
    const action = plan.actions.find(action => action.id === 'gcp:secret:API_TOKEN')!;
    api.objects.set('/v1/' + name, { name, createTime: '2026-10-24T12:00:00Z' });
    expect(await driver.inspect({ ...ctx, action })).toEqual({ state: 'conflict', reason: 'identity_mismatch' });
    expect(api.calls.every(call => call.method === 'GET' || call.url.endsWith(':testIamPermissions'))).toBe(true);
  });

});
