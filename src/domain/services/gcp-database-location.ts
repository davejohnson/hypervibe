/**
 * Where an environment's PostgreSQL database is on Google Cloud.
 *
 * This is the only place that knows the defaults: the instance is in the
 * environment's own Google project and the database is named `app`. A binding
 * may record another project or database name (a shared server); every reader
 * asks here instead of assuming.
 *
 * The environment's DATABASE_URL secret is not part of the location: it always
 * stays in the environment's own project.
 */
export const GCP_DEFAULT_DATABASE_NAME = 'app';

export interface GcpDatabaseLocation {
  /** Google project that holds the Cloud SQL instance. */
  gcpProjectId: string;
  instanceName: string;
  /** PostgreSQL database inside the instance. */
  databaseName: string;
}

export interface GcpDatabaseBinding {
  database?: { instanceName: string; gcpProjectId?: string; databaseName?: string };
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Undefined when the binding records no database. Saved bindings are untyped data, so every field is checked. */
export function gcpDatabaseLocation(environmentGcpProjectId: string, binding: GcpDatabaseBinding | undefined): GcpDatabaseLocation | undefined {
  const database = binding?.database as { instanceName?: unknown; gcpProjectId?: unknown; databaseName?: unknown } | undefined;
  if (!database || typeof database !== 'object' || !filled(database.instanceName)) return undefined;
  return {
    gcpProjectId: filled(database.gcpProjectId) ? database.gcpProjectId : environmentGcpProjectId,
    instanceName: database.instanceName,
    databaseName: filled(database.databaseName) ? database.databaseName : GCP_DEFAULT_DATABASE_NAME,
  };
}
