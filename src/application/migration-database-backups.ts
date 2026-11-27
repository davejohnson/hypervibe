import { sqlAdmin } from '../adapters/providers/gcp/gcp-data.client.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { GCP_PROJECT_ID_PATTERN, gcpCredentialsMatchProject, gcpEnvironmentBindingConflict } from '../domain/services/gcp-environment-target.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { gcpDatabaseConnectionName, gcpDatabaseLocation, gcpDatabaseOnSharedServer, gcpDatabasePlanBlocker, gcpDedicatedDatabaseOwner } from './gcp-database-location.js';
import { engineGcpAdapter, type EngineBinding } from './infrastructure-engine.js';

/** A recorded location selects the two exact reads. Google must independently identify the owned database. */
function dedicatedDestination(project: Project, destination: Environment, target: EnvironmentSpec) {
  const bindings = destination.platformBindings;
  const { projectId, environmentId: region } = bindings;
  const engine = bindings.engine as EngineBinding | undefined;
  const saved = engine?.database;
  if (!project.id || destination.projectId !== project.id || !destination.id
    || target.hosting.provider !== 'cloudrun' || target.database?.provider !== 'cloudsql' || target.database.placement === 'app'
    || bindings.provider !== 'cloudrun' || typeof projectId !== 'string' || !GCP_PROJECT_ID_PATTERN.test(projectId)
    || typeof region !== 'string' || !region
    || gcpEnvironmentBindingConflict(bindings, target.hosting.gcpProjectId, target.hosting.region ?? 'us-central1')
    || engine?.kind !== 'opentofu' || !saved || gcpDatabaseOnSharedServer(engine)
    || gcpDatabasePlanBlocker(projectId, engine, destination.id)) return;

  // An omitted field uses the existing dedicated location convention. A malformed field cannot stand in for one.
  if ([saved.gcpProjectId, saved.region, saved.databaseName, saved.connectionName].some(value =>
    value !== undefined && (typeof value !== 'string' || !value.trim()))) return;
  const location = gcpDatabaseLocation(projectId, engine);
  if (!location || !/^[a-z][a-z0-9-]*$/.test(location.instanceName)) return;
  const connectionName = gcpDatabaseConnectionName(location, region);
  if (saved.connectionName !== undefined && saved.connectionName !== connectionName) return;
  return { ...location, region, connectionName };
}

/** True only for an observed daily standard backup configuration on this migration's dedicated Cloud SQL database. */
export async function observeMigrationDatabaseBackups(project: Project, destination: Environment, target: EnvironmentSpec): Promise<boolean> {
  try {
    const database = dedicatedDestination(project, destination, target);
    if (!database) return false;
    const adapter = await engineGcpAdapter(project, target.hosting.gcpProjectId);
    if (!adapter || !gcpCredentialsMatchProject(adapter.engineConnection(), database.gcpProjectId, { allowLegacyKey: !target.hosting.gcpProjectId })) return false;
    const token = await adapter.engineAccessToken();
    const options: RequestInit = { signal: AbortSignal.timeout(15_000), redirect: 'error' };
    const instancePath = `instances/${encodeURIComponent(database.instanceName)}`;
    const read = (path: string, fields: string) => sqlAdmin(token, database.gcpProjectId,
      `${path}?${new URLSearchParams({ fields })}`, options);
    const result = await read(instancePath, 'project,region,name,connectionName,state,instanceType,databaseVersion,settings(userLabels,backupConfiguration(enabled,backupTier))');
    if (result.status !== 200) return false;
    const instance = await result.json() as {
      project?: string; region?: string; name?: string; connectionName?: string; state?: string; instanceType?: string; databaseVersion?: string;
      settings?: { userLabels?: Record<string, string>; backupConfiguration?: { enabled?: boolean; backupTier?: string } };
    };
    const backups = instance.settings?.backupConfiguration;
    if (instance.project !== database.gcpProjectId || instance.region !== database.region
      || instance.name !== database.instanceName || instance.connectionName !== database.connectionName
      || instance.state !== 'RUNNABLE' || instance.instanceType !== 'CLOUD_SQL_INSTANCE' || !/^POSTGRES_[0-9]+$/.test(instance.databaseVersion ?? '')
      || !gcpDedicatedDatabaseOwner(instance.settings?.userLabels, destination.id)
      || backups?.enabled !== true || backups.backupTier !== 'STANDARD') return false;
    // An enabled schedule on an owned server says nothing about a database that no longer exists on that server.
    const logical = await read(`${instancePath}/databases/${encodeURIComponent(database.databaseName)}`, 'project,instance,name');
    if (logical.status !== 200) return false;
    const observed = await logical.json() as { project?: string; instance?: string; name?: string };
    return observed.project === database.gcpProjectId && observed.instance === database.instanceName && observed.name === database.databaseName;
  } catch {
    return false;
  }
}
