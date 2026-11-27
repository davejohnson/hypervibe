import { nativeDatabaseConnectivity } from '../registry/database-connectivity.js';

export function nativeDatabaseProvider(host: string): string | undefined {
  const matches = Object.entries(nativeDatabaseConnectivity).filter(([, connectivity]) =>
    connectivity.compatibleHostingProviders.includes(host));
  return matches.length === 1 ? matches[0]![0] : undefined;
}

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
  const provider = typeof host === 'string' ? nativeDatabaseProvider(host) : undefined;
  return provider ? { ...environment, database: { ...database, provider } } : environment;
}

/**
 * Older specs carried `hosting.engine: "opentofu"`. The engine is no longer a
 * choice (cloud hosting always uses it), so the field is dropped on read and
 * never written back.
 */
export function withoutEngineFlag(environment: unknown): unknown {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return environment;
  const { hosting } = environment as { hosting?: unknown };
  if (!hosting || typeof hosting !== 'object' || Array.isArray(hosting) || !('engine' in hosting)) return environment;
  const { engine: _engine, ...rest } = hosting as Record<string, unknown>;
  return { ...environment, hosting: rest };
}
