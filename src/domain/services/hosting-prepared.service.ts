import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import { preparedHostingBindingsSchema, preparedHostingMarkerSchema, preparedHostingReleaseEvidenceSchema,
  type PreparedHostingMarker, type PreparedHostingObservation, type PreparedHostingReleaseEvidence } from '../ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { observeManagedReleaseEvidence } from './managed-release-observation.js';

export const HOSTING_PREPARED_OPERATION = 'hostingPreparedBindings';
const unavailable = 'Installer-prepared hosting identity or pending release could not be verified. No binding or workload change is authorized.';
export const preparedBindingFingerprint = canonicalJsonSha256;
export const preparedHostingObservationSchema = z.object({ state: z.literal('verified'), bindings: preparedHostingBindingsSchema,
  preparation: preparedHostingMarkerSchema }).strict();
export const preparedHostingActionMetadataSchema = z.object({ operation: z.literal(HOSTING_PREPARED_OPERATION),
  proof: preparedHostingObservationSchema.extend({ releaseEvidence: preparedHostingReleaseEvidenceSchema.optional() }),
  previousPreparation: preparedHostingMarkerSchema.optional(), beforeBindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  afterBindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => Boolean(value.proof.releaseEvidence) === Boolean(value.previousPreparation));
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
  return { ...before, ...next, services, preparedHosting: proof.preparation };
}
type PreparedHostingInput = { environment: Environment; environmentSpec: EnvironmentSpec; hosting: Pick<IHostingAdapter, 'preparedHosting'>; project?: Project; spec?: ProjectSpec;
  reviewedRelease?: PreparedHostingReleaseEvidence; reviewedPreparation?: PreparedHostingMarker };
export async function observePreparedHosting(input: PreparedHostingInput): Promise<PreparedHostingObservation & { releaseEvidence?: PreparedHostingReleaseEvidence }> {
  try {
    assertPreparedBindingRecoveryClear(input.environment);
    if (!input.hosting.preparedHosting) throw new Error();
    const previous = input.environment.platformBindings.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(input.environment.platformBindings.preparedHosting);
    // The saved prior marker keeps an export-only retry on the original workflow
    // semantic input after SQLite has already recorded completed first releases.
    const releaseEnvironment = input.reviewedPreparation ? { ...input.environment,
      platformBindings: { ...input.environment.platformBindings, preparedHosting: input.reviewedPreparation } } : input.environment;
    const releaseEvidence = input.project && input.spec && (previous?.pendingFirstRelease.length || input.reviewedRelease)
      ? await observeManagedReleaseEvidence({ project: input.project, spec: input.spec, environment: releaseEnvironment, reviewed: input.reviewedRelease }) : undefined;
    if (input.reviewedRelease && !releaseEvidence) throw new Error();
    const result = preparedHostingObservationSchema.parse(await input.hosting.preparedHosting.inspect({ environment: input.environment,
      environmentSpec: input.environmentSpec, ...(releaseEvidence ? { releaseEvidence } : {}) }));
    mergePreparedHostingBindings(input.environment, input.environmentSpec, result);
    const completesRelease = previous?.pendingFirstRelease.some(name => !result.preparation.pendingFirstRelease.includes(name));
    if (completesRelease && !releaseEvidence) throw new Error();
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
  const after = mergePreparedHostingBindings(input.environment, input.environmentSpec, proof);
  if (isDeepStrictEqual(input.environment.platformBindings, after)) return null;
  return { id: `hosting-prepared:${input.environmentSpec.hosting.provider}:${input.environment.name}`, type: 'update', verified: true, requiresConfirm: true,
    resource: { kind: 'project', provider: input.environmentSpec.hosting.provider, name: input.environment.name },
    reason: 'Record the exact administrator-prepared hosting resources and pending first releases without changing cloud resources.',
    metadata: { operation: HOSTING_PREPARED_OPERATION, proof,
      ...(proof.releaseEvidence ? { previousPreparation: preparedHostingMarkerSchema.parse(input.environment.platformBindings.preparedHosting) } : {}),
      beforeBindingsFingerprint: preparedBindingFingerprint(input.environment.platformBindings),
      afterBindingsFingerprint: preparedBindingFingerprint(after) } };
}
