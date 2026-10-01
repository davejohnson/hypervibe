import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { observeBackupPolicy } from '../../domain/services/backup-policy.service.js';
import { planBackupPolicy } from '../../domain/services/backup-policy-plan.service.js';
import type { DailyBackupObservation } from '../../domain/ports/daily-backup.port.js';
import { applyBackupPolicyAction } from '../apply-backup-policy.js';

describe('reviewed daily backup policy application', () => {
  let directory: string; let ctx: CommandContext; let disabled: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-daily-backup-apply-'));
    disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC; process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => {
    vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
    if (disabled === undefined) delete process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    else process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled;
  });

  async function fixture(kind: 'database' | 'volume' = 'database') {
    const project = ctx.repos.projects.create({ name: 'daily-backup-test', defaultPlatform: 'railway' });
    const target = { projectId: 'rp', environmentId: 'prod', serviceId: 'web', mountPath: '/data' };
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { appliedSpecHash: 'reviewed-deployment', ...(kind === 'volume' ? {
        serviceVolumes: { web: { provider: 'railway', state: 'bound', target, externalId: 'volume' } },
      } : {}) } });
    const component = kind === 'database' ? ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'db', bindings: { provider: 'railway' } }) : undefined;
    const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'railway' },
      services: kind === 'volume' ? { web: { volume: { mountPath: '/data' } } } : {},
      ...(kind === 'database' ? { database: { provider: 'railway' } } : {}) });
    const source = { provider: 'railway', primaryExternalId: kind === 'database' ? 'db' : 'web',
      providerScope: { projectId: 'rp', environmentId: 'prod' }, resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'vi' } };
    let observation: DailyBackupObservation = { state: 'known', source, daily: false, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' };
    const observe = vi.fn(async () => observation);
    const configureDaily = vi.fn(async () => {
      expect(ctx.repos.environments.findById(environment.id)!.platformBindings.backupPolicyAttempts)
        .toEqual({ [action.id]: { source, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64) } });
      observation = { state: 'known', source, daily: true, policyFingerprint: 'b'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' };
      return { success: true, message: 'Scheduled', data: { applied: 1, skipped: 0, mutationAttempted: true } };
    });
    const adapter = { name: 'railway', ...(kind === 'database' ? { dailyBackups: { observe, configureDaily } }
      : { serviceVolumes: { dailyBackups: { observe, configureDaily } } }) };
    vi.spyOn(ctx.adapterFactory, kind === 'database' ? 'getDatabaseAdapter' : 'getProviderAdapter')
      .mockResolvedValue({ success: true, adapter: adapter as never });
    const coverage = await observeBackupPolicy({ spec: environmentSpec, environment, components: component ? [component] : [], project, adapterFactory: ctx.adapterFactory });
    const action = planBackupPolicy(coverage).actions[0];
    expect(action).toBeDefined();
    const apply = (changes: Record<string, unknown> = {}) => applyBackupPolicyAction({ ctx, project,
      environmentName: environment.name, environmentSpec, action, confirmedActionIds: new Set([action.id]), ...changes });
    const reserve = (value: unknown = { source, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64) }) =>
      ctx.repos.environments.updatePlatformBindings(environment.id, { backupPolicyAttempts: { [action.id]: value } });
    return { project, environment, component, environmentSpec, source, action, observe, configureDaily, apply, reserve,
      current: () => ctx.repos.environments.findById(environment.id)!,
      setObservation: (next: DailyBackupObservation) => { observation = next; } };
  }

  it.each(['database', 'volume'] as const)('persists a reservation before the %s write, verifies convergence, and preserves deployment state', async kind => {
    const f = await fixture(kind);
    expect(await f.apply()).toMatchObject({ success: true, data: { applied: 1, skipped: 0, backupObserved: 'unchecked', restoreTested: 'unchecked' } });
    expect(f.configureDaily).toHaveBeenCalledTimes(1);
    expect(f.current().platformBindings).toMatchObject({ appliedSpecHash: 'reviewed-deployment', backupPolicyAttempts: {} });
  });

  it.each(['missing confirmation', 'wrong id', 'wrong target', 'unverified', 'not billable', 'unsupported provider'])(
    'rejects %s before any provider policy write', async failure => {
      const f = await fixture(); const action = structuredClone(f.action);
      if (failure === 'wrong id') action.id += ':forged';
      if (failure === 'wrong target') (action.metadata!.item as { target: { componentId: string } }).target.componentId = 'replacement';
      if (failure === 'unverified') action.verified = false;
      if (failure === 'not billable') action.billable = false;
      if (failure === 'unsupported provider') action.resource.provider = 'supabase';
      const result = await f.apply({ action, ...(failure === 'missing confirmation' ? { confirmedActionIds: new Set() } : {}) });
      expect(result).toMatchObject({ success: false, status: 'blocked', data: { applied: 0 } });
      expect(f.configureDaily).not.toHaveBeenCalled();
    });

  it.each(['disabled', 'retained descriptor changed', 'stale fingerprint', 'source changed', 'unknown read', 'malformed attempt'])(
    'rejects %s without turning uncertain state into mutation authority', async failure => {
      const f = await fixture(); let spec = f.environmentSpec;
      if (failure === 'disabled') spec = { ...spec, backups: { mode: 'disabled', reason: 'Disposable data' } };
      if (failure === 'retained descriptor changed') spec = { ...spec, database: undefined };
      if (failure === 'stale fingerprint') f.setObservation({ state: 'known', source: f.source, daily: false, policyFingerprint: 'c'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' });
      if (failure === 'source changed') f.setObservation({ state: 'known', source: { ...f.source, primaryExternalId: 'replacement' }, daily: false, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' });
      if (failure === 'unknown read') f.setObservation({ state: 'unknown', reason: 'Unavailable' });
      if (failure === 'malformed attempt') f.reserve({ uncertain: true });
      expect(await f.apply({ environmentSpec: spec })).toMatchObject({ success: false, status: 'blocked' });
      expect(f.configureDaily).not.toHaveBeenCalled();
    });

  it('does not call the adapter when the durable reservation cannot be saved', async () => {
    const f = await fixture(); vi.spyOn(ctx.repos.environments, 'updatePlatformBindings').mockReturnValue(null);
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 0 } });
    expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it('retains an uncertain write across a fresh context and never automatically repeats it', async () => {
    const f = await fixture(); f.configureDaily.mockRejectedValue(new Error('private transport detail'));
    expect(await f.apply()).toMatchObject({ success: false, data: { applied: null, skipped: 0 } });
    expect(f.current().platformBindings.backupPolicyAttempts).toHaveProperty(f.action.id);
    ctx = createCommandContext();
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: null } });
    expect(f.configureDaily).toHaveBeenCalledTimes(1);
  });

  it('resolves a retained attempt through fresh exact-source daily observation without a second write', async () => {
    const f = await fixture(); f.reserve();
    f.setObservation({ state: 'known', source: f.source, daily: true, policyFingerprint: 'b'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' });
    expect(await f.apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(f.configureDaily).not.toHaveBeenCalled();
    expect(f.current().platformBindings.backupPolicyAttempts).toEqual({});
  });

  it('cannot clear an earlier attempt by observing a different source already scheduled', async () => {
    const f = await fixture(); f.reserve({ source: { ...f.source, primaryExternalId: 'earlier-db' }, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'e'.repeat(64) });
    f.setObservation({ state: 'known', source: f.source, daily: true, policyFingerprint: 'b'.repeat(64), preservationFingerprint: 'e'.repeat(64), mechanism: 'snapshot' });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(f.current().platformBindings.backupPolicyAttempts).toHaveProperty(f.action.id);
    expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it('cannot clear an uncertain write after daily becomes enabled but stronger protection changed', async () => {
    const f = await fixture(); f.reserve();
    f.setObservation({ state: 'known', source: f.source, daily: true, policyFingerprint: 'b'.repeat(64),
      preservationFingerprint: 'f'.repeat(64), mechanism: 'snapshot' });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: null } });
    expect(f.current().platformBindings.backupPolicyAttempts).toHaveProperty(f.action.id);
    expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it('rejects a preservation mismatch immediately before writing even if the full policy hash repeats', async () => {
    const f = await fixture();
    f.setObservation({ state: 'known', source: f.source, daily: false, policyFingerprint: 'a'.repeat(64),
      preservationFingerprint: 'f'.repeat(64), mechanism: 'snapshot' });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 0 } });
    expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it.each([0, 1])('clears only an explicitly unattempted failed write, preserving its skipped count %s and unrelated reservations', async skipped => {
    const f = await fixture();
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { backupPolicyAttempts: {
      'backup-policy:volume:railway:other': { source: f.source, policyFingerprint: 'd'.repeat(64), preservationFingerprint: 'e'.repeat(64) },
    } });
    f.configureDaily.mockResolvedValue({ success: false, message: 'Changed before write', data: { applied: 0, skipped, mutationAttempted: false } });
    expect(await f.apply()).toMatchObject({ success: false, data: { applied: 0, skipped } });
    expect(f.current().platformBindings.backupPolicyAttempts).toEqual({
      'backup-policy:volume:railway:other': { source: f.source, policyFingerprint: 'd'.repeat(64), preservationFingerprint: 'e'.repeat(64) },
    });
  });

  it.each(['not scheduled', 'changed source', 'changed stronger protection', 'unknown'])('retains a success acknowledgement when post-write policy is %s', async result => {
    const f = await fixture();
    f.configureDaily.mockImplementation(async () => {
      f.setObservation(result === 'unknown' ? { state: 'unknown', reason: 'Unavailable' } : {
        state: 'known', source: result === 'changed source' ? { ...f.source, primaryExternalId: 'replacement' } : f.source,
        daily: result !== 'not scheduled', policyFingerprint: 'b'.repeat(64),
        preservationFingerprint: result === 'changed stronger protection' ? 'f'.repeat(64) : 'e'.repeat(64), mechanism: 'snapshot',
      });
      return { success: true, message: 'Accepted', data: { applied: 1, skipped: 0, mutationAttempted: true } };
    });
    expect(await f.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(f.current().platformBindings.backupPolicyAttempts).toHaveProperty(f.action.id);
  });
});
