import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJsonSha256 as hash } from '../../lib/canonical-json.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { managedRecoveryTaskCheckpointSchema } from '../ports/managed-recovery-task.port.js';
import type { BackupPolicyContext } from './backup-policy.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import { managedBackupTargetSchema, managedBackupTargetHash, openRecoveryStorage, resolveManagedBackupTarget } from './managed-backup-target.service.js';
import { observeRecoveryExecution } from './recovery-set-health.service.js';

export const MANUAL_BACKUP_OPERATION = 'manualBackupRun';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const manualBackupRequestId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const manualBackupRecordSchema = z.object({ version: z.literal(1), requestId: manualBackupRequestId,
  executionId: z.string().uuid(), target: managedBackupTargetSchema, targetHash: digest,
  checkpoint: managedRecoveryTaskCheckpointSchema.optional(), jobId: z.string().min(1).max(1000).optional(), complete: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.targetHash !== managedBackupTargetHash(value.target)
    || value.checkpoint && value.checkpoint.provider !== value.target.hosting.provider
    || value.complete && (!value.jobId || value.checkpoint?.phase !== 'complete' || value.checkpoint.terminal?.status !== 'succeeded'))
    ctx.addIssue({ code: 'custom', message: 'Manual backup completion lacks exact terminal and cleanup evidence.' });
});
export const manualBackupRecordsSchema = z.record(manualBackupRequestId, manualBackupRecordSchema).superRefine((values, ctx) => {
  if (Object.entries(values).some(([key, value]) => value.requestId !== key)) ctx.addIssue({ code: 'custom', message: 'Manual backup request identity differs.' });
});
export type ManualBackupRecord = z.infer<typeof manualBackupRecordSchema>;
export const manualBackupMetadataSchema = z.object({ operation: z.literal(MANUAL_BACKUP_OPERATION), requestId: manualBackupRequestId,
  targetHash: digest, recordHash: digest, executionId: z.string().uuid() }).strict();
export function manualBackupActionValid(action: PlanAction): boolean {
  const metadata = manualBackupMetadataSchema.safeParse(action.metadata);
  return metadata.success && action.id === `manual-backup:${metadata.data.requestId}` && action.resource.kind === 'database'
    && action.resource.name === 'manual-backup' && Boolean(action.resource.provider) && !action.dependsOn?.length
    && (action.type === 'noop' || action.type === 'update' && action.requiresConfirm === true && action.billable === true && action.dataBearing === true);
}
export function manualBackupExecutionId(environmentId: string, requestId: string) {
  const value = createHash('sha256').update(`manual-backup\0${environmentId}\0${manualBackupRequestId.parse(requestId)}`).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export function manualBackupFingerprint(context: BackupPolicyContext) {
  return context.environment && hash({ projectId: context.project?.id, environmentId: context.environment.id,
    bindings: context.environment.platformBindings, components: context.components.map(row => ({ id: row.id, externalId: row.externalId, bindings: row.bindings })) });
}
export async function planManualBackup(context: BackupPolicyContext): Promise<{ action: PlanAction; record?: ManualBackupRecord }> {
  const requestId = context.spec.backups?.mode === 'daily' ? context.spec.backups.run?.id : undefined;
  const blocked = (reason: string) => ({ action: { id: `manual-backup:${requestId ?? 'missing'}`, type: 'update' as const,
    resource: { kind: 'database' as const, name: 'manual-backup', provider: context.spec.hosting.provider }, verified: false,
    reason, metadata: { operation: MANUAL_BACKUP_OPERATION, blockedReason: 'manual_backup_unverified' } } });
  try {
    if (!requestId || !context.environment || !context.project) return blocked('A one-use request and exact existing environment are required.');
    if (!providerRegistry.getMetadata(context.spec.hosting.provider)?.lifecycle?.hosting?.recoveryTasks?.durableProgress)
      return blocked('This hosting provider has no reviewed restart-safe manual backup execution capability.');
    const records = manualBackupRecordsSchema.parse(context.environment.platformBindings.manualRecovery ?? {});
    if (Object.entries(records).some(([key, value]) => key !== requestId && !value.complete && !(value.checkpoint?.phase === 'complete' && value.checkpoint.terminal?.status === 'failed')))
      return blocked('A previous manual backup still requires exact recovery or cleanup; restore its request id before new work.');
    const target = await resolveManagedBackupTarget(context, { localAuthority: true });
    if (target.state !== 'ready') return blocked(target.issues.join(' '));
    if (!target.target.database || !target.target.executionTarget || target.target.automation)
      return blocked('Manual execution requires the prepared native database, archive and dedicated backup identity.');
    const connected = await context.adapterFactory.getProviderAdapter(context.spec.hosting.provider, context.project, undefined, context.environment.name);
    if (!connected.success || connected.adapter?.name !== context.spec.hosting.provider
      || !providerRegistry.connectionProviders(context.spec.hosting.provider).includes(connected.connectionProvider ?? ''))
      return blocked('Manual backup execution requires the current verified local cloud connection; a hosted deployment grant does not authorize this operation.');
    const executionId = manualBackupExecutionId(context.environment.id, requestId);
    const retained = records[requestId];
    if (retained && (retained.targetHash !== target.contractHash || retained.executionId !== executionId))
      return blocked('The one-use request already belongs to another exact source, helper or runtime; preserve its recovery record.');
    if (retained?.complete) {
      const adapter = await context.adapterFactory.getStorageAdapter(target.target.destination.identity.provider, context.project, context.environment.name);
      if (!adapter.success || !adapter.adapter) return blocked('The retained backup archive cannot be observed.');
      const archive = await openRecoveryStorage(adapter.adapter, context.environment, target.target.destination.identity);
      try { await observeRecoveryExecution({ archive, target: retained.target, setId: executionId, jobId: retained.jobId }); }
      finally { archive.destroy(); }
    }
    const record = retained ?? { version: 1 as const, requestId, executionId, target: target.target, targetHash: target.contractHash };
    return { record, action: { id: `manual-backup:${requestId}`, type: retained?.complete ? 'noop' : 'update',
      resource: { kind: 'database', name: 'manual-backup', provider: context.spec.hosting.provider }, verified: true,
      ...(retained?.complete ? {} : { requiresConfirm: true, billable: true, dataBearing: true }),
      reason: retained?.complete ? 'This exact backup, isolated logical restore and temporary job cleanup remain verified.'
        : `Back up ${target.target.database.source.provider} ${target.target.database.source.primaryExternalId} (${JSON.stringify(target.target.database.source.providerScope)}) into ${target.target.destination.identity.provider} ${target.target.destination.identity.externalId}; verify an isolated logical restore and remove only this temporary job. The pinned helper uses the existing dedicated backup identity. Compute, archive storage and API usage are billable; all prior archives remain.`,
      metadata: { operation: MANUAL_BACKUP_OPERATION, requestId, executionId, targetHash: target.contractHash, recordHash: hash(retained ?? null) } } };
  } catch { return blocked('The exact manual backup source, retained operation or archive evidence could not be verified. No new backup is authorized.'); }
}
