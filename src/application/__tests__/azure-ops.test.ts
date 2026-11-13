import { describe, expect, it } from 'vitest';
import { AzureTokens, azureDatabaseNames, azureKeyVaultSecretStore, dropEnvironmentDatabase, emptyContainer, ensureEnvironmentDatabase, purgeVaultSecrets, taggedResources, type SqlRunner } from '../azure-ops.js';

const access = { tenantId: 't', clientId: 'c', clientSecret: 'client-secret-value' };
const json = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

/** Answers Entra token requests itself; routes the rest. Records every call. */
function fake(route: (method: string, url: string, body?: string) => Response) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: `token-for-${new URLSearchParams(String(init?.body)).get('scope')}`, expires_in: 3600 });
    return route(method, url, typeof init?.body === 'string' ? init.body : undefined);
  }) as typeof fetch;
  return { calls, tokens: new AzureTokens(access, fetchImpl) };
}

describe('Azure Key Vault secret store', () => {
  it('writes under the environment\'s names, observes presence without returning the value, and never counts errors as absent', async () => {
    const azure = fake((method, url) => {
      if (url.includes('/secrets/test--jwt-secret') && method === 'GET') return json(200, { value: 'the-value' });
      if (url.includes('/secrets/test--missing-key')) return json(404, { error: { code: 'SecretNotFound' } });
      if (url.includes('/secrets/test--flaky')) return json(503);
      if (method === 'PUT' && url.includes('/secrets/test--gone')) return json(409, { error: { code: 'ObjectIsDeletedButRecoverable' } });
      return json(200, {});
    });
    const store = azureKeyVaultSecretStore(azure.tokens, 'https://hv-app-abc123.vault.azure.net/', (key) => `test--${key.toLowerCase().replace(/_/g, '-')}`);
    expect(await store.observe('JWT_SECRET')).toBe('present');
    expect(await store.observe('MISSING_KEY')).toBe('absent');
    expect(await store.observe('FLAKY')).toEqual({ unknown: 'Key Vault could not be read (HTTP 503).' });
    expect(await store.write('STRIPE_KEY', 'sk_live')).toBeUndefined();
    expect(await store.write('GONE', 'x')).toMatch(/deleted from Key Vault recently/);
    expect(azure.calls.find((call) => call.method === 'PUT')?.url).toBe('https://hv-app-abc123.vault.azure.net/secrets/test--stripe-key?api-version=7.4');
    // One token, scoped to Key Vault only.
    expect(azure.calls.filter((call) => call.url.startsWith('https://login.'))).toHaveLength(1);
    expect(azure.calls[0]!.body).toContain('scope=https%3A%2F%2Fvault.azure.net%2F.default');
  });

  it('purges only the environment\'s own secrets', async () => {
    const deleted: string[] = [];
    const azure = fake((method, url) => {
      if (method === 'GET') return json(200, { value: [{ id: 'https://v.vault.azure.net/secrets/test--a' }, { id: 'https://v.vault.azure.net/secrets/testing--b' }, { id: 'https://v.vault.azure.net/secrets/prod--c' }] });
      deleted.push(`${method} ${new URL(url).pathname}`);
      return url.includes('/deletedsecrets/') ? json(204) : json(200);
    });
    await expect(purgeVaultSecrets(azure.tokens, 'https://hv-app-abc123.vault.azure.net/', 'test--')).resolves.toEqual({ removed: 1 });
    expect(deleted).toEqual(['DELETE /secrets/test--a', 'DELETE /deletedsecrets/test--a']);
  });
});

describe('Azure database logins on a shared server', () => {
  const recorder = () => {
    const statements: Array<{ database: string; sql: string }> = [];
    const runner: SqlRunner = async (database, run) => {
      await run(async (sql) => { statements.push({ database, sql }); return { rows: [] }; });
    };
    return { statements, runner };
  };

  it('gives each environment its own database that only its logins can connect to', async () => {
    const { statements, runner } = recorder();
    const urls = await ensureEnvironmentDatabase(runner, { host: 'srv.postgres.database.azure.com', environmentName: 'pr-12', waker: true });
    expect(azureDatabaseNames('pr-12')).toEqual({ database: 'app_pr_12', login: 'app_pr_12', waker: 'waker_pr_12' });
    const sql = statements.map((entry) => entry.sql);
    expect(sql).toContain('CREATE DATABASE app_pr_12 OWNER app_pr_12');
    expect(sql).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE app_pr_12 FROM PUBLIC');
    expect(sql).toContain('GRANT pg_read_all_data TO waker_pr_12');
    // Passwords travel only as SCRAM verifiers.
    expect(sql.find((statement) => statement.startsWith('CREATE ROLE app_pr_12'))).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(urls.databaseUrl).toMatch(/^postgresql:\/\/app_pr_12:[A-Za-z0-9_-]{32}@srv\.postgres\.database\.azure\.com:5432\/app_pr_12\?sslmode=require$/);
    expect(urls.wakerUrl).toMatch(/^postgresql:\/\/waker_pr_12:/);
    expect(statements.at(-1)).toEqual({ database: 'app_pr_12', sql: 'ALTER SCHEMA public OWNER TO app_pr_12' });
  });

  it('drops only the environment\'s database and logins', async () => {
    const { statements, runner } = recorder();
    await dropEnvironmentDatabase(runner, 'test');
    expect(statements.map((entry) => entry.sql).slice(1)).toEqual(['DROP DATABASE IF EXISTS app_test', 'DROP ROLE IF EXISTS app_test', 'DROP ROLE IF EXISTS waker_test']);
  });
});

describe('Azure storage and absence checks', () => {
  it('empties a container blob by blob, and reports a missing container as gone', async () => {
    let listed = 0;
    const azure = fake((method, url) => {
      if (url.includes('comp=list')) return new Response(listed++ === 0 ? '<EnumerationResults><Blobs><Blob><Name>a/b.txt</Name></Blob><Blob><Name>c &amp; d</Name></Blob></Blobs></EnumerationResults>' : '<EnumerationResults><Blobs/></EnumerationResults>', { status: 200 });
      return new Response(null, { status: method === 'DELETE' ? 202 : 404 });
    });
    await expect(emptyContainer(azure.tokens, 'acct', 'docs')).resolves.toEqual({ deleted: 2 });
    expect(azure.calls.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname)).toEqual(['/docs/a/b.txt', '/docs/c%20%26%20d']);
    const missing = fake(() => new Response('', { status: 404 }));
    await expect(emptyContainer(missing.tokens, 'acct', 'docs')).resolves.toEqual({ gone: true });
  });

  it('lists what is still tagged for an environment, and says unknown instead of none on errors', async () => {
    const found = fake(() => json(200, { value: [{ name: 'hv-app-test-web' }] }));
    await expect(taggedResources(found.tokens, 's', 'hv-app', 'hv-environment', 'env1')).resolves.toEqual(['hv-app-test-web']);
    expect(decodeURIComponent(found.calls.at(-1)!.url)).toContain("tagName eq 'hv-environment' and tagValue eq 'env1'");
    const failing = fake(() => json(403, { error: { code: 'AuthorizationFailed' } }));
    await expect(taggedResources(failing.tokens, 's', 'hv-app', 'hv-environment', 'env1')).resolves.toEqual({ unknown: expect.stringContaining('AuthorizationFailed') });
  });
});
