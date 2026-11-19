import { describe, expect, it } from 'vitest';
import { AzureTokens, azureDatabaseNames, azureKeyVaultSecretStore, dropEnvironmentDatabase, emptyContainer, ensureEnvironmentDatabase, purgeVaultSecrets, taggedResources, withAzureSetupAccess, type SqlRunner } from '../azure-ops.client.js';

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
    let metadataStatus = 200;
    const azure = fake((method, url) => {
      if (url.includes('/secrets?') && method === 'GET') return json(metadataStatus, { value: [{ id: 'https://hv-app-abc123.vault.azure.net/secrets/test--jwt-secret', attributes: { enabled: true } }] });
      if (method === 'PUT' && url.includes('/secrets/test--gone')) return json(409, { error: { code: 'ObjectIsDeletedButRecoverable' } });
      return json(200, {});
    });
    const store = azureKeyVaultSecretStore(azure.tokens, 'https://hv-app-abc123.vault.azure.net/', (key) => `test--${key.toLowerCase().replace(/_/g, '-')}`);
    expect(await store.observe('JWT_SECRET')).toBe('present');
    expect(await store.observe('MISSING_KEY')).toBe('absent');
    metadataStatus = 503;
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

describe('Azure database setup access', () => {
  const serverId = '/subscriptions/s/resourceGroups/hv-app/providers/Microsoft.DBforPostgreSQL/flexibleServers/hv-app-shared-abc123';
  /** A server that starts closed, refuses addresses without a rule and reports the caller's address when it does. */
  const server = (options: { failClose?: boolean } = {}) => {
    const state = { access: 'Disabled', rule: undefined as string | undefined };
    const azure = fake((method, url, body) => {
      if (url.includes('/firewallRules/hypervibe-setup')) {
        if (method === 'PUT') { state.rule = JSON.parse(body!).properties.startIpAddress; expect(JSON.parse(body!).properties.endIpAddress).toBe(state.rule); return json(202); }
        if (method === 'DELETE') { state.rule = undefined; return json(202); }
      }
      if (method === 'PATCH') {
        const wanted = JSON.parse(body!).properties.network.publicNetworkAccess as string;
        if (wanted === 'Disabled' && options.failClose) return json(409, { error: { code: 'ServerIsBusy' } });
        state.access = wanted; return json(202);
      }
      return json(200, { properties: { state: 'Ready', network: { publicNetworkAccess: state.access } } });
    });
    const probe = async () => {
      if (state.access !== 'Enabled') throw new Error('connect ETIMEDOUT');
      if (state.rule !== '203.0.113.7') throw new Error('no pg_hba.conf entry for host "203.0.113.7", user "hypervibe-deploy-app", database "postgres", SSL encryption');
    };
    return { azure, state, probe };
  };
  /** No waiting between attempts, and no address service unless a test supplies one. */
  const quiet = { pollMs: 0, lookupAddress: async () => undefined };
  const puts = (azure: { calls: Array<{ method: string; body?: string }> }) => azure.calls.filter((call) => call.method === 'PUT').map((call) => JSON.parse(call.body!).properties.startIpAddress);

  it('opens the server to this computer\'s address only, runs the work, then closes it again', async () => {
    const { azure, state, probe } = server();
    const seen: Array<typeof state> = [];
    await expect(withAzureSetupAccess(azure.tokens, serverId, probe, async () => { seen.push({ ...state }); return 'done'; }, quiet)).resolves.toBe('done');
    expect(seen).toEqual([{ access: 'Enabled', rule: '203.0.113.7' }]);
    expect(state).toEqual({ access: 'Disabled', rule: undefined });
    // Nothing wider than one address was ever written: first an address nobody can use, then this computer's.
    expect(puts(azure)).toEqual(['192.0.2.1', '203.0.113.7']);
  });

  it('asks an address service when Azure drops the connection without saying which address it refused', async () => {
    // Live 2026-11-18 (West US 2): with public access on, every attempt ended "timeout expired". Azure sent no refusal to read the address from.
    const { azure, state } = server();
    const silent = async () => { if (state.access !== 'Enabled' || state.rule !== '203.0.113.7') throw new Error('timeout expired'); };
    const learned: string[] = [];
    await expect(withAzureSetupAccess(azure.tokens, serverId, silent, async () => state.rule, { pollMs: 0, lookupAddress: async () => '203.0.113.7', onLearned: (how) => learned.push(how) })).resolves.toBe('203.0.113.7');
    expect(puts(azure)).toEqual(['192.0.2.1', '203.0.113.7']);
    expect(learned).toEqual(['an address service']);
    expect(state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('keeps waiting through dropped connections while the new rule takes effect, and takes a refused login as reached', async () => {
    const slow = server();
    let attempts = 0;
    const lagging = async () => { await slow.probe(); if (slow.state.rule === '203.0.113.7' && attempts++ < 3) throw new Error('timeout expired'); };
    await expect(withAzureSetupAccess(slow.azure.tokens, serverId, lagging, async () => 'done', quiet)).resolves.toBe('done');
    const refused = server();
    // A new server does not know its administrator for a minute: the network is open, so the work runs and retries the login itself.
    const login = async () => { await refused.probe(); throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); };
    await expect(withAzureSetupAccess(refused.azure.tokens, serverId, login, async () => refused.state.rule, quiet)).resolves.toBe('203.0.113.7');
    expect(refused.state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('closes the server again when the work fails, and reports the failure', async () => {
    const { azure, state, probe } = server();
    await expect(withAzureSetupAccess(azure.tokens, serverId, probe, async () => { throw new Error('permission denied to create role'); }, quiet)).rejects.toThrow('permission denied to create role');
    expect(state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('allows no usable address when it cannot learn this computer\'s, and still closes', async () => {
    const { azure, state } = server();
    await expect(withAzureSetupAccess(azure.tokens, serverId, async () => { throw new Error('connect ETIMEDOUT'); }, async () => 'never', quiet)).rejects.toThrow(/did not open the database server to anything/);
    expect(puts(azure)).toEqual(['192.0.2.1']);
    expect(state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('tries again when closing fails once', async () => {
    const { azure, state, probe } = server();
    let failed = false;
    const flaky = { get: (scope: string) => azure.tokens.get(scope), fetchImpl: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH' && String(init.body).includes('Disabled') && !failed) { failed = true; throw new TypeError('fetch failed'); }
      return azure.tokens.fetchImpl(url, init);
    }) as typeof fetch };
    await expect(withAzureSetupAccess(flaky, serverId, probe, async () => 'done', quiet)).resolves.toBe('done');
    expect(state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('reports what the server answered when it cannot learn this computer\'s address', async () => {
    // Live 2026-11-18 (West US 2): the address was never learned and the message gave no reason, so the cause could not be found.
    const timedOut = server();
    await expect(withAzureSetupAccess(timedOut.azure.tokens, serverId, async () => { throw Object.assign(new Error('connect ETIMEDOUT 20.1.2.3:5432'), { code: 'ETIMEDOUT' }); }, async () => 'never', quiet))
      .rejects.toThrow(/did not open the database server to anything\. Last answer: ETIMEDOUT: connect ETIMEDOUT 20\.1\.2\.3:5432/);
    // Node reports several failed addresses as one error with an empty message.
    const several = server();
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 20.1.2.3:5432'), { code: 'ETIMEDOUT' })], ''), { code: 'ETIMEDOUT' });
    await expect(withAzureSetupAccess(several.azure.tokens, serverId, async () => { throw aggregate; }, async () => 'never', quiet)).rejects.toThrow(/Last answer: ETIMEDOUT: connect ETIMEDOUT 20\.1\.2\.3:5432/);
    expect(several.state).toEqual({ access: 'Disabled', rule: undefined });
  });

  it('says so when it cannot close the server, even though the work succeeded', async () => {
    const { azure, probe } = server({ failClose: true });
    await expect(withAzureSetupAccess(azure.tokens, serverId, probe, async () => 'done', quiet)).rejects.toThrow(/could not turn the database server's public access off again.*hv_plan/);
  });
});
