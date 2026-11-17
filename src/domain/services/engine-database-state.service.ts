import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { supportsEngineDatabaseAccess, type EngineDatabaseBinding } from '../ports/engine-database-access.port.js';
import { adapterFactory } from './adapter.factory.js';

/** Recover an accepted binding through the registered provider's private native-state capability. */
export async function recoverEngineDatabaseBinding(project: Project, environment: Environment, provider: 'aws' | 'azure'): Promise<EngineDatabaseBinding> {
  const resolved = await adapterFactory.getProviderAdapter(provider, project);
  if (!resolved.success || !supportsEngineDatabaseAccess(resolved.adapter)) throw new Error('A verified provider with managed database access is required to recover the accepted binding.');
  return resolved.adapter.recoverManagedDatabaseBinding(project, environment);
}
