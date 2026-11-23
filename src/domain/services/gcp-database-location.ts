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
  /** Region of the instance, when it is recorded apart from the environment's. */
  region?: string;
}

export interface GcpDatabaseBinding {
  database?: { instanceName: string; gcpProjectId?: string; databaseName?: string; region?: string };
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Undefined when the binding records no database. Saved bindings are untyped data, so every field is checked. */
export function gcpDatabaseLocation(environmentGcpProjectId: string, binding: GcpDatabaseBinding | undefined): GcpDatabaseLocation | undefined {
  const database = binding?.database as { instanceName?: unknown; gcpProjectId?: unknown; databaseName?: unknown; region?: unknown } | undefined;
  if (!database || typeof database !== 'object' || !filled(database.instanceName)) return undefined;
  return {
    gcpProjectId: filled(database.gcpProjectId) ? database.gcpProjectId : environmentGcpProjectId,
    instanceName: database.instanceName,
    databaseName: filled(database.databaseName) ? database.databaseName : GCP_DEFAULT_DATABASE_NAME,
    ...(filled(database.region) ? { region: database.region } : {}),
  };
}

/** `project:region:instance`, the name Cloud SQL sockets and connectors use. */
export function gcpDatabaseConnectionName(database: GcpDatabaseLocation, environmentRegion: string): string {
  return `${database.gcpProjectId}:${database.region ?? environmentRegion}:${database.instanceName}`;
}

/**
 * Why Hypervibe must not plan changes for this environment's database, if it must not.
 *
 * Reading a location is safe anywhere. Changing things is not: the login,
 * rotation, adoption and teardown steps all assume the environment owns the
 * whole instance, and on a server shared with other environments they would
 * reset the other environments' passwords or report the database gone. Until
 * those steps act on a verified allocation, a database that is not the
 * environment's own instance blocks planning.
 */
export function gcpDatabasePlanBlocker(environmentGcpProjectId: string, binding: GcpDatabaseBinding | undefined): string | undefined {
  if (binding?.database === undefined || binding.database === null) return undefined;
  const database = gcpDatabaseLocation(environmentGcpProjectId, binding);
  if (!database) return 'The saved record of this environment\'s database is damaged, so Hypervibe will not plan changes to it.';
  if (database.gcpProjectId !== environmentGcpProjectId || database.databaseName !== GCP_DEFAULT_DATABASE_NAME || database.region !== undefined) {
    return 'This environment\'s database is on a server the environment does not own. Hypervibe cannot manage that yet.';
  }
  return undefined;
}
