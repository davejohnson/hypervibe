import { createHash } from 'node:crypto';
import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { bindingIdentityFingerprint } from '../services/binding-identity.js';
import { liveHashesForSecret } from '../services/delegated-secret.service.js';
import type { PlanAction } from './plan.types.js';

/** Scope is persisted authority, not a display filter on a full plan. */
export function isScopedSecretAction(action: PlanAction): boolean {
  const metadata = action.metadata;
  const services = metadata?.services;
  return action.resource.kind === 'secret' && action.id === `secret:${action.resource.name}`
    && ['update', 'noop'].includes(action.type) && action.verified
    && !action.dependsOn?.length && !action.billable && !action.dataBearing && !action.requiresConfirm
    && metadata?.operation === 'delegatedSecretSync' && metadata.inputProvided === true
    && metadata.driftPolicy === 'preserve' && metadata.deferDeployment === true
    && typeof metadata.principal === 'string' && metadata.principal.length > 0
    && typeof metadata.targetFingerprint === 'string' && /^[a-f0-9]{64}$/.test(metadata.targetFingerprint)
    && Array.isArray(services) && services.length > 0
    && services.every(service => typeof service === 'string' && service.length > 0)
    && new Set(services).size === services.length
    && Object.keys(metadata).every(key => ['operation', 'principal', 'inputProvided', 'driftPolicy', 'services', 'deferDeployment', 'targetFingerprint'].includes(key));
}

/** Selected keys and exact hosting identities only; unrelated drift cannot
 * authorize, or require, an infrastructure change in this maintenance plan. */
export function scopedSecretObservation(
  environment: Environment,
  spec: EnvironmentSpec,
  observed: ObservedState | null,
  keys: string[]
): { targetFingerprint: string; fingerprint: string } {
  const binding = parseHostingBindings(environment);
  const separateEnvironment = providerRegistry.getMetadata(spec.hosting.provider)?.orchestration?.environment?.separateResource;
  if (binding.provider !== spec.hosting.provider || !binding.projectId || !observed?.projectExists
    || observed.provider !== binding.provider || observed.projectId !== binding.projectId
    || observed.completeness?.project === 'unknown' || observed.completeness?.environment === 'unknown'
    || (separateEnvironment && (!binding.environmentId || binding.environmentId !== observed.environmentId))
    || !(observed.completeness?.services === 'complete' || !observed.completeness?.services && !observed.partial)) {
    throw new Error('Secret updates require verified existing hosting bindings for this exact environment.');
  }
  const names = Object.keys(spec.services).sort();
  if (!names.length) throw new Error('Secret updates require existing bound services.');
  const services = names.map(name => {
    const bound = binding.services?.[name];
    const id = bound?.serviceId || bound?.jobName;
    const matches = observed.services.filter(service => service.externalId === id);
    if (!id || matches.length !== 1 || matches[0].name !== name || matches[0].identityOnly
      || observed.services.filter(service => service.name === name).length !== 1) {
      throw new Error(`Secret updates require one verified existing binding for ${name}. Run a full plan separately to review binding repairs.`);
    }
    return { name, id, resourceUid: bound.resourceUid, jobName: bound.jobName };
  });
  if (new Set(services.map(service => service.id)).size !== services.length) {
    throw new Error('Secret destinations must have distinct bound service identities.');
  }
  for (const key of keys) {
    if (liveHashesForSecret(observed, names, key).hasUnknownDestination) {
      throw new Error(`Cannot verify the current ${key} configuration on every selected service.`);
    }
  }
  const targetFingerprint = bindingIdentityFingerprint({ provider: binding.provider, projectId: binding.projectId,
    environmentId: binding.environmentId, providerScope: binding.providerScope, services });
  const selected = services.map(({ name, id }) => {
    const live = observed.services.find(service => service.externalId === id)!;
    return { name, keys: [...keys].sort().map(key => ({ key,
      present: live.envVarKeys.includes(key), hash: live.envVarHashes[key] ?? null })) };
  });
  return { targetFingerprint, fingerprint: createHash('sha256')
    .update(JSON.stringify({ targetFingerprint, selected })).digest('hex') };
}
