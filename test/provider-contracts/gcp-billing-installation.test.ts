import { serviceUsageResponse } from './helpers/gcp-service-usage.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1, planCloudInstallationContinuationV1,
  cloudInstallationNextStageV1 } from '../../src/application/hosted/cloud-installation.js';
import * as lifecycle from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationRecord } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed transports, not live evidence. Independent native contracts:
// cloud.google.com/billing/docs/how-to/modify-project: switching requires an
// unlink permission in addition to link; a link-only principal must be rejected.
// billingAccounts.setIamPolicy uses IAM Policy.etag; updateBillingInfo has none.
// iamcredentials generateAccessToken returns a short-lived token, never a key.
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'sequence',
  environment: 'production', provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: ['API_KEY'],
  source: { repository: 'github.com/example/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { scopeKind: 'new-project', projectId: 'sequence-new-project', displayName: 'Sequence', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
};
const billingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const collectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture(options: { raceAssociation?: boolean; extraUnlink?: boolean; otherAccountUnlink?: boolean; loseBillingAck?: boolean;
  deniedAccountPolicy?: boolean; policyConflict?: boolean; loseCleanupAck?: boolean; expireCleanup?: boolean; historical?: boolean; initialAssignment?: boolean;
  loseBeforeBillingAck?: boolean; revokeAtFinalBillingCheck?: boolean } = {}) {
  const records = new Map<string, CloudInstallationRecord>(); const objects = new Map<string, any>();
  const policies = new Map<string, any>(); const apis = new Set<string>();
  const calls: Array<{ method: string; url: string; body: any; token: string | null }> = [];
  let project: any = null; let billing = ''; let etag = 1, attemptedBillingReads = 0; let authorized = true;
  const targetAccount = intent.nativeScope.billingAccountName;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const path = url.pathname; const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const token = new Headers(init.headers).get('authorization'); calls.push({ method, url: url.href, body, token });
    expect(init.redirect).toBe('error');
    if (path.endsWith(':testIamPermissions')) return Response.json({ permissions: token === 'Bearer synthetic-billing-token'
      ? body.permissions.filter((value: string) => options.extraUnlink || !['resourcemanager.projects.deleteBillingAssignment', 'billing.resourceAssociations.delete'].includes(value))
      : body.permissions.filter((value: string) => !options.deniedAccountPolicy || value !== 'billing.accounts.setIamPolicy') });
    if (path === `/v1/${targetAccount}`) return Response.json({ name: targetAccount, open: true, displayName: 'Studio' });
    if (path === '/v3/projects' && method === 'POST') {
      expect(records.get(intent.installationId)?.attempts.at(-1)?.status).toBe('attempted');
      project = { name: 'projects/987654321012', projectId: 'sequence-new-project', displayName: 'Sequence', state: 'ACTIVE',
        parent: 'organizations/987654', createTime: '2026-10-25T12:00:00Z', labels: body.labels };
      return Response.json({ name: 'operations/pc.123456' });
    }
    if (path === '/v3/operations/pc.123456') return Response.json({ name: 'operations/pc.123456', done: true, response: project });
    if (path === '/v3/projects/sequence-new-project' || path === '/v3/projects/987654321012') return project ? Response.json(project) : Response.json({}, { status: 404 });
    if (path === '/v1/projects/sequence-new-project') return Response.json({ projectId: 'sequence-new-project', projectNumber: '987654321012', lifecycleState: 'ACTIVE' });
    if (path === '/v1/projects/sequence-new-project/billingInfo') {
      if (method === 'GET' && records.get(billingId)?.attempts.at(-1)?.status === 'attempted'
        && ++attemptedBillingReads === 3 && options.revokeAtFinalBillingCheck) authorized = false;
      if (method === 'PUT') {
        expect(token).toBe(options.initialAssignment ? 'Bearer synthetic-admin-token' : 'Bearer synthetic-billing-token');
        expect(records.get(billingId)?.attempts.at(-1)?.status).toBe('attempted');
        expect(body).toEqual({ billingAccountName: targetAccount });
        if (options.loseBeforeBillingAck) throw new Error('synthetic uncertain billing dispatch');
        if (options.raceAssociation) billing = 'billingAccounts/OTHER1-123456-789ABC';
        // Native permission contract, modeled independently of adapter decisions.
        if (billing && billing !== targetAccount && !options.otherAccountUnlink && !options.initialAssignment) return Response.json({ error: { code: 403 } }, { status: 403 });
        billing = targetAccount;
        if (options.loseBillingAck) throw new Error('synthetic lost billing acknowledgement');
      }
      return Response.json({ name: 'projects/sequence-new-project/billingInfo', projectId: 'sequence-new-project', billingAccountName: billing, billingEnabled: !!billing });
    }
    if (url.hostname === 'serviceusage.googleapis.com') {
      const name = path.slice(4).replace(':enable', '');
      if (method === 'POST') { apis.add(name); return Response.json({ name: 'operations/acf.123456', done: true }); }
      return serviceUsageResponse(url, name, apis.has(name) ? 'ENABLED' : 'DISABLED');
    }
    if (path.endsWith(':generateAccessToken')) {
      expect(token).toBe('Bearer synthetic-host-token'); expect(body.lifetime).toBe('900s');
      return Response.json({ accessToken: 'synthetic-billing-token', expireTime: new Date(Date.now() + 900_000).toISOString() });
    }
    if (path.endsWith(':getIamPolicy')) return Response.json(policies.get(path.replace(':getIamPolicy', '')) ?? {
      etag: 'E0', version: 3, bindings: [{ role: 'roles/viewer', members: ['user:owner@example.test'] }],
    });
    if (path.endsWith(':setIamPolicy')) {
      expect(token).toBe('Bearer synthetic-admin-token');
      const key = path.replace(':setIamPolicy', ''); const old = policies.get(key) ?? { etag: 'E0' };
      if (options.policyConflict) return Response.json({}, { status: 412 });
      if (body.policy.etag !== old.etag) return Response.json({}, { status: 412 });
      expect(body.policy.bindings).toEqual(expect.arrayContaining([{ role: 'roles/viewer', members: ['user:owner@example.test'] }]));
      const value = { ...body.policy, etag: `E${etag++}` }; policies.set(key, value);
      if (options.loseCleanupAck && billing && body.policy.bindings.every((binding: any) => binding.role === 'roles/viewer')) throw new Error('synthetic lost cleanup ack');
      return Response.json(value);
    }
    if (path.endsWith('/roles') && method === 'POST') {
      expect(body.role.includedPermissions).not.toContain('resourcemanager.projects.deleteBillingAssignment');
      const name = `projects/sequence-new-project/roles/${body.roleId}`; const value = { ...body.role, name };
      objects.set('/v1/' + name, value); return Response.json(value);
    }
    if (path.endsWith('/serviceAccounts') && method === 'POST') {
      const email = `${body.accountId}@sequence-new-project.iam.gserviceaccount.com`;
      const value = { name: `projects/sequence-new-project/serviceAccounts/${email}`, email, projectId: 'sequence-new-project', uniqueId: '333333333333333333333', ...body.serviceAccount };
      objects.set('/v1/' + value.name, value); objects.set('/v1/projects/sequence-new-project/serviceAccounts/' + value.uniqueId, value);
      return Response.json(value);
    }
    if (method === 'GET' && objects.has(path)) return Response.json(objects.get(path));
    if (method === 'GET') return Response.json({}, { status: 404 });
    throw new Error('Unexpected synthetic native request');
  };
  const nativeDriver = createGcpCloudInstallationDriver({ fetch: request });
  // Only this synthetic historical snapshot builder omits today's immutable
  // plan blocker. It never invokes connect mutations (which reject independently).
  // It reconstructs already-existing native resources and durable attempts to
  // exercise read-only recovery and separately reviewed cleanup.
  const driver = options.historical ? { ...nativeDriver, plan: async (input: Parameters<typeof nativeDriver.plan>[0]) => {
    const plan = await nativeDriver.plan(input); return { ...plan, blockedReason: undefined };
  } } : nativeDriver;
  const context = { driver, authorize: async () => authorized, timeoutMs: 60_000,
    store: { read: async (id: string) => structuredClone(records.get(id) ?? null), compareAndSwap: async (id: string, revision: number | null, record: CloudInstallationRecord) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(record)); return true;
    } }, authentication: { administrator: { getAccessToken: async () => {
      if (options.expireCleanup && billing) throw new Error('synthetic expired administrator');
      return 'synthetic-admin-token';
    } },
      host: { verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => 'synthetic-host-token', getIdToken: async () => 'unused' } } };
  const apply = (record: CloudInstallationRecord) => applyCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
  const prepare = async () => {
    const projectPlan = await planCloudInstallationV1({ ...context, intent: options.initialAssignment
      ? { ...intent, nativeScope: { ...intent.nativeScope, assignmentMode: 'initial-reviewed-v1' } } : intent });
    const projectReady = await apply(projectPlan);
    expect(projectReady.status).toBe('scope-ready');
    expect(cloudInstallationNextStageV1(projectReady, driver)).toBe('scope-preparation');
    expect(calls.filter(call => call.method !== 'GET' && !call.url.endsWith(':testIamPermissions')).map(call => new URL(call.url).pathname)).toEqual(['/v3/projects']);
    return planCloudInstallationContinuationV1({ ...context, scopePreparationId: projectReady.installationId, scopePreparationDigest: projectReady.plan.digest, installationId: billingId });
  };
  const historical = async () => {
    if (!options.historical) throw new Error('Synthetic historical fixture only');
    const record = await prepare();
    const owner = createHash('sha256').update(JSON.stringify([intent.customerId, intent.appId, intent.environment, billingId])).digest('hex');
    const accountName = record.plan.actions.find(action => action.id === 'gcp:billing:account')!.resource.name;
    const email = accountName.split('/').at(-1)!;
    const roles = Object.fromEntries(['link', 'impersonator'].map(role => [role, record.plan.actions.find(action => action.id === `gcp:billing:role:${role}`)!.resource.name]));
    for (const action of record.plan.actions) {
      if (action.metadata.operation === 'attach-billing' || action.metadata.operation === 'revoke') break;
      const attempt = { id: randomUUID(), actionId: action.id, status: 'attempted' as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      record.attempts.push(attempt);
      if (action.metadata.operation === 'enable-api') apis.add(action.resource.name);
      if (action.metadata.operation === 'create-account') {
        const value = { name: accountName, email, projectId: 'sequence-new-project', uniqueId: '333333333333333333333', description: `hypervibe:${owner}:${attempt.id}` };
        objects.set('/v1/' + accountName, value); objects.set('/v1/projects/sequence-new-project/serviceAccounts/' + value.uniqueId, value);
      }
      if (action.metadata.operation === 'create-role') {
        const includedPermissions = action.metadata.native.role === 'link'
          ? ['resourcemanager.projects.get', 'resourcemanager.projects.createBillingAssignment', 'serviceusage.services.list', 'serviceusage.effectivepolicy.get']
          : ['iam.serviceAccounts.get', 'iam.serviceAccounts.getAccessToken'];
        objects.set('/v1/' + action.resource.name, { name: action.resource.name, stage: 'GA', description: `hypervibe:${owner}:${attempt.id}`, includedPermissions });
      }
      if (action.metadata.operation === 'grant') {
        const target = action.metadata.native.target;
        const path = target === 'project' ? '/v3/projects/987654321012' : target === 'billing' ? '/v1/' + targetAccount : '/v1/projects/sequence-new-project/serviceAccounts/333333333333333333333';
        policies.set(path, { etag: 'E0', version: 3, bindings: [{ role: 'roles/viewer', members: ['user:owner@example.test'] },
          { role: target === 'project' ? roles.link : target === 'billing' ? 'roles/billing.user' : roles.impersonator,
            members: [`serviceAccount:${target === 'account' ? intent.hostIdentity.serviceAccountEmail : email}`] }] });
      }
      const observation = await nativeDriver.recover({ intent: record.intent, authentication: context.authentication, signal: new AbortController().signal,
        completed: record.completed, attempts: record.attempts, beforeMutation: async () => { throw new Error('Historical recovery cannot write'); }, action, attempt });
      expect(observation.state).toBe('satisfied');
      if (observation.state !== 'satisfied') throw new Error('Synthetic historical observation failed');
      record.completed[action.id] = observation.evidence;
      Object.assign(attempt, { status: 'succeeded', evidence: observation.evidence });
    }
    record.attempts.push({ id: randomUUID(), actionId: 'gcp:billing:attach', status: 'rejected', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reason: 'insufficient_permissions' });
    record.status = 'blocked'; record.reason = 'insufficient_permissions'; billing = 'billingAccounts/OTHER1-123456-789ABC';
    records.set(record.installationId, structuredClone(record));
    return record;
  };
  return { context, nativeDriver, calls, records, policies, objects, apply, prepare, historical, billing: () => billing,
    setBilling: (value: string) => { billing = value; }, setParent: (value: string) => { project.parent = value; } };
}

describe('GCP billing safety boundary and reconstructed historical cleanup', () => {
  it('reviews and applies the versioned initial assignment through transient browser authority without temporary IAM', async () => {
    const f = fixture({ initialAssignment: true, deniedAccountPolicy: true }); const plan = await f.prepare();
    expect(plan.status).toBe('review-required');
    expect(plan.intent.nativeScope.assignmentMode).toBe('initial-reviewed-v1');
    expect(plan.plan.actions).toHaveLength(1); expect(plan.plan.actions[0]).toMatchObject({ billable: true, requiresConfirm: true });
    expect(plan.plan.review.warnings.join(' ')).toMatch(/concurrent/i);
    const ready = await f.apply(plan); expect(ready.status).toBe('scope-ready');
    expect(f.billing()).toBe(intent.nativeScope.billingAccountName);
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(f.calls.some(call => call.url.includes('iam.googleapis.com') || call.url.includes('iamcredentials.googleapis.com') || call.url.endsWith(':setIamPolicy'))).toBe(false);
    expect(lifecycle.cloudInstallationDisconnectionIntentV1(ready, f.context.driver, collectionId)).toBeNull();
    expect(JSON.stringify([...f.records.values()])).not.toContain('synthetic-admin-token');
  });
  it('requires exact initial-assignment confirmation and preserves an account observed before dispatch', async () => {
    const f = fixture({ initialAssignment: true }); const plan = await f.prepare();
    await applyCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: [] });
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    f.setBilling('billingAccounts/OTHER1-123456-789ABC');
    expect((await f.apply(plan)).status).toBe('blocked');
    expect(f.billing()).toBe('billingAccounts/OTHER1-123456-789ABC');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it('recovers a lost initial-assignment response by reading without repeating PUT', async () => {
    const f = fixture({ initialAssignment: true, loseBillingAck: true }); const plan = await f.prepare();
    expect((await f.apply(plan)).status).not.toBe('scope-ready');
    const recovered = await reconcileCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(recovered.status).toBe('scope-ready'); expect((await f.apply(plan)).status).toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });
  it('makes the reviewed native non-atomic assignment behavior explicit for a concurrent external change', async () => {
    const f = fixture({ initialAssignment: true, raceAssociation: true }); const plan = await f.prepare();
    expect(plan.plan.review.warnings.join(' ')).toMatch(/replace.*concurrent/i);
    expect((await f.apply(plan)).status).toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });
  it('never repeats an uncertain initial assignment when readback still shows no association', async () => {
    const f = fixture({ initialAssignment: true, loseBeforeBillingAck: true }); const plan = await f.prepare();
    expect((await f.apply(plan)).status).not.toBe('scope-ready');
    expect((await reconcileCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest })).status).not.toBe('scope-ready');
    expect((await f.apply(plan)).status).not.toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });
  it('rechecks app authority after the final native billing read and before PUT', async () => {
    const f = fixture({ initialAssignment: true, revokeAtFinalBillingCheck: true }); const plan = await f.prepare();
    expect((await f.apply(plan)).status).not.toBe('scope-ready');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it('blocks fresh attachment before all temporary writes even with every action confirmed', async () => {
    const f = fixture(); const plan = await f.prepare(); const before = f.calls.length;
    expect(plan).toMatchObject({ status: 'blocked', reason: 'billing_assignment_unverified', plan: { blockedReason: 'billing_assignment_unverified' } });
    expect((await f.apply(plan)).status).toBe('blocked');
    expect(f.calls.slice(before).every(call => call.method === 'GET' || call.url.endsWith(':testIamPermissions'))).toBe(true);
    expect(f.calls.filter(call => call.method === 'PUT' || call.url.endsWith(':setIamPolicy'))).toHaveLength(0);
    expect(plan.plan.review.resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'project', scope: 'organizations/987654' })]));
  });
  it('rejects direct native connect mutations without a verified billing preservation guard', async () => {
    const f = fixture(); const plan = await f.prepare(); const before = f.calls.length;
    for (const action of plan.plan.actions.filter(action => action.metadata.operation !== 'revoke')) {
      const result = await f.nativeDriver.mutate({ intent: plan.intent, authentication: f.context.authentication, completed: {},
        signal: new AbortController().signal, action, beforeMutation: async () => { throw new Error('No mutation permitted'); },
        attempt: { id: randomUUID(), actionId: action.id, status: 'attempted', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      expect(result).toEqual({ state: 'rejected', reason: 'billing_assignment_unverified' });
    }
    expect(f.calls).toHaveLength(before);
  });
  it('does not treat selected-account probes as proof of absent inherited unlink on source account B', async () => {
    // Existing B delete-only grants can be inherited without get/list permission.
    // An account-A negative probe does not establish a native no-switch guard.
    const f = fixture({ raceAssociation: true, otherAccountUnlink: true }); const plan = await f.prepare();
    expect((await f.apply(plan)).reason).toBe('billing_assignment_unverified');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
  it('verifies already-associated billing without any IAM or billing writes and requires a separate collection review', async () => {
    const f = fixture(); const project = await planCloudInstallationV1({ ...f.context, intent }); await f.apply(project);
    f.setBilling(intent.nativeScope.billingAccountName);
    const plan = await planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: project.installationId, scopePreparationDigest: project.plan.digest, installationId: billingId });
    expect(plan.plan.actions).toHaveLength(1); expect(plan.plan.actions[0].type).toBe('noop');
    const ready = await f.apply(plan); expect(ready.status).toBe('scope-ready');
    expect(cloudInstallationNextStageV1(ready, f.context.driver)).toBe('collection');
    const child = await planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: ready.installationId, scopePreparationDigest: ready.plan.digest, installationId: collectionId });
    expect(child.intent.stage).toBe('collection');
    expect(f.calls.filter(call => call.method === 'PUT' || call.url.endsWith(':setIamPolicy'))).toHaveLength(0);
    expect(JSON.stringify([...f.records.values()])).not.toMatch(/synthetic-(admin|billing|host)-token|accessToken/);
    ready.completed['gcp:billing:existing'].resources = [];
    expect(() => cloudInstallationNextStageV1(ready, f.context.driver)).toThrow();
  });
  it('requires a separate partial-scope cleanup review after historical failed billing and preserves account B', async () => {
    const f = fixture({ historical: true }); const source = await f.historical();
    await reconcileCloudInstallationV1({ ...f.context, installationId: source.installationId, planDigest: source.plan.digest });
    const cleanup = await planCloudInstallationV1({ ...f.context, intent: lifecycle.cloudInstallationDisconnectionIntentV1(source, f.context.driver, collectionId) });
    expect(cleanup).toMatchObject({ status: 'review-required', intent: { mode: 'disconnect', stage: 'scope-preparation' } });
    expect((await f.apply(cleanup)).status).toBe('disconnected');
    expect(f.billing()).toBe('billingAccounts/OTHER1-123456-789ABC');
    expect([...f.policies.values()].every(value => value.bindings.every((binding: any) => binding.role === 'roles/viewer'))).toBe(true);
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    const before = f.calls.filter(call => call.url.endsWith(':setIamPolicy')).length;
    await f.apply(cleanup); expect(f.calls.filter(call => call.url.endsWith(':setIamPolicy'))).toHaveLength(before);
  });
  it('recovers lost partial-cleanup responses across restart without a second removal', async () => {
    const f = fixture({ historical: true, loseCleanupAck: true }); const source = await f.historical();
    const cleanup = await planCloudInstallationV1({ ...f.context, intent: lifecycle.cloudInstallationDisconnectionIntentV1(source, f.context.driver, collectionId) });
    let result = await f.apply(cleanup);
    for (let i = 0; i < 3 && result.status !== 'disconnected'; i++) {
      await reconcileCloudInstallationV1({ ...f.context, installationId: cleanup.installationId, planDigest: cleanup.plan.digest });
      result = await f.apply(cleanup);
    }
    expect(result.status).toBe('disconnected');
    expect(f.calls.filter(call => call.url.endsWith(':setIamPolicy'))).toHaveLength(3);
  });
  it('rejects cleanup of a same-name replacement service account and never clears the grants', async () => {
    const f = fixture({ historical: true }); const source = await f.historical();
    const cleanup = await planCloudInstallationV1({ ...f.context, intent: lifecycle.cloudInstallationDisconnectionIntentV1(source, f.context.driver, collectionId) });
    for (const object of f.objects.values()) if (object.uniqueId) object.uniqueId = '444444444444444444444';
    expect((await f.apply(cleanup)).status).toBe('blocked');
    expect(f.calls.filter(call => call.url.endsWith(':setIamPolicy'))).toHaveLength(0);
  });
  it('preserves uncertain grant attempts until exact read-only recovery establishes cleanup ownership', async () => {
    const f = fixture({ historical: true }); const source = await f.historical();
    delete source.completed['gcp:billing:grant:billing'];
    source.attempts.find(attempt => attempt.actionId === 'gcp:billing:grant:billing')!.status = 'uncertain';
    expect(() => lifecycle.cloudInstallationDisconnectionIntentV1(source, f.context.driver, collectionId)).toThrow();
    f.records.set(source.installationId, source);
    const observed = await reconcileCloudInstallationV1({ ...f.context, installationId: source.installationId, planDigest: source.plan.digest });
    expect(lifecycle.cloudInstallationDisconnectionIntentV1(observed, f.context.driver, collectionId)).toMatchObject({ mode: 'disconnect' });
  });
  it('preserves etag conflicts and requires separate retry confirmation for rejected cleanup', async () => {
    const f = fixture({ historical: true, policyConflict: true }); const source = await f.historical();
    const cleanup = await planCloudInstallationV1({ ...f.context, intent: lifecycle.cloudInstallationDisconnectionIntentV1(source, f.context.driver, collectionId) });
    expect((await f.apply(cleanup)).status).toBe('blocked');
    expect((await f.apply(cleanup)).reason).toBe('retry_confirmation_required');
    expect(f.calls.filter(call => call.url.endsWith(':setIamPolicy'))).toHaveLength(1);
  });
  it('returns explicit no-cleanup for the project-only stage and verifies current parent before continuation', async () => {
    const f = fixture(); const project = await planCloudInstallationV1({ ...f.context, intent }); const ready = await f.apply(project);
    expect(lifecycle.cloudInstallationDisconnectionIntentV1(ready, f.context.driver, collectionId)).toBeNull();
    f.setParent('organizations/999999');
    await expect(planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: ready.installationId, scopePreparationDigest: ready.plan.digest, installationId: billingId })).rejects.toThrow();
  });
});
