import { scramVerifier } from '../../../utils/scram.js';
import crypto from 'crypto';
import type { AzureEngineCredentials } from './azure-engine.adapter.js';
import { azureSecretName } from './tofu/azure-engine.config.js';

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

export interface AzureTokenProvider { get(scope: string): Promise<string>; readonly fetchImpl: typeof fetch }

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

export async function azureRest(tokens: AzureTokenProvider, scope: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<RestResult> {
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
  /** Only the owner's local reveal page may receive this value. */
  read(key: string): Promise<{ value: string } | { error: string }>;
}

/**
 * One environment's secrets in the project Key Vault. Observation reads metadata
 * only; a secret value is fetched separately when the owner clicks the local page.
 */
export function azureKeyVaultSecretStore(tokens: AzureTokenProvider, vaultUri: string, nameFor: (key: string) => string = azureSecretName): AzureKeyVaultSecretStore {
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(vaultUri)) throw new Error('Key Vault address is invalid.');
  const secretUrl = (key: string) => `${vaultUri}secrets/${encodeURIComponent(nameFor(key))}`;
  const hasVersion = (id: unknown, key: string): boolean => typeof id === 'string'
    && id.startsWith(`${secretUrl(key)}/`) && /^[^/?#]+$/.test(id.slice(secretUrl(key).length + 1));
  const call = async (method: string, key: string, body?: unknown) => tokens.fetchImpl(`${secretUrl(key)}?api-version=7.4`, {
    method, headers: { authorization: `Bearer ${await tokens.get(AZURE_SCOPES.vault)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
  return {
    name: 'Azure Key Vault',
    async observe(key) {
      try {
        // List Secrets gives current/base metadata without values. Listing versions
        // cannot prove the current value is enabled because their order is undefined.
        let next = `${vaultUri}secrets?api-version=7.4&maxresults=25`;
        const visited = new Set<string>();
        while (visited.size < 100 && !visited.has(next)) {
          const url = new URL(next);
          if (url.origin !== new URL(vaultUri).origin || url.pathname !== '/secrets' || url.username || url.password || url.hash) break;
          visited.add(next);
          const response = await tokens.fetchImpl(next, {
            method: 'GET', headers: { authorization: `Bearer ${await tokens.get(AZURE_SCOPES.vault)}` }, signal: AbortSignal.timeout(20_000),
          });
          if (response.status !== 200) {
            await response.body?.cancel();
            return { unknown: `Key Vault could not be read (HTTP ${response.status}).` };
          }
          const body = await response.json() as { value?: Array<{ id?: unknown; attributes?: { enabled?: unknown } }>; nextLink?: unknown };
          if (!Array.isArray(body?.value) || body.value.some((item) => typeof item?.id !== 'string'
            || !item.id.startsWith(`${vaultUri}secrets/`) || !/^[A-Za-z0-9-]+$/.test(item.id.slice(`${vaultUri}secrets/`.length)))) break;
          const current = body.value.find((item) => item.id === secretUrl(key));
          if (current) return current.attributes?.enabled === true ? 'present' : { unknown: 'The current Key Vault secret is disabled or its enabled state is unknown.' };
          if (body.nextLink == null) return 'absent';
          if (typeof body.nextLink !== 'string' || !body.nextLink) break;
          next = body.nextLink;
        }
        return { unknown: 'Key Vault did not return complete secret metadata.' };
      } catch {
        return { unknown: 'Key Vault could not be read.' };
      }
    },
    async read(key) {
      try {
        const response = await call('GET', key);
        if (response.status !== 200) {
          await response.body?.cancel();
          return { error: `Key Vault could not read the secret value (HTTP ${response.status}).` };
        }
        const body = await response.json() as { id?: unknown; value?: unknown };
        if (!hasVersion(body?.id, key) || typeof body.value !== 'string' || !body.value) {
          return { error: 'Key Vault did not return the requested secret value.' };
        }
        return { value: body.value };
      } catch {
        return { error: 'Key Vault could not read the secret value.' };
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
export async function purgeVaultSecrets(tokens: AzureTokenProvider, vaultUri: string, prefix: string): Promise<{ removed: number } | { error: string }> {
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

/** Names of one environment's database and logins on a (possibly shared) server. */
export function azureDatabaseNames(environmentName: string): { database: string; login: string; waker: string } {
  const slug = environmentName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'env';
  return { database: `app_${slug}`, login: `app_${slug}`, waker: `waker_${slug}` };
}

/**
 * Microsoft's own PostgreSQL image (Azure Linux) from Microsoft's registry, pinned by digest.
 * Only its psql client is used.
 */
export const AZURE_SETUP_IMAGE = 'mcr.microsoft.com/azurelinux/base/postgres@sha256:c1a4225eedf956a6ec2152efcf250aee3fec8281ffb3db6ee2b2a2b8b5a69f21';
const APPS_API = 'api-version=2024-03-01';
/** A new server's Entra administrator takes a minute to be usable, so the job waits for a connection before it runs the script. */
const SETUP_COMMAND = 'n=0; until psql -qAtc "select 1" >/dev/null 2>&1 || [ "$n" -ge 12 ]; do n=$((n+1)); sleep 10; done; printf "%s" "$HV_SETUP_SQL" | psql -q -v ON_ERROR_STOP=1 -f -';

export interface AzureSetupJob {
  /** ARM id of the job to create and delete; one per environment, so two environments can set up at once. */
  id: string;
  /** The Container Apps environment inside the project's private network. */
  environmentId: string;
  host: string;
  /** The deploy identity's name, which is its PostgreSQL administrator login. */
  user: string;
}

/**
 * Flexible Server has no SQL-over-HTTPS API, and the server is never opened to
 * the internet. Setup SQL runs where the apps run: Hypervibe creates a one-off
 * Container Apps job in the project's private network, starts it, waits for it
 * to finish and deletes it. The job logs in as the deploy identity with a
 * short-lived Entra token; the token and the script are job secrets, which
 * Azure never returns. The job is deleted whatever happened, and a failure to
 * delete it is an error.
 */
export async function runAzureSetupSql(tokens: AzureTokenProvider, job: AzureSetupJob, script: string, options: { pollMs?: number } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 5000;
  const wait = () => new Promise((done) => setTimeout(done, pollMs));
  const url = `${ARM}${job.id}?${APPS_API}`;
  const name = job.id.split('/').at(-1)!;
  const remove = async (): Promise<string | undefined> => {
    let last = 'Azure did not answer';
    for (let attempt = 0; attempt < 3; attempt++) {
      const deleted = await azureRest(tokens, AZURE_SCOPES.arm, 'DELETE', url).catch(() => undefined);
      if (deleted && [204, 404].includes(deleted.status)) return undefined;
      if (deleted && [200, 202].includes(deleted.status)) {
        for (let poll = 0; poll < 60; poll++) {
          const read = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', url).catch(() => undefined);
          if (read?.status === 404) return undefined;
          await wait();
        }
        last = 'Azure did not confirm the deletion in time';
      } else if (deleted) last = azureError(deleted);
      await wait();
    }
    return last;
  };
  const stale = await remove();
  if (stale) throw new Error(`Hypervibe could not remove an earlier database setup job, ${name} (${stale}).`);
  let failure: unknown;
  try {
    // A job must be in its environment's region, which is the shared network's and not always the app's.
    const environment = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${job.environmentId}?${APPS_API}`);
    if (environment.status !== 200 || typeof environment.body.location !== 'string') throw new Error(`Hypervibe could not read the project's Container Apps environment (${azureError(environment)}).`);
    const created = await azureRest(tokens, AZURE_SCOPES.arm, 'PUT', url, { location: environment.body.location, properties: {
      environmentId: job.environmentId, workloadProfileName: 'Consumption',
      configuration: { triggerType: 'Manual', replicaTimeout: 600, replicaRetryLimit: 0, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
        secrets: [{ name: 'token', value: await tokens.get(AZURE_SCOPES.postgres) }, { name: 'script', value: script }] },
      template: { containers: [{ name: 'setup', image: AZURE_SETUP_IMAGE, command: ['/bin/sh', '-c', SETUP_COMMAND], resources: { cpu: 0.25, memory: '0.5Gi' },
        env: [{ name: 'PGHOST', value: job.host }, { name: 'PGPORT', value: '5432' }, { name: 'PGUSER', value: job.user }, { name: 'PGDATABASE', value: 'postgres' },
          // The certificate is verified against the host name with the image's own trusted roots.
          { name: 'PGSSLMODE', value: 'verify-full' }, { name: 'PGSSLROOTCERT', value: 'system' }, { name: 'PGCONNECT_TIMEOUT', value: '15' },
          { name: 'PGPASSWORD', secretRef: 'token' }, { name: 'HV_SETUP_SQL', secretRef: 'script' }] }] },
    } });
    if (![200, 201].includes(created.status)) throw new Error(`Hypervibe could not create the database setup job (${azureError(created)}).`);
    for (let attempt = 0; ; attempt++) {
      const read = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', url);
      const state = (read.body.properties as { provisioningState?: string } | undefined)?.provisioningState;
      if (read.status === 200 && state === 'Succeeded') break;
      if (state === 'Failed' || state === 'Canceled' || attempt >= 60) throw new Error(`Azure did not finish creating the database setup job${state ? ` (${state})` : ''}.`);
      await wait();
    }
    const started = await azureRest(tokens, AZURE_SCOPES.arm, 'POST', `${ARM}${job.id}/start?${APPS_API}`);
    const execution = started.body.name;
    if (![200, 202].includes(started.status) || typeof execution !== 'string') throw new Error(`Hypervibe could not start the database setup job (${azureError(started)}).`);
    for (let attempt = 0; ; attempt++) {
      const read = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${job.id}/executions?${APPS_API}`);
      const status = ((read.body.value ?? []) as Array<{ name?: string; properties?: { status?: string } }>).find((entry) => entry.name === execution)?.properties?.status;
      if (status === 'Succeeded') break;
      if (status === 'Failed' || status === 'Stopped' || status === 'Degraded') throw new Error(`The database setup job ${status === 'Failed' ? 'failed' : `ended as ${status}`}. Its output is in the project's Container Apps logs under ${name}.`);
      if (attempt >= 180) throw new Error(`The database setup job did not finish in time${status ? ` (${status})` : ''}.`);
      await wait();
    }
  } catch (error) { failure = error; }
  const left = await remove();
  if (left) throw new Error(`${failure instanceof Error ? `${failure.message} ` : ''}Hypervibe could not delete the database setup job ${name} (${left}). It holds a login token that expires within the hour; run hv_plan and hv_apply again to remove it.`);
  if (failure) throw failure;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe SQL identifier ${name}.`);
  return name;
};

/**
 * The psql script that creates (or rotates) one environment's login and
 * database on the server, and the connection URLs it makes valid. Only its own
 * logins may connect to its database, so environments sharing a server cannot
 * read each other's data. Passwords appear in the script only as SCRAM verifiers.
 */
export function environmentDatabaseSetup(params: { host: string; environmentName: string; waker: boolean }): { script: string; databaseUrl: string; wakerUrl?: string } {
  const names = azureDatabaseNames(params.environmentName);
  const login = ident(names.login); const database = ident(names.database); const waker = ident(names.waker);
  const password = crypto.randomBytes(24).toString('base64url');
  const wakerPassword = crypto.randomBytes(24).toString('base64url');
  const role = (name: string, secret: string) => {
    const verifier = scramVerifier(secret);
    if (!/^[A-Za-z0-9+/=$:-]+$/.test(verifier)) throw new Error('Unexpected SCRAM verifier format.');
    return `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN 'ALTER' ELSE 'CREATE' END || ' ROLE ${name} LOGIN PASSWORD ''${verifier}''' \\gexec`;
  };
  const script = [
    role(login, password),
    // The administrator must be a member to hand the database over to the login.
    `GRANT ${login} TO CURRENT_USER;`,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database}') THEN 'ALTER DATABASE ${database} OWNER TO ${login}' ELSE 'CREATE DATABASE ${database} OWNER ${login}' END \\gexec`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC;`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${login};`,
    ...(params.waker ? [role(waker, wakerPassword), `GRANT CONNECT ON DATABASE ${database} TO ${waker};`, `GRANT pg_read_all_data TO ${waker};`] : []),
    `\\connect ${database}`,
    `ALTER SCHEMA public OWNER TO ${login};`,
  ].join('\n') + '\n';
  const url = (user: string, secret: string) => `postgresql://${user}:${secret}@${params.host}:5432/${database}?sslmode=require`;
  return { script, databaseUrl: url(login, password), ...(params.waker ? { wakerUrl: url(waker, wakerPassword) } : {}) };
}

/** The psql script that removes one environment's database and logins, leaving the rest of a shared server untouched. */
export function environmentDatabaseDrop(environmentName: string): string {
  const names = azureDatabaseNames(environmentName);
  const database = ident(names.database);
  return [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();`,
    `DROP DATABASE IF EXISTS ${database};`,
    ...[ident(names.login), ident(names.waker)].map((role) => `DROP ROLE IF EXISTS ${role};`),
  ].join('\n') + '\n';
}

// ------------------------------------------------------------------ Storage and absence

/** Deletes every blob in a container (shared keys are off, so this uses the deploy identity's data role). */
export async function emptyContainer(tokens: AzureTokenProvider, account: string, container: string): Promise<{ deleted: number } | { gone: true } | { error: string }> {
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
export async function taggedResources(tokens: AzureTokenProvider, subscriptionId: string, resourceGroup: string, tag: string, value: string): Promise<string[] | { unknown: string }> {
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

/** A Key Vault's address from its name. */
export const azureVaultUri = (vaultName: string): string => `https://${vaultName}.vault.azure.net/`;
