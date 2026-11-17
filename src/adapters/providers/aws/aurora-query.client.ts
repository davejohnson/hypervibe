import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand, type Field, type SqlParameter } from '@aws-sdk/client-rds-data';
import type { DatabaseQueryOptions, DatabaseQueryResult } from '../../../domain/ports/database-query.port.js';
import { analyzeSqlQuery } from '../../../domain/services/sql-query-analysis.js';
import type { AwsAccess } from './aws-engine.client.js';

/** Translate positional parameters only in executable SQL, never quoted text or comments. */
export function auroraParameters(sql: string, values: unknown[] = []): { sql: string; parameters: SqlParameter[] } {
  let result = ''; let i = 0; const used = new Set<number>();
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; }
    else if (sql.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]!;
      const escaped = quote === "'" && /[eE]/.test(sql[start - 1] ?? '') && !/[\w$]/.test(sql[start - 2] ?? '');
      while (i < sql.length) { if (escaped && sql[i] === '\\') { i += 2; continue; } if (sql[i++] === quote) { if (sql[i] === quote) i++; else break; } }
    } else {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) { const end = sql.indexOf(tag, i + tag.length); i = end < 0 ? sql.length : end + tag.length; }
      else {
        const position = sql.slice(i).match(/^\$(\d+)/);
        if (position) {
          const index = Number(position[1]);
          if (index < 1 || index > values.length) throw new Error('A SQL positional parameter has no supplied value.');
          used.add(index); result += `:hv${index}`; i += position[0].length; continue;
        }
        i++;
      }
    }
    result += sql.slice(start, i);
  }
  if (used.size !== values.length) throw new Error('SQL parameters must match the referenced positional values.');
  const field = (value: unknown): Field => {
    if (value === null) return { isNull: true };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number' && Number.isFinite(value)) return Number.isSafeInteger(value) ? { longValue: value } : { doubleValue: value };
    throw new Error('Aurora Data API accepts scalar string, number, boolean or null query parameters.');
  };
  return { sql: result, parameters: values.map((value, index) => ({ name: `hv${index + 1}`, value: field(value) })) };
}

/** No passwords leave Secrets Manager. Every statement uses the exact environment database and a bounded transaction. */
export class AuroraQueryClient {
  private readonly client: RDSDataClient;
  private pending = new Set<string>();
  private cleanupUnknown = false;
  constructor(access: AwsAccess, private readonly target: { clusterArn: string; secretArn: string; database: string; owner: string }) {
    this.client = new RDSDataClient({ ...access, maxAttempts: 1 });
  }
  private get identity() { return { resourceArn: this.target.clusterArn, secretArn: this.target.secretArn, database: this.target.database }; }
  private async begin(): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try { return (await this.client.send(new BeginTransactionCommand(this.identity), { abortSignal: AbortSignal.timeout(30_000) })).transactionId; }
      catch (error) {
        // AWS documents this as a rejected request that starts resuming an idle cluster. Never retry an ambiguous transaction start.
        if (!(error instanceof Error && error.name === 'DatabaseResumingException') || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
    }
  }
  async query(sql: string, values?: unknown[], options: DatabaseQueryOptions = {}): Promise<DatabaseQueryResult> {
    const analysis = analyzeSqlQuery(sql);
    if (analysis.multiStatement || options.readOnly !== false && analysis.isMutation) return { success: false, error: 'Only one read-only statement is permitted without mutation authority.' };
    let statement: ReturnType<typeof auroraParameters>;
    try { statement = auroraParameters(sql, values); } catch (error) { return { success: false, error: (error as Error).message }; }
    let transactionId: string | undefined;
    let began = false;
    try {
      began = true;
      transactionId = await this.begin();
      if (!transactionId || transactionId.length > 192) throw new Error('Missing transaction identity.');
      this.pending.add(transactionId);
      const execute = (statementSql: string, extra = {}) => this.client.send(new ExecuteStatementCommand({ ...this.identity, transactionId, sql: statementSql, ...extra }), { abortSignal: AbortSignal.timeout(35_000) });
      if (options.readOnly !== false) await execute('SET TRANSACTION READ ONLY');
      const identity = await execute('SELECT session_user AS session_user, current_user AS current_user, current_database() AS database', { formatRecordsAs: 'JSON' });
      const authenticated: unknown = JSON.parse(identity.formattedRecords ?? 'null');
      if (!Array.isArray(authenticated) || authenticated.length !== 1 || authenticated[0]?.session_user !== this.target.owner
        || authenticated[0]?.current_user !== this.target.owner || authenticated[0]?.database !== this.target.database) throw new Error('The Data API session did not authenticate as the accepted application login.');
      const timeout = Math.min(30_000, Math.max(1, Math.floor(options.statementTimeoutMs ?? 30_000)));
      await execute(`SET LOCAL statement_timeout = ${timeout}`);
      const response = await execute(statement.sql, { parameters: statement.parameters, formatRecordsAs: 'JSON', includeResultMetadata: true, resultSetOptions: { longReturnType: 'STRING', decimalReturnType: 'STRING' } });
      const scalar = (field: Field): unknown => {
        if (field.isNull === true) return null;
        if (field.stringValue !== undefined) return field.stringValue;
        if (field.booleanValue !== undefined) return field.booleanValue;
        if (field.longValue !== undefined) { if (!Number.isSafeInteger(field.longValue)) throw new Error('Unsafe numeric result.'); return field.longValue; }
        if (field.doubleValue !== undefined && Number.isFinite(field.doubleValue)) return field.doubleValue;
        throw new Error('Unsupported result value.');
      };
      const records = response.records?.map(record => {
        const columns = response.columnMetadata;
        if (!columns || columns.length !== record.length || columns.some(column => !column.name) || new Set(columns.map(column => column.name)).size !== columns.length) throw new Error('Incomplete result metadata.');
        return Object.fromEntries(record.map((field, index) => [columns[index]!.name!, scalar(field)]));
      });
      const text = response.formattedRecords ?? JSON.stringify(records ?? []);
      const maxBytes = Math.min(512 * 1024, options.maxResponseBytes ?? 512 * 1024);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) return { success: false, error: `Query result exceeded the ${maxBytes}-byte diagnostic response limit.` };
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Malformed result.');
      const maxRows = Math.min(500, options.maxRows ?? 500);
      if (rows.length > maxRows) return { success: false, error: `Query result exceeded the ${maxRows}-row diagnostic limit. Add a narrower WHERE clause or LIMIT.` };
      if (options.readOnly === false) {
        const committed = await this.client.send(new CommitTransactionCommand({ ...this.identity, transactionId }), { abortSignal: AbortSignal.timeout(30_000) });
        if (committed.transactionStatus !== 'Transaction Committed') throw new Error('Unconfirmed transaction commit.');
        this.pending.delete(transactionId); transactionId = undefined;
      }
      return { success: true, rows, rowCount: rows.length || response.numberOfRecordsUpdated || 0,
        fields: Object.keys(rows[0] ?? {}).map(name => ({ name, dataType: 'unknown' })) };
    } catch (error) {
      if (began && !transactionId && !(error instanceof Error && error.name === 'DatabaseResumingException')) this.cleanupUnknown = true;
      return { success: false, error: options.readOnly === false
        ? 'Aurora query failed or its result could not be verified. A submitted mutation may have committed; inspect its outcome before retrying.'
        : 'Aurora read-only query failed or its result could not be verified. Check access and SQL before retrying.' };
    }
    finally { if (transactionId) await this.rollback(transactionId); }
  }
  private async rollback(transactionId: string): Promise<void> {
    try {
      const response = await this.client.send(new RollbackTransactionCommand({ ...this.identity, transactionId }), { abortSignal: AbortSignal.timeout(30_000) });
      if (response.transactionStatus === 'Rollback Complete') this.pending.delete(transactionId);
    } catch { /* The lease reports unverified cleanup, retaining the exact transaction for one final attempt. */ }
  }
  async release(): Promise<boolean> {
    for (const transactionId of this.pending) await this.rollback(transactionId);
    const clean = this.pending.size === 0 && !this.cleanupUnknown; this.client.destroy(); return clean;
  }
}
