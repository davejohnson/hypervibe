import { describe, expect, it } from 'vitest';
import '../../../application/providers.js';
import { RdsAdapter } from '../aws/rds.adapter.js';
import { AzurePostgresAdapter } from '../azure/azure-postgres.adapter.js';
import { CloudSqlAdapter } from '../gcp/cloudsql.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../railway/railway-database.factory.js';
import { supportsDatabaseLifecycle, supportsDatabaseOperations } from '../../../domain/ports/database.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

describe('database capability truth', () => {
  it('preserves existing database operations without advertising cloud provisioning', () => {
    const adapters = new Map<string, unknown>([
      ['railway', createRailwayDatabaseAdapter({ hostingAdapter: new RailwayAdapter(), envRepo: {} as never })],
      ['cloudsql', new CloudSqlAdapter()], ['rds', new RdsAdapter()], ['azure-postgres', new AzurePostgresAdapter()],
    ]);
    expect(providerRegistry.namesFor('database')).toEqual(['railway']);
    expect(providerRegistry.namesForMutation('database')).toEqual(['railway']);
    for (const [provider, adapter] of adapters) {
      expect(supportsDatabaseOperations(adapter), provider).toBe(true);
      expect(supportsDatabaseLifecycle(adapter), provider).toBe(provider === 'railway');
      expect(providerRegistry.get(provider)?.databaseRuntime, provider).toBeDefined();
    }
    expect(providerRegistry.all().filter(provider => provider.databaseRuntime).map(provider => provider.metadata.name).sort())
      .toEqual([...adapters.keys()].sort());
  });

  it('keeps existing Cloud SQL recovery operations separate from planned resource provisioning', () => {
    for (const adapter of [new CloudSqlAdapter(), new RdsAdapter(), new AzurePostgresAdapter()]) {
      expect(adapter.capabilities.supportsReadReplicas, adapter.name).toBe(false);
      expect(adapter.capabilities.supportsPointInTimeRecovery, adapter.name).toBe(adapter.name === 'cloudsql');
      expect(providerRegistry.lifecycleMaturity(adapter.name, 'database')?.status).toBe('planned');
    }
  });

  it('preserves the Railway database network boundary', () => {
    expect(providerRegistry.getMetadata('railway')?.lifecycle?.databaseConnectivity?.compatibleHostingProviders).toEqual(['railway']);
    for (const provider of ['cloudsql', 'rds', 'azure-postgres']) expect(providerRegistry.getMetadata(provider)?.lifecycle?.databaseConnectivity).toBeUndefined();
  });
});
