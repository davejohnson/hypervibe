/**
 * Where an environment's PostgreSQL database is. The resolver is pure and lives
 * in the domain layer so the query path can use it too; application code
 * imports it from here.
 */
export { GCP_DEFAULT_DATABASE_NAME, gcpDatabaseConnectionName, gcpDatabaseLocation, gcpDatabaseOnSharedServer, gcpDatabasePlanBlocker, gcpOwnInstanceRecord, type GcpDatabaseBinding, type GcpDatabaseLocation } from '../domain/services/gcp-database-location.js';
