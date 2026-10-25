import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { IDatabaseAdapter } from '../../../domain/ports/database.port.js';
import type { DatabaseCredentialLifecycle, DatabaseCredentialSelection, DatabaseCredentialTarget, DatabaseCredentialUpdate } from '../../../domain/ports/database-credential.port.js';
import type { TemporaryDatabaseAccess } from '../../../domain/ports/provider.port.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;

import { replaceDatabasePassword } from '../../../domain/services/database-credential-value.js';
export { replaceDatabasePassword, replaceDatabaseCredentialBindings } from '../../../domain/services/database-credential-value.js';

type NativeOptions = {
  /** SQL-only opt-in: never send the replacement as a logged Bind parameter. */
  passwordEncoding?: 'scram-sha-256';
  inputMode?: 'supplied' | 'provider-generated';
  identity?: (component: Component) => Promise<{ inputMode: 'supplied' | 'provider-generated'; providerScope?: Record<string, string> }>;
  validateInspection?: (environment: Environment, component: Component) => Promise<void>;
  connectionUrl?: (environment: Environment, component: Component) => Promise<string | null>;
  readCurrent?: (component: Component, target: DatabaseCredentialTarget) => Promise<string | null>;
  rotate?: (component: Component, target: DatabaseCredentialTarget, replacement?: string) => Promise<DatabaseCredentialUpdate | undefined>;
  /** Update provider-owned issuer metadata after SQL authentication changes. */
  synchronizeIssuer?: (environment: Environment, component: Component, replacement: string) => Promise<void>;
  inspectIssuer?: (environment: Environment, component: Component, replacement: string) => Promise<'match' | 'different' | 'unknown'>;
};

/** PostgreSQL's scram_build_secret algorithm and defaults, pinned to REL_17_6:
 * https://github.com/postgres/postgres/blob/REL_17_6/src/common/scram-common.c
 * https://github.com/postgres/postgres/blob/REL_17_6/src/include/common/scram-common.h
 * ASCII URL-safe input is unchanged by SASLprep; other input is rejected rather
 * than inventing a Unicode normalization contract. This private verifier can
 * still be logged by PostgreSQL, but plaintext never enters SQL or its Bind.
 */
function postgresScramVerifier(password: string): string {
  if (!/^[A-Za-z0-9._~-]+$/.test(password)) throw new Error('Unsupported PostgreSQL password encoding.');
  const salt = randomBytes(16);
  const passwordBytes = Buffer.from(password, 'ascii');
  let salted: Buffer | undefined, client: Buffer | undefined, stored: Buffer | undefined, server: Buffer | undefined;
  try {
    salted = pbkdf2Sync(passwordBytes, salt, 4096, 32, 'sha256');
    client = createHmac('sha256', salted).update('Client Key', 'ascii').digest();
    stored = createHash('sha256').update(client).digest();
    server = createHmac('sha256', salted).update('Server Key', 'ascii').digest();
    return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored.toString('base64')}:${server.toString('base64')}`;
  } finally {
    passwordBytes.fill(0); salted?.fill(0); client?.fill(0); stored?.fill(0); server?.fill(0);
  }
}

/** Common PostgreSQL proof/recovery boundary; providers own native reset APIs.
 * Inspection is read-only. Only apply/probe acquire existing operation-scoped
 * database access, with the provider's existing cleanup contract. */
export function createPostgresCredentialLifecycle(adapterFor: () => IDatabaseAdapter, native: NativeOptions = {}): DatabaseCredentialLifecycle {
  async function inspect(environment: Environment, component: Component, selection: DatabaseCredentialSelection): Promise<DatabaseCredentialTarget> {
    const adapter = adapterFor();
    if (component.id !== selection.component || component.environmentId !== environment.id || environment.name !== selection.environment
      || component.type !== 'postgres' || component.bindings.provider !== adapter.name || !component.externalId) throw new Error('Database identity does not match the reviewed environment/component.');
    const observed = await adapter.observeDatabase(environment, component);
    if (!observed || observed.externalId !== component.externalId || observed.engine !== 'postgres' || observed.provider !== adapter.name) throw new Error('The exact native database identity is absent or unknown.');
    if (native.validateInspection) await native.validateInspection(environment, component);
    const url = native.connectionUrl ? await native.connectionUrl(environment, component) : await adapter.getConnectionUrl(component);
    const direct = text(component.bindings.directUrl) ?? url;
    if (!direct) throw new Error('The bound database connection identity is unavailable.');
    let parsed: URL;
    try { parsed = new URL(direct); } catch { throw new Error('The bound database connection identity is invalid.'); }
    const username = text(component.bindings.username) ?? decodeURIComponent(parsed.username);
    const database = text(component.bindings.database) ?? decodeURIComponent(parsed.pathname.slice(1));
    if (username !== selection.username || database !== selection.database || decodeURIComponent(parsed.pathname.slice(1)) !== database
      || !['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Database user or database identity differs from the reviewed selection.');
    const scope = record(component.bindings.providerScope);
    const providerScope = Object.fromEntries(Object.entries(scope).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    for (const key of ['branchId', 'endpointId', 'environmentId', 'projectId', 'organizationSlug']) {
      const value = text(component.bindings[key]);
      if (value) providerScope[key] = value;
    }
    if (!Object.keys(providerScope).length) throw new Error('Database native account scope is missing.');
    const nativeIdentity = native.identity ? await native.identity(component) : undefined;
    Object.assign(providerScope, nativeIdentity?.providerScope);
    return { provider: adapter.name, componentId: component.id, environmentId: environment.id, externalId: component.externalId,
      username, database, providerScope, inputMode: nativeIdentity?.inputMode ?? native.inputMode ?? 'supplied',
      connection: { host: parsed.hostname, port: Number(parsed.port || 5432), username: decodeURIComponent(parsed.username), database } };
  }
  async function verifyTarget(environment: Environment, component: Component, target: DatabaseCredentialTarget) {
    if (!isDeepStrictEqual(await inspect(environment, component, { environment: environment.name, component: target.componentId, username: target.username, database: target.database }), target)) throw new Error('Database target identity changed after review.');
  }
  async function connection<T>(environment: Environment, component: Component, operation: (url: string) => Promise<T>): Promise<T> {
    const adapter = adapterFor();
    let access: TemporaryDatabaseAccess | undefined;
    try {
      if (adapter.capabilities.supportsTemporaryDatabaseAccess && adapter.acquireTemporaryDatabaseAccess && adapter.releaseTemporaryDatabaseAccess) {
        access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);
      }
      const url = access?.connectionUrl ?? text(component.bindings.directUrl) ?? (native.connectionUrl ? await native.connectionUrl(environment, component) : await adapter.getConnectionUrl(component));
      if (!url) throw new Error('Database connection unavailable.');
      return await operation(url);
    } finally {
      if (access?.temporary) await adapter.releaseTemporaryDatabaseAccess!(environment, component, access);
    }
  }
  const clientFor = (url: string) => {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 15000, query_timeout: 15000 });
    // pg also emits connection loss independently of the rejected query. Keep
    // that event inside this bounded operation; query/connect still determine
    // unknown versus acknowledged and no provider error escapes to output.
    client.on('error', () => {});
    return client;
  };
  const port: DatabaseCredentialLifecycle = {
    inspect,
    async readCurrent(environment, component, target) {
      await verifyTarget(environment, component, target);
      try { return native.readCurrent ? await native.readCurrent(component, target) : null; }
      catch { throw new Error('The exact database user password could not be read for recovery.'); }
    },
    async probe(environment, component, target, replacement) {
      const tested = 'Fresh PostgreSQL password authentication, session user and database identity; application queries and existing sessions were not tested.';
      try {
        await verifyTarget(environment, component, target);
        return await connection(environment, component, async original => {
          const parsed = new URL(original);
          const candidate = replaceDatabasePassword(original, replacement, { username: decodeURIComponent(parsed.username), database: target.database });
          const client = clientFor(candidate);
          // AuthenticationOk alone can mean trust/peer/certificate access. A
          // native replacement proof requires the actual driver's password
          // challenge followed by a completed authenticated connection.
          let passwordChallenge = false;
          client.connection.once('authenticationCleartextPassword', () => { passwordChallenge = true; });
          client.connection.once('authenticationMD5Password', () => { passwordChallenge = true; });
          client.connection.once('authenticationSASL', (message: { mechanisms?: string[] }) => {
            passwordChallenge = message.mechanisms?.some(value => value === 'SCRAM-SHA-256' || value === 'SCRAM-SHA-256-PLUS') === true;
          });
          try {
            await client.connect();
            if (!passwordChallenge) return { state: 'unknown', tested };
            const response = await client.query('SELECT session_user AS username, current_database() AS database');
            return { state: response.rows.length === 1 && response.rows[0].username === target.username && response.rows[0].database === target.database ? 'authenticated' as const : 'unknown' as const, tested };
          } finally { await client.end().catch(() => {}); }
        });
      } catch (error) { return { state: record(error).code === '28P01' ? 'rejected' : 'unknown', tested }; }
    },
    async rotate(environment, component, target, replacement) {
      let attempted = false;
      try {
        await verifyTarget(environment, component, target);
        if (native.passwordEncoding === 'scram-sha-256' && (!replacement || !/^[A-Za-z0-9._~-]+$/.test(replacement))) return { state: 'blocked' };
        if (native.rotate) {
          attempted = true;
          const result = await native.rotate(component, target, replacement);
          if (result) return result;
          attempted = false;
        }
        if (!replacement || replacement.includes('\0')) return { state: 'blocked' };
        const sqlPassword = native.passwordEncoding === 'scram-sha-256' ? postgresScramVerifier(replacement) : replacement;
        await connection(environment, component, async url => {
          const client = clientFor(url);
          try {
            await client.connect();
            const identity = await client.query('SELECT session_user AS username, current_database() AS database');
            if (identity.rows.length !== 1 || identity.rows[0].username !== target.username || identity.rows[0].database !== target.database) throw new Error('Database authenticated identity changed.');
            await client.query('BEGIN');
            await client.query("SELECT set_config('hypervibe.credential_rotation_password', $1, true)", [sqlPassword]);
            attempted = true;
            await client.query("DO $hypervibe$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L', session_user, current_setting('hypervibe.credential_rotation_password')); END $hypervibe$");
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
          finally { await client.end().catch(() => {}); }
        });
        return { state: 'acknowledged' };
      } catch { return { state: attempted ? 'unknown' : 'blocked' }; }
    },
    async finalize(environment, component, target, replacement) {
      try {
        await verifyTarget(environment, component, target);
        if (native.synchronizeIssuer) await native.synchronizeIssuer(environment, component, replacement);
        return { state: 'acknowledged' };
      } catch { return { state: 'unknown' }; }
    },
    async inspectIssuer(environment, component, target, replacement) {
      try { await verifyTarget(environment, component, target); return native.inspectIssuer ? await native.inspectIssuer(environment, component, replacement) : 'match'; }
      catch { return 'unknown'; }
    },
  };
  return port;
}
