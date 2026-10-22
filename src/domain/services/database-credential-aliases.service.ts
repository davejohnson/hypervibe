import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Component } from '../entities/component.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentPlan, PlanOptions } from '../plan/plan.service.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { databaseCredentialAliasTargetSchema, databaseCredentialAliasesInspectionSchema,
  type DatabaseCredentialAliasesInspection } from '../ports/database-credential-aliases.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { bindingIdentityFingerprint } from './binding-identity.js';
import { currentDatabaseScopeComponent, planDatabaseScopeBinding } from './database-scope-binding.service.js';

export const DATABASE_CREDENTIAL_ALIASES_OPERATION = 'databaseCredentialAliasesRepair';
const namesSchema = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/));
export const databaseCredentialAliasesMetadataSchema = z.object({
  operation: z.literal(DATABASE_CREDENTIAL_ALIASES_OPERATION), componentId: z.string().min(1),
  environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/), target: databaseCredentialAliasTargetSchema,
  checkedNames: namesSchema.min(1), changeNames: namesSchema,
}).strict().superRefine((value, ctx) => {
  for (const names of [value.checkedNames, value.changeNames]) {
    if (new Set(names).size !== names.length || !isDeepStrictEqual(names, [...names].sort())) {
      ctx.addIssue({ code: 'custom', message: 'Alias names must be exact, sorted and unique.' });
    }
  }
  if (!Object.keys(value.target.providerScope).length || value.changeNames.some(name => !value.checkedNames.includes(name))) {
    ctx.addIssue({ code: 'custom', message: 'Alias repair requires complete scope and checked names.' });
  }
});
type Metadata = z.infer<typeof databaseCredentialAliasesMetadataSchema>;
const actionId = (componentId: string) => `database-credential-aliases:${componentId}`;
export const databaseCredentialAliasesActionSchema = z.object({
  id: z.string(), type: z.literal('update'),
  resource: z.object({ kind: z.literal('database'), name: z.literal('postgres'), provider: z.string().min(1) }).strict(),
  verified: z.literal(true), requiresConfirm: z.literal(true), reason: z.string(),
  metadata: databaseCredentialAliasesMetadataSchema,
}).strict().superRefine((action, ctx) => {
  if (action.id !== actionId(action.metadata.componentId) || action.resource.provider !== action.metadata.target.provider
    || !action.metadata.changeNames.length) ctx.addIssue({ code: 'custom', message: 'Alias repair action has inconsistent authority.' });
});
const recoverySchema = z.object({ phase: z.literal('attempted'), metadata: databaseCredentialAliasesMetadataSchema,
  inspectionEncrypted: z.string().min(1) }).strict();
const components = new ComponentRepository();
const environments = new EnvironmentRepository();
class AliasPrerequisite extends Error {}
function pending(component: Component) {
  if (component.bindings.credentialAliasRepair === undefined) return undefined;
  const parsed = recoverySchema.safeParse(component.bindings.credentialAliasRepair);
  if (!parsed.success) throw new AliasPrerequisite('Credential alias recovery state is invalid; it was preserved.');
  return parsed.data;
}
function activeRotation(component: Component): boolean {
  return Boolean(component.bindings.credentialRotation
    && (component.bindings.credentialRotation as { phase?: string }).phase !== 'installed');
}
function load(project: Project, environmentName: string, spec: EnvironmentSpec) {
  const environment = environments.findByProjectAndName(project.id, environmentName);
  const candidates = environment ? components.findByEnvironmentId(environment.id).filter(c => c.type === spec.database?.engine) : [];
  const component = candidates.length === 1 ? candidates[0] : undefined;
  if (spec.database?.credentialAliases?.mode !== 'issuer-references' || !environment || !component?.externalId
    || component.bindings.provider !== spec.database.provider || component.bindings.retainedCleanup
    || component.bindings.provisioningIncomplete || component.bindings.unresolvedMutation) {
    throw new AliasPrerequisite('Credential alias repair requires its declaration and one complete existing database binding.');
  }
  const scope = z.record(z.string().min(1), z.string().min(1)).safeParse(component.bindings.providerScope);
  if (!scope.success || !Object.keys(scope.data).length) throw new AliasPrerequisite('Credential alias repair requires complete database provider scope.');
  if (components.findByEnvironmentId(environment.id).some(activeRotation)) {
    throw new AliasPrerequisite('Recover the active database password rotation before repairing aliases.');
  }
  for (const otherProject of new ProjectRepository().findAll()) for (const otherEnvironment of environments.findByProjectId(otherProject.id)) {
    for (const other of components.findByEnvironmentId(otherEnvironment.id)) {
      if (other.id === component.id || other.externalId !== component.externalId || other.bindings.provider !== component.bindings.provider) continue;
      const otherScope = z.record(z.string().min(1), z.string().min(1)).safeParse(other.bindings.providerScope);
      if (!otherScope.success || !isDeepStrictEqual(Object.keys(otherScope.data).sort(), Object.keys(scope.data).sort())
        || isDeepStrictEqual(otherScope.data, scope.data)) {
        throw new AliasPrerequisite('The database identity is shared or ambiguously bound to another environment.');
      }
    }
  }
  return { environment, component, target: { provider: spec.database.provider, resourceId: component.externalId, providerScope: scope.data } };
}
function inspection(value: unknown, target: Metadata['target']) {
  const parsed = databaseCredentialAliasesInspectionSchema.parse(value);
  if (!isDeepStrictEqual(parsed.target, target)) throw new AliasPrerequisite('Observed database scope does not match the reviewed binding.');
  return { ...parsed, checkedNames: [...parsed.checkedNames].sort(), changeNames: [...parsed.changeNames].sort() };
}
function metadataFor(component: Component, bindings: Record<string, unknown>, value: DatabaseCredentialAliasesInspection): Metadata {
  return { operation: DATABASE_CREDENTIAL_ALIASES_OPERATION, componentId: component.id,
    environmentFingerprint: bindingIdentityFingerprint(bindings), target: value.target,
    checkedNames: value.checkedNames, changeNames: value.changeNames };
}
function decrypt(value: string, target: Metadata['target']) { return inspection(getSecretStore().decryptObject(value), target); }
const warnings = ['This plan repairs database variable references only. SQL authentication, application use and rollout are unchecked; deployment remains separate.'];

/** Public read-only projection; private provider evidence never leaves this service. */
export async function observeDatabaseCredentialAliases(params: { project: Project; spec: EnvironmentSpec; environmentName: string }): Promise<{
  state: 'verified' | 'drift' | 'unknown'; checkedNames: string[]; changeNames: string[]; authentication: 'unchecked'; reason?: string;
} | undefined> {
  if (!params.spec.database?.credentialAliases) return undefined;
  try {
    const current = load(params.project, params.environmentName, params.spec);
    if (pending(current.component)) throw new AliasPrerequisite('The original alias repair needs readback verification through its isolated plan.');
    const adapter = await adapterFactory.getDatabaseAdapter(current.target.provider, params.project);
    if (!adapter.success || !adapter.adapter?.credentialAliases) throw new AliasPrerequisite('The database provider does not support credential alias inspection.');
    const observed = inspection(await adapter.adapter.credentialAliases.inspect(current), current.target);
    return { state: observed.changeNames.length ? 'drift' : 'verified', checkedNames: observed.checkedNames,
      changeNames: observed.changeNames, authentication: 'unchecked' };
  } catch (error) {
    return { state: 'unknown', checkedNames: [], changeNames: [], authentication: 'unchecked',
      reason: error instanceof AliasPrerequisite ? error.message : 'Database alias configuration or exact scope could not be verified.' };
  }
}

export async function planDatabaseCredentialAliases(params: { project: Project; spec: ProjectSpec; revision: number;
  environmentName: string; options?: PlanOptions; onlyIfNeeded?: boolean }): Promise<EnvironmentPlan | { error: string } | null> {
  if (params.options?.serviceFilter !== undefined || params.options?.envVarOverrides !== undefined || params.options?.envFile !== undefined
    || params.options?.secretRefs !== undefined || params.options?.includeEnvFile === true) {
    return { error: 'Credential alias repair accepts no deployment, dotenv, service or secret inputs.' };
  }
  const spec = params.spec.environments[params.environmentName];
  if (!spec?.database?.credentialAliases) return params.onlyIfNeeded ? null : { error: 'Declare database.credentialAliases.mode="issuer-references" first.' };
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName);
  if (params.onlyIfNeeded && (!environment || !components.findByEnvironmentId(environment.id).some(c => c.type === spec.database!.engine))) return null;
  if (!environment) return { error: 'Credential alias repair requires an existing environment.' };
  const blocked: EnvironmentPlan['blocked'] = []; const actions: PlanAction[] = [];
  let metadata: Metadata | undefined; let encrypted: string | undefined;
  try {
    if (params.onlyIfNeeded) {
      const context = { project: params.project, spec, environment,
        components: components.findByEnvironmentId(environment.id), adapterFactory };
      const component = currentDatabaseScopeComponent(context);
      // A legacy binding needs the existing independently verified, local-only
      // normalization first. Never fall through to unrelated full-plan actions.
      // Explicit partial/malformed scope and pending credential work stay blocked.
      if (component && !Object.hasOwn(component.bindings, 'providerScope')
        && !context.components.some(entry => entry.bindings.credentialAliasRepair !== undefined || activeRotation(entry))) {
        const provider = await adapterFactory.getDatabaseAdapter(spec.database.provider, params.project);
        if (!provider.success || !provider.adapter?.credentialAliases) {
          throw new AliasPrerequisite(`Credential alias repair is unsupported or unavailable for ${spec.database.provider}.`);
        }
        const binding = await planDatabaseScopeBinding(context);
        if (binding.actions.length) {
          const document = { kind: 'hv_plan', scope: 'database-bindings' as const,
            environmentName: params.environmentName, specRevision: params.revision,
            observedFingerprint: null, actions: binding.actions, warnings: binding.warnings };
          const runs = new RunRepository();
          const run = runs.create({ projectId: params.project.id, environmentId: environment.id, type: 'plan', plan: document });
          runs.updateStatus(run.id, 'succeeded');
          return { planRunId: run.id, scope: 'database-bindings', specRevision: params.revision,
            environmentName: params.environmentName, verified: true, observed: null,
            actions: binding.actions, warnings: binding.warnings, blocked: [], unmanaged: [], inputRequired: [] };
        }
      }
    }
    const current = load(params.project, params.environmentName, spec);
    const resolved = await adapterFactory.getDatabaseAdapter(spec.database.provider, params.project);
    const capability = resolved.adapter?.credentialAliases;
    if (!resolved.success || !capability) throw new AliasPrerequisite(`Credential alias repair is unsupported or unavailable for ${spec.database.provider}.`);
    const observed = inspection(await capability.inspect(current), current.target);
    const recovery = pending(current.component);
    if (recovery) {
      const expected = decrypt(recovery.inspectionEncrypted, current.target);
      metadata = metadataFor(current.component, current.environment.platformBindings, expected);
      if (!isDeepStrictEqual(metadata, recovery.metadata)) throw new AliasPrerequisite('Pending alias repair scope changed; preserve the original recovery record.');
      encrypted = recovery.inspectionEncrypted;
    } else {
      metadata = metadataFor(current.component, current.environment.platformBindings, observed);
      encrypted = getSecretStore().encryptObject(observed);
    }
    if (params.onlyIfNeeded && !recovery && !metadata.changeNames.length) return null;
    if (metadata.changeNames.length) actions.push({ id: actionId(current.component.id), type: 'update',
      resource: { kind: 'database', provider: current.target.provider, name: 'postgres' }, verified: true, requiresConfirm: true,
      reason: recovery ? 'Verify the original database alias repair without repeating an uncertain write.'
        : 'Make database connection aliases reference the existing issuer password without changing SQL authentication or deploying.', metadata });
  } catch (error) {
    metadata = undefined; encrypted = undefined; actions.length = 0;
    blocked.push({ category: 'prerequisite', provider: spec.database.provider,
      reason: error instanceof AliasPrerequisite ? error.message : 'Database alias evidence or exact scope could not be verified.' });
  }
  const document = { kind: 'hv_plan', scope: 'database-credential-aliases', environmentName: params.environmentName,
    specRevision: params.revision, databaseCredentialAliasesReady: blocked.length === 0, observedFingerprint: null, actions, warnings,
    ...(metadata ? { databaseCredentialAliasesVerification: metadata } : {}),
    ...(encrypted ? { overrides: { databaseCredentialAliasesEncrypted: encrypted } } : {}) };
  const runs = new RunRepository(); const run = runs.create({ projectId: params.project.id, environmentId: environment.id, type: 'plan', plan: document });
  runs.updateStatus(run.id, 'succeeded');
  return { planRunId: run.id, scope: 'database-credential-aliases', specRevision: params.revision, environmentName: params.environmentName,
    verified: blocked.length === 0, observed: null, actions, warnings, blocked, unmanaged: [], inputRequired: [] };
}

export async function verifyDatabaseCredentialAliases(params: { project: Project; spec: EnvironmentSpec; environmentName: string; metadata: unknown }): Promise<boolean> {
  try {
    const m = databaseCredentialAliasesMetadataSchema.parse(params.metadata);
    const current = load(params.project, params.environmentName, params.spec);
    if (pending(current.component) || current.component.id !== m.componentId
      || bindingIdentityFingerprint(current.environment.platformBindings) !== m.environmentFingerprint) return false;
    const adapter = await adapterFactory.getDatabaseAdapter(current.target.provider, params.project);
    if (!adapter.success || !adapter.adapter?.credentialAliases) return false;
    const observed = inspection(await adapter.adapter.credentialAliases.inspect(current), current.target);
    return !observed.changeNames.length && isDeepStrictEqual(m, metadataFor(current.component, current.environment.platformBindings, observed));
  } catch { return false; }
}
const stop = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
export async function applyDatabaseCredentialAliases(params: { project: Project; spec: EnvironmentSpec; environmentName: string;
  action: PlanAction; confirmed: ReadonlySet<string>; encrypted?: string }): Promise<ActionResult> {
  const parsed = databaseCredentialAliasesActionSchema.safeParse(params.action);
  if (!parsed.success || !params.confirmed.has(params.action.id) || !params.encrypted) return stop('Alias repair requires its exact confirmed action and encrypted evidence.');
  try {
    const m = parsed.data.metadata;
    const current = load(params.project, params.environmentName, params.spec);
    const expected = decrypt(params.encrypted, current.target);
    if (!isDeepStrictEqual(m, metadataFor(current.component, current.environment.platformBindings, expected))) return stop('Database alias scope changed; re-plan.');
    const recovery = pending(current.component);
    if (recovery && (!isDeepStrictEqual(recovery.metadata, m)
      || !isDeepStrictEqual(decrypt(recovery.inspectionEncrypted, current.target), expected))) return stop('The original alias recovery evidence changed; it was preserved.');
    const adapter = await adapterFactory.getDatabaseAdapter(current.target.provider, params.project);
    const capability = adapter.adapter?.credentialAliases;
    if (!adapter.success || !capability) return stop('The reviewed database alias capability is unavailable.');
    let recorded = Boolean(recovery);
    const receipt = await capability.repair({ component: current.component, environment: current.environment, expected,
      allowWrite: !recovery, beforeWrite: async () => {
        if (recorded) throw new Error('Repeated alias write is not authorized.');
        const fresh = load(params.project, params.environmentName, params.spec);
        if (fresh.component.id !== m.componentId || pending(fresh.component)
          || bindingIdentityFingerprint(fresh.environment.platformBindings) !== m.environmentFingerprint
          || !isDeepStrictEqual(fresh.target, m.target)) throw new Error('Alias repair identity changed before write.');
        const state = { phase: 'attempted' as const, metadata: m, inspectionEncrypted: params.encrypted! };
        components.updateBindings(current.component.id, { credentialAliasRepair: state });
        if (!isDeepStrictEqual(pending(components.findById(current.component.id)!), state)) throw new Error('Alias repair recovery intent was not persisted.');
        recorded = true;
      } });
    const data = receipt.data;
    const counts = z.object({ requestedCount: z.number().int().nonnegative(), appliedCount: z.number().int().nonnegative(), skippedCount: z.number().int().nonnegative() }).safeParse(data);
    if (!receipt.success || data?.referencesVerified !== true || data.deploymentDeferred !== true || data.authentication !== 'unchecked'
      || !counts.success || counts.data.requestedCount !== expected.checkedNames.length
      || counts.data.appliedCount + counts.data.skippedCount !== counts.data.requestedCount
      || counts.data.appliedCount > expected.changeNames.length || counts.data.appliedCount > 0 && !recorded
      || recovery && counts.data.appliedCount !== 0) return stop('Database references are not verified. Preserve recovery evidence and re-plan; deployment was not authorized.');
    const finalScope = load(params.project, params.environmentName, params.spec);
    const latest = finalScope.component;
    const finalRecovery = pending(latest);
    if (latest.id !== m.componentId || !isDeepStrictEqual(finalScope.target, m.target)
      || bindingIdentityFingerprint(finalScope.environment.platformBindings) !== m.environmentFingerprint
      || (recorded ? !finalRecovery || !isDeepStrictEqual(finalRecovery.metadata, m)
        || !isDeepStrictEqual(decrypt(finalRecovery.inspectionEncrypted, current.target), expected) : Boolean(finalRecovery))) {
      return stop('Database identity or recovery ownership changed during verification. Preserve the recovery record and re-plan.');
    }
    const { credentialAliasRepair: _recovery, ...bindings } = latest.bindings;
    if (recorded) components.update(latest.id, { bindings });
    return { success: true, message: `Database references verified: ${counts.data.appliedCount} changed, ${counts.data.skippedCount} skipped. SQL authentication and application rollout remain unchecked.`,
      data: { ...counts.data, referencesVerified: true, deploymentDeferred: true, authentication: 'unchecked', applicationUse: 'unchecked' } };
  } catch { return stop('Database alias repair could not be verified. Preserve recovery evidence and re-plan; an uncertain write is never repeated automatically.'); }
}
