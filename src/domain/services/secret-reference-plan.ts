import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';
import type { ObservedState } from '../ports/observe.port.js';
import { runtimeSecretReferenceSchema, type RuntimeSecretReference } from '../ports/secret-destination.port.js';
import type { ProjectSecretSpec, ProjectSpec } from '../spec/spec.schema.js';
import { runtimeSecretReferenceIdentity } from './runtime-secret-references.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { Environment } from '../entities/environment.entity.js';
import { parseHostingBindings } from '../ports/hosting.port.js';

export const SECRET_REFERENCE_OPERATION = 'secretReferenceSync';

export const secretReferenceActionMetadataSchema = z.object({
  operation: z.literal(SECRET_REFERENCE_OPERATION), ownership: z.enum(['delegated', 'hypervibe']),
  principal: z.string().min(1), services: z.array(z.string().min(1)).min(1), reference: runtimeSecretReferenceSchema,
  generator: z.literal('random-base64url-32-v1').optional(), generation: z.number().int().positive().optional(),
  replacementPolicy: z.enum(['confirm', 'immutable']).optional(), conflictsWith: z.array(z.string()).optional(),
  /** Conditional creation intent; this is not evidence of provider absence. */
  creationOnlyServices: z.array(z.string().min(1)).min(1).optional(),
  activation: z.literal('application-release').optional(),
  /** Accept metadata only after the exact prepared application release. */
  preparedReleaseBinding: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.services).size !== value.services.length) ctx.addIssue({ code: 'custom', message: 'Duplicate services' });
  if (value.creationOnlyServices && (new Set(value.creationOnlyServices).size !== value.creationOnlyServices.length
    || value.creationOnlyServices.some(name => !value.services.includes(name)))) ctx.addIssue({ code: 'custom', message: 'Invalid creation-only services' });
  if (value.ownership === 'hypervibe' && (value.principal !== 'hypervibe' || !value.generator || !value.generation || !value.replacementPolicy || !value.conflictsWith))
    ctx.addIssue({ code: 'custom', message: 'Generated reference requires generator and lifecycle policy' });
  if (value.ownership === 'delegated' && [value.generator, value.generation, value.replacementPolicy, value.conflictsWith].some(v => v !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Delegated reference cannot claim generated ownership' });
});

export function secretReferencesForEnvironment(spec: ProjectSpec, environmentName: string): Record<string, RuntimeSecretReference> {
  return Object.fromEntries(Object.entries(spec.environments[environmentName]?.secretDestinations ?? {})
    .filter(([, binding]) => binding.version !== undefined)
    .map(([key, binding]) => [key, runtimeSecretReferenceSchema.parse(binding)]));
}

/** Compare native metadata only. Missing observation never means a missing key. */
export function referenceState(observed: ObservedState | null, services: string[], key: string,
  reference: RuntimeSecretReference, knownAbsent = false): 'unknown' | 'missing' | 'matching' | 'replacement' {
  if (knownAbsent) return 'missing';
  if (!observed || observed.partial || !services.length) return 'unknown';
  const target = runtimeSecretReferenceIdentity(reference);
  let missing = false;
  let matching = false;
  for (const name of services) {
    const candidates = observed.services.filter(service => service.name === name);
    if (candidates.length !== 1 || !Array.isArray(candidates[0].envVarKeys)) return 'unknown';
    const service = candidates[0];
    if (isDeepStrictEqual(service.envVarSecretRefs?.[key], target)) matching = true;
    else if (service.envVarKeys.includes(key)) return 'replacement';
    else missing = true;
  }
  return missing ? 'missing' : matching ? 'matching' : 'unknown';
}

export function planSecretReference(input: {
  key: string; slot: ProjectSecretSpec; spec: ProjectSpec; environmentName: string;
  hostingProvider: string; observed: ObservedState | null; suppliedValue?: string;
  environment?: Pick<Environment, 'platformBindings'> | null;
  destinationsAreKnownAbsent?: boolean;
}) {
  const { key, slot } = input;
  const binding = input.spec.environments[input.environmentName].secretDestinations![key];
  const principal = slot.ownership === 'delegated' ? slot.principal : 'hypervibe';
  const services = Object.keys(input.spec.environments[input.environmentName].services).sort();
  const metadata: Record<string, unknown> = { operation: SECRET_REFERENCE_OPERATION,
    ownership: slot.ownership, principal, services,
    ...(slot.ownership === 'hypervibe' ? { generator: slot.generator, generation: slot.generation,
      replacementPolicy: slot.replacementPolicy ?? 'confirm', conflictsWith: slot.conflictsWith ?? [] } : {}) };
  const action: PlanAction = { id: `secret:${key}`, type: 'noop',
    resource: { kind: 'secret', name: key, provider: input.hostingProvider },
    verified: false, reason: '', metadata };
  let required = false;
  let blocked = false;
  if (slot.credential) {
    action.reason = 'Native secret destinations cannot also declare credential lifecycle authority; preserve the reference and remove the unsupported credential declaration.';
    blocked = true;
  } else if (!providerRegistry.getMetadata(input.hostingProvider)?.runtimeSecretReferenceProviders?.includes(binding.destination.provider)) {
    action.reason = `${input.hostingProvider} cannot consume ${binding.destination.provider} references; select supported native hosting`;
    blocked = true;
  } else if (input.suppliedValue !== undefined) {
    action.reason = `Deliver ${key} directly to its secret manager; local value inputs are forbidden for this destination`;
    blocked = true;
  } else if (binding.version === undefined) {
    required = slot.ownership === 'hypervibe' || slot.required !== false;
    action.reason = `${key} needs direct secret manager delivery and an immutable version receipt`;
  } else {
    const parsed = runtimeSecretReferenceSchema.safeParse(binding);
    if (!parsed.success) {
      action.reason = `${key} has no valid immutable secret manager reference`;
      blocked = true;
    } else {
      metadata.reference = parsed.data;
      const hosting = input.environment ? parseHostingBindings(input.environment) : null;
      const creationOnlyServices = hosting?.projectId && hosting.provider === input.hostingProvider
        && input.observed && !input.observed.partial && input.observed.completeness?.services === 'complete'
        && providerRegistry.getMetadata(input.hostingProvider)?.supportsCreateOnlyDeploy === true
        ? services.filter(name => !hosting.services?.[name]?.serviceId && !hosting.services?.[name]?.jobName
          && !input.observed!.services.some(service => service.name === name)) : [];
      if (creationOnlyServices.length) metadata.creationOnlyServices = creationOnlyServices;
      const existingServices = services.filter(name => !creationOnlyServices.includes(name));
      if (!creationOnlyServices.length && existingServices.length && input.observed && !input.observed.partial
        && existingServices.every(name => input.observed!.services.filter(service => service.name === name
          && service.externalId === hosting?.services?.[name]?.serviceId
          && service.runtimeSecretReferenceActivation === 'application-release').length === 1)) metadata.activation = 'application-release';
      const state = existingServices.length ? referenceState(input.observed, existingServices, key, parsed.data, input.destinationsAreKnownAbsent) : 'initializing';
      const prior = input.environment?.platformBindings.secretVersionBindings;
      const priorBinding = prior && typeof prior === 'object' && !Array.isArray(prior)
        ? (prior as Record<string, unknown>)[key] : undefined;
      const conflicts = slot.ownership === 'hypervibe' ? slot.conflictsWith ?? [] : [];
      const immutable = slot.ownership === 'hypervibe' && slot.replacementPolicy === 'immutable';
      const legacy = input.environment?.platformBindings.delegatedEnvBindings;
      const retainedLegacyConflict = legacy !== undefined && (!Array.isArray(legacy)
        || legacy.some(entry => entry && typeof entry === 'object'
          && [key, ...conflicts].includes((entry as Record<string, unknown>).name as string)));
      const retainedNativeConflict = prior && typeof prior === 'object' && !Array.isArray(prior)
        && conflicts.some(conflict => Object.hasOwn(prior, conflict));
      const conflictsUnknownOrPresent = immutable && conflicts.some(conflict => !input.destinationsAreKnownAbsent
        && (!input.observed || input.observed.partial || existingServices.some(name => {
          const service = input.observed!.services.find(candidate => candidate.name === name);
          return !service || !Array.isArray(service.envVarKeys) || service.envVarKeys.includes(conflict);
        })));
      const { creationOnlyServices: _creationIntent, activation: _activation, ...bindingMetadata } = metadata;
      if (immutable && (state === 'replacement' || conflictsUnknownOrPresent || retainedLegacyConflict || retainedNativeConflict
        || priorBinding !== undefined && !isDeepStrictEqual(priorBinding, bindingMetadata))) {
        action.reason = `Immutable secret ${key} has a conflicting reference, lifecycle record, or unverified conflicting key`;
        blocked = true;
      } else if (state === 'unknown') {
        action.reason = `Cannot verify current runtime secret reference for ${key}; new unbound workloads require supported conditional creation`;
        blocked = true;
      } else {
        action.verified = true;
        action.type = state === 'matching' && !creationOnlyServices.length
          && (metadata.activation === undefined || isDeepStrictEqual(priorBinding, bindingMetadata)) ? 'noop' : 'update';
        if (state === 'replacement') action.requiresConfirm = true;
        action.reason = metadata.activation === 'application-release' && action.type !== 'noop'
          ? `Accept ${key} only after the exact managed application release; verify the immutable native reference without a separate write`
          : creationOnlyServices.length ? `Install ${key} only during conditional creation of ${creationOnlyServices.join(', ')}; verify the pinned reference after creation`
          : state === 'matching' ? `${key} matches its pinned secret manager version`
          : `Install the pinned secret manager reference for ${key}`;
      }
    }
  }
  if (required) metadata.inputRequired = true;
  if (blocked) metadata.blockedReason = 'secret_reference_unverified';
  return { action, inputRequired: required ? [{ key, principal, reason: action.reason }] : [],
    blockers: blocked ? [{ key, reason: action.reason }] : [],
    warnings: required || blocked ? [action.reason] : [] };
}

export function isSecretReferenceAction(action: PlanAction): boolean {
  return action.resource.kind === 'secret' && action.metadata?.operation === SECRET_REFERENCE_OPERATION;
}
