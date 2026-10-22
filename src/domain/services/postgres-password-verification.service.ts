import { Client } from 'pg';
import { databasePasswordEndpointSchema, type DatabasePasswordAuthentication,
  type DatabasePasswordEndpoint } from '../ports/database-password-rotation.port.js';

/** A fresh, verified-TLS login. Never uses the process PG* defaults or a pool.
 * Only PostgreSQL invalid_password during connection proves password rejection.
 * Do not return driver errors: they can include credentials and remote labels. */
export async function verifyPostgresPassword(
  endpoint: DatabasePasswordEndpoint,
  password: string,
  options: { ca?: string; timeoutMs?: number } = {},
): Promise<DatabasePasswordAuthentication> {
  if (!databasePasswordEndpointSchema.safeParse(endpoint).success || !password
    || process.env.PGOPTIONS?.trim() || process.env.PGREPLICATION?.trim()
    || /[\s/\\\0]/.test(endpoint.host)) return { status: 'unknown', reason: 'invalid_target' };
  const timeout = Math.min(10_000, Math.max(100, options.timeoutMs ?? 5000));
  const client = new Client({ host: endpoint.host, port: endpoint.port, user: endpoint.username,
    database: endpoint.database, password, ssl: { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
    connectionTimeoutMillis: timeout, query_timeout: timeout,
    application_name: 'hypervibe-password-verification' });
  client.on('error', () => { /* The bounded query/connect result carries safe failure state. */ });
  try {
    try { await client.connect(); } catch (error) {
      return error && typeof error === 'object' && 'code' in error && error.code === '28P01'
        ? { status: 'rejected', reason: 'password_rejected' }
        : { status: 'unknown', reason: 'authentication_unknown' };
    }
    const result = await client.query('SELECT current_user::text AS username, current_database()::text AS database');
    if (result.rows.length !== 1 || result.rows[0]?.username !== endpoint.expectedRole
      || result.rows[0]?.database !== endpoint.database) return { status: 'unknown', reason: 'identity_mismatch' };
    return { status: 'accepted' };
  } catch {
    return { status: 'unknown', reason: 'authentication_unknown' };
  } finally { await client.end().catch(() => {}); }
}
