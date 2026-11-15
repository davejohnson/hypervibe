import { nativeDatabaseConnectivity } from '../registry/database-connectivity.js';

/**
 * Fill an omitted `database.provider` with the hosting platform's own database
 * before validation. An explicit provider is never replaced; a host without a
 * single native database is left for schema validation to report.
 */
export function withDefaultDatabaseProvider(environment: unknown): unknown {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return environment;
  const { database, hosting } = environment as { database?: unknown; hosting?: unknown };
  if (!database || typeof database !== 'object' || Array.isArray(database)) return environment;
  if ((database as { provider?: unknown }).provider !== undefined) return environment;
  const host = hosting && typeof hosting === 'object' ? (hosting as { provider?: unknown }).provider : undefined;
  const matches = typeof host === 'string'
    ? Object.entries(nativeDatabaseConnectivity).filter(([, connectivity]) => connectivity.compatibleHostingProviders.includes(host))
    : [];
  if (matches.length !== 1) return environment;
  return { ...environment, database: { ...database, provider: matches[0][0] } };
}
