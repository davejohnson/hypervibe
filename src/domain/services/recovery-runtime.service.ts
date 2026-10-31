import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import type { BackupPolicyContext } from './backup-policy.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { Receipt } from '../ports/provider.port.js';
import { recoveryRuntimeExecutionTargetSchema, recoveryRuntimeStepSchema, type RecoveryRuntimeBinding, type RecoveryRuntimeObservation, type RecoveryRuntimeTarget } from '../ports/recovery-runtime.port.js';
import { managedBackupRecoveryRuntimeTarget, resolveManagedBackupTarget } from './managed-backup-target.service.js';
import { buildDatabaseEnvVarsFromComponent } from './database-env.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { recoveryRuntimeBindings, runtimeCoordinatesSchema } from './runtime-evidence.js';
import { recoverySourceIdentitySchema } from './recovery-source.js';
import { objectRecoveryIdentitySchema } from './object-recovery-set.service.js';

export const RECOVERY_RUNTIME_OPERATION = 'recoveryRuntimePrepare';
export const isRecoveryRuntimeAction = (action: PlanAction): boolean => action.metadata?.operation === RECOVERY_RUNTIME_OPERATION;
export type RecoveryRuntimePreparationObservation = RecoveryRuntimeObservation & {
  provider: string;
  mode?: 'ensure' | 'destroy';
  /** Internal only: plans carry a hash, never this environment or its bindings. */
  target?: RecoveryRuntimeTarget;
  binding?: RecoveryRuntimeBinding;
};
export interface RecoveryRuntimeBindingPatch {
  recoveryRuntime?: RecoveryRuntimeBinding;
  /** Local encrypted payload; must never enter exported environment bindings. */
  recoveryRuntimeSecretInputs?: string;
}
const unavailable = 'The exact backup worker prerequisites or retained attempt could not be verified.';
const hash = (value: unknown) => canonicalJsonSha256(value);
const secretHash = (value: string) => createHash('sha256').update(value).digest('hex');
const encryptedInputsSchema = z.object({ attemptId: z.string().min(1), inputs: z.record(z.string(), z.string().min(1)) }).strict();
const metadataSchema = z.object({ operation: z.literal(RECOVERY_RUNTIME_OPERATION), mode: z.enum(['ensure', 'destroy']), targetHash: z.string().regex(/^[a-f0-9]{64}$/), bindingHash: z.string().regex(/^[a-f0-9]{64}$/), step: recoveryRuntimeStepSchema }).strict();

const sourceSnapshotSchema = z.object({ database: recoverySourceIdentitySchema, destination: objectRecoveryIdentitySchema,
  objects: z.array(z.object({ name: z.string().min(1), identity: objectRecoveryIdentitySchema }).strict()),
  runnerImage: z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/), credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function retainedTarget(context: BackupPolicyContext, binding: RecoveryRuntimeBinding): RecoveryRuntimeTarget {
  const snapshot = sourceSnapshotSchema.parse(JSON.parse(binding.evidence.sourceSnapshot!));
  return { environment: context.environment!, database: snapshot.database, destination: snapshot.destination, objects: snapshot.objects,
    runnerImage: snapshot.runnerImage, privateInputFingerprints: { databaseUrl: snapshot.credentialHash } };
}

function targetHash(target: RecoveryRuntimeTarget): string {
  const { recoveryRuntime: _binding, recoveryRuntimeSecretInputs: _secretInputs, ...platformBindings } = target.environment.platformBindings;
  return hash({ ...target, environment: { id: target.environment.id, projectId: target.environment.projectId, name: target.environment.name, platformBindings } });
}
function privateValues(context: BackupPolicyContext, target: RecoveryRuntimeTarget, verifyFingerprint = true): Record<string, string> {
  const components = context.components.filter(component => component.environmentId === target.environment.id
    && component.externalId === target.database.primaryExternalId && component.bindings.provider === target.database.provider);
  if (components.length !== 1) throw new Error('The exact backup source component is ambiguous.');
  const databaseUrl = buildDatabaseEnvVarsFromComponent(components[0]!).envVars.DATABASE_URL;
  if (!databaseUrl || verifyFingerprint && secretHash(databaseUrl) !== target.privateInputFingerprints?.databaseUrl) throw new Error('The backup database input changed.');
  return { databaseUrl };
}
function retainedInputs(context: BackupPolicyContext, binding?: RecoveryRuntimeBinding): Record<string, string> | undefined {
  const pending = binding?.pending;
  if (!pending?.step.privateInputKeys?.length) return undefined;
  const encrypted = context.environment?.platformBindings.recoveryRuntimeSecretInputs;
  if (typeof encrypted !== 'string') throw new Error('The retained encrypted backup input is missing.');
  const retained = encryptedInputsSchema.parse(getSecretStore().decryptObject(encrypted));
  if (retained.attemptId !== pending.attemptId || Object.keys(retained.inputs).sort().join('\0') !== [...pending.step.privateInputKeys].sort().join('\0')) throw new Error('The retained backup input identity does not match.');
  return retained.inputs;
}
const protectedInputs = (current: Record<string, string>, retained?: Record<string, string>) => ({ ...current, ...Object.fromEntries(Object.entries(retained ?? {}).map(([key, value]) => [`retained:${key}`, value])) });
function assertValueFree(value: unknown, privateInputs: Record<string, string>) {
  const secrets = Object.values(privateInputs);
  for (const candidate of Object.values(privateInputs)) {
    try { const password = new URL(candidate.replace(/^(postgres(?:ql)?:\/\/[^/]+@)\//, '$1localhost/')).password; if (password) secrets.push(password, decodeURIComponent(password)); } catch { /* The whole selected value remains protected. */ }
  }
  if (JSON.stringify(redactExactValues(value, secrets)) !== JSON.stringify(value)) throw new Error('Private backup input appeared in provider evidence.');
}

/** Observation never resolves new secrets or mutates provider/local state. */
export async function observeRecoveryRuntime(context: BackupPolicyContext): Promise<RecoveryRuntimePreparationObservation> {
  const provider = context.spec.hosting.provider;
  const unknown = (): RecoveryRuntimePreparationObservation => ({ provider, state: 'unknown', reason: unavailable });
  try {
    const raw = context.environment?.platformBindings.recoveryRuntime;
    const binding = recoveryRuntimeBindings(raw);
    if (binding && binding.provider !== provider) return unknown();
    if (!binding && !providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.recoveryRuntime) return { provider, state: 'ready' };
    if (!context.environment || !context.project) return { provider, state: 'waiting', reason: 'Bind the selected environment before preparing backup execution.' };
    const mode = context.spec.backups?.mode === 'disabled' ? 'destroy' : 'ensure';
    if (mode === 'destroy' && !binding) return { provider, state: 'ready' };
    if (mode === 'ensure' && !context.spec.database) return binding ? unknown() : { provider, state: 'ready' };
    const selected = await context.adapterFactory.getProviderAdapter(provider, context.project, undefined, context.environment.name);
    if (!selected.success || selected.adapter?.name !== provider) return unknown();
    const driver = selected.adapter.recoveryRuntime;
    if (!driver) return binding ? unknown() : { provider, state: 'ready' };
    await selected.adapter.configureTarget?.({ region: context.spec.hosting.region });
    let target: RecoveryRuntimeTarget;
    if (mode === 'destroy') target = retainedTarget(context, binding!);
    else {
      const managed = await resolveManagedBackupTarget(context, { allowUnpreparedRuntime: true });
      if (managed.state !== 'ready') return { provider, state: 'waiting', reason: 'The exact backup sources, archive and helper image must be ready before worker preparation.', binding };
      target = managedBackupRecoveryRuntimeTarget(context, managed.target);
    }
    const inputs = mode === 'destroy' ? {} : privateValues(context, target);
    const retained = retainedInputs(context, binding);
    if (retained) target.privateInputFingerprints = { ...target.privateInputFingerprints, ...Object.fromEntries(Object.entries(retained).map(([key, value]) => [key, secretHash(value)])) };
    const result = await driver.inspect({ target, binding, mode });
    assertValueFree(result, protectedInputs(inputs, retained));
    if (result.state === 'action') {
      const step = recoveryRuntimeStepSchema.parse(result.step);
      runtimeCoordinatesSchema.parse(step.target);
      if (new Set(step.privateInputKeys).size !== (step.privateInputKeys?.length ?? 0)
        || step.privateInputKeys?.some(key => !Object.hasOwn(inputs, key))) return unknown();
      if (binding?.pending && step.operation !== 'recover') return { provider, target, binding, state: 'waiting', reason: 'The recorded worker preparation attempt must be recovered before another write.' };
      if (!binding?.pending && step.operation === 'recover') return unknown();
      return { provider, mode, target, binding, state: 'action', step };
    }
    if (result.state === 'ready') {
      if (binding?.pending) return unknown();
      if (mode === 'destroy') return { provider, mode, target, binding, state: 'ready' };
      if (!result.executionTarget) return unknown();
      const executionTarget = recoveryRuntimeExecutionTargetSchema.parse(result.executionTarget);
      if (executionTarget.provider !== provider || executionTarget.worker.provider !== provider) return unknown();
      return { provider, target, binding, state: 'ready', executionTarget };
    }
    return { provider, target, binding, state: result.state === 'waiting' ? 'waiting' : 'unknown', reason: unavailable };
  } catch { return unknown(); }
}

export function planRecoveryRuntime(observation: RecoveryRuntimePreparationObservation): PlanAction[] {
  if (observation.state === 'ready' || observation.state === 'waiting') return [];
  const step = observation.state === 'action' ? observation.step : undefined;
  return [{ id: 'recovery-runtime:backup-runtime', type: 'update', resource: { kind: 'service', provider: observation.provider, name: 'backup-runtime' },
    verified: Boolean(step && observation.target), reason: step?.description ?? unavailable,
    ...(step?.requiresConfirm ? { requiresConfirm: true } : {}),
    ...(step?.billable ? { billable: true } : {}),
    metadata: step && observation.target ? { operation: RECOVERY_RUNTIME_OPERATION, mode: observation.mode ?? 'ensure', targetHash: targetHash(observation.target), bindingHash: hash(observation.binding ?? null), step }
      : { operation: RECOVERY_RUNTIME_OPERATION, blockedReason: 'recovery_runtime_unknown' } }];
}

export async function applyRecoveryRuntimeAction(input: { context: BackupPolicyContext; action: PlanAction; confirmedActionIds: ReadonlySet<string>; save: (patch: RecoveryRuntimeBindingPatch) => void | Promise<void> }): Promise<Receipt> {
  const blocked = (message = unavailable): Receipt => ({ success: false, message });
  try {
    const metadata = metadataSchema.safeParse(input.action.metadata);
    if (!metadata.success || input.action.type !== 'update' || !input.context.environment || !input.context.project) return blocked();
    const observed = await observeRecoveryRuntime(input.context);
    const fresh = planRecoveryRuntime(observed)[0];
    if (observed.state !== 'action' || !observed.target || !fresh?.verified || hash(fresh) !== hash(input.action)
      || (fresh.requiresConfirm && !input.confirmedActionIds.has(fresh.id))) return blocked('Backup preparation changed or its exact approval is missing; re-plan.');
    const selected = await input.context.adapterFactory.getProviderAdapter(observed.provider, input.context.project, undefined, input.context.environment.name);
    if (!selected.success || selected.adapter?.name !== observed.provider || !selected.adapter.recoveryRuntime) return blocked();
    const driver = selected.adapter.recoveryRuntime;
    await selected.adapter.configureTarget?.({ region: input.context.spec.hosting.region });
    const { target, step } = observed;
    const mode = observed.mode ?? 'ensure';
    const priorEncryptedInputs = input.context.environment.platformBindings.recoveryRuntimeSecretInputs;
    let binding: RecoveryRuntimeBinding;
    let attemptId: string;
    let inputs: Record<string, string> | undefined;
    const currentInputs = mode === 'destroy' ? {} : privateValues(input.context, target, !observed.binding?.pending);
    if (observed.binding?.pending) {
      if (step.operation !== 'recover') return blocked('The unresolved backup preparation attempt cannot be repeated.');
      binding = observed.binding;
      attemptId = binding.pending!.attemptId;
      inputs = retainedInputs(input.context, binding);
    } else {
      if (step.operation === 'recover') return blocked();
      attemptId = randomUUID();
      inputs = step.privateInputKeys?.length ? Object.fromEntries(step.privateInputKeys.map(key => [key, currentInputs[key]!])) : undefined;
      binding = { provider: observed.provider, evidence: observed.binding?.evidence ?? {}, pending: { attemptId, step } };
      await input.save({ recoveryRuntime: binding, recoveryRuntimeSecretInputs: inputs ? getSecretStore().encryptObject({ attemptId, inputs }) : undefined });
    }
    const result = await driver.apply({ target, binding, mode, step, attemptId, ...(inputs ? { privateInputs: inputs } : {}) });
    if (!result.receipt.success && !observed.binding?.pending
      && (result.receipt.data?.mutationAttempted === false || result.receipt.data?.mutationRejected === true)) {
      await input.save({ recoveryRuntime: observed.binding, recoveryRuntimeSecretInputs: typeof priorEncryptedInputs === 'string' ? priorEncryptedInputs : undefined });
      return blocked('The provider rejected this preparation step before any change took effect. Re-plan after resolving the access requirement.');
    }
    if (!result.receipt.success || !result.binding) return blocked('Backup preparation remains incomplete. The recorded attempt and encrypted input are retained for recovery.');
    const accepted = recoveryRuntimeBindings(result.binding)!;
    assertValueFree(accepted, protectedInputs(currentInputs, inputs));
    if (accepted.provider !== observed.provider || accepted.pending) return blocked();
    const verified = await driver.inspect({ target, binding: accepted, mode });
    assertValueFree(verified, protectedInputs(currentInputs, inputs));
    if (verified.state === 'unknown' || verified.state === 'waiting'
      || (verified.state === 'action' && hash(recoveryRuntimeStepSchema.parse(verified.step)) === hash(step))) return blocked('The prepared backup resource has not independently converged; its attempt remains retained.');
    if (verified.state === 'ready' && mode === 'ensure') {
      const execution = recoveryRuntimeExecutionTargetSchema.safeParse(verified.executionTarget);
      if (!execution.success || execution.data.provider !== observed.provider || execution.data.worker.provider !== observed.provider) return blocked();
    }
    await input.save({ recoveryRuntime: mode === 'destroy' && verified.state === 'ready' ? undefined : accepted, recoveryRuntimeSecretInputs: undefined });
    return { success: true, message: 'Verified this backup worker prerequisite. Re-plan for its next dependency.' };
  } catch { return blocked('Backup preparation could not be safely completed. Any recorded attempt and encrypted input remain available for recovery.'); }
}
