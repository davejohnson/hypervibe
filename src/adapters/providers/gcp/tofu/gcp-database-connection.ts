/**
 * Everything a workload may know about its database: where the socket is and
 * where an on-demand worker counts pending work. Nothing here says who created
 * the database, what it costs or who may change it. The workload generator
 * takes this and nothing else, so it cannot tell a database this environment
 * owns from one it was handed.
 */
export interface GcpDatabaseConnection {
  /** `project:region:instance` for the Cloud Run socket: a literal, or a reference into this configuration. */
  connectionName: string;
  /** False until the app's login exists, so a first deployment never points services at a database they cannot log in to. */
  wireServices: boolean;
  /** Where the Cloud SQL Data API runs an on-demand worker's pending-work query. */
  workerQuery: { projectId: string; instanceName: string; databaseName: string };
}
