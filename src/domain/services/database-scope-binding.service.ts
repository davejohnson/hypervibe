import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { bindingIdentityFingerprint, providerIdentityScopeMatches } from './binding-identity.js';
import { resolveBackupTarget, type BackupPolicyContext } from './backup-policy.service.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from './recovery-source.js';

export const DATABASE_SCOPE_BIND_OPERATION = 'databaseScopeBind';
export const databaseScopeBindingActionId = (provider: string, componentId: string) =>
  `database-scope:${encodeURIComponent(provider)}:${encodeURIComponent(componentId)}`;
export const databaseScopeBindingMetadataSchema = z.object({
  operation: z.literal(DATABASE_SCOPE_BIND_OPERATION),
  componentId: recoveryIdentityStringSchema,
  source: recoverySourceIdentitySchema,
  bindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function isDatabaseScopeBindingAction(action: PlanAction): boolean {
  const parsed = databaseScopeBindingMetadataSchema.safeParse(action.metadata);
  if (!parsed.success) return false;
  const { componentId, source } = parsed.data;
  const registration = providerRegistry.get(action.resource.provider);
  const keys = registration?.inspection?.selectors.database?.scopeKeys ?? [];
  return action.type === 'update' && action.resource.kind === 'database' && action.verified === true
    && action.requiresConfirm === true && action.billable !== true && action.dataBearing !== true
    && !action.dependsOn?.length
    && action.id === databaseScopeBindingActionId(action.resource.provider, componentId)
    && source.provider === action.resource.provider
    && registration?.metadata.lifecycle?.databaseEngines?.includes(action.resource.name) === true
    && registration.metadata.lifecycle.dailyBackups?.database === true
    && keys.length > 0 && keys.every(key => Boolean(source.providerScope[key]));
}

/** Select an existing current identity, never a retained or unfinished create. */
export function currentDatabaseScopeComponent(context: BackupPolicyContext): Component | undefined {
  const desired = context.spec.database;
  if (!desired || !context.environment || context.spec.backups?.mode === 'disabled') return undefined;
  const candidates = context.components.filter(component => component.environmentId === context.environment!.id
    && component.type === desired.engine);
  if (candidates.length !== 1) return undefined;
  const component = candidates[0];
  if (component.bindings.provider !== desired.provider || !component.externalId
    || component.bindings.retainedCleanup === true || component.bindings.provisioningIncomplete === true
    || component.bindings.unresolvedMutation !== undefined) return undefined;
  return component;
}

/** Native backup observation already owns independently verified recovery scope.
 * Do not use the aggregate managed-program observation: it can be derived from
 * the very local bindings this action is repairing.
 */
export async function observeDatabaseBindingSource(context: BackupPolicyContext, component: Component) {
  const registration = providerRegistry.get(String(component.bindings.provider));
  const keys = registration?.inspection?.selectors.database?.scopeKeys ?? [];
  if (!registration?.metadata.lifecycle?.dailyBackups?.database || !keys.length) return undefined;
  try {
    const target = await resolveBackupTarget(context, { kind: 'database', name: component.type,
      provider: String(component.bindings.provider), componentId: component.id, retained: false, bindingState: 'bound' });
    if (target.state !== 'ready') return undefined;
    const observation = await target.observe();
    const parsed = recoverySourceIdentitySchema.safeParse(observation.state === 'known' ? observation.source : undefined);
    if (!parsed.success || parsed.data.provider !== component.bindings.provider
      || parsed.data.primaryExternalId !== component.externalId
      || !keys.every(key => Boolean(parsed.data.providerScope[key]))
      || !providerIdentityScopeMatches({ componentBindings: component.bindings,
        environmentBindings: context.environment?.platformBindings, provider: parsed.data.provider,
        liveScope: parsed.data.providerScope })) return undefined;
    return parsed.data;
  } catch { return undefined; }
}

export async function planDatabaseScopeBinding(context: BackupPolicyContext): Promise<{ actions: PlanAction[]; warnings: string[] }> {
  const component = currentDatabaseScopeComponent(context);
  if (!component || Object.hasOwn(component.bindings, 'providerScope')) return { actions: [], warnings: [] };
  const source = await observeDatabaseBindingSource(context, component);
  if (!source) return { actions: [], warnings: [
    'The current database lacks durable recovery scope and its native recovery source could not be independently verified. No binding repair is authorized.',
  ] };
  const action: PlanAction = { id: databaseScopeBindingActionId(source.provider, component.id), type: 'update',
    resource: { kind: 'database', name: component.type, provider: source.provider }, verified: true, requiresConfirm: true,
    reason: 'Record the independently verified recovery scope of the existing database without changing provider resources.',
    metadata: { operation: DATABASE_SCOPE_BIND_OPERATION, componentId: component.id, source,
      bindingsFingerprint: bindingIdentityFingerprint(component.bindings) } };
  return isDatabaseScopeBindingAction(action) ? { actions: [action], warnings: [] } : { actions: [], warnings: [] };
}
