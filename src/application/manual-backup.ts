import { SpecStore } from '../domain/spec/spec.store.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { managedBackupProviderNames } from '../domain/services/managed-backup-target.service.js';
import { isDeepStrictEqual } from 'node:util';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { Receipt } from '../domain/ports/provider.port.js';
import { managedRecoveryTaskCheckpointSchema } from '../domain/ports/managed-recovery-task.port.js';
import { manualBackupRecordsSchema, manualBackupRecordSchema, planManualBackup } from '../domain/services/manual-backup.service.js';
import { executeLocalManagedBackup } from './managed-backup.js';

/** The generic executor holds the environment lock; complete-binding CAS also
 * refuses concurrent writes from other processes or stale callback closures. */
export async function applyManualBackup(input: { ctx: CommandContext; project: Project; environmentId: string;
  spec: EnvironmentSpec; specRevision: number; action: PlanAction; confirmed: ReadonlySet<string> }): Promise<Receipt & { status?: 'pending' | 'blocked' }> {
  const blocked = (message: string): Receipt & { status: 'blocked' } => ({ success: false, status: 'blocked', message });
  let attempted = false;
  try {
    const { ctx } = input;
    const environment = ctx.repos.environments.findById(input.environmentId);
    if (!environment || environment.projectId !== input.project.id || !input.confirmed.has(input.action.id))
      return blocked('The exact one-use backup action must be confirmed for this environment.');
    let expected = structuredClone(environment.platformBindings);
    const context = { project: input.project, environment, spec: input.spec,
      components: ctx.repos.components.findByEnvironmentId(environment.id), adapterFactory: ctx.adapterFactory };
    const fresh = await planManualBackup(context);
    if (!fresh.record || !fresh.action.verified || fresh.action.type !== 'update' || !isDeepStrictEqual(fresh.action, input.action))
      return blocked('The manual backup source or recorded attempt changed. Re-plan without replaying native writes.');
    let record = fresh.record;
    const componentSnapshot = (rows: typeof context.components) => rows.map(row => ({ id: row.id, externalId: row.externalId, bindings: row.bindings }));
    const initialComponents = componentSnapshot(context.components);
    const connectionProviders = [...new Set(managedBackupProviderNames(record.target).flatMap(provider => providerRegistry.connectionProviders(provider)))].sort();
    const connectionSnapshot = () => connectionProviders.map(provider => {
      const connection = ctx.repos.connections.findBestMatchFromHints(provider, getProjectScopeHints(input.project, environment.name));
      return connection ? { id: connection.id, status: connection.status, encrypted: connection.credentialsEncrypted } : null;
    });
    const initialConnections = connectionSnapshot();
    const assertCurrent = () => {
      if (new SpecStore().get(input.project)?.revision !== input.specRevision
        || !isDeepStrictEqual(initialComponents, componentSnapshot(ctx.repos.components.findByEnvironmentId(environment.id)))
        || !isDeepStrictEqual(initialConnections, connectionSnapshot())) throw Error('The current backup source, desired request or connection authority changed.');
    };
    const component = context.components.find(row => row.id === record.target.database?.componentId);
    if (!component) return blocked('The exact existing database component is unavailable.');
    const save = (next: typeof record) => {
      assertCurrent();
      const records = manualBackupRecordsSchema.parse(expected.manualRecovery ?? {});
      const parsed = manualBackupRecordSchema.parse(next);
      const saved = ctx.repos.environments.compareAndSwapPlatformBindings(environment.id, expected,
        { ...expected, manualRecovery: { ...records, [record.requestId]: parsed } });
      if (!saved) throw Error('Manual backup authority changed concurrently. Retain the recorded attempt.');
      expected = structuredClone(saved.platformBindings);
      const reloaded = ctx.repos.environments.findById(environment.id);
      if (!reloaded || !isDeepStrictEqual(reloaded.platformBindings, expected)) throw Error('Manual backup progress readback changed.');
      record = manualBackupRecordsSchema.parse(reloaded.platformBindings.manualRecovery)[record.requestId];
      return record;
    };
    // Reserve the request permanently before opening the worker execution path.
    save(record); attempted = true;
    const result = await executeLocalManagedBackup({ target: record.target, environment: { ...environment, platformBindings: expected },
      executionId: record.executionId, databaseComponent: component,
      beforeCompletion: jobId => {
        assertCurrent();
        if (!isDeepStrictEqual(ctx.repos.environments.findById(environment.id)?.platformBindings, expected)) throw Error('Backup completion authority changed.');
        if (record.jobId && record.jobId !== jobId) throw Error('Backup completion changed its exact native execution.');
        if (!record.jobId) save({ ...record, jobId });
      },
      adapter: async provider => {
        const selected = await ctx.adapterFactory.getProviderAdapter(provider, input.project, undefined, environment.name);
        if (!selected.success || !selected.adapter || !providerRegistry.connectionProviders(provider).includes(selected.connectionProvider ?? '')) throw Error('Current scoped local connection unavailable.');
        return selected.adapter;
      }, lifecycle: { state: record.checkpoint,
        persist: async checkpoint => save({ ...record, checkpoint: managedRecoveryTaskCheckpointSchema.parse(checkpoint) }).checkpoint! } });
    if (result.status !== 'healthy' || result.setId !== record.executionId || record.checkpoint?.phase !== 'complete'
      || record.checkpoint.terminal?.status !== 'succeeded')
      return { success: false, status: 'pending', message: 'The backup, isolated logical restore or native cleanup is not yet verified. Retain this request for recovery.' };
    save({ ...record, complete: true });
    return { success: true, message: 'The exact backup and isolated logical restore are verified; its temporary job is removed and all prior archives remain.',
      data: { executionId: record.executionId, restoreVerified: true, cleanupVerified: true, retainedArchivesPreserved: true } };
  } catch {
    try {
      const retained = manualBackupRecordsSchema.parse(input.ctx.repos.environments.findById(input.environmentId)?.platformBindings.manualRecovery ?? {})[String(input.action.metadata?.requestId)];
      if (retained?.checkpoint?.phase === 'complete' && retained.checkpoint.terminal?.status === 'failed')
        return { success: false, message: 'The backup helper failed and its temporary resources were removed. This request will not run again; preserve partial archives and review a new request only after fixing the failure.', data: { cleanupVerified: true } };
    } catch { /* Preserve malformed or unavailable evidence; never infer absence. */ }
    return { success: false, status: attempted ? 'pending' : 'blocked', message: attempted
      ? 'This manual backup remains recorded and incomplete. Re-plan this same request to inspect its exact progress; do not issue another backup.'
      : 'The exact manual backup authority could not be verified. No new execution is authorized.' };
  }
}
