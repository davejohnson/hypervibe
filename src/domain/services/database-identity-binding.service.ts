import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ObservedState } from '../ports/observe.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { BackupPolicyContext } from './backup-policy.service.js';
import { primaryDatabaseRecordState } from './database-scope-binding.service.js';
import { recoveryIdentityStringSchema } from './recovery-source.js';

/**
 * Records which provider resource is the environment's primary database in the
 * committed bindings. Identity is proven by an exact, scoped hosting
 * observation, so it is independent of backup policy: an environment that
 * deliberately has no backups still gets a committed database identity.
 */
export const DATABASE_IDENTITY_RECORD_OPERATION = 'databaseIdentityRecord';
export const databaseIdentityRecordActionId = (provider: string, componentId: string) =>
  `database-identity:${encodeURIComponent(provider)}:${encodeURIComponent(componentId)}`;
export const databaseIdentityRecordMetadataSchema = z.object({
  operation: z.literal(DATABASE_IDENTITY_RECORD_OPERATION),
  componentId: recoveryIdentityStringSchema,
  externalId: recoveryIdentityStringSchema,
  projectId: recoveryIdentityStringSchema,
  environmentId: recoveryIdentityStringSchema,
}).strict();
export type DatabaseIdentityRecordMetadata = z.infer<typeof databaseIdentityRecordMetadataSchema>;

export function isDatabaseIdentityRecordAction(action: PlanAction): boolean {
  const parsed = databaseIdentityRecordMetadataSchema.safeParse(action.metadata);
  if (!parsed.success) return false;
  const registration = providerRegistry.get(action.resource.provider);
  return action.type === 'update' && action.resource.kind === 'database' && action.verified === true
    && action.requiresConfirm === true && action.billable !== true && action.dataBearing !== true
    && !action.dependsOn?.length
    && action.id === databaseIdentityRecordActionId(action.resource.provider, parsed.data.componentId)
    && registration?.metadata.lifecycle?.databaseEngines?.includes(action.resource.name) === true;
}

/** The current managed database identity, regardless of backup policy or recorded scope. */
export function currentDatabaseIdentityComponent(context: Pick<BackupPolicyContext, 'spec' | 'environment' | 'components'>): Component | undefined {
  const desired = context.spec.database;
  if (!desired || !context.environment) return undefined;
  const candidates = context.components.filter(component => component.environmentId === context.environment!.id
    && component.type === desired.engine);
  if (candidates.length !== 1) return undefined;
  const component = candidates[0];
  if (component.bindings.provider !== desired.provider || !component.externalId
    || component.bindings.retainedCleanup === true || component.bindings.provisioningIncomplete === true
    || component.bindings.unresolvedMutation !== undefined) return undefined;
  return component;
}

/**
 * Exactly one resource with the component's identity in a complete, exact-scope
 * inventory of this environment. Names and images are never evidence.
 */
export function observedDatabaseIdentity(observed: ObservedState | undefined, environment: Environment,
  component: Component): { projectId: string; environmentId: string } | undefined {
  const bindings = environment.platformBindings;
  if (!observed || observed.provider !== component.bindings.provider || !observed.projectExists
    || !observed.projectId || !observed.environmentId
    // Plan observation defaults unreported project/environment completeness to complete.
    || (observed.completeness?.project ?? 'complete') !== 'complete' || (observed.completeness?.environment ?? 'complete') !== 'complete'
    || observed.completeness?.services !== 'complete' || observed.completeness?.databases === 'unknown'
    || bindings.projectId !== observed.projectId || bindings.environmentId !== observed.environmentId) return undefined;
  const candidates = [...observed.services, ...(observed.databases ?? [])]
    .filter(resource => resource.externalId === component.externalId);
  return candidates.length === 1 ? { projectId: observed.projectId, environmentId: observed.environmentId } : undefined;
}

export function planDatabaseIdentityRecord(context: Pick<BackupPolicyContext, 'spec' | 'environment' | 'components'>,
  observed: ObservedState | undefined): { actions: PlanAction[]; warnings: string[] } {
  const component = currentDatabaseIdentityComponent(context);
  if (!component || !context.environment) return { actions: [], warnings: [] };
  const state = primaryDatabaseRecordState(context.environment.platformBindings, component);
  if (state === 'recorded') return { actions: [], warnings: [] };
  if (state === 'conflict') return { actions: [], warnings: [
    'The committed primary database identity names a different database than the one Hypervibe manages. It was left unchanged; review databaseTopology.primary in .hypervibe/bindings.json.',
  ] };
  const scope = observedDatabaseIdentity(observed, context.environment, component);
  if (!scope) return { actions: [], warnings: [
    'The managed database identity is not recorded in .hypervibe/bindings.json and could not be confirmed in a complete inventory of this environment. No identity was recorded.',
  ] };
  const provider = String(component.bindings.provider);
  const action: PlanAction = { id: databaseIdentityRecordActionId(provider, component.id), type: 'update',
    resource: { kind: 'database', name: component.type, provider }, verified: true, requiresConfirm: true,
    reason: 'Record the existing database identity in .hypervibe/bindings.json without changing provider resources.',
    metadata: { operation: DATABASE_IDENTITY_RECORD_OPERATION, componentId: component.id,
      externalId: component.externalId!, ...scope } };
  return isDatabaseIdentityRecordAction(action) ? { actions: [action], warnings: [] } : { actions: [], warnings: [] };
}
