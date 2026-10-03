import { isDeepStrictEqual } from 'node:util';
import type { Project } from '../domain/entities/project.entity.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import type { BackupPolicyContext } from '../domain/services/backup-policy.service.js';
import { bindingIdentityFingerprint, providerIdentityScopeMatches } from '../domain/services/binding-identity.js';
import { currentDatabaseScopeComponent, databaseScopeBindingMetadataSchema,
  isDatabaseScopeBindingAction, observeDatabaseBindingSource, primaryDatabaseRecordState } from '../domain/services/database-scope-binding.service.js';
import { recoverySourceIdentityMatches } from '../domain/services/recovery-source.js';
import type { CommandContext } from './context.js';

const blocked = (message: string, applied = 0): ActionResult => ({ success: false, status: 'blocked', message,
  data: { applied, skipped: 0, providerMutations: 0 } });

export async function applyDatabaseScopeBinding(params: {
  ctx: CommandContext; project: Project; environmentName: string; environmentSpec: EnvironmentSpec;
  action: PlanAction; confirmedActionIds: ReadonlySet<string>;
}): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  const parsed = databaseScopeBindingMetadataSchema.safeParse(action.metadata);
  if (!parsed.success || !isDatabaseScopeBindingAction(action) || !params.confirmedActionIds.has(action.id)) {
    return blocked('Database scope repair requires its exact reviewed action and confirmation. Re-run hv_plan.');
  }
  const reviewed = parsed.data;
  const load = () => {
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    const context: BackupPolicyContext = { project, spec: environmentSpec, environment,
      components: environment ? ctx.repos.components.findByEnvironmentId(environment.id) : [], adapterFactory: ctx.adapterFactory };
    const component = currentDatabaseScopeComponent(context);
    if (!component || component.id !== reviewed.componentId || component.type !== action.resource.name
      || component.bindings.provider !== reviewed.source.provider || component.externalId !== reviewed.source.primaryExternalId) return undefined;
    const alreadyBound = Object.hasOwn(component.bindings, 'providerScope');
    if (alreadyBound && !isDeepStrictEqual(component.bindings.providerScope, reviewed.source.providerScope)) return undefined;
    const { providerScope: _scope, ...priorBindings } = component.bindings;
    if (bindingIdentityFingerprint(priorBindings) !== reviewed.bindingsFingerprint) return undefined;
    return { context, component, alreadyBound };
  };
  let current = load();
  if (!current) return blocked('The reviewed database identity or its binding metadata changed. Re-run hv_plan.');
  const environmentFingerprint = bindingIdentityFingerprint(current.context.environment!.platformBindings);
  const source = await observeDatabaseBindingSource(current.context, current.component);
  if (!source || !recoverySourceIdentityMatches(source, reviewed.source)) {
    return blocked('The exact reviewed database recovery source could not be re-observed. No binding changed; re-run hv_plan.');
  }
  // Re-load after the network boundary, preserving credentials and recovery
  // evidence written while the read was in flight. Only one field is merged.
  current = load();
  if (!current || bindingIdentityFingerprint(current.context.environment!.platformBindings) !== environmentFingerprint
    || !providerIdentityScopeMatches({ componentBindings: current.component.bindings,
      environmentBindings: current.context.environment!.platformBindings, provider: source.provider,
      liveScope: source.providerScope })) return blocked('Database or environment bindings changed during source observation. Re-run hv_plan.');
  const environmentId = current.component.environmentId;
  const primaryState = primaryDatabaseRecordState(current.context.environment!.platformBindings, current.component);
  if (primaryState === 'conflict') {
    return blocked('The committed primary database identity names a different database. It was left unchanged; review databaseTopology.primary in .hypervibe/bindings.json.');
  }
  let applied = 0;
  let recordedPrimary = false;
  try {
    // Record the environment identity first: the component write below also
    // exports the repository bindings, so a failed export is retried as export-only.
    if (primaryState === 'missing') {
      // Record only the exact re-observed identity; never replace another record.
      const topology = current.context.environment!.platformBindings.databaseTopology as Record<string, unknown> | undefined;
      const replicas = topology?.replicas && typeof topology.replicas === 'object' ? topology.replicas : {};
      ctx.repos.environments.updatePlatformBindings(environmentId, { databaseTopology: {
        primary: { provider: reviewed.source.provider, externalId: reviewed.source.primaryExternalId }, replicas } });
      recordedPrimary = true;
      applied = 1;
    }
    if (!current.alreadyBound) {
      const saved = ctx.repos.components.updateBindings(current.component.id, { providerScope: reviewed.source.providerScope });
      if (!saved || !isDeepStrictEqual(saved.bindings.providerScope, reviewed.source.providerScope)) {
        return blocked('The database scope write could not be verified. Re-run hv_plan to inspect the current binding.', applied);
      }
      applied = 1;
    }
    // A prior SQLite write may have succeeded before repository export failed.
    ctx.repos.environments.syncRepoBindingsForId(environmentId);
  } catch {
    const saved = ctx.repos.components.findById(current.component.id);
    const scopeSaved = !current.alreadyBound && isDeepStrictEqual(saved?.bindings.providerScope, reviewed.source.providerScope);
    return blocked('Database binding persistence or repository export could not be completed. The exact local identity is retained; retry this reviewed action to verify and export it.',
      scopeSaved || recordedPrimary ? 1 : 0);
  }
  if (!applied) return { success: true, message: 'The reviewed database recovery scope and identity are already recorded.',
    data: { applied: 0, skipped: 1, providerMutations: 0 } };
  return { success: true, message: primaryState === 'missing'
    ? 'Recorded the existing database identity in .hypervibe/bindings.json. Backup completion and restore remain unchecked.'
    : 'Recorded the existing database recovery scope. Backup completion and restore remain unchecked.',
    data: { applied: 1, skipped: 0, providerMutations: 0 } };
}
