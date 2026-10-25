import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { DopplerAdapter } from '../../../adapters/providers/secretmanagers/doppler.adapter.js';
import '../../../adapters/providers/secretmanagers/vault.adapter.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { verifyConnection } from '../connection-ops.service.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-connection-output-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const supplied = 'not-a-recognizable-token-pattern-9274';
function save(provider: string, credentials: Record<string, unknown>) {
  return new ConnectionRepository().create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
}
function expectSafe(result: unknown) {
  const output = JSON.stringify(result);
  expect(output).not.toContain(supplied);
  expect(output).toContain('[redacted]');
  expect(JSON.stringify(new AuditRepository().findRecent())).not.toContain(supplied);
}

// Real adapters and serialized HTTP. Official endpoint/authentication contracts:
// https://docs.github.com/en/rest/users/users#get-the-authenticated-user
// https://docs.doppler.com/reference/api
// Error echoes are deliberately synthetic negative observations: neither a token
// pattern nor provider-authentication success may authorize publishing its value.
it.each(['github', 'doppler'] as const)('scrubs a %s error response at the shared output and audit boundary', async provider => {
  const connection = save(provider, provider === 'github' ? { apiToken: supplied } : { token: supplied });
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(provider === 'github' ? 'https://api.github.com/user' : 'https://api.doppler.com/v3/configs/config/secrets');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${supplied}`);
    return Response.json({ message: `Rejected credential ${supplied}` }, { status: 401 });
  });
  const result = await verifyConnection(provider);
  expect(result.kind).toBe('failed'); expect(request).toHaveBeenCalledOnce();
  expectSafe(result);
  expect(new ConnectionRepository().findById(connection.id)?.status).toBe('failed');
  if (provider === 'github') expect(new AuditRepository().findByResource('connection', connection.id)[0]?.details.reason).toContain('[redacted]');
});

// https://developer.hashicorp.com/vault/api-docs/auth/approle#login-with-approle
// AppRole authenticates inside connect(), so this exercises the outer caught-
// error branch rather than the adapter's returned failed verification result.
it('scrubs a caught secret-manager connection error from the actual AppRole transport', async () => {
  save('vault', { address: 'https://vault.example', roleId: 'app-role', secretId: supplied });
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe('https://vault.example/v1/auth/approle/login');
    expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ role_id: 'app-role', secret_id: supplied });
    return Response.json({ errors: [`Rejected AppRole secret ${supplied}`] }, { status: 400 });
  });
  const result = await verifyConnection('vault');
  expect(result.kind).toBe('threw'); expect(request).toHaveBeenCalledOnce(); expectSafe(result);
});

it('scrubs caught provider construction errors using nested encrypted credential inputs', async () => {
  const connection = save('github', { apiToken: 'separate-private-input', nested: [{ value: supplied }] });
  vi.spyOn(providerRegistry.get('github')!, 'factory').mockRejectedValue(new Error(`Provider startup echoed ${supplied}`));
  const result = await verifyConnection('github');
  expect(result.kind).toBe('threw'); expectSafe(result);
  expect(new AuditRepository().findByResource('connection', connection.id)[0]?.details.error).toContain('[redacted]');
});

it('scrubs successful diagnostic fields and warnings before audit or return', async () => {
  const connection = save('github', { apiToken: 'separate-private-input', serviceAccountJson: JSON.stringify({ private_key: supplied }) });
  vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'safe-user', warning: `Check ${supplied}`, email: `${supplied}@example.invalid` } as any);
  const result = await verifyConnection('github');
  expect(result.kind).toBe('verified'); expectSafe(result);
  expect(new AuditRepository().findByResource('connection', connection.id)[0]?.details.email).toBe('[redacted]@example.invalid');
});

it('scrubs successful secret-manager identity output', async () => {
  save('doppler', { token: supplied });
  vi.spyOn(DopplerAdapter.prototype, 'verify').mockResolvedValue({ success: true, identity: `Identity echoed ${supplied}` });
  const result = await verifyConnection('doppler');
  expect(result.kind).toBe('verified'); expectSafe(result);
});

// Vault's lookup-self data.id is the token, not an account identity:
// https://developer.hashicorp.com/vault/api-docs/auth/token#lookup-a-token-self
it('does not expose a newly issued Vault AppRole token when lookup has no display name', async () => {
  const issuedToken = 'newly-issued-private-material-6389';
  save('vault', { address: 'https://vault.example', roleId: 'app-role', secretId: supplied });
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === 'https://vault.example/v1/auth/approle/login') {
      expect(JSON.parse(String(init?.body))).toEqual({ role_id: 'app-role', secret_id: supplied });
      return Response.json({ auth: { client_token: issuedToken } });
    }
    expect(String(input)).toBe('https://vault.example/v1/auth/token/lookup-self');
    expect(new Headers(init?.headers).get('x-vault-token')).toBe(issuedToken);
    return Response.json({ data: { id: issuedToken } });
  });
  const result = await verifyConnection('vault');
  expect(result.kind).toBe('verified'); expect(request).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ data: {} });
  expect(result).not.toHaveProperty('data.identity');
  expect(JSON.stringify(result)).not.toContain(issuedToken);
  expect(JSON.stringify(new AuditRepository().findRecent())).not.toContain(issuedToken);
});
