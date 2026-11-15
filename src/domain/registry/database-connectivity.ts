/**
 * Native database connectivity shared by provider registration and spec parsing.
 * Keep this metadata independent of adapter bootstrap: hosted and CI readers
 * must interpret the same committed document without loading cloud clients.
 */
export const nativeDatabaseConnectivity = {
  railway: { compatibleHostingProviders: ['railway'] },
  cloudsql: { compatibleHostingProviders: ['cloudrun'] },
  rds: { compatibleHostingProviders: ['ecs'] },
  'azure-postgres': { compatibleHostingProviders: ['azure-container-apps'] },
};
