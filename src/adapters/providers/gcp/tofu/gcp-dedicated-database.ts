import type { EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { GcpDatabaseConnection } from './gcp-database-connection.js';

/**
 * A Cloud SQL instance that one environment creates, sizes, protects and
 * deletes in its own OpenTofu configuration. Every Cloud SQL resource,
 * address, cost attribute and adoption rule for that case lives here. The
 * workload generator (`gcp-engine.backend.ts`) places what this returns and
 * hands workloads only a `GcpDatabaseConnection`.
 */
export interface GcpCloudSqlInput {
  /** Physical instance name; unique per project for a week after deletion, so Hypervibe picks and records it. */
  instanceName: string;
  databaseName: string;
  tier?: string;
  /** Refuse deletion, both in the engine and on Google's side, until turned off in a reviewed change. */
  deletionProtection?: boolean;
  /** Creation-only backup/PITR defaults; ordinary plans preserve existing native policy. */
  retainedBackups?: number;
  transactionLogDays?: number;
  /** PostgreSQL major version (default 16). */
  majorVersion?: number;
  /**
   * Wire services to the database (socket volume + CLOUD_SQL_CONNECTION_NAME).
   * False until Hypervibe's credential exists, so a first deployment never
   * points services at a database they cannot log in to.
   */
  wireServices: boolean;
}

export const DATABASE_ENGINE_ADDRESSES = ['google_sql_database_instance.db', 'google_sql_database.app', 'google_sql_user.worker_waker'] as const;

/** The Cloud SQL IAM database user for a service account email. */
export function iamDatabaseUser(serviceAccountEmail: string): string {
  return serviceAccountEmail.replace(/\.gserviceaccount\.com$/, '');
}

/** What workloads see of an environment's own database: references into the same configuration. */
export function dedicatedDatabaseConnection(projectId: string, database: GcpCloudSqlInput | undefined): GcpDatabaseConnection | undefined {
  if (!database) return undefined;
  return {
    connectionName: '${google_sql_database_instance.db.connection_name}',
    wireServices: database.wireServices === true,
    workerQuery: { projectId, instanceName: database.instanceName, databaseName: database.databaseName },
  };
}

export function dedicatedDatabase(params: {
  projectId: string;
  region: string;
  environmentId?: string;
  database?: GcpCloudSqlInput;
  /** A database this environment previously created that is no longer desired. */
  retired?: boolean;
  /** Set when an on-demand worker counts pending work: the runtime identity that gets a read-only login ('' when unknown). */
  workerLoginEmail?: string;
}): { resource: Record<string, Record<string, unknown>>; mappings: Record<string, EngineResourceMapping> } {
  const onDemand = params.workerLoginEmail !== undefined;
  const sql: Record<string, Record<string, unknown>> = {};
  const databaseMapping: EngineResourceMapping = { actionId: 'database:postgres', kind: 'database', name: 'postgres', dataBearing: true, billable: true,
    costAttributes: ['settings.*.tier', 'settings.*.disk_size', 'settings.*.disk_type', 'settings.*.availability_type', 'settings.*.edition'] };
  if (params.database) {
    if (!/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/.test(params.database.instanceName)) throw new Error('Cloud SQL instance name is invalid.');
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(params.database.databaseName)) throw new Error('Database name is invalid.');
    sql.google_sql_database_instance = { db: {
      name: params.database.instanceName,
      project: params.projectId,
      region: params.region,
      database_version: `POSTGRES_${params.database.majorVersion ?? 16}`,
      // Hypervibe's confirmation gate always governs deletion. A protected database also refuses
      // deletion here and in the Google console until protection is turned off in its own change.
      deletion_protection: params.database.deletionProtection === true,
      // Backup changes need their own scoped review. Retain the provider's full policy,
      // including fields absent from our input, on updates and interrupted-create adoption.
      // Enterprise Plus can retain longer PITR logs, so its edition must survive too.
      lifecycle: [{
        ignore_changes: ['settings[0].backup_configuration', 'settings[0].edition'],
        // Enterprise-only defaults cannot resize a retained Plus instance.
        // Evaluate the effective plan values, after ignore_changes preserves its
        // edition, instead of hiding all tier drift (which would disable sizing).
        // https://cloud.google.com/sql/docs/postgres/machine-series-overview
        postcondition: [{
          condition: '${self.settings[0].edition != "ENTERPRISE_PLUS" || !(startswith(self.settings[0].tier, "db-custom-") || contains(["db-f1-micro", "db-g1-small"], self.settings[0].tier))}',
          error_message: 'This database uses Cloud SQL Enterprise Plus, but the requested size is only available on Enterprise. Hypervibe cannot apply this size change while preserving the database recovery settings.',
        }],
      }],
      settings: [{
        deletion_protection_enabled: params.database.deletionProtection === true,
        // Shared-core tiers require the Enterprise edition.
        edition: 'ENTERPRISE',
        tier: params.database.tier ?? 'db-f1-micro',
        availability_type: 'ZONAL',
        ip_configuration: [{ ipv4_enabled: true }],
        // On-demand workers count pending work through the Data API as an IAM database user.
        ...(onDemand ? {
          data_api_access: 'ALLOW_DATA_API',
          database_flags: [{ name: 'cloudsql.iam_authentication', value: 'on' }],
        } : {}),
        backup_configuration: [{
          enabled: true, point_in_time_recovery_enabled: true,
          ...(params.database.transactionLogDays ? { transaction_log_retention_days: params.database.transactionLogDays } : {}),
          ...(params.database.retainedBackups ? { backup_retention_settings: [{ retained_backups: params.database.retainedBackups, retention_unit: 'COUNT' }] } : {}),
        }],
        user_labels: { 'managed-by': 'hypervibe', ...(params.environmentId ? { 'hv-environment': params.environmentId.toLowerCase() } : {}) },
      }],
    } };
    sql.google_sql_database = { app: {
      name: params.database.databaseName,
      project: params.projectId,
      instance: '${google_sql_database_instance.db.name}',
      // Deleting the instance removes its databases; dropping one first fails while connections exist.
      deletion_policy: 'ABANDON',
    } };
    if (onDemand) {
      if (!params.workerLoginEmail) throw new Error('On-demand workers require the runtime identity.');
      sql.google_sql_user = { worker_waker: {
        name: iamDatabaseUser(params.workerLoginEmail),
        project: params.projectId,
        instance: '${google_sql_database_instance.db.name}',
        type: 'CLOUD_IAM_SERVICE_ACCOUNT',
        // Google cannot delete a PostgreSQL login that holds grants, and this one is granted read access.
        // It is left in place when it leaves the plan and goes with the instance when the database is removed.
        deletion_policy: 'ABANDON',
      } };
    }
  }
  const mappings: Record<string, EngineResourceMapping> = {};
  if (params.database || params.retired) {
    for (const address of DATABASE_ENGINE_ADDRESSES) mappings[address] = databaseMapping;
  }
  return { resource: sql, mappings };
}

/** Takes over an instance Hypervibe itself attempted to create that engine state does not track yet. */
export function dedicatedDatabaseImports(projectId: string, database: GcpCloudSqlInput | undefined, adoptInstance: string | undefined): Record<string, string> {
  if (!adoptInstance) return {};
  if (adoptInstance !== database?.instanceName) throw new Error('Only the desired database instance can be adopted.');
  return { 'google_sql_database_instance.db': `projects/${projectId}/instances/${adoptInstance}` };
}
