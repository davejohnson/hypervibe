import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';
import type { BackupCoverageItem } from './backup-policy.service.js';
import { recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';
import { backupPolicyAttempts } from './backup-policy-attempts.js';

export const DAILY_BACKUP_OPERATION = 'dailyBackupConfigure';
export const backupPolicyActionId = (resource: { kind: string; provider: string; name: string }) =>
  `backup-policy:${resource.kind}:${encodeURIComponent(resource.provider)}:${encodeURIComponent(resource.name)}`;

export const backupPolicyActionMetadataSchema = z.object({
  operation: z.literal(DAILY_BACKUP_OPERATION),
  item: z.object({
    resource: z.object({ kind: z.enum(['database', 'volume', 'storage']), name: z.string().min(1), provider: z.string().min(1),
      retained: z.boolean(), bindingState: z.literal('bound'), componentId: z.string().min(1).optional() }).strict(),
    state: z.enum(['needs-configuration', 'scheduled']),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('database'), componentId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('volume'), name: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('storage'), name: z.string().min(1) }).strict(),
    ]),
  }).strict(),
  source: recoverySourceIdentitySchema,
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  preservationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Provider configuration is only one part of recovery evidence. */
export function planBackupPolicy(coverage: { policy: { mode: 'daily' | 'disabled' }; resources: BackupCoverageItem[] },
  options: { explicitDatabaseBackups?: boolean; attempts?: unknown } = {}) {
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  let attempts: ReturnType<typeof backupPolicyAttempts>;
  try { attempts = backupPolicyAttempts(options.attempts); }
  catch {
    return { actions, warnings: ['Daily backup policy attempts are malformed or conflicting. No policy write is authorized until their source identities are reconciled.'],
      complete: false, backupObserved: 'unchecked' as const, restoreTested: 'unchecked' as const };
  }
  for (const item of coverage.resources) {
    if (item.state === 'disabled') continue;
    const id = backupPolicyActionId(item.resource);
    const recovery = Object.hasOwn(attempts, id);
    if (recovery && item.observation?.state === 'known'
      && (!recoverySourceIdentityMatches(attempts[id].source, item.observation.source)
        || attempts[id].preservationFingerprint !== item.observation.preservationFingerprint)) {
      warnings.push(`The unresolved daily backup policy write for ${item.resource.name} has a different source or unverified preservation of existing protection. Reconcile its retained evidence before another write.`);
      continue;
    }
    if (item.state !== 'scheduled') warnings.push(`Daily backups for ${item.resource.kind} ${item.resource.name} (${item.resource.provider}): ${item.reason ?? item.state}.`);
    if (recovery && item.state !== 'scheduled') {
      warnings.push(`A previous daily backup policy write for ${item.resource.name} has an uncertain outcome. Observe and resolve that attempt before another write; Hypervibe will not retry it automatically.`);
      continue;
    }
    if (coverage.policy.mode === 'disabled' || !item.target || item.observation?.state !== 'known'
      || item.resource.bindingState !== 'bound' || (item.state !== 'needs-configuration' && !recovery)) continue;
    // The existing explicit resilience contract owns its backup mutation.
    if (item.resource.kind === 'database' && !item.resource.retained && options.explicitDatabaseBackups) continue;
    const { reason: _reason, ...resource } = item.resource;
    const metadata = backupPolicyActionMetadataSchema.safeParse({ operation: DAILY_BACKUP_OPERATION,
      item: { resource, state: item.state, target: item.target }, source: item.observation.source,
      policyFingerprint: item.observation.policyFingerprint, preservationFingerprint: item.observation.preservationFingerprint });
    if (!metadata.success) { warnings.push(`Daily backup identity for ${item.resource.name} is incomplete; no mutation is authorized.`); continue; }
    actions.push({ id, type: 'update', resource: { kind: resource.kind, provider: resource.provider, name: resource.name },
      verified: true, requiresConfirm: true, billable: true, dataBearing: true,
      reason: recovery ? 'Verify the observed daily schedule after an uncertain write; do not repeat the write.'
        : 'Enable daily protection while preserving existing retention, stronger schedules and PITR.',
      metadata: metadata.data });
  }
  const visible = new Set(coverage.resources.map(item => backupPolicyActionId(item.resource)));
  for (const id of Object.keys(attempts)) {
    if (!visible.has(id)) warnings.push(`Unresolved daily backup policy attempt ${id} has no current resource binding. Its retained source must be reconciled before coverage is complete.`);
  }
  return { actions, warnings,
    complete: Object.keys(attempts).length === 0 && coverage.resources.every(item => item.state === 'scheduled' || item.state === 'disabled'),
    backupObserved: 'unchecked' as const, restoreTested: 'unchecked' as const };
}
