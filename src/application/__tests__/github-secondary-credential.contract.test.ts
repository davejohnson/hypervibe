import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { registerConnectionsTools } from '../../tools/connections.tools.js';
import { createToolContext } from '../context.js';
import { parseToolEnvelope } from '../../tools/__tests__/tool-result.js';
import '../../adapters/providers/github/github.adapter.js';

const scope = 'owner/app';
const originalApi = 'synthetic-existing-api-private';
const oldPackages = 'synthetic-existing-package-private';
const nextPackages = 'synthetic-new-package-private';
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-github-secondary-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });

function existing(selectedScope: string | null = scope, status: 'verified' | 'pending' | 'failed' = 'verified') {
  const repo = new ConnectionRepository();
  const connection = repo.create({ provider: 'github', scope: selectedScope,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: originalApi, login: 'owner', username: 'legacy-owner', packageReadToken: oldPackages }) });
  repo.updateStatus(connection.id, status);
  new AuditRepository().create({ action: 'connection.created', resourceType: 'connection', resourceId: connection.id,
    details: { credentialsSource: 'env', credentialsRef: 'env:ORIGINAL_API',
      credentialsResolution: { apiToken: { resolvedRef: 'env:ORIGINAL_API', sourceKey: 'ORIGINAL_API' } } } });
  return repo.findById(connection.id)!;
}
function input() {
  const file = path.join(root, 'owner-private.env');
  writeFileSync(file, `HYPERVIBE_NODE_AUTH_TOKEN=${nextPackages}\n`, { mode: 0o600 });
  return { provider: 'github', scope, credentialsRef: `dotenv:${file}#HYPERVIBE_NODE_AUTH_TOKEN`, credentialsKey: 'packageReadToken' };
}
async function client() {
  const server = new McpServer({ name: 'github-secondary-test', version: '1' });
  registerConnectionsTools(createMcpCommandRegistrar(server), createToolContext());
  const api = new Client({ name: 'github-secondary-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), api.connect(a)]);
  return { call: async (args: Record<string, unknown>) => parseToolEnvelope(await api.callTool({ name: 'hv_connections', arguments: args })) as any,
    close: async () => { await api.close(); await server.close(); } };
}
// Reconstructed from official GET /user and X-OAuth-Scopes documentation, not
// live provider evidence. Exercise the actual adapter's serialized HTTP boundary.
function transport(options: { packageScopes?: string; packageLogin?: unknown; packageId?: unknown; primaryId?: unknown; primaryLogin?: string;
  packageStatus?: number; onRead?: (token: string) => void } = {}) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const request = new Request(url, init); requests.push(request);
    expect(request.method).toBe('GET'); expect(request.url).toBe('https://api.github.com/user');
    expect(request.headers.get('accept')).toBe('application/vnd.github+json');
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    options.onRead?.(token);
    if (token === nextPackages) return Response.json({ login: options.packageLogin ?? 'owner',
      ...(Object.hasOwn(options, 'packageId') ? options.packageId === undefined ? {} : { id: options.packageId } : { id: 7 }) },
      { status: options.packageStatus ?? 200, headers: { 'x-oauth-scopes': options.packageScopes ?? 'read:packages' } });
    expect(token).toBe(originalApi);
    return Response.json({ login: options.primaryLogin ?? 'owner',
      ...(Object.hasOwn(options, 'primaryId') ? options.primaryId === undefined ? {} : { id: options.primaryId } : { id: 7 }) },
      { headers: { 'x-oauth-scopes': 'repo, workflow' } });
  });
  return requests;
}

describe('GitHub optional package credential update through hv_connections', () => {
  it('adds only the supplied package role without exporting or replacing the verified exact-scope API credential', async () => {
    const before = existing(); const requests = transport(); const args = input(); const t = await client();
    try {
      const result = await t.call(args);
      expect(result.ok).toBe(true);
      const saved = new ConnectionRepository().findById(before.id)!;
      expect(saved.status).toBe('verified'); expect(saved.scope).toBe(scope);
      expect(getSecretStore().decryptObject(saved.credentialsEncrypted)).toEqual({ apiToken: originalApi,
        login: 'owner', username: 'legacy-owner', packageReadToken: nextPackages });
      expect(requests.map(r => r.headers.get('authorization'))).toContain(`Bearer ${nextPackages}`);
      expect(requests.map(r => r.headers.get('authorization'))).toContain(`Bearer ${originalApi}`);
      expect(requests.every(r => r.redirect === 'error' && r.headers.get('x-github-api-version') === '2026-03-10')).toBe(true);
      const audit = new AuditRepository().findByResource('connection', before.id);
      const delta = audit.find(event => event.action === 'connection.credentials.updated');
      expect(delta?.details.scope).toBe(scope);
      expect(delta?.details).toMatchObject({ credentialKeys: ['packageReadToken'], credentialsRef: args.credentialsRef,
        credentialsResolution: { packageReadToken: { resolvedRef: args.credentialsRef, sourceKey: 'HYPERVIBE_NODE_AUTH_TOKEN' } } });
      expect(delta?.details).not.toHaveProperty('credentialsResolution.apiToken');
      expect(JSON.stringify({ result, audit })).not.toMatch(/synthetic-(existing|new)-(api|package)-private/);
    } finally { await t.close(); }
  });

  it.each([
    ['different native account with same login', { packageId: 8 }],
    ['missing secondary identity', { packageId: undefined }],
    ['missing primary identity', { primaryId: undefined }],
    ['malformed secondary identity', { packageId: '7' }],
    ['nonpositive identity', { packageId: 0 }],
    ['unsafe identity', { packageId: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing package scope', { packageScopes: 'repo, workflow' }],
    ['unauthenticated package token', { packageStatus: 401 }],
    ['malformed identity', { packageLogin: { private: nextPackages } }],
  ])('preserves the entire usable connection when verification rejects %s', async (_label, options) => {
    const before = existing(); const requests = transport(options); const t = await client();
    try {
      const result = await t.call(input()); expect(result.ok).toBe(false);
      expect(new ConnectionRepository().findById(before.id)).toEqual(before);
      expect(new AuditRepository().findByAction('connection.credentials.updated')).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(nextPackages);
      expect(requests.map(r => r.headers.get('authorization'))).toContain(`Bearer ${nextPackages}`);
    } finally { await t.close(); }
  });

  it('accepts a rename only when both tokens prove the same stable native account', async () => {
    const before = existing(); transport({ primaryLogin: 'old-owner', packageLogin: 'new-owner' }); const t = await client();
    try { expect((await t.call(input())).ok).toBe(true);
      const saved = getSecretStore().decryptObject<Record<string, unknown>>(new ConnectionRepository().findById(before.id)!.credentialsEncrypted);
      expect(saved.login).toBe('new-owner'); expect(saved.apiToken).toBe(originalApi); expect(saved.packageReadToken).toBe(nextPackages); }
    finally { await t.close(); }
  });

  it('does not fall back to a global or another repository API connection', async () => {
    const global = existing(null); const unrelated = existing('other/app'); const requests = transport(); const t = await client();
    try {
      const result = await t.call(input()); expect(result.ok).toBe(false); expect(requests).toHaveLength(0);
      expect(new ConnectionRepository().findById(global.id)).toEqual(global);
      expect(new ConnectionRepository().findById(unrelated.id)).toEqual(unrelated);
      expect(new ConnectionRepository().findByProviderAndScope('github', scope)).toBeNull();
    } finally { await t.close(); }
  });

  it.each(['pending', 'failed'] as const)('does not reuse a %s primary connection', async status => {
    const before = existing(scope, status); const requests = transport(); const t = await client();
    try { expect((await t.call(input())).ok).toBe(false); expect(requests).toHaveLength(0);
      expect(new ConnectionRepository().findById(before.id)).toEqual(before); }
    finally { await t.close(); }
  });

  it.each([
    { packageReadToken: '' }, { packageReadToken: '  ' }, { packageReadToken: 7 },
    { packageReadToken: nextPackages, login: 'another' },
  ])('rejects a malformed or expanded secondary payload without changing the primary', async supplied => {
    const before = existing(); const requests = transport(); const t = await client();
    try { expect((await t.call({ provider: 'github', scope, credentials: supplied })).ok).toBe(false);
      expect(new ConnectionRepository().findById(before.id)).toEqual(before); expect(requests).toHaveLength(0); }
    finally { await t.close(); }
  });

  it('rejects malformed saved primary credentials without a provider read', async () => {
    const before = existing(); const repo = new ConnectionRepository();
    repo.updateCredentials(before.id, getSecretStore().encryptObject({ login: 'owner' })); repo.updateStatus(before.id, 'verified');
    const malformed = repo.findById(before.id); const requests = transport(); const t = await client();
    try { expect((await t.call(input())).ok).toBe(false); expect(repo.findById(before.id)).toEqual(malformed); expect(requests).toHaveLength(0); }
    finally { await t.close(); }
  });

  it('does not overwrite a primary rotated during the read-only verification', async () => {
    const before = existing(); const repo = new ConnectionRepository(); let rotated: ReturnType<typeof repo.findById>;
    transport({ onRead(token) { if (token === nextPackages) {
      repo.updateCredentials(before.id, getSecretStore().encryptObject({ apiToken: 'synthetic-concurrent-api', login: 'owner' }));
      repo.updateStatus(before.id, 'verified'); rotated = repo.findById(before.id);
    } } });
    const t = await client();
    try { expect((await t.call(input())).ok).toBe(false); expect(repo.findById(before.id)).toEqual(rotated!);
      expect(new AuditRepository().findByAction('connection.credentials.updated')).toEqual([]); }
    finally { await t.close(); }
  });

  it('rolls back the credential write if its role provenance cannot be recorded', async () => {
    const before = existing(); transport(); const create = AuditRepository.prototype.create;
    vi.spyOn(AuditRepository.prototype, 'create').mockImplementation(function (this: AuditRepository, event) {
      if (event.action === 'connection.credentials.updated') throw new Error(nextPackages);
      return create.call(this, event);
    });
    const t = await client();
    try { const result = await t.call(input()); expect(result.ok).toBe(false);
      expect(new ConnectionRepository().findById(before.id)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain(nextPackages); }
    finally { await t.close(); }
  });

  it('preserves the primary and redacts failures which echo both private credentials', async () => {
    const before = existing();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`${originalApi} ${nextPackages}`));
    const t = await client();
    try { const result = await t.call(input()); expect(result.ok).toBe(false);
      expect(new ConnectionRepository().findById(before.id)).toEqual(before);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-(existing-api|new-package)-private/); }
    finally { await t.close(); }
  });

  it('keeps complete replacement behavior when a primary token is explicitly supplied', async () => {
    const before = existing();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(url, init); expect(request.url).toBe('https://api.github.com/user');
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-replacement-api');
      return Response.json({ login: 'owner', id: 7 }, { headers: { 'x-oauth-scopes': 'repo, workflow' } });
    });
    const t = await client();
    try { expect((await t.call({ provider: 'github', scope, credentials: { apiToken: 'synthetic-replacement-api' } })).ok).toBe(true);
      const saved = new ConnectionRepository().findById(before.id)!;
      expect(getSecretStore().decryptObject(saved.credentialsEncrypted)).toEqual({ apiToken: 'synthetic-replacement-api', login: 'owner' });
      expect(new AuditRepository().findByAction('connection.credentials.updated')).toEqual([]); }
    finally { await t.close(); }
  });
});
