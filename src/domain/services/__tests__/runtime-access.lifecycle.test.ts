import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction } from '../runtime-access.service.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';
import type { IProviderAdapter } from '../../ports/provider.port.js';
import type { IStorageAdapter } from '../../ports/storage.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
afterEach(() => vi.restoreAllMocks());

// Synthetic shared-lifecycle model; native wire contracts are exercised by each adapter suite.
function fixture() {
  const environment = { id: 'env-one', projectId: 'app', name: 'production', platformBindings: {
    services: { web: { serviceId: 'exact-web' } },
    storage: { documents: { provider: 'test-storage', externalId: 'exact-bucket', instanceScope: { accountId: 'a' }, region: 'region', services: ['web'], envKeys: ['BUCKET'] } },
  } } as unknown as Environment;
  const environmentSpec = { hosting: { provider: 'test-host', region: 'region' }, services: { web: { workloadKind: 'web' } },
    storage: { documents: { provider: 'test-storage', injectInto: ['web'] } } } as unknown as EnvironmentSpec;
  const identity = { provider: 'test-cloud', principal: 'runtime', source: 'observed' as const, scope: { accountId: 'a', uid: 'immutable' } };
  let grant: any;
  const runtimeAccess = {
    hostingProviders: ['test-host'],
    observe: vi.fn(async (_target: any) => grant ? { state: 'present', binding: grant } : { state: 'absent' }),
    grant: vi.fn(async (_target, attemptId) => {
      expect((environment.platformBindings.storageRuntimeAccess as any).documents.web.pending.attemptId).toBe(attemptId);
      grant = { id: 'grant-exact', attemptId, evidence: { principal: 'runtime' } };
      return { receipt: { success: true, message: 'Verified' }, binding: grant };
    }),
    revoke: vi.fn(async (_target: any) => { grant = undefined; return { success: true, message: 'Verified absent' }; }),
  };
  const hosting = { name: 'test-host', resolveRuntimeIdentity: vi.fn(async () => identity) } as unknown as IProviderAdapter;
  const storage = { name: 'test-storage', runtimeAccess } as unknown as IStorageAdapter;
  const input = { environment, environmentSpec, hosting, storageAdapters: { 'test-storage': storage } };
  const save = vi.fn((bindings) => { Object.assign(environment.platformBindings, bindings); });
  return { ...input, input, save, runtimeAccess, identity, setGrant: (value: any) => { grant = value; } };
}
async function actions(f: ReturnType<typeof fixture>) {
  return planRuntimeAccess(await observeRuntimeAccess(f.input));
}

describe('explicit runtime access lifecycle', () => {
  it('grants a prepared replacement before activation, retains the old grant, and converges after an explicit retirement', async () => {
    const f = fixture();
    await applyRuntimeAccessAction({ ...f.input, action: (await actions(f))[0], save: f.save, confirmedActionIds: new Set() });
    const oldRecord = structuredClone((f.environment.platformBindings.storageRuntimeAccess as any).documents.web);
    const prepared = { ...f.identity, principal: 'replacement-runtime', source: 'configured' as const, scope: { ...f.identity.scope, uid: 'replacement-immutable' }, activation: { previousPrincipal: f.identity.principal, workloadEtag: 'exact-etag' } };
    const grants = new Map([[f.identity.principal, oldRecord.binding]]); let activated = false;
    f.runtimeAccess.observe.mockImplementation(async (target: any) => grants.has(target.identity.principal) ? { state: 'present', binding: grants.get(target.identity.principal) } : { state: 'absent' });
    f.runtimeAccess.grant.mockImplementation(async (target: any, attemptId: string) => { const binding = { id: target.identity.principal, attemptId, evidence: { principal: target.identity.principal } }; grants.set(target.identity.principal, binding); return { receipt: { success: true, message: 'Granted' }, binding }; });
    f.runtimeAccess.revoke.mockImplementation(async (target: any) => { grants.delete(target.identity.principal); return { success: true, message: 'Absent' }; });
    const step = { operation: 'attach', target: { phase: 'activate', workloadUid: 'exact-workload' }, description: 'Activate the separately prepared identity.', requiresConfirm: true, restartsWorkload: true };
    const inspect = vi.fn(async () => activated ? { state: 'ready', identity: { ...prepared, source: 'observed', activation: undefined } } : { state: 'action', step, preparedIdentity: prepared, requiresStorageAccess: true });
    const apply = vi.fn(async () => { expect(grants.has(prepared.principal)).toBe(true); expect(grants.has(f.identity.principal)).toBe(true); activated = true; return { receipt: { success: true, message: 'Activated' }, binding: { provider: 'test-host', evidence: { roleId: 'replacement-immutable' } } }; });
    Object.assign(f.hosting, { runtimeIdentities: { inspect, apply } });
    const [grant] = await actions(f); expect(grant.metadata?.operation).toBe('storageRuntimeGrant'); expect(apply).not.toHaveBeenCalled();
    expect((await applyRuntimeAccessAction({ ...f.input, action: grant, save: f.save, confirmedActionIds: new Set() })).success).toBe(true);
    expect((f.environment.platformBindings.storageRuntimeAccess as any).documents.web.retiring).toEqual(oldRecord);
    const [activate] = await actions(f); expect(activate.metadata?.operation).toBe('runtimeIdentity'); expect(activate.metadata?.step).toEqual(step);
    expect((await applyRuntimeAccessAction({ ...f.input, action: activate, save: f.save, confirmedActionIds: new Set([activate.id]) })).success).toBe(true);
    const [retire] = await actions(f); expect(retire.metadata?.operation).toBe('storageRuntimeRevoke'); expect(retire.metadata?.retiring).toBe(true);
    f.runtimeAccess.revoke.mockImplementationOnce(async (target: any) => { grants.delete(target.identity.principal); throw new Error('Lost exact revoke receipt'); });
    expect((await applyRuntimeAccessAction({ ...f.input, action: retire, save: f.save, confirmedActionIds: new Set([retire.id]) })).success).toBe(false);
    const pendingRetirement = (f.environment.platformBindings.storageRuntimeAccess as any).documents.web.retiring.pending.attemptId;
    const [recover] = await actions(f); expect(recover.metadata?.operation).toBe('storageRuntimeRecover'); expect(recover.metadata?.retiring).toBe(true);
    expect((await applyRuntimeAccessAction({ ...f.input, action: recover, save: f.save, confirmedActionIds: new Set([recover.id]) })).success).toBe(true);
    expect(f.runtimeAccess.revoke).toHaveBeenCalledOnce(); expect(pendingRetirement).toBeTruthy();
    expect((f.environment.platformBindings.storageRuntimeAccess as any).documents.web).not.toHaveProperty('retiring');
    expect(await actions(f)).toEqual([]); expect(apply).toHaveBeenCalledOnce();
    expect(f.runtimeAccess.grant).toHaveBeenCalledTimes(2); expect(grants.has(prepared.principal)).toBe(true); expect(grants.has(f.identity.principal)).toBe(false);
  });
  it('waits for an after-workload identity when no exact workload has been bound', async () => {
    const f = fixture(); f.environment.platformBindings.services = {};
    vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ lifecycle: { hosting: { runtimeIdentityTiming: 'after-workload' } } } as never);
    const inspect = vi.fn(async () => ({ state: 'unknown', reason: 'No workload identity exists yet.' }));
    Object.assign(f.hosting, { runtimeIdentities: { inspect, apply: vi.fn() } });
    const observed = await observeRuntimeAccess(f.input);
    expect(planRuntimeAccess(observed)).toEqual([]);
    expect(observed.identities[0]?.observation.state).toBe('waiting');
    expect(inspect).not.toHaveBeenCalled(); expect(f.runtimeAccess.observe).not.toHaveBeenCalled();
  });

  it('revokes grants first, waits for workload deletion, then clears only the independently absent owned identity', async () => {
    const f = fixture();
    await applyRuntimeAccessAction({ ...f.input, action: (await actions(f))[0], save: f.save, confirmedActionIds: new Set() });
    let servicePresent = true; let rolePresent = true;
    f.environment.platformBindings.runtimeIdentities = { web: { provider: 'test-host', evidence: { roleId: 'immutable', serviceId: 'exact-web' } } };
    f.environmentSpec.services = {}; f.environmentSpec.storage!.documents.injectInto = [];
    const step = { operation: 'destroy', target: { roleId: 'immutable' }, description: 'Remove the exact unused runtime role.', requiresConfirm: true };
    const inspect = vi.fn(async (request: any) => {
      if (request.mode !== 'destroy') return { state: 'unknown', reason: 'Removed workloads cannot be ensured.' };
      if (servicePresent) return { state: 'waiting', reason: 'Remove the workload first.' };
      return rolePresent ? { state: 'action', step } : { state: 'ready' };
    });
    const apply = vi.fn(async (request: any) => { expect(request.mode).toBe('destroy'); rolePresent = false; return { receipt: { success: true, message: 'Absent' } }; });
    Object.assign(f.hosting, { runtimeIdentities: { inspect, apply } });
    const [revoke] = await actions(f); expect(revoke.metadata?.operation).toBe('storageRuntimeRevoke');
    expect(inspect).not.toHaveBeenCalled();
    expect((await applyRuntimeAccessAction({ ...f.input, action: revoke, save: f.save, confirmedActionIds: new Set([revoke.id]) })).success).toBe(true);
    expect(await actions(f)).toEqual([]); expect(inspect.mock.calls.at(-1)![0].mode).toBe('destroy');
    servicePresent = false; f.environment.platformBindings.services = {};
    const [destroy] = await actions(f); expect(destroy.metadata?.step).toEqual(step);
    expect((await applyRuntimeAccessAction({ ...f.input, action: destroy, save: f.save, confirmedActionIds: new Set([destroy.id]) })).success).toBe(true);
    expect(f.environment.platformBindings.runtimeIdentities).toEqual({});
    expect(await actions(f)).toEqual([]); expect(apply).toHaveBeenCalledOnce();
  });

  it('awaits durable asynchronous intent persistence before calling a native identity writer', async () => {
    const f = fixture(); const step = { operation: 'create', target: { serviceId: 'exact-web' }, description: 'Create the isolated runtime identity.', requiresConfirm: true };
    const inspect = vi.fn(async () => ({ state: 'action', step })); const apply = vi.fn(async () => ({ receipt: { success: false, data: { mutationAttempted: false } } }));
    Object.assign(f.hosting, { runtimeIdentities: { inspect, apply } });
    const [action] = await actions(f);
    const save = vi.fn(async () => { throw new Error('Disk unavailable'); });
    expect((await applyRuntimeAccessAction({ ...f.input, action, save, confirmedActionIds: new Set([action.id]) })).success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
  it('clears only a new definitively rejected identity write while preserving uncertain or older attempts', async () => {
    const f = fixture(); const step = { operation: 'create', target: { serviceId: 'exact-web' }, description: 'Create the isolated runtime identity.', requiresConfirm: true };
    Object.assign(f.hosting, { runtimeIdentities: { inspect: vi.fn(async () => ({ state: 'action', step })), apply: vi.fn(async () => ({ receipt: { success: false, data: { mutationAttempted: true, mutationRejected: true } } })) } });
    const [action] = await actions(f);
    expect((await applyRuntimeAccessAction({ ...f.input, action, save: f.save, confirmedActionIds: new Set([action.id]) })).success).toBe(false);
    expect(f.environment.platformBindings.runtimeIdentities).toEqual({});
  });
  it('never reissues a retained identity write when observation repeats the original mutation frontier', async () => {
    const f = fixture(); const step = { operation: 'create', target: { serviceId: 'exact-web' }, description: 'Create identity.', requiresConfirm: true };
    const binding = { provider: 'test-host', evidence: {}, pending: { attemptId: 'original-uncertain-attempt', step } };
    f.environment.platformBindings.runtimeIdentities = { web: binding };
    const apply = vi.fn(); Object.assign(f.hosting, { runtimeIdentities: { inspect: vi.fn(async () => ({ state: 'action', step })), apply } });
    expect(await actions(f)).toEqual([]);
    expect(f.environment.platformBindings.runtimeIdentities).toEqual({ web: binding }); expect(apply).not.toHaveBeenCalled();
  });
  it('plans a missing live grant despite retained wiring, persists intent before grant, then becomes mutation-free noop', async () => {
    const f = fixture();
    const [action] = await actions(f);
    expect(action.metadata?.operation).toBe('storageRuntimeGrant');
    expect(await applyRuntimeAccessAction({ ...f.input, action, save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: true });
    expect(await actions(f)).toEqual([]);
    expect(f.runtimeAccess.grant).toHaveBeenCalledTimes(1);
    expect(f.runtimeAccess.revoke).not.toHaveBeenCalled();
    f.setGrant(undefined);
    expect((await actions(f))[0].metadata?.operation).toBe('storageRuntimeGrant');
  });
  it('does not treat failed reads or an unbound existing grant as absence', async () => {
    const f = fixture();
    f.runtimeAccess.observe.mockRejectedValue(new Error('provider may echo secrets'));
    const [unknown] = await actions(f);
    expect(unknown.verified).toBe(false);
    expect(JSON.stringify(unknown)).not.toContain('echo secrets');
    f.runtimeAccess.observe.mockResolvedValue({ state: 'present', binding: { id: 'other', attemptId: 'not-approved', evidence: {} } } as never);
    expect((await actions(f))[0].verified).toBe(false);
    expect(f.runtimeAccess.grant).not.toHaveBeenCalled();
  });
  it('retains uncertain grant intent and recovers only its exact attempt', async () => {
    const f = fixture();
    const perform = f.runtimeAccess.grant.getMockImplementation()!;
    f.runtimeAccess.grant.mockImplementationOnce(async (...args) => { await perform(...args); throw new Error('response lost'); });
    const [action] = await actions(f);
    expect(await applyRuntimeAccessAction({ ...f.input, action, save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: false });
    const pending = (f.environment.platformBindings.storageRuntimeAccess as any).documents.web.pending.attemptId;
    const [recover] = await actions(f);
    expect(recover.metadata?.operation).toBe('storageRuntimeRecover');
    expect(await applyRuntimeAccessAction({ ...f.input, action: recover, save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: true });
    expect(f.runtimeAccess.grant.mock.calls[1][1]).toBe(pending);
    expect(await actions(f)).toEqual([]);
  });
  it('requires exact confirmation before revocation and clears only verified absent grants', async () => {
    const f = fixture();
    await applyRuntimeAccessAction({ ...f.input, action: (await actions(f))[0], save: f.save, confirmedActionIds: new Set() });
    f.environmentSpec.storage!.documents.injectInto = [];
    const [revoke] = await actions(f);
    expect(revoke.requiresConfirm).toBe(true);
    expect(await applyRuntimeAccessAction({ ...f.input, action: revoke, save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: false });
    expect(f.runtimeAccess.revoke).not.toHaveBeenCalled();
    expect(await applyRuntimeAccessAction({ ...f.input, action: revoke, save: f.save, confirmedActionIds: new Set([revoke.id]) })).toMatchObject({ success: true });
    expect(await actions(f)).toEqual([]);
  });
  it('refuses stale principal changes and persistence failures before any mutation', async () => {
    const f = fixture();
    const [action] = await actions(f);
    f.identity.scope.uid = 'replacement';
    expect(await applyRuntimeAccessAction({ ...f.input, action, save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: false });
    f.save.mockImplementationOnce(() => { throw new Error('disk failed'); });
    expect(await applyRuntimeAccessAction({ ...f.input, action: (await actions(f))[0], save: f.save, confirmedActionIds: new Set() })).toMatchObject({ success: false });
    expect(f.runtimeAccess.grant).not.toHaveBeenCalled();
  });
});

it('does not equate retained env keys with a live bucket grant during ordinary planning', async () => {
  const { planStorage } = await import('../storage-plan.service.js');
  const { providerRegistry } = await import('../../registry/provider.registry.js');
  const f = fixture();
  vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ storageRuntimeAccess: { hostingProviders: ['test-host'] } } as never);
  const observed = { services: [{ name: 'web', externalId: 'exact-web', envVarKeys: ['BUCKET'] }], storage: [], partial: false, warnings: [], databases: [] } as never;
  const wire = planStorage({ environment: f.environment, environmentSpec: f.environmentSpec, observed }).actions.find(action => action.metadata?.operation === 'storageWire');
  expect(wire?.type).toBe('update');
  expect(wire?.metadata?.blockedReason).toBe('runtime_access_unverified');
  vi.restoreAllMocks();
});
