import { isDeepStrictEqual } from 'node:util';
import type { Project } from '../domain/entities/project.entity.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import { resolvePlanActionAuthority } from '../domain/plan/action-authority.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { backupPolicyAttempts, type BackupPolicyAttempt } from '../domain/services/backup-policy-attempts.js';
import { backupPolicyActionMetadataSchema } from '../domain/services/backup-policy-plan.service.js';
import { configureBackupPolicyItem, observeBackupPolicy, type BackupCoverageItem, type BackupPolicyContext } from '../domain/services/backup-policy.service.js';
import { recoverySourceIdentityMatches } from '../domain/services/recovery-source.js';
import type { CommandContext } from './context.js';

const evidence = { backupObserved: 'unchecked', restoreTested: 'unchecked' } as const;
const blocked = (message: string, applied: number | null = 0, skipped = 0): ActionResult => ({
  success: false, status: 'blocked', message, data: { applied, skipped, ...evidence },
});

export async function applyBackupPolicyAction(params: {
  ctx: CommandContext;
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
  confirmedActionIds?: ReadonlySet<string>;
}): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  const parsed = backupPolicyActionMetadataSchema.safeParse(action.metadata);
  if (!parsed.success || resolvePlanActionAuthority(action)?.capability !== 'backup-policy.configure'
    || !params.confirmedActionIds?.has(action.id)) {
    return blocked('Daily backup policy changes require the exact reviewed, billable, data-bearing action and its confirmation. Re-run hv_plan.');
  }
  const reviewed = parsed.data;
  if (environmentSpec.backups?.mode === 'disabled'
    || (action.resource.kind === 'database' && !reviewed.item.resource.retained && environmentSpec.database?.resilience?.backups)) {
    return blocked('The current spec excludes this default policy action or gives an explicit database policy ownership. Re-run hv_plan.');
  }
  const load = (): BackupPolicyContext | undefined => {
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    return environment ? { spec: environmentSpec, environment, project, adapterFactory: ctx.adapterFactory,
      components: ctx.repos.components.findByEnvironmentId(environment.id) } : undefined;
  };
  const matches = (item: BackupCoverageItem): boolean => {
    const { reason: _reason, ...resource } = item.resource;
    return isDeepStrictEqual(resource, reviewed.item.resource) && isDeepStrictEqual(item.target, reviewed.item.target);
  };
  let context = load();
  if (!context?.environment) return blocked('The reviewed environment is no longer tracked. Re-run hv_plan.');
  let attempts: Record<string, BackupPolicyAttempt>;
  try { attempts = backupPolicyAttempts(context.environment.platformBindings.backupPolicyAttempts); }
  catch { return blocked('Daily backup policy recovery state is malformed. Resolve it before attempting another write.', null); }
  const pending = attempts[action.id];
  let item: BackupCoverageItem | undefined;
  try { item = (await observeBackupPolicy(context)).resources.find(matches); }
  catch { return blocked('The exact daily backup policy could not be observed.', pending ? null : 0); }
  if (!item || item.observation?.state !== 'known'
    || !recoverySourceIdentityMatches(item.observation.source, reviewed.source)
    || (pending && !recoverySourceIdentityMatches(item.observation.source, pending.source))) {
    return blocked('The reviewed backup source, durable target or observed policy changed or is unknown. Re-run hv_plan.', pending ? null : 0);
  }
  if (pending && (item.observation.preservationFingerprint !== pending.preservationFingerprint
    || item.observation.preservationFingerprint !== reviewed.preservationFingerprint)) {
    return blocked('The previous backup policy write has no verified preservation of existing protection. Its reservation is retained; review the native policy before further work.', null);
  }

  const clear = (): void => {
    const current = load();
    if (!current?.environment) throw new Error('Environment missing');
    const currentAttempts = backupPolicyAttempts(current.environment.platformBindings.backupPolicyAttempts);
    const retained = currentAttempts[action.id];
    const expected = pending ?? { source: reviewed.source, policyFingerprint: reviewed.policyFingerprint, preservationFingerprint: reviewed.preservationFingerprint };
    if (retained && (!recoverySourceIdentityMatches(retained.source, expected.source)
      || retained.policyFingerprint !== expected.policyFingerprint
      || retained.preservationFingerprint !== expected.preservationFingerprint)) throw new Error('Attempt changed');
    delete currentAttempts[action.id];
    if (!ctx.repos.environments.updatePlatformBindings(current.environment.id, { backupPolicyAttempts: currentAttempts })) {
      throw new Error('Recovery state was not persisted');
    }
  };
  const success = (applied: number, skipped: number): ActionResult => ({ success: true,
    message: 'The exact resource has an observed daily backup policy; recovery-point availability and restore remain unchecked.',
    data: { applied, skipped, policyConfigured: true, ...evidence },
  });
  if (item.observation.daily) {
    if (pending) {
      try { clear(); }
      catch { return blocked('Daily policy is observed, but its retained write marker could not be reconciled.', 0, 1); }
    }
    return success(0, 1);
  }
  if (pending) return blocked('A previous daily backup policy write remains uncertain. Observation has not confirmed it; no automatic retry is allowed.', null);
  if (reviewed.item.state !== 'needs-configuration' || item.observation.policyFingerprint !== reviewed.policyFingerprint
    || item.observation.preservationFingerprint !== reviewed.preservationFingerprint) {
    return blocked('The effective backup policy changed after review. Re-run hv_plan before changing it.');
  }

  // Re-load local identities after observation. The shared dispatcher derives the
  // provider target again, and the adapter independently rechecks source/policy.
  context = load();
  if (!context?.environment) return blocked('The reviewed environment disappeared before its backup write.');
  try {
    attempts = backupPolicyAttempts(context.environment.platformBindings.backupPolicyAttempts);
    if (Object.hasOwn(attempts, action.id)) return blocked('A daily backup write was reserved during observation; no second write is allowed.', null);
    const reservation = { source: reviewed.source, policyFingerprint: reviewed.policyFingerprint, preservationFingerprint: reviewed.preservationFingerprint };
    const saved = ctx.repos.environments.updatePlatformBindings(context.environment.id, {
      backupPolicyAttempts: { ...attempts, [action.id]: reservation },
    });
    if (!saved || !isDeepStrictEqual(backupPolicyAttempts(saved.platformBindings.backupPolicyAttempts)[action.id], reservation)) {
      return blocked('The durable daily backup write reservation could not be saved; no provider mutation was attempted.');
    }
    context = { ...context, environment: saved };
  } catch {
    return blocked('The durable daily backup write reservation could not be saved; no provider mutation was attempted.');
  }
  let receipt;
  try { receipt = await configureBackupPolicyItem({ ...context, item, reviewed }); }
  catch { return blocked('Daily backup write outcome is uncertain. Its reservation is retained and will not be retried.', null); }
  const data = receipt.data;
  const unattempted = data?.mutationAttempted === false;
  const unattemptedSkipped = Number.isInteger(data?.skipped) && Number(data?.skipped) >= 0
    && Number(data?.skipped) <= 1 ? Number(data?.skipped) : 0;
  if (unattempted) {
    try { clear(); }
    catch { return blocked('The adapter made no policy change, but its retained reservation could not be cleared.', 0, 1); }
  }
  if (!receipt.success) return blocked(unattempted
    ? 'The daily backup policy was not changed; its reviewed target or policy requires a new plan.'
    : 'Daily backup write completion is uncertain. Its reservation is retained and will not be retried.', unattempted ? 0 : null, unattempted ? unattemptedSkipped : 0);

  let after: BackupCoverageItem | undefined;
  try {
    const fresh = load();
    after = fresh ? (await observeBackupPolicy(fresh)).resources.find(matches) : undefined;
  } catch { /* An acknowledgement is not observed convergence. */ }
  if (after?.observation?.state !== 'known' || !after.observation.daily
    || !recoverySourceIdentityMatches(after.observation.source, reviewed.source)
    || after.observation.preservationFingerprint !== reviewed.preservationFingerprint) {
    return blocked('The provider acknowledged the policy but exact-source daily scheduling and preservation of existing protection could not be verified. Observe again; do not repeat the write.', unattempted ? 0 : null, unattempted ? unattemptedSkipped : 0);
  }
  const applied = data?.applied; const skipped = data?.skipped;
  if (!Number.isInteger(applied) || !Number.isInteger(skipped) || Number(applied) < 0 || Number(skipped) < 0
    || Number(applied) + Number(skipped) !== 1 || (unattempted && applied !== 0)) {
    return blocked('Daily policy is observed, but the adapter did not provide valid applied/skipped counts. Retained recovery state requires observation.', unattempted ? 0 : null);
  }
  if (!unattempted) {
    try { clear(); }
    catch { return blocked('Daily policy is observed, but its write reservation could not be reconciled.', Number(applied), Number(skipped)); }
  }
  return success(Number(applied), Number(skipped));
}
