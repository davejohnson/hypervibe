import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
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
it.each(['github'] as const)('scrubs a %s error response at the shared output and audit boundary', async provider => {
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

