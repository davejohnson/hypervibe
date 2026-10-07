import type { Project } from '../domain/entities/project.entity.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { currentDatabaseIdentityComponent, databaseIdentityRecordMetadataSchema,
  isDatabaseIdentityRecordAction, observedDatabaseIdentity } from '../domain/services/database-identity-binding.service.js';
import { primaryDatabaseRecordState } from '../domain/services/database-scope-binding.service.js';
import type { CommandContext } from './context.js';

const blocked = (message: string): ActionResult => ({ success: false, status: 'blocked', message,
  data: { applied: 0, skipped: 0, providerMutations: 0 } });

export async function applyDatabaseIdentityRecord(params: {
  ctx: CommandContext; project: Project; environmentName: string; environmentSpec: EnvironmentSpec;
  action: PlanAction; confirmedActionIds: ReadonlySet<string>;
}): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  const parsed = databaseIdentityRecordMetadataSchema.safeParse(action.metadata);
  if (!parsed.success || !isDatabaseIdentityRecordAction(action) || !params.confirmedActionIds.has(action.id)) {
    return blocked('Recording the database identity requires its exact reviewed action and confirmation. Re-run hv_plan.');
  }
  const reviewed = parsed.data;
  const load = () => {
    const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
    if (!environment) return undefined;
    const component = currentDatabaseIdentityComponent({ spec: environmentSpec, environment,
      components: ctx.repos.components.findByEnvironmentId(environment.id) });
    if (!component || component.id !== reviewed.componentId || component.externalId !== reviewed.externalId
      || component.bindings.provider !== action.resource.provider
      || environment.platformBindings.projectId !== reviewed.projectId
      || environment.platformBindings.environmentId !== reviewed.environmentId) return undefined;
    return { environment, component };
  };
  let current = load();
  if (!current) return blocked('The reviewed database identity or environment changed. Re-run hv_plan.');
  const state = primaryDatabaseRecordState(current.environment.platformBindings, current.component);
  if (state === 'conflict') {
    return blocked('The committed primary database identity names a different database. It was left unchanged; review databaseTopology.primary in .hypervibe/bindings.json.');
  }
  if (state === 'recorded') {
    // A prior SQLite write may have succeeded before repository export failed.
    try { ctx.repos.environments.syncRepoBindingsForId(current.environment.id); }
    catch { return blocked('The database identity is recorded locally but could not be exported. Retry this reviewed action.'); }
    return { success: true, message: 'The reviewed database identity is already recorded.',
      data: { applied: 0, skipped: 1, providerMutations: 0 } };
  }
  // Re-confirm the exact identity in a fresh, complete inventory before writing.
  const adapterResult = await ctx.adapterFactory.getProviderAdapter(action.resource.provider, project);
  const adapter = adapterResult.success ? adapterResult.adapter : undefined;
  if (!adapter?.capabilities?.supportsObserve || typeof adapter.observe !== 'function') {
    return blocked('The hosting provider could not re-confirm the database identity. No binding changed; re-run hv_plan.');
  }
  let observed;
  try { observed = await adapter.observe(current.environment); }
  catch { return blocked('The hosting provider could not re-confirm the database identity. No binding changed; re-run hv_plan.'); }
  const fingerprint = JSON.stringify(current.environment.platformBindings);
  current = load();
  if (!current || JSON.stringify(current.environment.platformBindings) !== fingerprint
    || primaryDatabaseRecordState(current.environment.platformBindings, current.component) !== 'missing') {
    return blocked('Database or environment bindings changed during re-confirmation. Re-run hv_plan.');
  }
  const scope = observedDatabaseIdentity(observed, current.environment, current.component);
  if (!scope || scope.projectId !== reviewed.projectId || scope.environmentId !== reviewed.environmentId) {
    return blocked('The database identity could not be re-confirmed in a complete inventory of this environment. No binding changed; re-run hv_plan.');
  }
  try {
    const topology = current.environment.platformBindings.databaseTopology as Record<string, unknown> | undefined;
    const replicas = topology?.replicas && typeof topology.replicas === 'object' ? topology.replicas : {};
    ctx.repos.environments.updatePlatformBindings(current.environment.id, { databaseTopology: {
      primary: { provider: action.resource.provider, externalId: reviewed.externalId }, replicas } });
    ctx.repos.environments.syncRepoBindingsForId(current.environment.id);
  } catch {
    return { success: false, status: 'blocked', message: 'The database identity could not be fully recorded or exported. Retry this reviewed action to verify and export it.',
      data: { applied: 0, skipped: 0, providerMutations: 0 } };
  }
  return { success: true, message: 'Recorded the existing database identity in .hypervibe/bindings.json. Provider resources were not changed.',
    data: { applied: 1, skipped: 0, providerMutations: 0 } };
}
