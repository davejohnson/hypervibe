import { describe, expect, it, vi } from 'vitest';
import {
  planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1,
  parseCloudInstallationRecordV1,
  cloudInstallationDisconnectionIntentV1,
  cloudInstallationConnectionsV1,
} from '../cloud-installation.js';
import type {
  CloudInstallationAction, CloudInstallationContext, CloudInstallationDriver, CloudInstallationIntent,
  CloudInstallationRecord, CloudInstallationEvidence,
} from '../../../domain/ports/cloud-installation.port.js';

// Synthetic provider semantics exercise the shared authorization/CAS boundary.
// They are not transport fixtures or evidence of native cloud compatibility.
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'app-a',
  environment: 'production', provider: 'gcp', mode: 'connect', keys: ['API_KEY'],
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { projectId: 'customer-project' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
};
const evidence: CloudInstallationEvidence = { resources: [{ kind: 'writer', id: 'native-writer', identity: { uniqueId: '123' } }], native: {} };
const action = (id = 'writer'): CloudInstallationAction => ({ id, type: 'create', resource: { kind: 'secret', name: id, provider: 'gcp' },
  verified: true, requiresConfirm: true, reason: 'Prepare scoped writer.', metadata: { operation: 'writerCreate', category: 'identity', execution: 'api', native: {} } });

function fixture(actions = [action()]) {
  let record: CloudInstallationRecord | null = null;
  let present = false;
  const driver: CloudInstallationDriver = {
    provider: 'gcp', parseScope: value => value as Record<string, string>,
    parseAction: value => value as CloudInstallationAction, parseEvidence: value => value as CloudInstallationEvidence,
    plan: vi.fn(async () => ({ actions, review: { permissions: [], costs: [], warnings: [] } })),
    inspect: vi.fn(async () => present ? { state: 'satisfied' as const, evidence } : { state: 'action-required' as const }),
    mutate: vi.fn(async context => { await context.beforeMutation(); present = true; return { state: 'acknowledged' as const, evidence }; }),
    recover: vi.fn(async () => present ? { state: 'satisfied' as const, evidence } : { state: 'unknown' as const, reason: 'not_converged' as const }),
    connections: vi.fn(() => []),
  };
  const store = {
    read: vi.fn(async () => record && structuredClone(record)),
    compareAndSwap: vi.fn(async (_id: string, expected: number | null, next: CloudInstallationRecord) => {
      if ((record?.revision ?? null) !== expected) return false;
      record = structuredClone(next); return true;
    }),
  };
  const context: CloudInstallationContext = { driver, store, authorize: vi.fn(async () => true),
    authentication: { host: { verifyIdentity: vi.fn(async () => intent.hostIdentity),
      getIdToken: vi.fn(async () => 'transient-id-token'), getAccessToken: vi.fn(async () => 'transient-access-token') } } };
  const plan = () => planCloudInstallationV1({ ...context, intent });
  const apply = async (extra = {}) => { const saved = record!; return applyCloudInstallationV1({ ...context, installationId: saved.installationId,
    planDigest: saved.plan.digest, confirmActions: actions.map(item => item.id), ...extra }); };
  const reconcile = () => reconcileCloudInstallationV1({ ...context, installationId: record!.installationId, planDigest: record!.plan.digest });
  return { context, driver, store, plan, apply, reconcile, get: () => record!, setPresent: () => { present = true; } };
}

describe('hosted installation lifecycle (synthetic provider boundary)', () => {
  it('reviews first-writer authorization distinctly while preserving exact existing targets', async () => {
    const f = fixture();
    const destination = { provider: 'gcp-secret-manager' as const, projectId: 'customer-project', projectNumber: '123456789', secretId: 'retained-key' };
    const existing = { ...intent, mode: 'connect-existing' as const, migrationTargets: [{ key: 'API_KEY', destination }] };
    const planned = await planCloudInstallationV1({ ...f.context, intent: existing });
    const changed = structuredClone(planned); changed.intent.mode = 'migrate';
    expect(() => parseCloudInstallationRecordV1(changed, f.driver)).toThrow('invalid_contract');
    const ready = await f.apply();
    vi.mocked(f.driver.connections).mockReturnValue([{ key: 'API_KEY', destination, writerAuthorization: { writerId: 'native-writer' } }]);
    expect(cloudInstallationConnectionsV1(ready, f.driver)[0].destination).toEqual(destination);
    vi.mocked(f.driver.connections).mockReturnValue([{ key: 'API_KEY', destination: { ...destination, secretId: 'replacement' }, writerAuthorization: { writerId: 'native-writer' } }]);
    expect(() => cloudInstallationConnectionsV1(ready, f.driver)).toThrow('invalid_contract');
    const unsafe = fixture([{ ...action(), metadata: { ...action().metadata, category: 'secret-container' } }]);
    await expect(planCloudInstallationV1({ ...unsafe.context, intent: existing })).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(unsafe.store.compareAndSwap).not.toHaveBeenCalled();
    await expect(planCloudInstallationV1({ ...fixture().context, intent: { ...existing, migrationTargets: undefined } })).rejects.toMatchObject({ code: 'invalid_contract' });
  });
  it('cannot omit an accepted trust grant whose acknowledgment was lost when projecting disconnect', async () => {
    const first = action('account'); const grant = { ...action('host-trust'), dependsOn: ['account'], type: 'update' as const,
      metadata: { ...action().metadata, category: 'trust' as const, operation: 'grant-host' } };
    const f = fixture([first, grant]); const live = new Set<string>(); await f.plan();
    vi.mocked(f.driver.inspect).mockImplementation(async context => live.has(context.action.id) ? { state: 'satisfied', evidence } : { state: 'action-required' });
    vi.mocked(f.driver.recover).mockImplementation(async context => live.has(context.action.id) ? { state: 'satisfied', evidence } : { state: 'unknown', reason: 'not_converged' });
    vi.mocked(f.driver.mutate).mockImplementation(async context => {
      await context.beforeMutation(); live.add(context.action.id);
      if (context.action.id === 'host-trust') throw new Error('Lost native grant acknowledgment');
      return { state: 'acknowledged', evidence };
    });
    const uncertain = await f.apply(); expect(uncertain.status).toBe('pending');
    expect(uncertain.completed.account).toBeDefined(); expect(uncertain.completed['host-trust']).toBeUndefined();
    for (const status of ['attempted', 'acknowledged', 'pending', 'uncertain'] as const) {
      const historical = structuredClone(uncertain); historical.attempts.at(-1)!.status = status;
      expect(() => cloudInstallationDisconnectionIntentV1(historical, f.driver, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toThrow();
    }
    const recovered = await f.reconcile();
    expect(recovered.status).toBe('ready');
    expect(cloudInstallationDisconnectionIntentV1(recovered, f.driver, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')?.installed).toHaveLength(2);
    const drifted = structuredClone(recovered); drifted.status = 'blocked'; delete drifted.completed['host-trust'];
    expect(() => cloudInstallationDisconnectionIntentV1(drifted, f.driver, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toThrow();
    expect(f.driver.mutate).toHaveBeenCalledTimes(2);
  });
  it('projects explicit no cleanup only for a collection review with no attempts or completed native evidence', async () => {
    const f = fixture(); const planned = await f.plan();
    expect(cloudInstallationDisconnectionIntentV1(planned, f.driver, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeNull();
    vi.mocked(f.driver.mutate).mockResolvedValue({ state: 'uncertain', reason: 'provider_error' });
    const unknown = await f.apply();
    expect(() => cloudInstallationDisconnectionIntentV1(unknown, f.driver, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toThrow();
  });
  it('persists an explicit blocked review without allowing confirmations or read-only reconciliation to dispatch it', async () => {
    const unverified = { ...action(), verified: false };
    const f = fixture([unverified]);
    vi.mocked(f.driver.plan).mockResolvedValue({ actions: [unverified], review: { permissions: [], costs: [], warnings: [] },
      blockedReason: 'create_ownership_unverified' });
    const planned = await f.plan();
    expect(planned).toMatchObject({ status: 'blocked', reason: 'create_ownership_unverified',
      plan: { blockedReason: 'create_ownership_unverified', actions: [{ verified: false }] } });
    expect((await f.apply()).status).toBe('blocked');
    expect((await f.reconcile()).reason).toBe('create_ownership_unverified');
    expect(f.driver.inspect).not.toHaveBeenCalled();
    expect(f.driver.mutate).not.toHaveBeenCalled();
    expect(f.get().attempts).toEqual([]);
    const tampered = structuredClone(planned); delete tampered.plan.blockedReason;
    expect(() => parseCloudInstallationRecordV1(tampered, f.driver)).toThrow();
    tampered.plan.blockedReason = 'not_converged';
    expect(() => parseCloudInstallationRecordV1(tampered, f.driver)).toThrow();
  });

  it('persists an exact reviewed plan then attempts before mutating and verifies completion', async () => {
    const f = fixture(); const planned = await f.plan();
    expect(planned.status).toBe('review-required'); expect(planned.plan.digest).toMatch(/^[a-f0-9]{64}$/);
    vi.mocked(f.driver.mutate).mockImplementation(async ({ attempt, beforeMutation }) => {
      expect(f.get().attempts.at(-1)).toMatchObject({ id: attempt.id, status: 'attempted' });
      await beforeMutation();
      f.setPresent(); return { state: 'acknowledged', evidence };
    });
    expect((await f.apply()).status).toBe('ready'); expect(f.driver.recover).toHaveBeenCalledOnce();
  });
  it('requires the exact plan digest and action confirmation', async () => {
    const f = fixture(); await f.plan();
    await expect(f.apply({ planDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'plan_mismatch' });
    expect((await f.apply({ confirmActions: [] })).reason).toBe('confirmation_required');
    expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('rejects secret-shaped or extra durable intent fields', async () => {
    const f = fixture();
    await expect(planCloudInstallationV1({ ...f.context, intent: { ...intent, clientSecret: 'must-never-persist' } })).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(f.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it('cannot replace a customer/environment/source intent under an existing installation id', async () => {
    const f = fixture(); await f.plan();
    for (const change of [{ environment: 'staging' }, { customerId: 'other' }, { source: { ...intent.source, revision: 'c'.repeat(40) } }]) {
      await expect(planCloudInstallationV1({ ...f.context, intent: { ...intent, ...change } })).rejects.toMatchObject({ code: 'scope_mismatch' });
    }
    expect(f.driver.plan).toHaveBeenCalledOnce();
  });
  it('a noop re-observes and performs zero mutations', async () => {
    const f = fixture([{ ...action(), type: 'noop', requiresConfirm: false }]); f.setPresent(); await f.plan();
    expect((await f.apply()).status).toBe('ready'); expect(f.driver.mutate).not.toHaveBeenCalled();
    expect(f.get().attempts).toEqual([]);
  });
  it('unknown/noop-missing observations never authorize writes', async () => {
    const f = fixture([{ ...action(), type: 'noop' }]); await f.plan();
    expect((await f.apply()).status).toBe('blocked'); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('orders explicit dependencies and stops before downstream work on unknown outcome', async () => {
    const f = fixture([{ ...action('second'), dependsOn: ['first'] }, action('first')]); await f.plan();
    vi.mocked(f.driver.mutate).mockResolvedValue({ state: 'uncertain', reason: 'provider_error' });
    expect((await f.apply()).status).toBe('pending');
    expect(vi.mocked(f.driver.mutate).mock.calls.map(([input]) => input.action.id)).toEqual(['first']);
  });
  it('lost acknowledgment is fenced across restarts and can only reconcile', async () => {
    const f = fixture(); await f.plan();
    vi.mocked(f.driver.mutate).mockImplementation(async context => { await context.beforeMutation(); f.setPresent(); throw new Error('provider echoed token'); });
    expect((await f.apply()).status).toBe('pending'); expect(f.get().attempts[0].status).toBe('uncertain');
    expect(JSON.stringify(f.get())).not.toContain('echoed');
    expect((await f.apply()).status).toBe('ready'); expect(f.driver.mutate).toHaveBeenCalledOnce();
  });
  it('uncertain absence never permits blind resubmission even with retry confirmation', async () => {
    const f = fixture(); await f.plan(); vi.mocked(f.driver.mutate).mockResolvedValue({ state: 'uncertain', reason: 'provider_error' });
    await f.apply(); const attempt = f.get().attempts[0];
    vi.mocked(f.driver.recover).mockResolvedValue({ state: 'action-required' });
    expect((await f.apply({ retryActions: [{ actionId: 'writer', attemptId: attempt.id }] })).status).toBe('pending');
    expect(f.driver.mutate).toHaveBeenCalledOnce();
  });
  it('definite no-effect rejection needs a separate exact attempt retry confirmation', async () => {
    const f = fixture(); await f.plan(); vi.mocked(f.driver.mutate).mockResolvedValueOnce({ state: 'rejected', reason: 'insufficient_permissions' });
    expect((await f.apply()).status).toBe('blocked'); const attempt = f.get().attempts[0];
    expect((await f.apply()).reason).toBe('retry_confirmation_required');
    expect((await f.apply({ retryActions: [{ actionId: 'writer', attemptId: attempt.id }] })).status).toBe('ready');
    expect(f.driver.mutate).toHaveBeenCalledTimes(2);
  });
  it('CAS conflicts before an attempt prevent every mutation', async () => {
    const f = fixture(); await f.plan(); vi.mocked(f.store.compareAndSwap).mockResolvedValue(false);
    await expect(f.apply()).rejects.toMatchObject({ code: 'store_conflict' }); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('CAS failure after a native write leaves the prewritten attempt recoverable without replay', async () => {
    const f = fixture(); await f.plan(); const save = f.store.compareAndSwap.getMockImplementation()!;
    vi.mocked(f.store.compareAndSwap).mockImplementation(async (id, revision, next) => next.attempts.at(-1)?.status === 'acknowledged' ? false : save(id, revision, next));
    await expect(f.apply()).rejects.toMatchObject({ code: 'store_conflict' });
    expect(f.get().attempts[0].status).toBe('attempted');
    vi.mocked(f.store.compareAndSwap).mockImplementation(save);
    expect((await f.reconcile()).status).toBe('ready'); expect(f.driver.mutate).toHaveBeenCalledOnce();
  });
  it('authorization revoked after readback stops a mutation', async () => {
    const f = fixture(); await f.plan();
    vi.mocked(f.context.authorize).mockImplementation(async input => input.phase !== 'mutate');
    expect((await f.apply()).reason).toBe('authorization_revoked'); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('a recreated host service account invalidates approval despite identical email', async () => {
    const f = fixture(); await f.plan();
    vi.mocked(f.context.authentication.host.verifyIdentity).mockResolvedValue({ ...intent.hostIdentity, subject: '999999999999999999999' });
    expect((await f.apply()).reason).toBe('identity_mismatch'); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('external console installation retains an attempt and verifies independently on return', async () => {
    const f = fixture([{ ...action(), metadata: { ...action().metadata, execution: 'external' } }]); await f.plan();
    vi.mocked(f.driver.mutate).mockImplementation(async context => { await context.beforeMutation(); return { state: 'external', url: 'https://example.com/review?scope=customer' }; });
    expect((await f.apply()).status).toBe('pending');
    expect(f.get().attempts[0].externalUrl).toBe('https://example.com/review?scope=customer');
    f.setPresent(); expect((await f.reconcile()).status).toBe('ready'); expect(f.driver.mutate).toHaveBeenCalledOnce();
  });
  it('rejects invalid dependency graphs and disconnect secret destruction', async () => {
    const f = fixture([{ ...action(), dependsOn: ['missing'] }]); await expect(f.plan()).rejects.toMatchObject({ code: 'invalid_contract' });
    const g = fixture([{ ...action(), type: 'destroy', metadata: { ...action().metadata, category: 'secret-container' } }]);
    await expect(planCloudInstallationV1({ ...g.context, intent: { ...intent, mode: 'disconnect', installed: [evidence] } })).rejects.toMatchObject({ code: 'invalid_contract' });
  });
  it('rejects tampered persisted plan digests and unexpected evidence fields', async () => {
    const f = fixture(); await f.plan();
    expect(() => parseCloudInstallationRecordV1({ ...f.get(), plan: { ...f.get().plan, digest: '0'.repeat(64) } }, f.driver)).toThrow();
    expect(() => parseCloudInstallationRecordV1({ ...f.get(), completed: { writer: { ...evidence, value: 'secret' } } }, f.driver)).toThrow();
  });
  it('does not expose an existing review after its authorization has been revoked', async () => {
    const f = fixture(); await f.plan(); vi.mocked(f.context.authorize).mockResolvedValue(false);
    await expect(f.plan()).rejects.toMatchObject({ code: 'authorization_revoked' });
  });
  it('rejects an empty plan rather than claiming a verified cloud installation', async () => {
    const f = fixture([]); await expect(f.plan()).rejects.toMatchObject({ code: 'invalid_contract' });
  });
  it('passes exact verified predecessor identity to dependent actions without allowing mutation of durable evidence', async () => {
    const f = fixture([action('first'), { ...action('second'), dependsOn: ['first'] }]); await f.plan();
    vi.mocked(f.driver.inspect).mockImplementation(async context => {
      if (context.action.id === 'second') {
        expect(context.completed.first.resources[0].identity.uniqueId).toBe('123');
        context.completed.first.resources[0].identity.uniqueId = 'changed-in-driver';
      }
      return { state: 'action-required' };
    });
    expect((await f.apply()).status).toBe('ready');
    expect(f.get().completed.first.resources[0].identity.uniqueId).toBe('123');
  });
  it('bounded lost mutation outcome stays fenced even if a provider ignores cancellation', async () => {
    const f = fixture(); f.context.timeoutMs = 10; await f.plan();
    vi.mocked(f.driver.mutate).mockImplementation(async context => { await context.beforeMutation(); return new Promise(resolve => setTimeout(() => resolve({ state: 'acknowledged' }), 30)); });
    expect((await f.apply()).reason).toBe('timeout');
    expect(f.get().attempts[0].status).toBe('uncertain');
    await f.reconcile(); expect(f.driver.mutate).toHaveBeenCalledOnce();
  });
  it('read-only reconciliation cannot dispatch a fresh action', async () => {
    const f = fixture(); await f.plan(); expect((await f.reconcile()).status).toBe('blocked');
    expect(f.driver.mutate).not.toHaveBeenCalled(); expect(f.get().attempts).toEqual([]);
  });
  it('disconnect only removes reviewed trust under a new operation and preserves native secret evidence', async () => {
    const trust = { ...action(), type: 'destroy' as const, metadata: { ...action().metadata, category: 'trust' as const } };
    const f = fixture([trust]);
    await planCloudInstallationV1({ ...f.context, intent: { ...intent, mode: 'disconnect', installed: [evidence] } });
    expect((await f.apply()).status).toBe('disconnected');
    expect(f.get().intent.installed).toEqual([evidence]);
    expect(vi.mocked(f.driver.mutate).mock.calls.every(([context]) => context.action.metadata.category === 'trust')).toBe(true);
  });
  it('rechecks current authorization at the native write boundary after provider prerequisite reads', async () => {
    const f = fixture(); await f.plan(); let writes = 0;
    vi.mocked(f.driver.mutate).mockImplementation(async context => {
      vi.mocked(f.context.authorize).mockResolvedValue(false);
      await context.beforeMutation();
      writes++; return { state: 'acknowledged' };
    });
    expect((await f.apply()).reason).toBe('authorization_revoked'); expect(writes).toBe(0);
  });
  it('rejects a store returning another installation even when its plan digest is supplied', async () => {
    const f = fixture(); await f.plan();
    await expect(f.apply({ installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).rejects.toMatchObject({ code: 'scope_mismatch' });
    expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('preserves a verified disconnect receipt after restart without requiring the removed cloud trust', async () => {
    const f = fixture([{ ...action(), type: 'destroy', metadata: { ...action().metadata, category: 'trust' } }]);
    await planCloudInstallationV1({ ...f.context, intent: { ...intent, mode: 'disconnect', installed: [evidence] } });
    expect((await f.apply()).status).toBe('disconnected');
    vi.mocked(f.driver.recover).mockResolvedValue({ state: 'unknown', reason: 'insufficient_permissions' });
    vi.mocked(f.driver.recover).mockClear();
    expect((await f.reconcile()).status).toBe('disconnected'); expect(f.driver.recover).not.toHaveBeenCalled();
  });
  it('reviews migration of exact existing targets and authorizes only new writer/trust actions', async () => {
    const f = fixture();
    await planCloudInstallationV1({ ...f.context, intent: { ...intent, mode: 'migrate', migrationTargets: [{ key: 'API_KEY',
      destination: { provider: 'gcp-secret-manager', projectId: 'customer-project', projectNumber: '123456789', secretId: 'existing' } }] } });
    expect((await f.apply()).status).toBe('ready');
  });
  it('migration requires exact key coverage and rejects secret container changes', async () => {
    const migrationTargets = [{ key: 'API_KEY', destination: { provider: 'gcp-secret-manager', projectId: 'customer-project', projectNumber: '123456789', secretId: 'existing' } }];
    for (const change of [{}, { migrationTargets: [] }, { migrationTargets: [{ ...migrationTargets[0], key: 'OTHER' }] }]) {
      const f = fixture(); await expect(planCloudInstallationV1({ ...f.context, intent: { ...intent, mode: 'migrate', ...change } })).rejects.toMatchObject({ code: 'invalid_contract' });
    }
    const f = fixture([{ ...action(), metadata: { ...action().metadata, category: 'secret-container' } }]);
    await expect(planCloudInstallationV1({ ...f.context, intent: { ...intent, mode: 'migrate', migrationTargets } })).rejects.toMatchObject({ code: 'invalid_contract' });
  });
});
