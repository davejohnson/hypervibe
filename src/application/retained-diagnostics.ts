import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { observeBackupPolicy } from '../domain/services/backup-policy.service.js';
import { observeBackupHealth } from '../domain/services/backup-health.service.js';
import { assessBackupReadiness } from '../domain/services/backup-readiness.js';

export async function explicitBackupEvidence(ctx: CommandContext, project: Project, environment: Environment | null, spec: EnvironmentSpec) {
  const components = environment ? ctx.repos.components.findByEnvironmentId(environment.id) : [];
  const context = { project, environment, spec, components, adapterFactory: ctx.adapterFactory };
  const backupCoverage = await observeBackupPolicy(context);
  const backupHealth = await observeBackupHealth(context);
  return { backupCoverage, backupHealth, backupReadiness: assessBackupReadiness(backupCoverage, backupHealth) };
}

export async function retainedDatabaseStatus(ctx: CommandContext, project: Project, environment: Environment | null) {
  if (!environment) return [];
  const databases = ctx.repos.components.findByEnvironmentId(environment.id).filter(component => component.type === 'postgres');
  return await Promise.all(databases.map(async component => {
    const provider = typeof component.bindings.provider === 'string' ? component.bindings.provider : undefined;
    const externalId = component.externalId ?? (typeof component.bindings.instanceId === 'string' ? component.bindings.instanceId : undefined);
    const base = { componentId: component.id, provider, externalId };
    if (!provider || !externalId || (component.bindings.instanceId && component.bindings.instanceId !== externalId)) {
      return { ...base, observation: 'unknown', reason: 'The recorded database identity is incomplete or inconsistent.' };
    }
    try {
      const result = await ctx.adapterFactory.getDatabaseOperations(provider, project);
      if (result.success && result.adapter?.name === provider) {
        const observed = await result.adapter.observeDatabase(environment, { ...component, externalId });
        if (observed?.provider === provider && observed.externalId === externalId) {
          return { ...base, observation: 'present', status: observed.status };
        }
      }
    } catch { /* A failed identity, scope or provider check does not prove absence. */ }
    return { ...base, observation: 'unknown', reason: 'The provider could not verify the exact bound database.' };
  }));
}
