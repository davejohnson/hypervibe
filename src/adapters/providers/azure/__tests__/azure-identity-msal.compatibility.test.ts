import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClientSecretCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { createHttpHeaders, type HttpClient, type PipelineRequest } from '@azure/core-rest-pipeline';

const require = createRequire(import.meta.url);
// Resolve the same MSAL package selected by Identity, including nested installs.
const identityRequire = createRequire(require.resolve('@azure/identity'));
const { ConfidentialClientApplication } = identityRequire('@azure/msal-node') as typeof import('@azure/msal-node');
const tenant = '11111111-1111-4111-8111-111111111111';
const clientId = '33333333-3333-4333-8333-333333333333';
const scope = 'https://management.azure.com/.default';
const authority = `https://login.microsoftonline.com/${tenant}`;

function discovery(origin = 'https://login.microsoftonline.com') {
  return {
    authorization_endpoint: `${origin}/${tenant}/oauth2/v2.0/authorize`,
    token_endpoint: `${origin}/${tenant}/oauth2/v2.0/token`,
    issuer: `${origin}/${tenant}/v2.0`,
    jwks_uri: `${origin}/${tenant}/discovery/v2.0/keys`,
    end_session_endpoint: `${origin}/${tenant}/oauth2/v2.0/logout`,
  };
}

const directories: string[] = [];
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(AZURE_|MSI_|IDENTITY_|IMDS_|MSAL_)/.test(name)) vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-identity-'));
  directories.push(directory);
  return directory;
}

// Synthetic responses follow Microsoft's OAuth2 client-credentials and App Service
// managed-identity contracts. Only the HTTP transport is replaced.
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
// https://learn.microsoft.com/azure/app-service/overview-managed-identity#rest-endpoint-reference
function identityTransport(tokenStatus = 200) {
  const requests: PipelineRequest[] = [];
  const httpClient: HttpClient = {
    async sendRequest(request) {
      requests.push(request);
      const url = new URL(request.url);
      expect(url.origin).toBe('https://login.microsoftonline.com');
      const isDiscovery = request.method === 'GET';
      if (isDiscovery) expect(url.pathname).toContain('/.well-known/openid-configuration');
      else expect(url.pathname).toBe(`/${tenant}/oauth2/v2.0/token`);
      const body = isDiscovery ? discovery() : tokenStatus === 200 ? {
        access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600, ext_expires_in: 3600,
      } : { error: 'invalid_client', error_description: 'Synthetic rejected credential' };
      return { request, status: isDiscovery ? 200 : tokenStatus,
        headers: createHttpHeaders({ 'content-type': 'application/json' }), bodyAsText: JSON.stringify(body) };
    },
  };
  return { httpClient, requests, posts: () => requests.filter(request => request.method === 'POST') };
}

function environmentIdentity() {
  vi.stubEnv('AZURE_TENANT_ID', tenant);
  vi.stubEnv('AZURE_CLIENT_ID', clientId);
}

describe('Azure Identity patched MSAL dependency', () => {
  it('keeps authorization-code credentials on the configured authority despite response routing metadata', async () => {
    // Reconstructed from upstream f550958 / GHSA-xcx6-jx8p-x3h5.
    // A different documented Microsoft cloud is deliberately absent from this
    // client's configuration. No request reaches either cloud: only the network
    // transport is replaced; actual MSAL endpoint selection and body encoding run.
    const posts: Array<{ url: string; body: URLSearchParams }> = [];
    const networkClient = {
      async sendGetRequestAsync<T>(url: string) {
        return { status: 200, headers: {}, body: discovery(new URL(url).origin) as T };
      },
      async sendPostRequestAsync<T>(url: string, options?: { body?: string }) {
        posts.push({ url, body: new URLSearchParams(options?.body) });
        return { status: 400, headers: {}, body: { error: 'invalid_grant', error_description: 'Synthetic rejected code' } as T };
      },
    };
    const app = new ConfidentialClientApplication({
      auth: { clientId, clientSecret: 'synthetic-client-secret', authority },
      system: { networkClient },
    });
    await expect(app.acquireTokenByCode({
      code: 'synthetic-request-code', scopes: [scope], redirectUri: 'http://localhost/callback',
    }, { cloud_instance_host_name: 'login.microsoftonline.us', code: 'synthetic-response-code' })).rejects.toBeDefined();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.get('client_secret')).toBe('synthetic-client-secret');
    expect(posts[0]!.body.get('code')).toBe('synthetic-request-code');
    expect(new URL(posts[0]!.url).origin).toBe('https://login.microsoftonline.com');
  });

  it('still rejects a mismatched response state before any token request', async () => {
    const networkClient = {
      sendGetRequestAsync: vi.fn(async () => { throw new Error('Unexpected discovery request'); }),
      sendPostRequestAsync: vi.fn(async () => { throw new Error('Unexpected token request'); }),
    };
    const app = new ConfidentialClientApplication({
      auth: { clientId, clientSecret: 'synthetic-client-secret', authority }, system: { networkClient },
    });
    await expect(app.acquireTokenByCode({ code: 'synthetic-code', state: 'expected-state',
      scopes: [scope], redirectUri: 'http://localhost/callback',
    }, { code: 'synthetic-code', state: 'wrong-state', cloud_instance_host_name: 'login.microsoftonline.us' }))
      .rejects.toMatchObject({ errorCode: 'state_mismatch' });
    expect(networkClient.sendGetRequestAsync).not.toHaveBeenCalled();
    expect(networkClient.sendPostRequestAsync).not.toHaveBeenCalled();
  });

  it.each(['explicit', 'environment'] as const)('preserves %s client-secret requests and cached token reuse', async mode => {
    const transport = identityTransport();
    const options = { httpClient: transport.httpClient, retryOptions: { maxRetries: 0 } };
    environmentIdentity();
    vi.stubEnv('AZURE_CLIENT_SECRET', 'synthetic-client-secret');
    vi.stubEnv('AZURE_TOKEN_CREDENTIALS', 'EnvironmentCredential');
    const credential = mode === 'explicit'
      ? new ClientSecretCredential(tenant, clientId, 'synthetic-client-secret', options)
      : new DefaultAzureCredential(options);
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'synthetic-access-token' });
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'synthetic-access-token' });
    expect(transport.posts()).toHaveLength(1);
    const body = new URLSearchParams(String(transport.posts()[0]!.body));
    expect(body.get('client_id')).toBe(clientId);
    expect(body.get('client_secret')).toBe('synthetic-client-secret');
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe(scope);
  });

  it('keeps an invalid configured environment credential as an authentication failure', async () => {
    const transport = identityTransport(401);
    environmentIdentity();
    vi.stubEnv('AZURE_CLIENT_SECRET', 'synthetic-rejected-secret');
    // The real chain must not try workload/managed identity or developer login
    // after a configured environment identity fails authentication.
    const credential = new DefaultAzureCredential({ httpClient: transport.httpClient, retryOptions: { maxRetries: 0 } });
    await expect(credential.getToken(scope)).rejects.toThrow(/invalid_client/);
    expect(transport.posts()).toHaveLength(1);
  });

  it('exchanges the exact federated assertion through the default workload-identity chain', async () => {
    const transport = identityTransport();
    const assertion = 'synthetic-header.synthetic-payload.synthetic-signature';
    const tokenFile = path.join(temporaryDirectory(), 'federated-token');
    writeFileSync(tokenFile, assertion, { mode: 0o600 });
    environmentIdentity();
    vi.stubEnv('AZURE_TOKEN_CREDENTIALS', 'WorkloadIdentityCredential');
    vi.stubEnv('AZURE_FEDERATED_TOKEN_FILE', tokenFile);
    const credential = new DefaultAzureCredential({ httpClient: transport.httpClient, retryOptions: { maxRetries: 0 } });
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'synthetic-access-token' });
    expect(transport.posts()).toHaveLength(1);
    const body = new URLSearchParams(String(transport.posts()[0]!.body));
    expect(body.get('client_id')).toBe(clientId);
    expect(body.get('client_assertion')).toBe(assertion);
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.has('client_secret')).toBe(false);
  });

  it('preserves App Service managed-identity endpoint, identity selector and header', async () => {
    vi.stubEnv('IDENTITY_ENDPOINT', 'http://identity.invalid/msi/token');
    vi.stubEnv('IDENTITY_HEADER', 'synthetic-identity-header');
    const requests: PipelineRequest[] = [];
    const credential = new ManagedIdentityCredential({ clientId, retryOptions: { maxRetries: 0 }, httpClient: {
      async sendRequest(request) {
        requests.push(request);
        return { request, status: 200, headers: createHttpHeaders({ 'content-type': 'application/json' }),
          bodyAsText: JSON.stringify({ access_token: 'synthetic-managed-token', token_type: 'Bearer',
            expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: 'https://management.azure.com', client_id: clientId }) };
      },
    } });
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'synthetic-managed-token' });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe('http://identity.invalid/msi/token');
    expect(url.searchParams.get('client_id')).toBe(clientId);
    expect(url.searchParams.get('resource')).toBe('https://management.azure.com');
    expect(requests[0]!.headers.get('x-identity-header')).toBe('synthetic-identity-header');
  });

  it.skipIf(process.platform === 'win32')('retains structured Azure CLI fallback without using a real login', async () => {
    const directory = temporaryDirectory();
    const argumentFile = path.join(directory, 'arguments.json');
    writeFileSync(path.join(directory, 'az'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argumentFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ accessToken: 'synthetic-cli-token', expires_on: String(Math.floor(Date.now()/1000)+3600), tokenType: 'Bearer' }));
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    vi.stubEnv('AZURE_TOKEN_CREDENTIALS', 'AzureCliCredential');
    const credential = new DefaultAzureCredential();
    await expect(credential.getToken(scope)).resolves.toMatchObject({ token: 'synthetic-cli-token' });
    expect(JSON.parse(readFileSync(argumentFile, 'utf8'))).toEqual([
      'account', 'get-access-token', '--output', 'json', '--resource', 'https://management.azure.com',
    ]);
  });

});
