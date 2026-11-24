import { ENGINE_DATABASE_URL_KEY } from '../../../../domain/services/engine-secret-id.js';
import type { GcpDatabaseConnection } from './gcp-database-connection.js';
import type { GcpCloudRunEngineInput, GcpCloudRunServiceInput, GcpSecretReference } from './gcp-engine.backend.js';

/**
 * A database for the workloads to use that is named outright, whatever
 * database this configuration itself creates. It is how workloads are moved
 * from one database to another while both exist: the one they leave, or the
 * one they are going to, can stay in the configuration untouched.
 *
 * The socket and the login travel together. A workload is never left with the
 * socket of one database and the connection secret of another.
 */
export interface GcpWorkloadDatabase {
  connection: GcpDatabaseConnection;
  /** The secret version holding the connection URL for that same database. */
  credential: GcpSecretReference;
  /**
   * The id of every secret that holds a connection to a database of this environment, whichever database that is. The
   * generator cannot tell such a secret from any other, so the caller says which they are.
   */
  databaseSecretIds: string[];
}

const same = (a: GcpSecretReference, b: GcpSecretReference): boolean => a.secretId === b.secretId && a.version === b.version;

/**
 * Gives one workload the named database's connection secret wherever it had
 * its database connection: under DATABASE_URL and under every other name that
 * carried that same reference (its aliases). Anything left that still points
 * at either database's secret in another version is refused.
 */
function withCredential(service: GcpCloudRunServiceInput, target: GcpWorkloadDatabase, databaseSecrets: ReadonlySet<string>): GcpCloudRunServiceInput {
  const references = Object.entries(service.secretEnv ?? {});
  if (!target.connection.wireServices) {
    // Nothing may reach for a database that is not ready: no connection secret under any name, and no pending-work check that would start a worker with no way in.
    const left = references.find(([, reference]) => databaseSecrets.has(reference.secretId));
    if (left) throw new Error(`Workload ${service.logicalName} has a database connection secret (${left[0]}), but the database it is pointed at is not ready for workloads.`);
    if (service.pendingWorkQuery) throw new Error(`Worker ${service.logicalName} counts pending work in a database that is not ready for workloads.`);
    return service;
  }
  const given = service.secretEnv?.[ENGINE_DATABASE_URL_KEY];
  if (!given) throw new Error(`Workload ${service.logicalName} would be connected to a database it has no connection secret for.`);
  if (!databaseSecrets.has(given.secretId)) throw new Error(`Workload ${service.logicalName} has a ${ENGINE_DATABASE_URL_KEY} that is not among the database connection secrets it was given.`);
  const secretEnv = Object.fromEntries(references.map(([name, reference]) => [name, same(reference, given) ? { ...target.credential } : reference]));
  // After that, every database connection secret the workload reads must be the named one, whatever name it is read under.
  const mixed = Object.entries(secretEnv).find(([, reference]) => databaseSecrets.has(reference.secretId) && !same(reference, target.credential));
  if (mixed) throw new Error(`Workload ${service.logicalName} would use two databases at once: ${mixed[0]} points at another connection than ${ENGINE_DATABASE_URL_KEY}.`);
  return { ...service, secretEnv };
}

export function workloadsOnNamedDatabase(input: GcpCloudRunEngineInput): GcpCloudRunEngineInput {
  const target = input.workloadDatabase;
  if (!target) return input;
  if (input.databaseConnection) throw new Error('A configuration names the database its workloads use in one way only.');
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(target.credential.secretId) || !/^[1-9][0-9]*$/.test(target.credential.version)) throw new Error('The named database needs one pinned version of its connection secret.');
  if (!Array.isArray(target.databaseSecretIds) || target.databaseSecretIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(id))) throw new Error('The named database needs the ids of every secret that holds a database connection.');
  const databaseSecrets = new Set([...target.databaseSecretIds, target.credential.secretId]);
  return {
    ...input,
    services: input.services.map((service) => withCredential(service, target, databaseSecrets)),
    ...(input.releaseJob ? { releaseJob: withCredential(input.releaseJob, target, databaseSecrets) } : {}),
  };
}
