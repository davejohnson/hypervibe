import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import { preparedHostingBindingsSchema, preparedHostingMarkerSchema, preparedHostingReleaseEvidenceSchema,
  preparedDirectReleaseEvidenceSchema, type PreparedHostingMarker, type PreparedHostingObservation, type PreparedHostingReleaseEvidence } from '../ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { observeManagedReleaseEvidence } from './managed-release-observation.js';
import type { PreparedHostingDescriptor } from '../ports/hosting-prepared.port.js';
import type { CloudDeploymentConnectionV1 } from '../ports/cloud-deployment.port.js';
import type { LocalPreparedHostingReceiptV1 } from '../ports/local-holding-preparation.port.js';
import { resolveBootstrapRuntimeInputs } from './bootstrap-runtime-inputs.js';
import { deriveHypervibeSecretValues } from './hypervibe-secret-value.js';
import { specToBootstrapParams } from '../spec/spec-bootstrap.js';
import { completePreparedDirectRelease, preparedReleaseAttempts } from './prepared-direct-release.service.js';

export function describePreparedHosting(receipt: CloudDeploymentConnectionV1 | LocalPreparedHostingReceiptV1): PreparedHostingDescriptor {
  if (!receipt.preparedResources) throw new Error('Native prepared resources are unavailable.');
  return { installationId: receipt.installationId, planDigest: receipt.planDigest, receiptDigest: canonicalJsonSha256(receipt),
    appId: receipt.appId, environment: receipt.environment, provider: receipt.provider, hostingProvider: receipt.hostingProvider,
    nativeScope: receipt.nativeScope, deployment: receipt.deployment, preparedResources: receipt.preparedResources,
    runtimeIdentities: receipt.runtimeIdentities };
}

export const HOSTING_PREPARED_OPERATION = 'hostingPreparedBindings';
const unavailable = 'Installer-prepared hosting identity or pending release could not be verified. No binding or workload change is authorized.';
export const preparedBindingFingerprint = canonicalJsonSha256;
export const preparedHostingObservationSchema = z.object({ state: z.literal('verified'), bindings: preparedHostingBindingsSchema,
  preparation: preparedHostingMarkerSchema, directReleaseEvidence: z.array(preparedDirectReleaseEvidenceSchema).min(1).max(50).optional() }).strict();
export const preparedHostingActionMetadataSchema = z.object({ operation: z.literal(HOSTING_PREPARED_OPERATION),
  proof: preparedHostingObservationSchema.extend({ releaseEvidence: preparedHostingReleaseEvidenceSchema.optional() }),
  previousPreparation: preparedHostingMarkerSchema.optional(), beforeBindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  afterBindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => Boolean(value.proof.releaseEvidence || value.proof.directReleaseEvidence) === Boolean(value.previousPreparation));
export function isPreparedHostingAction(action: PlanAction): boolean {
  const meta = preparedHostingActionMetadataSchema.safeParse(action.metadata);
  return meta.success && action.type === 'update' && action.verified && action.requiresConfirm === true
    && action.billable !== true && action.dataBearing !== true && !action.dependsOn?.length && action.resource.kind === 'project'
    && action.resource.provider === meta.data.proof.bindings.provider && action.id === `hosting-prepared:${action.resource.provider}:${action.resource.name}`;
}
function pending(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(pending);
  return Object.entries(value).some(([key, child]) => key === 'pending' && child != null || pending(child));
}
/** Pending native attempts and retained provider transitions cannot be bypassed by metadata binding. */
export function assertPreparedBindingRecoveryClear(environment: Environment): void {
  const b = environment.platformBindings;
  if (b.previousHosting || b.serviceCreateRecovery && Object.keys(b.serviceCreateRecovery as object).length
    || pending(b.runtimeIdentities) || pending(b.storageRuntimeAccess)) throw new Error(unavailable);
}
export function mergePreparedHostingBindings(environment: Environment, spec: EnvironmentSpec, proof: PreparedHostingObservation): Record<string, unknown> {
  assertPreparedBindingRecoveryClear(environment);
  const before = environment.platformBindings, next = proof.bindings;
  if (next.provider !== spec.hosting.provider || before.provider !== next.provider || before.projectId !== next.projectId
    || before.environmentId && before.environmentId !== next.environmentId
    || JSON.stringify(Object.keys(next.services).sort()) !== JSON.stringify(Object.keys(spec.services).sort())
    || proof.preparation.pendingFirstRelease.some(name => !next.services[name])) throw new Error(unavailable);
  const oldScope = before.providerScope;
  if (oldScope && (typeof oldScope !== 'object' || Array.isArray(oldScope)
    || Object.entries(oldScope).some(([key, value]) => next.providerScope[key] !== value))) throw new Error(unavailable);
  const previous = before.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(before.preparedHosting);
  if (previous) {
    for (const key of ['installationId', 'planDigest', 'receiptDigest'] as const)
      if (previous[key] !== proof.preparation[key]) throw new Error(unavailable);
    if (proof.preparation.pendingFirstRelease.some(name => !previous.pendingFirstRelease.includes(name))) throw new Error(unavailable);
  } else if (proof.preparation.pendingFirstRelease.length !== Object.keys(next.services).length) throw new Error(unavailable);
  const services = z.record(z.string(), z.record(z.string(), z.unknown())).parse(before.services ?? {});
  if (Object.keys(services).some(name => !next.services[name])) throw new Error(unavailable);
  for (const [name, service] of Object.entries(next.services)) {
    if (service.workloadKind !== spec.services[name]?.workloadKind) throw new Error(unavailable);
    const old = services[name];
    if (old) for (const key of ['serviceId', 'resourceUid', 'resourceType', 'jobName'] as const)
      if (old[key] !== undefined && old[key] !== service[key]) throw new Error(unavailable);
    services[name] = { ...old, ...service };
  }
  let completed = before;
  for (const evidence of proof.directReleaseEvidence ?? []) {
    completed = completePreparedDirectRelease({ ...environment, platformBindings: completed }, evidence);
    if (next.services[evidence.target.workload]?.imageUri !== evidence.target.imageUri) throw new Error(unavailable);
  }
  return { ...completed, ...next, services, preparedHosting: proof.preparation };
}
export function validatePreparedManagedInputs(spec: ProjectSpec, environmentName: string, values: Record<string, string> = {}): Record<string, string> {
  const environmentSpec = spec.environments[environmentName];
  const slots = Object.fromEntries(Object.entries(spec.secrets).filter(([key, slot]) => slot.environments.includes(environmentName) && !environmentSpec?.secretDestinations?.[key]));
  const generated = deriveHypervibeSecretValues(spec, environmentName);
  if (Object.entries(values).some(([key, value]) => !slots[key] || typeof value !== 'string' || !value)
    || Object.entries(generated).some(([key, value]) => values[key] !== value)
    || Object.entries(slots).some(([key, slot]) => slot.ownership === 'delegated' && slot.required && !values[key]))
    throw new Error('Prepared runtime inputs must match the exact accepted managed secret declarations and stable generated values.');
  return values;
}

type PreparedHostingInput = { environment: Environment; environmentSpec: EnvironmentSpec; hosting: Pick<IHostingAdapter, 'preparedHosting'>; project?: Project; spec?: ProjectSpec;
  managedSecretValues?: Record<string, string>; onObservation?(proof: PreparedHostingObservation): void; reviewedRelease?: PreparedHostingReleaseEvidence; reviewedPreparation?: PreparedHostingMarker };
export async function observePreparedHosting(input: PreparedHostingInput): Promise<PreparedHostingObservation & { releaseEvidence?: PreparedHostingReleaseEvidence }> {
  try {
    assertPreparedBindingRecoveryClear(input.environment);
    if (!input.hosting.preparedHosting) throw new Error();
    const previous = input.environment.platformBindings.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(input.environment.platformBindings.preparedHosting);
    // The saved prior marker keeps an export-only retry on the original workflow
    // semantic input after SQLite has already recorded completed first releases.
    const releaseEnvironment = input.reviewedPreparation ? { ...input.environment,
      platformBindings: { ...input.environment.platformBindings, preparedHosting: input.reviewedPreparation } } : input.environment;
    const releaseEvidence = input.project && input.spec && !input.environment.platformBindings.localPreparedHosting
      && (!input.environment.platformBindings.preparedDirectReleaseAttempts || input.reviewedRelease)
      && (previous?.pendingFirstRelease.length || input.reviewedRelease)
      ? await observeManagedReleaseEvidence({ project: input.project, spec: input.spec, environment: releaseEnvironment, reviewed: input.reviewedRelease }) : undefined;
    if (input.reviewedRelease && !releaseEvidence) throw new Error();
    const preserveReviewedRuntime = Boolean(input.environment.platformBindings.localPreparedHosting
      && (Object.values(preparedReleaseAttempts(input.environment)).some(attempt => ['attempted', 'uncertain'].includes(attempt.status))
        || input.reviewedPreparation));
    let runtimeEnvVarsByService: Record<string, Record<string, string>> | undefined;
    if (input.environment.platformBindings.localPreparedHosting && input.project && input.spec && previous?.pendingFirstRelease.length && !preserveReviewedRuntime) {
      const params = await resolveBootstrapRuntimeInputs({ project: input.project, environment: input.environment, environmentSpec: input.environmentSpec,
        params: specToBootstrapParams(input.project.name, input.environment.name, input.environmentSpec, input.spec.runtime),
        managedSecretValues: validatePreparedManagedInputs(input.spec, input.environment.name, input.managedSecretValues) });
      runtimeEnvVarsByService = Object.fromEntries(Object.keys(input.environmentSpec.services).map(name => [name,
        { ...params.queueEnvVars, ...params.envVars, ...params.envVarsByService?.[name] }]));
    }
    const result = preparedHostingObservationSchema.parse(await input.hosting.preparedHosting.inspect({ environment: input.environment,
      environmentSpec: input.environmentSpec, ...(preserveReviewedRuntime ? { preserveReviewedRuntime: true } : {}), ...(runtimeEnvVarsByService ? { runtimeEnvVarsByService } : {}), ...(releaseEvidence ? { releaseEvidence } : {}) }));
    mergePreparedHostingBindings(input.environment, input.environmentSpec, result);
    const completesRelease = previous?.pendingFirstRelease.some(name => !result.preparation.pendingFirstRelease.includes(name));
    if (completesRelease && !releaseEvidence && !result.directReleaseEvidence?.length) throw new Error();
    return { ...result, ...((completesRelease || input.reviewedRelease) && releaseEvidence ? { releaseEvidence } : {}) };
  } catch { throw new Error(unavailable); }
}
export async function planPreparedHosting(input: PreparedHostingInput): Promise<PlanAction | null> {
  if (!input.hosting.preparedHosting) {
    if (input.environment.platformBindings.preparedHosting !== undefined) throw new Error(unavailable);
    return null;
  }
  if (!input.environment.platformBindings.projectId) return null;
  const proof = await observePreparedHosting(input);
  input.onObservation?.(proof);
  const after = mergePreparedHostingBindings(input.environment, input.environmentSpec, proof);
  if (isDeepStrictEqual(input.environment.platformBindings, after)) return null;
  return { id: `hosting-prepared:${input.environmentSpec.hosting.provider}:${input.environment.name}`, type: 'update', verified: true, requiresConfirm: true,
    resource: { kind: 'project', provider: input.environmentSpec.hosting.provider, name: input.environment.name },
    reason: 'Record the exact administrator-prepared hosting resources and pending first releases without changing cloud resources.',
    metadata: { operation: HOSTING_PREPARED_OPERATION, proof,
      ...(proof.releaseEvidence || proof.directReleaseEvidence ? { previousPreparation: preparedHostingMarkerSchema.parse(input.environment.platformBindings.preparedHosting) } : {}),
      beforeBindingsFingerprint: preparedBindingFingerprint(input.environment.platformBindings),
      afterBindingsFingerprint: preparedBindingFingerprint(after) } };
}
