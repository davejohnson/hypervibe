import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseAccessAcquireResult } from '../services/database-access.service.js';

export interface AwsDatabaseBinding { clusterArn: string; accountId: string; region: string; name: string; owner: string; querySecretArn?: string }
export interface AzureDatabaseBinding { serverId: string; subscriptionId: string; resourceGroup: string; host: string; name: string; owner: string; secretUrl: string }
export type EngineDatabaseBinding = AwsDatabaseBinding | AzureDatabaseBinding;

/** Read-only native access to one accepted engine environment; no resource mutation authority. */
export interface IEngineDatabaseAccess {
  acquireManagedDatabaseAccess(project: Project, environment: Environment): Promise<DatabaseAccessAcquireResult>;
  observeManagedDatabase(project: Project, environment: Environment): Promise<Record<string, unknown>>;
  recoverManagedDatabaseBinding(project: Project, environment: Environment): Promise<EngineDatabaseBinding>;
}
export function supportsEngineDatabaseAccess(value: unknown): value is IEngineDatabaseAccess {
  const candidate = value as Partial<IEngineDatabaseAccess> | undefined;
  return !!candidate && typeof candidate.acquireManagedDatabaseAccess === 'function'
    && typeof candidate.observeManagedDatabase === 'function' && typeof candidate.recoverManagedDatabaseBinding === 'function';
}
