import { providerRegistry } from '../registry/provider.registry.js';

/**
 * Fill an omitted `database.provider` with the hosting platform's own database
 * before validation. An explicit provider is never replaced; a host without a
 * single native database is left for schema validation to report.
 */
export function withDefaultDatabaseProviders(document: unknown): unknown {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const environments = (document as { environments?: unknown }).environments;
  if (!environments || typeof environments !== 'object' || Array.isArray(environments)) return document;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [name, environment] of Object.entries(environments as Record<string, unknown>)) {
    next[name] = environment;
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) continue;
    const { database, hosting } = environment as { database?: unknown; hosting?: unknown };
    if (!database || typeof database !== 'object' || Array.isArray(database)) continue;
    if ((database as { provider?: unknown }).provider !== undefined) continue;
    const host = hosting && typeof hosting === 'object' ? (hosting as { provider?: unknown }).provider : undefined;
    const provider = typeof host === 'string' ? providerRegistry.defaultDatabaseProviderFor(host) : undefined;
    if (!provider) continue;
    next[name] = { ...environment, database: { ...database, provider } };
    changed = true;
  }
  return changed ? { ...document, environments: next } : document;
}
