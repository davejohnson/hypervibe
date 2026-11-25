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
  database?: {
    instanceName: string; gcpProjectId?: string; databaseName?: string; region?: string;
    /** 'app' when the database is one of several on a server the app's environments use together. Absent: the environment's own instance. */
    placement?: 'app';
    /** On such a server: the environment the database was made for, and the login its services use now. */
    tenantId?: string;
    activeLogin?: string;
    /** 'started': written before anything was created, so an interrupted creation can always be found. Absent once finished. */
    allocation?: 'started';
    /** On a shared server, while the database is being moved to an instance of the environment's own: that instance. The app still uses the shared one. */
    move?: { instanceName: string };
    /** On the environment's own instance, after such a move: the record of the database it left, kept until that one is deleted. */
    movedFrom?: Record<string, unknown>;
  };
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
 * True when the binding says the database is one of several on a server used by
 * more than this environment, whether or not the rest of the record is sound.
 * Everything that assumes the environment owns its whole instance asks this first.
 */
export function gcpDatabaseOnSharedServer(binding: GcpDatabaseBinding | undefined): boolean {
  return (binding?.database as { placement?: unknown } | undefined)?.placement !== undefined;
}

/**
 * A record of a database on a shared server is acted on only when it names a
 * server in this environment's own Google project and says it was made for
 * this very environment. Whether the rest of the record hangs together is for
 * the shared-database module, which is the only reader of those parts.
 */
function sharedRecordProblem(environmentGcpProjectId: string, binding: GcpDatabaseBinding, environmentId: string | undefined): string | undefined {
  const record = binding.database as Record<string, unknown>;
  const complete = record.placement === 'app' && filled(record.instanceName) && filled(record.region) && record.gcpProjectId === environmentGcpProjectId
    && filled(record.databaseName) && filled(record.tenantId);
  if (!complete) return 'The saved record of this environment\'s database on the shared server is incomplete, so Hypervibe will not plan changes to it.';
  if (!environmentId || record.tenantId !== environmentId) return 'The saved record says this database on the shared server was made for a different environment, so Hypervibe will not plan changes to it.';
  return undefined;
}

/**
 * Why Hypervibe must not plan changes for this environment's database, if it must not.
 *
 * Reading a location is safe anywhere. Changing things is not: the dedicated
 * login, rotation, adoption and teardown steps all assume the environment owns
 * the whole instance, and on a server used by other environments they would
 * reset the others' passwords or report the database gone. A database that is
 * not the environment's own instance is therefore plannable only when the
 * binding carries a complete record that it was allocated for this very
 * environment (`environmentId`); that record routes every change through the
 * shared-server module. Anything else blocks.
 */
export function gcpDatabasePlanBlocker(environmentGcpProjectId: string, binding: GcpDatabaseBinding | undefined, environmentId?: string): string | undefined {
  if (binding?.database === undefined || binding.database === null) return undefined;
  const database = gcpDatabaseLocation(environmentGcpProjectId, binding);
  if (!database) return 'The saved record of this environment\'s database is damaged, so Hypervibe will not plan changes to it.';
  if (gcpDatabaseOnSharedServer(binding)) return sharedRecordProblem(environmentGcpProjectId, binding, environmentId);
  if (database.gcpProjectId !== environmentGcpProjectId || database.databaseName !== GCP_DEFAULT_DATABASE_NAME || database.region !== undefined) {
    return 'This environment\'s database is on a server the environment does not own. Hypervibe cannot manage that yet.';
  }
  return undefined;
}

/**
 * What to save when the environment's own instance is created or changed. An
 * environment whose database is still on a shared server keeps that record and
 * notes the instance beside it; one that left a shared server keeps the record
 * of what it left until that is cleaned up.
 */
export function gcpOwnInstanceRecord(binding: GcpDatabaseBinding | undefined, instanceName: string): NonNullable<GcpDatabaseBinding['database']> {
  const now = binding?.database;
  if (now && gcpDatabaseOnSharedServer(binding)) return { ...now, move: { instanceName } };
  return { instanceName, ...(now?.movedFrom && now.instanceName === instanceName ? { movedFrom: now.movedFrom } : {}) };
}
