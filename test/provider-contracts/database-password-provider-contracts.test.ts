import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { canComposeDatabasePasswordRotation } from '../../src/domain/ports/database-credential.port.js';
import type { IDatabaseAdapter } from '../../src/domain/ports/database.port.js';
import { SupabaseAdapter } from '../../src/adapters/providers/supabase/supabase.adapter.js';
import { NeonAdapter } from '../../src/adapters/providers/neon/neon.adapter.js';
import { CloudSqlAdapter } from '../../src/adapters/providers/gcp/cloudsql.adapter.js';
import { AzurePostgresAdapter } from '../../src/adapters/providers/azure/azure-postgres.adapter.js';
import { FlyDatabaseAdapter } from '../../src/adapters/providers/fly/fly-database.adapter.js';
import { DigitalOceanDatabaseAdapter } from '../../src/adapters/providers/digitalocean/digitalocean-database.adapter.js';
import { RdsAdapter } from '../../src/adapters/providers/aws/rds.adapter.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
const review = JSON.parse(readFileSync(new URL('./database-password-provider-matrix.json', import.meta.url), 'utf8')) as {
  providers: Array<{ provider: string; admission: string; identity: string; native: string; recovery: string; sources: string[] }>;
};

it('reviews every registered database provider and requires complete composed rotation admission', async () => {
  expect(review.providers.map(row => row.provider).sort()).toEqual(providerRegistry.namesFor('database').sort());
  const railway = await providerRegistry.get('railway')!.derivedAdapters!.database!(new RailwayAdapter(), {}) as IDatabaseAdapter;
  const adapters: Record<string, IDatabaseAdapter> = { railway, supabase: new SupabaseAdapter(), neon: new NeonAdapter(),
    cloudsql: new CloudSqlAdapter(), rds: new RdsAdapter(), 'azure-postgres': new AzurePostgresAdapter(), fly: new FlyDatabaseAdapter(), digitalocean: new DigitalOceanDatabaseAdapter() };
  expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('database').sort());
  for (const row of review.providers) {
    expect(row.identity.length).toBeGreaterThan(20); expect(row.native.length).toBeGreaterThan(20); expect(row.recovery.length).toBeGreaterThan(20);
    expect(row.sources.length).toBeGreaterThanOrEqual(2);
    for (const source of row.sources) expect(new URL(source).protocol).toBe('https:');
    // A new complete implementation requires deliberate review/matrix changes.
    expect(row.admission).toBe('implemented');
    expect(canComposeDatabasePasswordRotation(adapters[row.provider]), row.provider).toBe(true);
  }
});
