import { Client } from 'pg';

export interface PostgresMaintenanceClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface PostgresMaintenanceDependencies {
  createClient(connectionUrl: string, options?: { writableSession?: boolean }): PostgresMaintenanceClient;
}

export interface PostgresWriteFenceObservation {
  state: 'fenced' | 'unfenced' | 'unknown';
  reason?: string;
}

const defaultDependencies: PostgresMaintenanceDependencies = {
  createClient(connectionUrl, options) {
    return new Client({
      connectionString: connectionUrl,
      ...(options?.writableSession
        ? { options: '-c default_transaction_read_only=off' }
        : {}),
    }) as unknown as PostgresMaintenanceClient;
  },
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function withClient<T>(
  connectionUrl: string,
  dependencies: PostgresMaintenanceDependencies,
  operation: (client: PostgresMaintenanceClient) => Promise<T>,
  options?: { writableSession?: boolean }
): Promise<T> {
  const client = dependencies.createClient(connectionUrl, options);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function observePostgresWriteFence(
  connectionUrl: string,
  dependencies: PostgresMaintenanceDependencies = defaultDependencies
): Promise<PostgresWriteFenceObservation> {
  try {
    return await withClient(connectionUrl, dependencies, async (client) => {
      const defaults = await client.query('SHOW default_transaction_read_only');
      const transaction = await client.query('SHOW transaction_read_only');
      const defaultValue = defaults.rows[0]?.default_transaction_read_only;
      const transactionValue = transaction.rows[0]?.transaction_read_only;
      return defaultValue === 'on' && transactionValue === 'on'
        ? { state: 'fenced' as const }
        : defaultValue === 'off' && transactionValue === 'off'
          ? { state: 'unfenced' as const }
          : { state: 'unknown' as const, reason: 'postgres_write_fence_inconsistent' };
    });
  } catch {
    return { state: 'unknown', reason: 'postgres_write_fence_observation_failed' };
  }
}

export async function setPostgresWriteFence(
  connectionUrl: string,
  enabled: boolean,
  dependencies: PostgresMaintenanceDependencies = defaultDependencies
): Promise<PostgresWriteFenceObservation> {
  try {
    await withClient(connectionUrl, dependencies, async (client) => {
      const identity = await client.query(
        'SELECT current_user AS role, current_database() AS database'
      );
      const role = identity.rows[0]?.role;
      const database = identity.rows[0]?.database;
      if (typeof role !== 'string' || typeof database !== 'string') {
        throw new Error('PostgreSQL identity unavailable');
      }
      const setting = enabled
        ? 'SET default_transaction_read_only = on'
        : 'RESET default_transaction_read_only';
      await client.query(
        `ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(database)} ${setting}`
      );
    }, { writableSession: !enabled });
    return observePostgresWriteFence(connectionUrl, dependencies);
  } catch {
    return { state: 'unknown', reason: 'postgres_write_fence_mutation_failed' };
  }
}
