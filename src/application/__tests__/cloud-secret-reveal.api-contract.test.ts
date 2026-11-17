import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AzureTokens } from '../../adapters/providers/azure/azure-ops.client.js';
import { deployPolicyDocument } from '../../adapters/providers/aws/aws-setup.client.js';
import { AZURE_ROLES, deployRoleGrants } from '../../adapters/providers/azure/azure-setup.client.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { revealGeneratedSecret, type EngineSecretStore } from '../engine-secrets.js';
import { awsSecretStore } from '../infrastructure-engine-aws.js';
import { azureEnvironmentSecretStore } from '../infrastructure-engine-azure.js';
import { resetRevealPagesForTests } from '../local-reveal-page.js';

// Reconstructed native responses, not live recordings. Shape/semantics sources:
// https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html
// https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-restrict-decryption.html
// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret
// https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secrets/get-secrets
// https://learn.microsoft.com/en-us/powershell/module/az.keyvault/get-azkeyvaultsecret
const SECRET = 'synthetic-generated-secret-for-local-browser-only';
const KEY = 'FLOW_SCRIPT_KEY';
const VAULT = 'https://hv-app-abc123.vault.azure.net/';
const VERSION = '11a536561da34d6b8b452d880df58f3a';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-reveal-contract-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetRevealPagesForTests();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function projectFixture(provider: 'aws' | 'azure') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'reveal-contract', defaultPlatform: provider });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name,
    environments: { testing: { hosting: { provider, engine: 'opentofu' }, services: { web: {} } } },
    secrets: { [KEY]: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['testing'] } },
  });
  return { ctx, project, spec };
}

async function awsFixture() {
  const f = projectFixture('aws');
  const environment = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'testing' });
  const parameterName = `/hypervibe/${environment.id.toLowerCase()}/${KEY}`;
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'aws', scope: f.project.name, credentialsEncrypted: getSecretStore().encryptObject({
    accessKeyId: 'test-access-key-1234', secretAccessKey: 'test-secret-key-for-aws-fixture-only',
    roleArn: 'arn:aws:iam::123456789012:role/hypervibe/hypervibe-deploy-fixture', accountId: '123456789012', region: 'us-west-2',
  }) });
  connections.updateStatus(connection.id, 'verified');
  const reads: Array<{ Name?: string; WithDecryption?: boolean }> = [];
  let outcome = { status: 200, body: { Parameter: { Name: parameterName, Type: 'SecureString', Value: SECRET, Version: 1 } } as unknown };
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (request) => {
    const serialized = typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8');
    if (request.hostname === 'sts.us-west-2.amazonaws.com') {
      expect(new URLSearchParams(serialized).get('Action')).toBe('AssumeRole');
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Readable.from([
        '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>test-role-key</AccessKeyId><SecretAccessKey>test-role-secret</SecretAccessKey><SessionToken>test-role-session</SessionToken></Credentials></AssumeRoleResult></AssumeRoleResponse>',
      ]) } };
    }
    expect(request.hostname).toBe('ssm.us-west-2.amazonaws.com');
    expect(request.headers['x-amz-target']).toBe('AmazonSSM.GetParameter');
    expect(request.headers['x-amz-security-token']).toBe('test-role-session');
    const body = JSON.parse(serialized);
    reads.push(body);
    const result = body.WithDecryption ? outcome : { status: 200, body: { Parameter: { Name: parameterName, Type: 'SecureString', Value: 'ciphertext', Version: 1 } } };
    return { response: { statusCode: result.status, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify(result.body)]) } };
  });
  const store = await awsSecretStore(f.ctx, f.project, 'testing');
  if ('blocked' in store) throw new Error(store.blocked);
  return { ...f, store, reads, parameterName, setOutcome: (status: number, body: unknown) => { outcome = { status, body }; } };
}

function azureFixture() {
  const f = projectFixture('azure');
  const calls: string[] = [];
  let outcome: () => Response = () => json(200, { value: SECRET, id: `${VAULT}secrets/testing--flow-script-key/${VERSION}` });
  let metadata: (url: string) => Response = () => json(200, { value: [{ id: `${VAULT}secrets/testing--flow-script-key`, attributes: { enabled: true } }] });
  const tokens = new AzureTokens({ tenantId: 'tenant', clientId: 'deploy-client', clientSecret: 'synthetic-deploy-secret' }, async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      expect(new URLSearchParams(String(init?.body)).get('scope')).toBe('https://vault.azure.net/.default');
      return json(200, { access_token: 'vault-deploy-token', expires_in: 3600 });
    }
    calls.push(url);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer vault-deploy-token' });
    if (new URL(url).pathname === '/secrets') return metadata(url);
    return outcome();
  });
  const store: EngineSecretStore = azureEnvironmentSecretStore({ tokens, vault: { name: 'hv-app-abc123', uri: VAULT, id: 'vault-resource-id' }, environmentName: 'testing' });
  return { ...f, store, calls, tokens, setOutcome: (next: () => Response) => { outcome = next; }, setMetadata: (next: (url: string) => Response) => { metadata = next; } };
}

function request(url: string, click = false) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(target, { method: click ? 'POST' : 'GET', headers: click ? { origin: target.origin, 'content-type': 'application/x-www-form-urlencoded' } : {} }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(click ? `nonce=${target.pathname.split('/').pop()}` : undefined);
  });
}

describe('AWS and Azure owner-only generated secret reads', () => {
  for (const provider of ['aws', 'azure'] as const) {
    it(`${provider} retrieves the value only on the local page click and keeps command results and HTML value-free`, async () => {
      const f = provider === 'aws' ? await awsFixture() : azureFixture();
      const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
      let opened = '';
      const params = { project: f.project, spec: f.spec, environmentName: 'testing', key: KEY, store: f.store, waitMs: 10, openBrowser: (url: string) => { opened = url; } };
      const first = await revealGeneratedSecret(f.ctx, params);
      expect(first.status).toBe('waiting');
      expect(JSON.stringify(first)).not.toContain(SECRET);
      const html = await request(opened);
      expect(html.status).toBe(200);
      expect(html.body).not.toContain(SECRET);
      if ('reads' in f) expect(f.reads).toEqual([{ Name: f.parameterName }]);
      else expect(f.calls).toEqual([`${VAULT}secrets?api-version=7.4&maxresults=25`]);
      const clicked = await request(opened, true);
      expect(clicked).toEqual({ status: 200, body: JSON.stringify({ value: SECRET }) });
      if ('reads' in f) expect(f.reads.at(-1)).toEqual({ Name: f.parameterName, WithDecryption: true });
      else expect(f.calls.at(-1)).toBe(`${VAULT}secrets/testing--flow-script-key?api-version=7.4`);
      const second = await revealGeneratedSecret(f.ctx, params);
      expect(second.status).toBe('viewed');
      expect(JSON.stringify(second)).not.toContain(SECRET);
      expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(SECRET);
    });

    it(`${provider} keeps a rejected read off the page and does not report the secret as viewed`, async () => {
      const f = provider === 'aws' ? await awsFixture() : azureFixture();
      if ('reads' in f) f.setOutcome(400, { __type: 'AccessDeniedException', message: SECRET });
      else f.setOutcome(() => json(403, { error: { message: SECRET } }));
      let opened = '';
      const params = { project: f.project, spec: f.spec, environmentName: 'testing', key: KEY, store: f.store, waitMs: 10, openBrowser: (url: string) => { opened = url; } };
      expect((await revealGeneratedSecret(f.ctx, params)).status).toBe('waiting');
      expect(await request(opened, true)).toEqual({ status: 502, body: '' });
      const result = await revealGeneratedSecret(f.ctx, params);
      expect(result.status).toBe('waiting');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });
  }

  it('AWS returns value-free errors for denied, absent, malformed and wrong-environment responses', async () => {
    const f = await awsFixture();
    expect(f.store.read).toBeTypeOf('function');
    for (const [status, body] of [
      [400, { __type: 'AccessDeniedException', message: SECRET }],
      [400, { __type: 'ParameterNotFound', message: SECRET }],
      [400, { __type: SECRET, message: SECRET }],
      [200, {}],
      [200, { Parameter: { Name: f.parameterName, Value: 42 } }],
      [200, { Parameter: { Name: '/hypervibe/other/FLOW_SCRIPT_KEY', Value: SECRET } }],
    ] as const) {
      f.setOutcome(status, body);
      const result = await f.store.read!(KEY);
      expect(result).toHaveProperty('error');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it('AWS reads each environment’s exact parameter path with the deploy role', async () => {
    const f = await awsFixture();
    const production = await awsSecretStore(f.ctx, f.project, 'production');
    if ('blocked' in production) throw new Error(production.blocked);
    const environment = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'production')!;
    const expected = `/hypervibe/${environment.id.toLowerCase()}/${KEY}`;
    expect(expected).not.toBe(f.parameterName);
    f.setOutcome(200, { Parameter: { Name: expected, Type: 'SecureString', Value: 'production-value', Version: 1 } });
    expect(await production.read!(KEY)).toEqual({ value: 'production-value' });
    expect(f.reads).toEqual([{ Name: expected, WithDecryption: true }]);
  });

  it('Azure observes metadata without retrieving values and keeps uncertain observations unknown', async () => {
    const f = azureFixture();
    expect(await f.store.observe(KEY)).toBe('present');
    expect(f.calls).toEqual([`${VAULT}secrets?api-version=7.4&maxresults=25`]);
    for (const response of [json(403, { error: { message: SECRET } }), json(200, {}), json(200, { value: [], nextLink: `${VAULT}secrets/testing--flow-script-key/versions?skip=1` }),
      json(200, { value: [{ id: `https://another.vault.azure.net/secrets/testing--flow-script-key`, attributes: { enabled: true } }] })]) {
      f.setMetadata(() => response);
      const observed = await f.store.observe(KEY);
      expect(observed).toHaveProperty('unknown');
      expect(JSON.stringify(observed)).not.toContain(SECRET);
    }
    f.setMetadata(() => json(200, { value: [] }));
    expect(await f.store.observe(KEY)).toBe('absent');
    f.setMetadata(() => json(404, { error: { code: 'VaultNotFound', message: SECRET } }));
    expect(await f.store.observe(KEY)).toHaveProperty('unknown');
  });

  it('Azure does not treat an identified but disabled secret as ready', async () => {
    const f = azureFixture();
    f.setMetadata(() => json(200, { value: [{ id: `${VAULT}secrets/testing--flow-script-key`, attributes: { enabled: false } }] }));
    expect(await f.store.observe(KEY)).toHaveProperty('unknown');
  });

  it('Azure follows current-secret metadata pages, independent of historical version state', async () => {
    const f = azureFixture();
    const next = `${VAULT}secrets?api-version=7.4&skiptoken=second`;
    let enabled = false;
    f.setMetadata((url) => url === next
      ? json(200, { value: [{ id: `${VAULT}secrets/testing--flow-script-key`, attributes: { enabled, exp: 1, nbf: 9999999999 } }] })
      : json(200, { value: [{ id: `${VAULT}secrets/production--flow-script-key`, attributes: { enabled: true } }], nextLink: next }));
    expect(await f.store.observe(KEY)).toHaveProperty('unknown');
    enabled = true;
    expect(await f.store.observe(KEY)).toBe('present');
    // No version ordering, disabled historical versions or expiry rules are inferred.
    expect(f.calls).toEqual([`${VAULT}secrets?api-version=7.4&maxresults=25`, next, `${VAULT}secrets?api-version=7.4&maxresults=25`, next]);
    f.setMetadata((url) => url === next ? json(200, { value: [] }) : json(200, { value: [], nextLink: next }));
    expect(await f.store.observe(KEY)).toBe('absent');
  });

  it('Azure stops cyclic or foreign metadata pagination without forwarding authorization', async () => {
    const f = azureFixture();
    const first = `${VAULT}secrets?api-version=7.4&maxresults=25`;
    for (const nextLink of [first, 'https://another.vault.azure.net/secrets?api-version=7.4']) {
      f.calls.length = 0;
      f.setMetadata(() => json(200, { value: [], nextLink }));
      expect(await f.store.observe(KEY)).toHaveProperty('unknown');
      expect(f.calls).toEqual([first]);
    }
  });

  it('Azure refuses denied, absent, malformed, wrong-environment and echoed errors without returning their contents', async () => {
    const f = azureFixture();
    expect(f.store.read).toBeTypeOf('function');
    for (const response of [json(403, { error: { code: SECRET, message: SECRET } }), json(404, { error: { message: SECRET } }), json(200, {}),
      json(200, { value: 42 }), new Response(SECRET, { status: 200 }),
      json(200, { value: SECRET, id: `${VAULT}secrets/production--flow-script-key/${VERSION}` })]) {
      f.setOutcome(() => response);
      const result = await f.store.read!(KEY);
      expect(result).toHaveProperty('error');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    f.setOutcome(() => { throw Object.assign(new Error(SECRET), { name: SECRET }); });
    expect(JSON.stringify(await f.store.read!(KEY))).not.toContain(SECRET);
  });

  it('uses environment names for Azure reads and existing deploy grants cover the providers’ read operations', async () => {
    const f = azureFixture();
    const production: EngineSecretStore = azureEnvironmentSecretStore({ tokens: f.tokens, vault: { name: 'hv-app-abc123', uri: VAULT, id: 'vault-resource-id' }, environmentName: 'production' });
    expect(production.read).toBeTypeOf('function');
    f.setOutcome(() => json(200, { value: 'production-value', id: `${VAULT}secrets/production--flow-script-key/${VERSION}` }));
    expect(await production.read!(KEY)).toEqual({ value: 'production-value' });
    expect(f.calls).toEqual([`${VAULT}secrets/production--flow-script-key?api-version=7.4`]);
    const policy = deployPolicyDocument('123456789012') as { Statement: Array<Record<string, unknown>> };
    expect(policy.Statement.find((statement) => statement.Sid === 'AppSecrets')).toMatchObject({ Effect: 'Allow', Action: 'ssm:*', Resource: 'arn:aws:ssm:*:123456789012:parameter/hypervibe/*' });
    expect(deployRoleGrants()).toContainEqual({ role: AZURE_ROLES.keyVaultSecretsOfficer, label: 'Key Vault Secrets Officer' });
  });
});
