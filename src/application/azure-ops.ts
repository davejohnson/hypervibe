import crypto from 'crypto';
import pg from 'pg';
import type { AzureEngineCredentials } from '../adapters/providers/azure/azure-engine.adapter.js';
import { azureSecretName } from '../adapters/providers/azure/tofu/azure-engine.config.js';

/**
 * The few Azure calls Hypervibe makes outside OpenTofu, all as the project's
 * deploy identity: Key Vault secrets, the app's database login, emptying
 * storage before teardown and confirming absence afterwards. Results keep
 * present, absent and unknown apart; errors never count as absence.
 */
type Fetch = typeof fetch;
export type AzureAccess = Pick<AzureEngineCredentials, 'tenantId' | 'clientId' | 'clientSecret'>;
export const ARM = 'https://management.azure.com';
export const AZURE_SCOPES = {
  arm: 'https://management.azure.com/.default',
  vault: 'https://vault.azure.net/.default',
  storage: 'https://storage.azure.com/.default',
  postgres: 'https://ossrdbms-aad.database.windows.net/.default',
} as const;

/** Client-credentials tokens for the deploy identity, one per resource, reused until five minutes before expiry. */
export class AzureTokens {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly access: AzureAccess, readonly fetchImpl: Fetch = fetch) {}

  async get(scope: string): Promise<string> {
    const cached = this.cache.get(scope);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const response = await this.fetchImpl(`https://login.microsoftonline.com/${this.access.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.access.clientId, client_secret: this.access.clientSecret, grant_type: 'client_credentials', scope }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !body.access_token) throw new Error(`Microsoft did not issue a deploy token for ${new URL(scope).host} (HTTP ${response.status}${body.error ? `, ${body.error}` : ''}).`);
    this.cache.set(scope, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }
}

export interface RestResult { status: number; body: Record<string, unknown> }

export async function azureRest(tokens: AzureTokens, scope: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<RestResult> {
  const response = await tokens.fetchImpl(url, {
    method, headers: { authorization: `Bearer ${await tokens.get(scope)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { text: text.slice(0, 2000) }; }
  return { status: response.status, body: parsed };
}

export function azureError(result: RestResult): string {
  const error = (result.body.error ?? {}) as { code?: string; message?: string };
  return `HTTP ${result.status}${error.code ? ` ${error.code}` : ''}${error.message ? `: ${String(error.message).slice(0, 240)}` : ''}`;
}

// ------------------------------------------------------------------ Key Vault

export interface AzureKeyVaultSecretStore {
  name: string;
  observe(key: string): Promise<'present' | 'absent' | { unknown: string }>;
  write(key: string, value: string): Promise<string | undefined>;
}

/**
 * One environment's secrets in the project Key Vault. Values only go in:
 * observe reports presence and discards the value unread.
 */
export function azureKeyVaultSecretStore(tokens: AzureTokens, vaultUri: string, nameFor: (key: string) => string = azureSecretName): AzureKeyVaultSecretStore {
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(vaultUri)) throw new Error('Key Vault address is invalid.');
  const call = async (method: string, key: string, body?: unknown) => tokens.fetchImpl(`${vaultUri}secrets/${nameFor(key)}?api-version=7.4`, {
    method, headers: { authorization: `Bearer ${await tokens.get(AZURE_SCOPES.vault)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
  return {
    name: 'Azure Key Vault',
    async observe(key) {
      try {
        const response = await call('GET', key);
        await response.body?.cancel();
        if (response.status === 200) return 'present';
        if (response.status === 404) return 'absent';
        return { unknown: `Key Vault could not be read (HTTP ${response.status}).` };
      } catch (error) {
        return { unknown: `Key Vault could not be read (${error instanceof Error ? error.name : 'error'}).` };
      }
    },
    async write(key, value) {
      try {
        const response = await call('PUT', key, { value, contentType: 'text/plain', tags: { 'managed-by': 'hypervibe' } });
        if (response.ok) { await response.body?.cancel(); return undefined; }
        const code = ((await response.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
        if (code === 'ObjectIsDeletedButRecoverable') return `${key} was deleted from Key Vault recently and cannot be written until its 7-day retention ends.`;
        return `Key Vault did not save ${key} (HTTP ${response.status}${code ? ` ${code}` : ''}).`;
      } catch (error) {
        return `Key Vault did not save ${key} (${error instanceof Error ? error.name : 'error'}).`;
      }
    },
  };
}

/** Deletes and purges every secret whose name starts with the prefix, so a recreated environment can reuse the names. */
export async function purgeVaultSecrets(tokens: AzureTokens, vaultUri: string, prefix: string): Promise<{ removed: number } | { error: string }> {
  const names: string[] = [];
  let next: string | undefined = `${vaultUri}secrets?api-version=7.4&maxresults=25`;
  while (next) {
    const page = await azureRest(tokens, AZURE_SCOPES.vault, 'GET', next);
    if (page.status !== 200) return { error: `Key Vault could not be listed (${azureError(page)}).` };
    for (const entry of (page.body.value ?? []) as Array<{ id?: string }>) {
      const name = entry.id?.split('/secrets/')[1]?.split('/')[0];
      if (name?.startsWith(prefix)) names.push(name);
    }
    next = typeof page.body.nextLink === 'string' ? page.body.nextLink : undefined;
  }
  for (const name of names) {
    const deleted = await azureRest(tokens, AZURE_SCOPES.vault, 'DELETE', `${vaultUri}secrets/${name}?api-version=7.4`);
    if (deleted.status !== 200 && deleted.status !== 404) return { error: `Key Vault did not delete ${name} (${azureError(deleted)}).` };
    // Deletion finishes in the background; purging before then reports a conflict.
    for (let attempt = 0; ; attempt++) {
      const purged = await azureRest(tokens, AZURE_SCOPES.vault, 'DELETE', `${vaultUri}deletedsecrets/${name}?api-version=7.4`);
      if (purged.status === 204 || purged.status === 200 || purged.status === 404 && attempt > 0) break;
      if (attempt >= 11) return { error: `Key Vault did not purge ${name} (${azureError(purged)}).` };
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
  return { removed: names.length };
}

// ------------------------------------------------------------------ PostgreSQL

/** A SCRAM-SHA-256 verifier, so the plaintext password never travels in SQL text. */
export function scramVerifier(password: string): string {
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Names of one environment's database and logins on a (possibly shared) server. */
export function azureDatabaseNames(environmentName: string): { database: string; login: string; waker: string } {
  const slug = environmentName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'env';
  return { database: `app_${slug}`, login: `app_${slug}`, waker: `waker_${slug}` };
}

export type SqlRunner = (database: string, statements: (query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<void>) => Promise<void>;

/**
 * Runs statements on the server as the deploy identity (its Entra administrator)
 * with a short-lived Entra token as the password, over TLS with the certificate
 * verified against the host name. Flexible Server has no SQL-over-HTTPS API.
 */
export function entraSqlRunner(tokens: AzureTokens, host: string, user: string): SqlRunner {
  return async (database, statements) => {
    const client = new pg.Client({
      host, port: 5432, database, user, password: await tokens.get(AZURE_SCOPES.postgres),
      ssl: { rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 30_000,
    });
    await client.connect();
    try { await statements((sql, values) => client.query(sql, values)); } finally { await client.end().catch(() => undefined); }
  };
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe SQL identifier ${name}.`);
  return name;
};

/**
 * Creates (or rotates) one environment's login and database on the server and
 * returns its connection URLs. Only its own logins may connect to its database,
 * so environments sharing a server cannot read each other's data.
 */
export async function ensureEnvironmentDatabase(sql: SqlRunner, params: { host: string; environmentName: string; waker: boolean }): Promise<{ databaseUrl: string; wakerUrl?: string }> {
  const names = azureDatabaseNames(params.environmentName);
  const login = ident(names.login); const database = ident(names.database); const waker = ident(names.waker);
  const password = crypto.randomBytes(24).toString('base64url');
  const wakerPassword = crypto.randomBytes(24).toString('base64url');
  await sql('postgres', async (query) => {
    const role = async (name: string, secret: string) => {
      const exists = (await query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rows.length > 0;
      await query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${name} LOGIN PASSWORD '${scramVerifier(secret)}'`);
    };
    await role(login, password);
    // The administrator must be a member to hand the database over to the login.
    await query(`GRANT ${login} TO CURRENT_USER`);
    if (!(await query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows.length) await query(`CREATE DATABASE ${database} OWNER ${login}`);
    else await query(`ALTER DATABASE ${database} OWNER TO ${login}`);
    await query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${login}`);
    if (params.waker) {
      await role(waker, wakerPassword);
      await query(`GRANT CONNECT ON DATABASE ${database} TO ${waker}`);
      await query(`GRANT pg_read_all_data TO ${waker}`);
    }
  });
  await sql(database, async (query) => { await query(`ALTER SCHEMA public OWNER TO ${login}`); });
  const url = (user: string, secret: string) => `postgresql://${user}:${secret}@${params.host}:5432/${database}?sslmode=require`;
  return { databaseUrl: url(login, password), ...(params.waker ? { wakerUrl: url(waker, wakerPassword) } : {}) };
}

/** Removes one environment's database and logins, leaving the rest of a shared server untouched. */
export async function dropEnvironmentDatabase(sql: SqlRunner, environmentName: string): Promise<void> {
  const names = azureDatabaseNames(environmentName);
  const database = ident(names.database);
  await sql('postgres', async (query) => {
    await query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [database]);
    await query(`DROP DATABASE IF EXISTS ${database}`);
    for (const role of [ident(names.login), ident(names.waker)]) await query(`DROP ROLE IF EXISTS ${role}`);
  });
}

// ------------------------------------------------------------------ Storage and absence

/** Deletes every blob in a container (shared keys are off, so this uses the deploy identity's data role). */
export async function emptyContainer(tokens: AzureTokens, account: string, container: string): Promise<{ deleted: number } | { gone: true } | { error: string }> {
  const base = `https://${account}.blob.core.windows.net/${container}`;
  const headers = { 'x-ms-version': '2023-11-03' };
  let deleted = 0;
  for (;;) {
    const listed = await tokens.fetchImpl(`${base}?restype=container&comp=list&maxresults=500`, { headers: { authorization: `Bearer ${await tokens.get(AZURE_SCOPES.storage)}`, ...headers }, signal: AbortSignal.timeout(60_000) });
    const text = await listed.text();
    if (listed.status === 404) return deleted ? { deleted } : { gone: true };
    if (listed.status !== 200) return { error: `Storage container ${container} could not be listed (HTTP ${listed.status}).` };
    const names = [...text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((match) => match[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\''));
    if (!names.length) return { deleted };
    for (const name of names) {
      const removed = await tokens.fetchImpl(`${base}/${name.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { authorization: `Bearer ${await tokens.get(AZURE_SCOPES.storage)}`, ...headers, 'x-ms-delete-snapshots': 'include' }, signal: AbortSignal.timeout(60_000) });
      await removed.body?.cancel();
      if (removed.status !== 202 && removed.status !== 404) return { error: `Could not delete ${name} from ${container} (HTTP ${removed.status}).` };
      deleted++;
    }
  }
}

/** Resources in the group still tagged for this environment; an unreadable answer is never "none". */
export async function taggedResources(tokens: AzureTokens, subscriptionId: string, resourceGroup: string, tag: string, value: string): Promise<string[] | { unknown: string }> {
  const filter = encodeURIComponent(`tagName eq '${tag}' and tagValue eq '${value}'`);
  let next: string | undefined = `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=2021-04-01&$filter=${filter}`;
  const found: string[] = [];
  while (next) {
    const page = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', next);
    if (page.status !== 200) return { unknown: `Hypervibe could not list the resource group (${azureError(page)}).` };
    found.push(...((page.body.value ?? []) as Array<{ name?: string }>).map((entry) => entry.name ?? '?'));
    next = typeof page.body.nextLink === 'string' ? page.body.nextLink : undefined;
  }
  return found;
}
