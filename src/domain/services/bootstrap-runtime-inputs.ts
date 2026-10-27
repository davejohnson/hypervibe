import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { BootstrapParams } from '../spec/spec-bootstrap.js';
import { buildDatabaseAliasEnvVars, buildDatabaseEnvVarsFromComponent } from './database-env.js';
import { buildCacheEnvVarsFromComponent } from './cache-env.js';
import { resolveQueueEnvVars } from './queue-env.js';
import { resolveStorageServiceEnvVars } from './storage-plan.service.js';
import { validateRuntimeSecretReferences } from './runtime-secret-references.js';

/** Resolve the same transient inputs for runtime review and execution. This
 * function neither generates secrets nor reads native secret values. Callers
 * must supply only their already authorized legacy managed values explicitly. */
export async function resolveBootstrapRuntimeInputs(input: {
  project: Project;
  environment: Environment | null;
  environmentSpec: EnvironmentSpec;
  params: BootstrapParams;
  managedSecretValues?: Record<string, string>;
}): Promise<BootstrapParams> {
  const { project, environment, environmentSpec } = input;
  if (environment && (environment.projectId !== project.id || environment.name !== input.params.environmentName))
    throw new Error('Runtime inputs require the exact project and environment.');
  let params = input.params;
  if (input.managedSecretValues !== undefined) {
    validateRuntimeSecretReferences(params.secretVersionRefs, input.managedSecretValues, () => true);
    params = { ...params, envVars: { ...(params.envVars ?? {}), ...input.managedSecretValues } };
  }
  const queueEnvVars = await resolveQueueEnvVars(project, environmentSpec, environment);
  if (queueEnvVars) params = { ...params, queueEnvVars };
  const storageServiceEnvVars = await resolveStorageServiceEnvVars(project, environmentSpec, environment);
  if (storageServiceEnvVars) params = { ...params, envVarsByService: storageServiceEnvVars };
  const components = new ComponentRepository();
  const database = environment && environmentSpec.database
    ? components.findByEnvironmentAndType(environment.id, environmentSpec.database.engine) : null;
  if (database) {
    const databaseEnvVars = buildDatabaseEnvVarsFromComponent(database).envVars;
    const aliases = Object.fromEntries(Object.entries(environmentSpec.services).map(([name, service]) =>
      [name, buildDatabaseAliasEnvVars(databaseEnvVars, service.databaseEnvAliases)])
      .filter(([, values]) => Object.keys(values).length)) as Record<string, Record<string, string>>;
    params = { ...params, envVars: { ...databaseEnvVars, ...(params.envVars ?? {}) },
      ...(Object.keys(aliases).length ? { envVarsByService: Object.fromEntries(
        [...new Set([...Object.keys(params.envVarsByService ?? {}), ...Object.keys(aliases)])].map(name =>
          [name, { ...(params.envVarsByService?.[name] ?? {}), ...(aliases[name] ?? {}) }])) } : {}),
    };
  }
  const cache = environment ? components.findByEnvironmentAndType(environment.id, 'redis') : null;
  if (cache) params = { ...params, envVars: { ...buildCacheEnvVarsFromComponent(cache).envVars, ...(params.envVars ?? {}) } };
  return params;
}
