import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { supportsDatabaseCheckpoint, DatabaseCheckpointObservationError, type DatabaseCheckpointBinding, type DatabaseCheckpointObservationFailure } from '../domain/ports/database-checkpoint.port.js';
import { checkpointBackupAvailable, checkpointIdentityMatches, databaseCheckpointBindings, databaseCheckpointIdentitySchema, databaseCheckpointSourceSchema, databaseCheckpointBackupSchema } from '../domain/services/database-checkpoint.js';
import { assessRecovery } from '../domain/services/recovery-assessment.js';
import { recoveryPointSchema } from '../domain/services/recovery-point.js';
import type { CommandContext } from './context.js';

const blocked = (message: string): ActionResult => ({ success: false, status: 'blocked', message, data: { recovery: assessRecovery() } });
const observationFailure = (error: unknown, stage: DatabaseCheckpointObservationFailure['stage']): DatabaseCheckpointObservationFailure =>
  error instanceof DatabaseCheckpointObservationError
    ? { stage: error.stage, category: error.category, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
    : { stage, category: error instanceof ZodError ? 'invalid_response' : 'unknown' };

export async function applyDatabaseCheckpoint(params: {
  ctx: CommandContext; environment: Environment; component: Component; environmentSpec: EnvironmentSpec;
  action: PlanAction; adapter: unknown; confirmedActionIds?: ReadonlySet<string>;
}): Promise<ActionResult> {
  const { ctx, environment, component, action, adapter } = params;
  const checkpointId = params.environmentSpec.database?.resilience?.checkpoint?.id;
  const reviewedSource = databaseCheckpointIdentitySchema.safeParse(action.metadata?.source);
  if (!checkpointId || action.metadata?.checkpointId !== checkpointId
    || action.id !== `database:${action.resource.provider}:checkpoint:${checkpointId}`
    || !reviewedSource.success || reviewedSource.data.provider !== action.resource.provider
    || action.resource.provider !== params.environmentSpec.database?.provider || action.resource.provider !== component.bindings.provider
    || component.environmentId !== environment.id || reviewedSource.data.primaryExternalId !== component.externalId
    || !supportsDatabaseCheckpoint(adapter)) {
    return blocked('The snapshot intent, provider capability, or reviewed source changed. Re-run hv_plan.');
  }
  if (!['create', 'update', 'noop'].includes(action.type) || !action.verified || action.metadata?.blockedReason
    || (action.type !== 'noop' && (action.requiresConfirm !== true || action.billable !== true || action.dataBearing !== true
    || !params.confirmedActionIds?.has(action.id)))) {
    return blocked('Snapshot creation requires the persisted billable, data-bearing confirmation and exact confirmed action ID.');
  }
  let checkpoints: Record<string, DatabaseCheckpointBinding>;
  try { checkpoints = databaseCheckpointBindings(component.bindings, environment.platformBindings); }
  catch { return blocked('Snapshot recovery state is invalid or conflicting; no provider mutation was attempted.'); }
  let binding = Object.hasOwn(checkpoints, checkpointId) ? checkpoints[checkpointId] : undefined;
  if (Object.entries(checkpoints).some(([id, previous]) => id !== checkpointId && ['attempting', 'running', 'unknown'].includes(previous.state))) {
    return blocked('A previous snapshot request is still pending or uncertain. Resolve it before using a new intent.');
  }
  let source;
  try { source = databaseCheckpointSourceSchema.parse(await adapter.observeCheckpointSource(environment, component)); }
  catch (error) {
    return { ...blocked('The exact database snapshot source and backup inventory could not be verified.'), data: {
      checkpointId, ...(binding?.operationId ? { operationId: binding.operationId } : {}),
      applied: binding ? null : 0, skipped: 0, restoreVerified: false, recovery: assessRecovery(),
      observationFailure: observationFailure(error, 'source_inventory'),
    } };
  }
  if (!checkpointIdentityMatches(reviewedSource.data, source)
    || (binding && !checkpointIdentityMatches(binding.source, source))) {
    return blocked('The snapshot source or provider scope changed after planning. Re-run hv_plan.');
  }
  const persist = (next: DatabaseCheckpointBinding): void => {
    checkpoints = { ...checkpoints, [checkpointId]: next };
    const resilience = component.bindings.resilience as Record<string, unknown> | undefined;
    const stored = ctx.repos.components.update(component.id, { bindings: { ...component.bindings, resilience: { ...resilience, checkpoints } }, externalId: component.externalId ?? undefined });
    if (!stored) throw new Error('The snapshot reservation could not be persisted.');
    binding = next;
    // Safe recovery identities also travel with the repository binding export.
    if (!ctx.repos.environments.updatePlatformBindings(environment.id, { databaseCheckpoints: checkpoints })) {
      throw new Error('The snapshot recovery export could not be persisted.');
    }
  };
  const unresolved = (message: string, status: 'blocked' | 'pending' = 'blocked', failure?: DatabaseCheckpointObservationFailure): ActionResult => ({
    success: false, status, message,
    data: { checkpointId, ...(binding?.operationId ? { operationId: binding.operationId } : {}), applied: null, skipped: 0, restoreVerified: false, recovery: assessRecovery(),
      ...(failure ? { observationFailure: failure } : {}) },
  });
  const receipt = (applied: number, skipped: number): ActionResult => ({
    success: true, message: 'Provider confirmed the named database snapshot; restore has not been tested.',
    data: { checkpointId, applied, skipped, operationId: binding!.operationId, source: binding!.source, backup: binding!.backup, restoreVerified: false, recovery: assessRecovery({ recoveryPoint: 'verified' }),
      recoveryPoint: recoveryPointSchema.parse({ kind: 'snapshot', source: binding!.source, id: binding!.backup!.id,
        createdAt: binding!.backup!.createdAt, expiresAt: binding!.backup!.expiresAt }) },
  });
  if (binding?.state === 'complete') {
    return checkpointBackupAvailable(binding, source.backups) ? receipt(0, 1)
      : blocked('The completed snapshot is missing or expired. This intent cannot create another snapshot.');
  }
  if (action.type === 'noop') return blocked('The noop has no verified completed recovery point. Re-run hv_plan.');
  if (binding && (binding.acknowledged !== true || binding.state === 'error')) {
    return unresolved('The previous snapshot request has an uncertain or failed outcome. It will not be repeated.');
  }
  let created = false;
  if (!binding) {
    if (action.type !== 'create') return blocked('The reviewed snapshot recovery action has no retained request identity. Re-run hv_plan.');
    try {
      persist({ source: databaseCheckpointIdentitySchema.parse({ provider: source.provider, primaryExternalId: source.primaryExternalId, providerScope: source.providerScope, resourceIdentity: source.resourceIdentity }), label: `hv-${checkpointId}-${randomUUID()}`,
        beforeBackupIds: source.backups.map((backup) => backup.id), beforeBackupExternalIds: source.backups.flatMap(backup => backup.externalId ? [backup.externalId] : []), requestStartedAt: new Date().toISOString(), state: 'attempting' });
    } catch {
      return blocked('The durable snapshot reservation could not be saved; no provider mutation was attempted.');
    }
    try {
      const result = await adapter.createCheckpoint(binding!.source, binding!.label);
      if (result.acknowledged !== true || (result.operationId !== undefined && (typeof result.operationId !== 'string' || !result.operationId.trim()))) {
        persist({ ...binding!, state: 'unknown' });
        return unresolved('The provider did not acknowledge the snapshot request. The request is retained and will not be repeated.');
      }
      persist({ ...binding!, state: 'running', acknowledged: true, ...(result.operationId ? { operationId: result.operationId } : {}) });
      created = true;
    } catch {
      // The pre-write reservation remains authoritative even if the later receipt cannot be saved.
      try { persist({ ...binding!, state: 'unknown' }); } catch { /* Preserve the original reservation. */ }
      return unresolved('Snapshot request acknowledgement is uncertain. Recovery state is retained; do not repeat the request.');
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let observing = true;
    try {
      const observed = await adapter.observeCheckpointRequest(environment, component, binding!);
      if (observed.state === 'failed' || observed.state === 'unknown') {
        observing = false;
        if (observed.state === 'failed') persist({ ...binding!, state: 'error' });
        return unresolved('The recorded snapshot request failed or its completion is unknown. No second snapshot was requested.');
      }
      if (observed.state === 'complete') {
        const completedSource = databaseCheckpointIdentitySchema.parse(observed.source);
        const backup = databaseCheckpointBackupSchema.parse(observed.backup);
        if (!checkpointIdentityMatches(binding!.source, completedSource)
          || binding!.beforeBackupIds.includes(backup.id)
          || (backup.expiresAt !== null && Date.parse(backup.expiresAt) <= Date.now())) {
          return unresolved('The completed recovery point does not match the retained source and new snapshot request.');
        }
        observing = false;
        persist({ ...binding!, state: 'complete', backup, verifiedAt: new Date().toISOString() });
        return receipt(created ? 1 : 0, created ? 0 : 1);
      }
      if (observed.state !== 'pending') throw new DatabaseCheckpointObservationError('operation_status', 'invalid_response');
    } catch (error) {
      return unresolved('Snapshot completion could not be observed. The recorded request will not be repeated.', 'blocked',
        observing ? observationFailure(error, 'operation_status') : undefined);
    }
    if (attempt < 2) await delay(1000);
  }
  return unresolved('The exact snapshot request is still pending. Re-plan to observe this request; no second snapshot will be created.', 'pending');
}
