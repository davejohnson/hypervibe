import pg from 'pg';
import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const { Client } = pg;

// Credentials schema for database connections
export const DatabaseCredentialsSchema = z.object({
  connectionUrl: z.string().min(1, 'Connection URL is required'),
  type: z.enum(['postgres', 'mysql']).optional().describe('Database type (auto-detected from URL if not specified)'),
});

export type DatabaseCredentials = z.infer<typeof DatabaseCredentialsSchema>;

// Patterns that indicate a destructive/mutating query
const MUTATION_PATTERNS = [
  /^\s*INSERT\s+/i,
  /^\s*UPDATE\s+/i,
  /^\s*DELETE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+/i,
  /^\s*GRANT\s+/i,
  /^\s*REVOKE\s+/i,
];

export interface QueryResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  fields?: Array<{ name: string; dataType: string }>;
  error?: string;
  warning?: string;
}

export class DatabaseAdapter {
  private credentials: DatabaseCredentials | null = null;

  connect(credentials: DatabaseCredentials): void {
    this.credentials = credentials;
  }

  /**
   * Detect database type from connection URL
   */
  getDbType(): 'postgres' | 'mysql' | 'unknown' {
    if (!this.credentials) return 'unknown';

    if (this.credentials.type) {
      return this.credentials.type;
    }

    const url = this.credentials.connectionUrl.toLowerCase();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return 'postgres';
    }
    if (url.startsWith('mysql://')) {
      return 'mysql';
    }
    return 'unknown';
  }

  /**
   * Check if a query is a mutation (INSERT, UPDATE, DELETE, etc.)
   */
  isMutationQuery(sql: string): boolean {
    return MUTATION_PATTERNS.some(pattern => pattern.test(sql.trim()));
  }

  /**
   * Analyze a query and return warnings
   */
  analyzeQuery(sql: string): { isMutation: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const isMutation = this.isMutationQuery(sql);

    if (isMutation) {
      const trimmed = sql.trim().toLowerCase();

      if (trimmed.startsWith('delete') && !trimmed.includes('where')) {
        warnings.push('DELETE without WHERE clause will affect all rows');
      }
      if (trimmed.startsWith('update') && !trimmed.includes('where')) {
        warnings.push('UPDATE without WHERE clause will affect all rows');
      }
      if (trimmed.startsWith('drop')) {
        warnings.push('DROP is destructive and cannot be undone');
      }
      if (trimmed.startsWith('truncate')) {
        warnings.push('TRUNCATE will remove all data from the table');
      }
    }

    return { isMutation, warnings };
  }

  /**
   * Execute a SQL query against Postgres
   */
  async queryPostgres(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    const client = new Client({
      connectionString: this.credentials.connectionUrl,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000, // 30 second query timeout
    });

    try {
      await client.connect();
      const result = await client.query(sql, params);

      return {
        success: true,
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        fields: result.fields?.map(f => ({
          name: f.name,
          dataType: String(f.dataTypeID),
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Execute a query (routes to appropriate database type)
   */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const dbType = this.getDbType();

    switch (dbType) {
      case 'postgres':
        return this.queryPostgres(sql, params);
      case 'mysql':
        return { success: false, error: 'MySQL support coming soon. Use postgres:// connections for now.' };
      default:
        return { success: false, error: `Unknown database type. URL should start with postgres:// or mysql://` };
    }
  }

  /**
   * Verify the connection works
   */
  async verify(): Promise<{ success: boolean; error?: string; version?: string }> {
    const dbType = this.getDbType();

    if (dbType === 'postgres') {
      const result = await this.queryPostgres('SELECT version()');
      if (result.success && result.rows?.[0]) {
        return { success: true, version: String(result.rows[0].version) };
      }
      return { success: false, error: result.error };
    }

    return { success: false, error: `Unsupported database type: ${dbType}` };
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'database',
    displayName: 'Database',
    category: 'database',
    credentialsSchema: DatabaseCredentialsSchema,
    setupHelpUrl: undefined,
  },
  factory: (credentials) => {
    const adapter = new DatabaseAdapter();
    adapter.connect(credentials as DatabaseCredentials);
    return adapter;
  },
});
