import pg from 'pg';
import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const { Client } = pg;

// Credentials schema for database connections
export const DatabaseCredentialsSchema = z.object({
  connectionUrl: z.string().min(1, 'Connection URL is required'),
  type: z.enum(['postgres']).optional().describe('Database type (auto-detected from URL if not specified)'),
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

/**
 * Strip string literals and comments so safety checks can't be evaded by
 * hiding keywords in comments/strings or prefixing statements with comments.
 * Handles -- line comments, nested block comments, '...' (with '' escapes),
 * "..." identifiers, and $tag$...$tag$ dollar quoting.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let result = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      result += ' ';
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      result += "''";
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      result += '""';
      continue;
    }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        result += "''";
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

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
  getDbType(): 'postgres' | 'unknown' {
    if (!this.credentials) return 'unknown';

    if (this.credentials.type) {
      return this.credentials.type;
    }

    const url = this.credentials.connectionUrl.toLowerCase();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return 'postgres';
    }
    return 'unknown';
  }

  /**
   * Check if a query is a mutation (INSERT, UPDATE, DELETE, etc.)
   * Comments and string literals are stripped first so keywords cannot be
   * hidden behind a leading comment or inside a data-modifying CTE.
   */
  isMutationQuery(sql: string): boolean {
    const stripped = stripSqlLiteralsAndComments(sql).trim();
    if (MUTATION_PATTERNS.some(pattern => pattern.test(stripped))) return true;
    // Data-modifying CTEs: WITH x AS (DELETE ... RETURNING *) SELECT ...
    if (/^WITH\b/i.test(stripped) && /\b(INSERT|UPDATE|DELETE)\b/i.test(stripped)) return true;
    // SELECT ... INTO creates a new table
    if (/^SELECT\b/i.test(stripped) && /\bINTO\b/i.test(stripped)) return true;
    return false;
  }

  /**
   * Check if SQL contains more than one statement (e.g. "SELECT 1; DROP TABLE x").
   */
  isMultiStatement(sql: string): boolean {
    const stripped = stripSqlLiteralsAndComments(sql);
    const semi = stripped.indexOf(';');
    if (semi === -1) return false;
    return stripped.slice(semi + 1).trim().length > 0;
  }

  /**
   * Analyze a query and return warnings
   */
  analyzeQuery(sql: string): { isMutation: boolean; multiStatement: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const isMutation = this.isMutationQuery(sql);
    const multiStatement = this.isMultiStatement(sql);

    if (isMutation) {
      const trimmed = stripSqlLiteralsAndComments(sql).trim().toLowerCase();

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

    return { isMutation, multiStatement, warnings };
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
      default:
        return { success: false, error: `Unknown database type. URL should start with postgres://` };
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
