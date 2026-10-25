import pg from 'pg';
import { z } from 'zod';
import type { DatabaseAuthenticationEvidence } from '../../../domain/ports/database-authentication.port.js';

const tlsSchema = z.union([z.boolean(), z.object({
  rejectUnauthorized: z.boolean().optional(), ca: z.string().optional(),
  cert: z.string().optional(), key: z.string().optional(), servername: z.string().optional(),
}).strict()]);
const configurationSchema = z.object({
  connectionString: z.string().min(1), ssl: tlsSchema.optional(),
  application_name: z.string().optional(), options: z.string().optional(),
  client_encoding: z.string().optional(),
  enableChannelBinding: z.boolean().optional(),
}).strict();
const uriOptions = new Set(['sslmode', 'ssl', 'application_name', 'options', 'client_encoding']);
const result = (authentication: DatabaseAuthenticationEvidence['authentication'], identity: DatabaseAuthenticationEvidence['identity'],
  reason?: DatabaseAuthenticationEvidence['reason']): DatabaseAuthenticationEvidence => ({
  authentication, identity, ...(reason ? { reason } : {}), connection: 'fresh',
  deployedConfiguration: 'unchecked', applicationOperation: 'unchecked',
});

/** Uses the caller's exact node-postgres application URL/TLS/startup settings.
 * No provider APIs, alternate endpoints, password substitution, pooling, or
 * temporary access are used. Only fixed read-only identity SQL is executed. */
export async function verifyPostgresApplicationAuthentication(configuration: unknown,
  expected: { username: string; database: string }): Promise<DatabaseAuthenticationEvidence> {
  let client: pg.Client | undefined;
  try {
    const parsed = configurationSchema.safeParse(configuration);
    if (!parsed.success) return result('unknown', 'unchecked', 'unsupported_configuration');
    const input = parsed.data, url = new URL(input.connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password
      || url.pathname.length < 2 || url.hash || input.connectionString.trim() !== input.connectionString
      || input.connectionString.includes('${{')) return result('unknown', 'unchecked', 'configuration_invalid');
    if ([...url.searchParams.keys()].some(key => !uriOptions.has(key))
      || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)
      || (url.searchParams.has('sslmode') && !['disable', 'require', 'verify-full', 'no-verify'].includes(url.searchParams.get('sslmode')!))
      || (url.searchParams.has('ssl') && !['true', 'false', '1', '0', 'no-verify'].includes(url.searchParams.get('ssl')!))) {
      return result('unknown', 'unchecked', 'unsupported_configuration');
    }
    if (decodeURIComponent(url.username) !== expected.username || decodeURIComponent(url.pathname.slice(1)) !== expected.database) {
      return result('unknown', 'mismatch', 'configuration_identity_mismatch');
    }
    // node-postgres inherits unspecified values from PG* variables. The verifier
    // cannot silently use this process's options in place of the application's.
    const inherited = [['PGOPTIONS', 'options'], ['PGAPPNAME', 'application_name'], ['PGCLIENT_ENCODING', 'client_encoding']] as const;
    if (inherited.some(([key, option]) => process.env[key] && !input[option] && !url.searchParams.has(option))
      || process.env.PGREPLICATION || (!url.port && process.env.PGPORT && process.env.PGPORT !== '5432')
      || (process.env.PGSSLMODE && input.ssl === undefined && !url.searchParams.has('sslmode') && !url.searchParams.has('ssl'))) {
      return result('unknown', 'unchecked', 'configuration_environment_conflict');
    }
    client = new pg.Client({ ssl: false, ...input, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
    // Do not let asynchronous connection errors escape as process-level errors.
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const response = await client.query('SELECT session_user AS username, current_user AS active_user, current_database() AS database');
    await client.query('ROLLBACK');
    const match = response.rows.length === 1 && response.rows[0].username === expected.username
      && response.rows[0].active_user === expected.username && response.rows[0].database === expected.database;
    return match ? result('authenticated', 'match') : result('unknown', 'mismatch', 'identity_mismatch');
  } catch (error) {
    // Parser, TLS and provider errors can echo credentials. Only SQLSTATE's
    // closed authentication category leaves this boundary.
    return error && typeof error === 'object' && 'code' in error && error.code === '28P01'
      ? result('rejected', 'unchecked', 'invalid_password')
      : result('unknown', 'unchecked', client ? 'connection_failed' : 'configuration_invalid');
  } finally { await client?.end().catch(() => {}); }
}
