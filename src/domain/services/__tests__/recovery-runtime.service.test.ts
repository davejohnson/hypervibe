import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SecretStore, getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import * as targets from '../managed-backup-target.service.js';
import { observeRecoveryRuntime, planRecoveryRuntime, applyRecoveryRuntimeAction, type RecoveryRuntimeBindingPatch } from '../recovery-runtime.service.js';
import type { BackupPolicyContext } from '../backup-policy.service.js';
import { providerRegistry } from '../../registry/provider.registry.js';

// Shared application contract with synthetic provider capabilities. Actual
// CloudRun/SQL/GCS API behavior is exercised separately through their transports.
const databaseUrl = 'postgresql://app:synthetic-database-password@db.internal/app';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-recovery-prep-')); vi.stubEnv('HYPERVIBE_DATA_DIR', directory); SecretStore.resetInstance(); });
afterEach(() => { SecretStore.resetInstance(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ lifecycle: { hosting: { recoveryRuntime: { databaseProviders: ['test-db'], storageProviders: ['test-storage'] } } } } as never);
  const now = new Date();
  const scope = { projectId: 'native-project', region: 'region-1' };
  const source = { provider: 'test-db', primaryExternalId: 'db', providerScope: scope, resourceIdentity: { instanceId: 'db' } };
  const environment = { id: 'env-id', projectId: 'project-id', name: 'production', createdAt: now, updatedAt: now, platformBindings: { provider: 'test-host', projectId: 'native-project', environmentId: 'region-1' } as Record<string, unknown> };
  const component = { id: 'db-id', environmentId: environment.id, externalId: 'db', type: 'postgres', createdAt: now, updatedAt: now, bindings: { provider: 'test-db', providerScope: scope, connectionUrl: databaseUrl } };
  const target = { version: 1 as const, project: 'app', environment: 'production', hosting: { provider: 'test-host', providerScope: scope }, runnerImage: 'ghcr.io/example/helper@sha256:' + 'a'.repeat(64), destination: { name: 'archive', identity: { provider: 'test-storage', externalId: 'archive', instanceScope: scope } }, database: { componentId: component.id, source }, objects: [], fileReferenceQueries: [], retainSets: 7 as const, maxDataAgeHours: 24 as const, restoreEveryDays: 7 as const };
  vi.spyOn(targets, 'resolveManagedBackupTarget').mockResolvedValue({ state: 'ready', target, contractHash: canonicalJsonSha256(target), providerCredentialNames: [] });
  const step = { component: 'database-secret-version', operation: 'write' as const, target: { secret: 'projects/project/secrets/exact-secret' }, description: 'Prepare the selected database connection for its backup worker.', requiresConfirm: true, privateInputKeys: ['databaseUrl'] };
  let completed = false;
  let uncertain = false;
  const inspect = vi.fn(async (request: any) => request.binding?.pending
    ? { state: 'action', step: { ...request.binding.pending.step, operation: 'recover', requiresConfirm: false } }
    : completed ? { state: 'ready', executionTarget: { provider: 'test-host', environmentId: environment.id, providerScope: scope, identity: { provider: 'test', principal: 'backup-worker', scope, source: 'observed' }, configuration: {}, worker: { provider: 'test-host', configuration: {} } } }
      : { state: 'action', step });
  const apply = vi.fn(async (request: any) => {
    expect(environment.platformBindings.recoveryRuntime).toMatchObject({ pending: { attemptId: request.attemptId } });
    if (request.step.operation !== 'recover') {
      expect(request.privateInputs).toEqual({ databaseUrl });
      expect(JSON.stringify(environment.platformBindings)).not.toContain(databaseUrl);
      expect(typeof environment.platformBindings.recoveryRuntimeSecretInputs).toBe('string');
    }
    if (uncertain) return { receipt: { success: false, error: databaseUrl, message: databaseUrl, data: { mutationAttempted: true } } };
    completed = true;
    return { receipt: { success: true, message: databaseUrl }, binding: { provider: 'test-host', evidence: { secretVersion: 'projects/project/secrets/exact-secret/versions/1' } } };
  });
  const factory = { getProviderAdapter: vi.fn(async () => ({ success: true, adapter: { name: 'test-host', recoveryRuntime: { inspect, apply } } })), getDatabaseAdapter: vi.fn(), getStorageAdapter: vi.fn() };
  const context = { spec: { hosting: { provider: 'test-host' }, services: {}, database: { provider: 'test-db', engine: 'postgres' }, backups: { mode: 'daily' } }, project: { id: 'project-id', name: 'app', defaultPlatform: 'test-host', policies: {}, createdAt: now, updatedAt: now }, environment, components: [component], adapterFactory: factory } as unknown as BackupPolicyContext;
  const save = vi.fn(async (patch: RecoveryRuntimeBindingPatch) => { for (const [key, value] of Object.entries(patch)) if (value === undefined) delete environment.platformBindings[key]; else environment.platformBindings[key] = value; });
  const action = async () => planRecoveryRuntime(await observeRecoveryRuntime(context))[0]!;
  return { context, environment, component, step, inspect, apply, save, action, set uncertain(value: boolean) { uncertain = value; } };
}

describe('reviewed backup runtime preparation', () => {
  it('leaves legacy providers without a declared capability or retained attempt alone', async () => {
    const f = fixture(); vi.mocked(providerRegistry.getMetadata).mockReturnValue(undefined);
    expect(await observeRecoveryRuntime(f.context)).toEqual({ provider: 'test-host', state: 'ready' });
    expect(f.context.adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
    f.environment.platformBindings.recoveryRuntime = { provider: 'test-host', evidence: {} };
    await observeRecoveryRuntime(f.context);
    expect(f.context.adapterFactory.getProviderAdapter).toHaveBeenCalledOnce();
  });
  it('plans one exact frontier without resolving or exporting secret values', async () => {
    const f = fixture(); const observed = await observeRecoveryRuntime(f.context); const actions = planRecoveryRuntime(observed);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ resource: { kind: 'service', name: 'backup-runtime', provider: 'test-host' }, requiresConfirm: true, metadata: { operation: 'recoveryRuntimePrepare', step: f.step } });
    expect(JSON.stringify(actions)).not.toContain(databaseUrl);
    expect(f.inspect.mock.calls[0]![0].target.privateInputFingerprints).toEqual({ databaseUrl: createHash('sha256').update(databaseUrl).digest('hex') });
    expect(f.apply).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });

  it('encrypts the exact private input and durably records its attempt before the provider write', async () => {
    const f = fixture(); const action = await f.action();
    const result = await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save });
    expect(result.success).toBe(true); expect(JSON.stringify(result)).not.toContain(databaseUrl);
    expect(f.save).toHaveBeenCalledTimes(2);
    const encrypted = f.save.mock.calls[0]![0].recoveryRuntimeSecretInputs as string;
    expect(getSecretStore().decryptObject<any>(encrypted).inputs).toEqual({ databaseUrl });
    expect(f.environment.platformBindings.recoveryRuntime).toEqual({ provider: 'test-host', evidence: { secretVersion: 'projects/project/secrets/exact-secret/versions/1' } });
    expect(f.environment.platformBindings.recoveryRuntimeSecretInputs).toBeUndefined();
    expect(planRecoveryRuntime(await observeRecoveryRuntime(f.context))).toEqual([]);
  });

  it.each(['missing-confirmation', 'changed-password', 'changed-action', 'noop'])('blocks %s before persistence or provider mutation', async scenario => {
    const f = fixture(); const action = await f.action();
    if (scenario === 'changed-password') f.component.bindings.connectionUrl = databaseUrl + '-rotated';
    if (scenario === 'changed-action') action.metadata!.step = { ...f.step, target: { secret: 'another-secret' } };
    if (scenario === 'noop') action.type = 'noop';
    const result = await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set(scenario === 'missing-confirmation' ? [] : [action.id]), save: f.save });
    expect(result.success).toBe(false); expect(f.apply).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });

  it('does not write to the provider when pending intent persistence fails', async () => {
    const f = fixture(); const action = await f.action(); f.save.mockRejectedValueOnce(new Error(databaseUrl));
    const result = await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save });
    expect(result.success).toBe(false); expect(f.apply).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(databaseUrl);
  });
  it.each([{ mutationAttempted: false }, { mutationAttempted: true, mutationRejected: true }])('restores the prior binding after a new definitely rejected write: %j', async data => {
    const f = fixture(); f.environment.platformBindings.recoveryRuntime = { provider: 'test-host', evidence: { accountUniqueId: 'retained-account' } };
    const action = await f.action();
    f.apply.mockResolvedValueOnce({ receipt: { success: false, message: databaseUrl, data } } as never);
    expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save })).success).toBe(false);
    expect(f.environment.platformBindings.recoveryRuntime).toEqual({ provider: 'test-host', evidence: { accountUniqueId: 'retained-account' } });
    expect(f.environment.platformBindings.recoveryRuntimeSecretInputs).toBeUndefined();
    expect((await f.action()).metadata?.step).toEqual(f.step);
  });

  it('retains an uncertain write and recovers the original attempt without replacing its encrypted inputs', async () => {
    const f = fixture(); f.uncertain = true; let action = await f.action();
    expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save })).success).toBe(false);
    const previous = structuredClone(f.environment.platformBindings);
    action = await f.action(); f.uncertain = false;
    expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set(), save: f.save })).success).toBe(true);
    expect(f.apply.mock.calls[1]![0].attemptId).toBe((previous.recoveryRuntime as any).pending.attemptId);
    expect(f.apply.mock.calls[1]![0].binding.pending.step.operation).toBe('write');
    expect(f.save.mock.calls.filter(call => call[0].recoveryRuntimeSecretInputs)).toHaveLength(1);
  });

  it('preserves encrypted recovery after provider success followed by local commit failure', async () => {
    const f = fixture(); const action = await f.action();
    const original = f.save.getMockImplementation()!; f.save.mockImplementationOnce(original).mockRejectedValueOnce(new Error(databaseUrl));
    expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save })).success).toBe(false);
    expect((f.environment.platformBindings.recoveryRuntime as any).pending).toBeDefined();
    expect(f.environment.platformBindings.recoveryRuntimeSecretInputs).toBeDefined();
    expect(JSON.stringify(planRecoveryRuntime(await observeRecoveryRuntime(f.context)))).not.toContain(databaseUrl);
  });

  it('recovers the original encrypted input after database credential rotation, then allows a separate new review', async () => {
    const f = fixture(); f.uncertain = true; let action = await f.action();
    await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save });
    f.component.bindings.connectionUrl = databaseUrl + '-rotated';
    action = await f.action(); f.uncertain = false;
    expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set(), save: f.save })).success).toBe(true);
    expect(f.apply.mock.calls[1]![0].target.privateInputFingerprints.databaseUrl).toBe(createHash('sha256').update(databaseUrl).digest('hex'));
    expect(f.apply.mock.calls[1]![0].privateInputs.databaseUrl).toBe(databaseUrl);
  });
});


it('removes disabled backup authority through a confirmed persisted reverse frontier without reading database credentials', async () => {
  const f = fixture();
  const retained = { database: { provider: 'test-db', primaryExternalId: 'db', providerScope: { projectId: 'native-project', region: 'region-1' }, resourceIdentity: { instanceId: 'db' } },
    destination: { provider: 'test-storage', externalId: 'archive', instanceScope: { projectId: 'native-project', region: 'region-1' } }, objects: [],
    runnerImage: `ghcr.io/example/helper@sha256:${'a'.repeat(64)}`, credentialHash: 'a'.repeat(64) };
  f.environment.platformBindings.recoveryRuntime = { provider: 'test-host', evidence: { sourceSnapshot: JSON.stringify(retained) } };
  f.context.spec.backups = { mode: 'disabled', reason: 'Remove collection-test recovery authority while retaining archives.' };
  f.context.components = [];
  const step = { component: 'identity', operation: 'destroy', target: { accountUniqueId: '123456789012345678901' }, description: 'Remove the verified dedicated recovery identity.', requiresConfirm: true };
  let removed = false;
  f.inspect.mockImplementation(async (request): Promise<any> => { expect(request.mode).toBe('destroy'); return removed ? { state: 'ready' } : { state: 'action', step }; });
  f.apply.mockImplementation(async (request): Promise<any> => {
    expect(request.mode).toBe('destroy'); expect(request.privateInputs).toBeUndefined();
    expect(f.environment.platformBindings.recoveryRuntime).toMatchObject({ pending: { attemptId: request.attemptId } });
    removed = true; return { receipt: { success: true }, binding: { provider: 'test-host', evidence: { sourceSnapshot: JSON.stringify(retained), removalComplete: 'true' } } };
  });
  const action = await f.action(); expect(action).toMatchObject({ requiresConfirm: true, metadata: { mode: 'destroy' } });
  expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set(), save: f.save })).success).toBe(false);
  expect(f.apply).not.toHaveBeenCalled();
  expect((await applyRecoveryRuntimeAction({ context: f.context, action, confirmedActionIds: new Set([action.id]), save: f.save })).success).toBe(true);
  expect(f.environment.platformBindings.recoveryRuntime).toBeUndefined();
  expect(f.environment.platformBindings.recoveryRuntimeSecretInputs).toBeUndefined();
  expect(targets.resolveManagedBackupTarget).not.toHaveBeenCalled();
});
