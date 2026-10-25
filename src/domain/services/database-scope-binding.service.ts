import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Component } from '../entities/component.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { bindingIdentityFingerprint, providerIdentityScopeMatches } from './binding-identity.js';
import { resolveBackupTarget, type BackupPolicyContext } from './backup-policy.service.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from './recovery-source.js';

export const DATABASE_SCOPE_BIND_OPERATION = 'databaseScopeBind';
export const databaseScopeBindingActionId = (provider: string, componentId: string) =>
  `database-scope:${encodeURIComponent(provider)}:${encodeURIComponent(componentId)}`;
export const databaseRuntimeReferenceSchema = z.object({
  directUrlVariable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const databaseScopeBindingMetadataSchema = z.object({
  operation: z.literal(DATABASE_SCOPE_BIND_OPERATION),
  componentId: recoveryIdentityStringSchema,
  source: recoverySourceIdentitySchema,
  bindingsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeReference: databaseRuntimeReferenceSchema.optional(),
  /** Frozen nonconflicting legacy scope; apply may fill only its absent keys. */
  priorProviderScope: recoverySourceIdentitySchema.shape.providerScope.optional(),
}).strict();

/** Ignore only fields this reviewed repair can add, including export-only retry. */
export function databaseScopeBindingsFingerprint(bindings: Record<string, unknown>, runtimeReference = false): string {
  return bindingIdentityFingerprint(Object.fromEntries(Object.entries(bindings)
    .filter(([key]) => key !== 'providerScope' && (!runtimeReference || key !== 'directUrlVariable'))));
}

export async function observeDatabaseRuntimeReference(context: BackupPolicyContext, component: Component) {
  const unknown = { state: 'unknown' as const };
  if (!context.environment) return unknown;
  const registration = providerRegistry.get(String(component.bindings.provider));
  if (!registration?.metadata.lifecycle?.dailyBackups?.database
    || !registration.inspection?.selectors.database?.scopeKeys?.length) return { state: 'unsupported' as const };
  try {
    const result = await context.adapterFactory.getDatabaseAdapter(String(component.bindings.provider), context.project);
    if (!result.success || !result.adapter || result.adapter.name !== component.bindings.provider) return unknown;
    if (!result.adapter.observeRuntimeReferenceBinding) return { state: 'unsupported' as const };
    const observed = await result.adapter.observeRuntimeReferenceBinding(context.environment, component);
    if (observed.state !== 'known') return unknown;
    const { state: _state, ...reference } = observed;
    const parsed = databaseRuntimeReferenceSchema.safeParse(reference);
    return parsed.success ? { state: 'known' as const, reference: parsed.data } : unknown;
  } catch { return unknown; }
}

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
  // Identity reconciliation is independent of whether backup management is enabled.
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

/** The committed primary database identity hosted inspection and recovery read. */
export function committedPrimaryDatabase(environmentBindings: Record<string, unknown> | undefined): { provider: string; externalId: string } | undefined {
  const topology = environmentBindings?.databaseTopology;
  const primary = topology && typeof topology === 'object' ? (topology as Record<string, unknown>).primary : undefined;
  if (!primary || typeof primary !== 'object') return undefined;
  const { provider, externalId } = primary as Record<string, unknown>;
  return typeof provider === 'string' && typeof externalId === 'string' ? { provider, externalId } : undefined;
}

export function primaryDatabaseRecordState(environmentBindings: Record<string, unknown> | undefined,
  component: Component): 'recorded' | 'missing' | 'conflict' {
  const recorded = committedPrimaryDatabase(environmentBindings);
  if (!recorded) return 'missing';
  return recorded.provider === component.bindings.provider && recorded.externalId === component.externalId ? 'recorded' : 'conflict';
}

function recordedProviderScope(component: Component): Record<string, string> | null | undefined {
  if (!Object.hasOwn(component.bindings, 'providerScope')) return undefined;
  const parsed = recoverySourceIdentitySchema.shape.providerScope.safeParse(component.bindings.providerScope);
  return parsed.success && isDeepStrictEqual(parsed.data, component.bindings.providerScope) ? parsed.data : null;
}

function completeProviderScope(component: Component, scope: Record<string, string> | undefined): boolean {
  const keys = providerRegistry.get(String(component.bindings.provider))?.inspection?.selectors.database?.scopeKeys ?? [];
  return Boolean(scope) && keys.length > 0 && keys.every(key => Boolean(scope![key]));
}

export async function planDatabaseScopeBinding(context: BackupPolicyContext): Promise<{ actions: PlanAction[]; warnings: string[] }> {
  const component = currentDatabaseScopeComponent(context);
  if (!component) return { actions: [], warnings: [] };
  const recordedScope = recordedProviderScope(component);
  if (recordedScope === null) return { actions: [], warnings: ['Malformed database scope is preserved; no binding repair is authorized.'] };
  const needsScope = !completeProviderScope(component, recordedScope);
  const runtimeReference = !Object.hasOwn(component.bindings, 'directUrlVariable')
    ? await observeDatabaseRuntimeReference(context, component) : { state: 'unsupported' as const };
  const needsRuntimeReference = runtimeReference.state === 'known';
  const primaryState = primaryDatabaseRecordState(context.environment?.platformBindings, component);
  const conflictWarning = primaryState === 'conflict'
    ? ['The committed primary database identity names a different database than the one Hypervibe manages. It was left unchanged; review databaseTopology.primary in .hypervibe/bindings.json.'] : [];
  if (!needsScope && primaryState !== 'missing' && !needsRuntimeReference) return { actions: [], warnings: conflictWarning };
  if (runtimeReference.state === 'unknown') return { actions: [], warnings: [...conflictWarning,
    'The database runtime URL reference could not be independently verified. No binding repair is authorized.'] };
  // The native source must independently agree with every recorded scope key;
  // only absent keys can be filled from exact provider evidence.
  const source = await observeDatabaseBindingSource(context, component);
  if (!source) return { actions: [], warnings: [...conflictWarning,
    needsScope ? 'The current database lacks durable recovery scope and its native recovery source could not be independently verified. No binding repair is authorized.'
      : 'The current database identity is not recorded in .hypervibe/bindings.json and its native source could not be independently verified. No binding repair is authorized.',
  ] };
  const action: PlanAction = { id: databaseScopeBindingActionId(source.provider, component.id), type: 'update',
    resource: { kind: 'database', name: component.type, provider: source.provider }, verified: true, requiresConfirm: true,
    reason: needsRuntimeReference
      ? 'Record the independently verified runtime URL variable of the existing database without changing provider resources.'
      : needsScope
      ? 'Record the independently verified recovery scope of the existing database without changing provider resources.'
      : 'Record the independently verified identity of the existing database in .hypervibe/bindings.json without changing provider resources.',
    metadata: { operation: DATABASE_SCOPE_BIND_OPERATION, componentId: component.id, source,
      ...(runtimeReference.state === 'known' ? { runtimeReference: runtimeReference.reference } : {}),
      ...(needsScope && recordedScope ? { priorProviderScope: recordedScope } : {}),
      bindingsFingerprint: databaseScopeBindingsFingerprint(component.bindings, needsRuntimeReference) } };
  return isDatabaseScopeBindingAction(action) ? { actions: [action], warnings: conflictWarning } : { actions: [], warnings: conflictWarning };
}
