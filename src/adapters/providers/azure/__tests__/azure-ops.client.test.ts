import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AZURE_DATABASE_ROOTS } from '../azure-database-roots.js';
import { AZURE_SETUP_IMAGE, AzureTokens, azureDatabaseNames, azureDatabaseRoots, azureKeyVaultSecretStore, emptyContainer, environmentDatabaseDrop, environmentDatabaseSetup, purgeVaultSecrets, runAzureSetupSql, taggedResources } from '../azure-ops.client.js';

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
  it('gives each environment its own database that only its logins can connect to', () => {
    const setup = environmentDatabaseSetup({ host: 'srv.postgres.database.azure.com', environmentName: 'pr-12', waker: true });
    expect(azureDatabaseNames('pr-12')).toEqual({ database: 'app_pr_12', login: 'app_pr_12', waker: 'waker_pr_12' });
    const lines = setup.script.trimEnd().split('\n');
    // Creates on a new server, rotates on one that already has the login or database.
    expect(lines[0]).toMatch(/^SELECT CASE WHEN EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_pr_12'\) THEN 'ALTER' ELSE 'CREATE' END \|\| ' ROLE app_pr_12 LOGIN PASSWORD ''SCRAM-SHA-256\$4096:[A-Za-z0-9+\/=$:]+''' \\gexec$/);
    expect(lines).toContain("SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = 'app_pr_12') THEN 'ALTER DATABASE app_pr_12 OWNER TO app_pr_12' ELSE 'CREATE DATABASE app_pr_12 OWNER app_pr_12' END \\gexec");
    expect(lines).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE app_pr_12 FROM PUBLIC;');
    expect(lines).toContain('GRANT pg_read_all_data TO waker_pr_12;');
    expect(lines.slice(-2)).toEqual(['\\connect app_pr_12', 'ALTER SCHEMA public OWNER TO app_pr_12;']);
    expect(setup.databaseUrl).toMatch(/^postgresql:\/\/app_pr_12:[A-Za-z0-9_-]{32}@srv\.postgres\.database\.azure\.com:5432\/app_pr_12\?sslmode=require$/);
    expect(setup.wakerUrl).toMatch(/^postgresql:\/\/waker_pr_12:/);
    // Passwords travel only as SCRAM verifiers.
    for (const url of [setup.databaseUrl, setup.wakerUrl!]) expect(setup.script).not.toContain(new URL(url).password);
    expect(environmentDatabaseSetup({ host: 'h', environmentName: 'test', waker: false }).script).not.toContain('waker');
  });

  it('drops only the environment\'s database and logins', () => {
    expect(environmentDatabaseDrop('test').trimEnd().split('\n').slice(1)).toEqual(['DROP DATABASE IF EXISTS app_test;', 'DROP ROLE IF EXISTS app_test;', 'DROP ROLE IF EXISTS waker_test;']);
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

describe('Azure database setup inside the private network', () => {
  const group = '/subscriptions/s/resourceGroups/hv-app';
  const job = { id: `${group}/providers/Microsoft.App/jobs/hv-app-test-dbsetup`, environmentId: `${group}/providers/Microsoft.App/managedEnvironments/hv-app-shared-apps`,
    host: 'srv.postgres.database.azure.com', user: 'hypervibe-app' };
  /** Azure's job API as documented: a job is created, started, reports its execution's status, and is gone after deletion. */
  const azureJobs = (options: { leftover?: boolean; status?: string; undeletable?: boolean; refuseCreate?: boolean; loseStart?: boolean; foreign?: boolean; bareStart?: boolean; flakyStatus?: boolean } = {}) => {
    const state = { job: options.leftover ? { tags: options.foreign ? {} : { 'hv-setup': 'database' } } as Record<string, unknown> : undefined as Record<string, unknown> | undefined, created: [] as Array<Record<string, any>>, deleted: 0, starts: 0, reads: 0 };
    const azure = fake((method, url, body) => {
      const path = new URL(url).pathname;
      if (path === job.environmentId) return json(200, { location: 'westus2' });
      if (path === `${job.id}/start` && method === 'POST') {
        state.starts++;
        if (options.loseStart) throw new TypeError('fetch failed');
        return state.job ? (options.bareStart ? json(202) : json(200, { name: 'run-1' })) : json(404);
      }
      if (path === `${job.id}/executions`) {
        if (options.flakyStatus && state.reads++ === 0) throw new TypeError('fetch failed');
        return json(200, { value: [{ name: 'run-1', properties: { status: options.status ?? 'Succeeded' } }] });
      }
      if (path !== job.id) throw new Error(`Unexpected call ${method} ${url}`);
      if (method === 'PUT' && options.refuseCreate) return json(403, { error: { code: 'AuthorizationFailed', message: 'no' } });
      if (method === 'PUT') { state.job = JSON.parse(body!); state.created.push(state.job!); return json(201); }
      if (method === 'DELETE') {
        if (options.undeletable) return json(409, { error: { code: 'JobBusy' } });
        if (!state.job) return json(204);
        state.job = undefined; state.deleted++; return json(202);
      }
      return state.job ? json(200, { tags: state.job.tags, properties: { provisioningState: 'Succeeded' } }) : json(404);
    });
    return { azure, state };
  };
  const fast = { pollMs: 0 };

  it('runs the script from a job in the network, without opening the server or asking anyone for an address', async () => {
    const { azure, state } = azureJobs();
    await runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast);
    // Only Entra sign-in and the job's own management calls: no database-server settings, no firewall rule, no address service.
    for (const call of azure.calls) expect(call.url.startsWith('https://login.microsoftonline.com/') || call.url.startsWith('https://management.azure.com/subscriptions/s/resourceGroups/hv-app/providers/Microsoft.App/')).toBe(true);
    expect(state.created).toHaveLength(1);
    const { location, properties } = state.created[0]!;
    expect(location).toBe('westus2');
    expect(state.created[0]!.tags).toEqual({ 'hv-setup': 'database' });
    expect(properties).toMatchObject({ environmentId: job.environmentId, configuration: { triggerType: 'Manual', replicaRetryLimit: 0 } });
    // The login token and the script are secrets; the container's settings only refer to them.
    expect(properties.configuration.secrets).toEqual([{ name: 'token', value: 'token-for-https://ossrdbms-aad.database.windows.net/.default' }, { name: 'script', value: 'SELECT 1;\n' }]);
    const container = properties.template.containers[0];
    expect(container.image).toBe(AZURE_SETUP_IMAGE);
    expect(AZURE_SETUP_IMAGE).toMatch(/^mcr\.microsoft\.com\/[a-z/]+@sha256:[0-9a-f]{64}$/);
    expect(container.env).toEqual(expect.arrayContaining([{ name: 'PGHOST', value: job.host }, { name: 'PGUSER', value: 'hypervibe-app' }, { name: 'PGSSLMODE', value: 'verify-full' },
      { name: 'PGPASSWORD', secretRef: 'token' }, { name: 'HV_SETUP_SQL', secretRef: 'script' }]));
    expect(JSON.stringify(properties.template)).not.toContain('token-for-');
    // The image trusts only a short Microsoft list, so the job brings the roots Azure databases chain to.
    const roots = container.env.find((entry: { name: string }) => entry.name === 'HV_SETUP_CA').value as string;
    expect(roots.match(/BEGIN CERTIFICATE/g)).toHaveLength(3);
    expect(roots).toBe(azureDatabaseRoots());
    expect(container.env).toContainEqual({ name: 'PGSSLROOTCERT', value: '/tmp/hv-ca.pem' });
    expect(container.command.at(-1)).toMatch(/^printf "%s" "\$HV_SETUP_CA" > \/tmp\/hv-ca\.pem;/);
    // Each is the certificate it claims to be: a self-signed root with the recorded fingerprint, not close to expiry.
    for (const root of AZURE_DATABASE_ROOTS) {
      const certificate = new crypto.X509Certificate(root.pem);
      expect(certificate.subject.split('\n')).toContain(`CN=${root.name}`);
      expect(certificate.fingerprint256).toBe(root.sha256);
      expect(certificate.checkIssued(certificate)).toBe(true);
      expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600_000);
    }
    expect(container.command.at(-1)).toContain('psql -q -v ON_ERROR_STOP=1 -f -');
    // Nothing is left behind.
    expect(state.job).toBeUndefined();
    expect(state.deleted).toBe(1);
  });

  it('removes a job left by an interrupted run before it starts', async () => {
    const { azure, state } = azureJobs({ leftover: true });
    await runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast);
    expect(state.deleted).toBe(2);
    expect(azure.calls.findIndex((call) => call.method === 'DELETE')).toBeLessThan(azure.calls.findIndex((call) => call.method === 'PUT'));
  });

  it('reports a failed script and still deletes the job', async () => {
    const { azure, state } = azureJobs({ status: 'Failed' });
    await expect(runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast)).rejects.toThrow(/database setup job failed.*logs under hv-app-test-dbsetup/);
    expect(state.job).toBeUndefined();
  });

  it('never deletes or replaces a job of the same name that it did not create', async () => {
    const { azure, state } = azureJobs({ leftover: true, foreign: true });
    await expect(runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast)).rejects.toThrow(/already exists and Hypervibe did not create it/);
    expect(azure.calls.filter((call) => call.method !== 'GET' && !call.url.startsWith('https://login.'))).toEqual([]);
    expect(state.job).toBeDefined();
  });

  it('follows the run when Azure accepts the start without naming it, and through one unanswered status read', async () => {
    const { azure, state } = azureJobs({ bareStart: true, flakyStatus: true });
    await runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast);
    expect(state.starts).toBe(1);
    expect(state.job).toBeUndefined();
  });

  it('stops with Azure\'s answer when the job is refused', async () => {
    const { azure, state } = azureJobs({ refuseCreate: true });
    await expect(runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast)).rejects.toThrow(/could not create the database setup job \(HTTP 403 AuthorizationFailed/);
    expect(state.starts).toBe(0);
  });

  it('does not start the job a second time when the answer to starting it is lost, and deletes it', async () => {
    const { azure, state } = azureJobs({ loseStart: true });
    await expect(runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast)).rejects.toThrow('fetch failed');
    expect(state.starts).toBe(1);
    expect(state.job).toBeUndefined();
  });

  it('does not start when an earlier job cannot be removed, and says so', async () => {
    const { azure, state } = azureJobs({ leftover: true, undeletable: true });
    await expect(runAzureSetupSql(azure.tokens, job, 'SELECT 1;\n', fast)).rejects.toThrow(/could not remove an earlier database setup job.*JobBusy/);
    expect(state.created).toEqual([]);
  });
});
