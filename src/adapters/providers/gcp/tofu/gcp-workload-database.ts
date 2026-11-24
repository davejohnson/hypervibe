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
}

const same = (a: GcpSecretReference, b: GcpSecretReference): boolean => a.secretId === b.secretId && a.version === b.version;

/**
 * Gives one workload the named database's connection secret wherever it had
 * its database connection: under DATABASE_URL and under every other name that
 * carried that same reference (its aliases). Anything left that still points
 * at either database's secret in another version is refused.
 */
function withCredential(service: GcpCloudRunServiceInput, target: GcpWorkloadDatabase): GcpCloudRunServiceInput {
  const given = service.secretEnv?.[ENGINE_DATABASE_URL_KEY];
  if (!target.connection.wireServices) {
    if (given) throw new Error(`Workload ${service.logicalName} has a database connection secret, but the database it is pointed at is not ready for workloads.`);
    return service;
  }
  if (!given) throw new Error(`Workload ${service.logicalName} would be connected to a database it has no connection secret for.`);
  const secretEnv = Object.fromEntries(Object.entries(service.secretEnv!).map(([name, reference]) => [name, same(reference, given) ? { ...target.credential } : reference]));
  const mixed = Object.entries(secretEnv).find(([, reference]) => !same(reference, target.credential) && (reference.secretId === given.secretId || reference.secretId === target.credential.secretId));
  if (mixed) throw new Error(`Workload ${service.logicalName} would use two databases at once: ${mixed[0]} points at another connection than ${ENGINE_DATABASE_URL_KEY}.`);
  return { ...service, secretEnv };
}

/**
 * The input with every workload (services, workers, scheduled jobs and the
 * release job) pointed at the named database. Returns the input itself, the
 * very same object, when no database is named.
 */
export function workloadsOnNamedDatabase(input: GcpCloudRunEngineInput): GcpCloudRunEngineInput {
  const target = input.workloadDatabase;
  if (!target) return input;
  if (input.databaseConnection) throw new Error('A configuration names the database its workloads use in one way only.');
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(target.credential.secretId) || !/^[1-9][0-9]*$/.test(target.credential.version)) throw new Error('The named database needs one pinned version of its connection secret.');
  return {
    ...input,
    services: input.services.map((service) => withCredential(service, target)),
    ...(input.releaseJob ? { releaseJob: withCredential(input.releaseJob, target) } : {}),
  };
}
