import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvSecretsTools } from '../hv-secrets.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-secrets-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-secrets-test', version: '1.0.0' });
  registerHvSecretsTools(server, createToolContext());
  const client = new Client({ name: 'hv-secrets-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_secrets_set target=mapping', () => {
  it('creates, lists, and removes a mapping', async () => {
    new ProjectRepository().create({ name: 'secrets-app' });
    const t = await makeClient();

    const created = await t.call('hv_secrets_set', {
      project: 'secrets-app',
      target: 'mapping',
      key: 'API_KEY',
      secretRef: 'vault://apps/prod#API_KEY',
      environments: ['production'],
    });
    expect(created.ok).toBe(true);
    expect(created.data.mapping.secretRef).toBe('vault://apps/prod#API_KEY');
    expect(created.next).toContain('hv_secrets_sync');

    const list = await t.call('hv_secrets_list', { project: 'secrets-app' });
    expect(list.ok).toBe(true);
    expect(list.data.mappings).toContainEqual(expect.objectContaining({ envVar: 'API_KEY' }));

    const removed = await t.call('hv_secrets_set', {
      project: 'secrets-app',
      target: 'mapping',
      key: 'API_KEY',
      remove: true,
    });
    expect(removed.ok).toBe(true);

    const after = await t.call('hv_secrets_list', { project: 'secrets-app' });
    expect(after.data.mappings).toEqual([]);
    await t.close();
  });

  it('rejects malformed secret refs', async () => {
    new ProjectRepository().create({ name: 'secrets-bad-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      project: 'secrets-bad-app',
      target: 'mapping',
      key: 'API_KEY',
      secretRef: 'not-a-ref',
    });
    expect(result.ok).toBe(false);
    await t.close();
  });
});

describe('hv_secrets_set target=github', () => {
  it('sets a GitHub Actions secret from a dotenv secretRef without echoing the value', async () => {
    new ProjectRepository().create({
      name: 'github-secret-app',
      gitRemoteUrl: 'https://github.com/davejohnson/github-secret-app',
    });
    const github = new ConnectionRepository().create({
      provider: 'github',
      scope: 'davejohnson/github-secret-app',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token' }),
    });
    new ConnectionRepository().updateStatus(github.id, 'verified');
    const envPath = path.join(tempDir, '.env');
    writeFileSync(envPath, 'GHCR_TOKEN=ghp_secret_value\n');
    const setSecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();
    const t = await makeClient();

    const result = await t.call('hv_secrets_set', {
      project: 'github-secret-app',
      target: 'github',
      key: 'IMAGE_REGISTRY_TOKEN',
      secretRef: `dotenv:${envPath}#GHCR_TOKEN`,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      repository: 'davejohnson/github-secret-app',
      secretName: 'IMAGE_REGISTRY_TOKEN',
      action: 'set',
      valueSource: 'dotenv',
    });
    expect(setSecret).toHaveBeenCalledWith('davejohnson', 'github-secret-app', 'IMAGE_REGISTRY_TOKEN', 'ghp_secret_value');
    expect(JSON.stringify(result)).not.toContain('ghp_secret_value');
    await t.close();
  });
});

describe('hv_secrets_set validation', () => {
  it('requires provider/path for manager writes', async () => {
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', { target: 'manager', key: 'X', value: 'y' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('requires a verified manager connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_secrets_set', {
      target: 'manager',
      provider: 'vault',
      path: 'apps/prod',
      key: 'X',
      value: 'y',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    expect(result.hint).toContain('hv_connect');
    await t.close();
  });
});

describe('hv_secrets_sync', () => {
  it('reports unsupported rotation providers', async () => {
    new ProjectRepository().create({ name: 'rotate-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_sync', {
      project: 'rotate-app',
      rotate: { provider: 'vault', path: 'apps/prod' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNSUPPORTED');
    await t.close();
  });

  it('dry-runs with no mappings as an empty sync', async () => {
    new ProjectRepository().create({ name: 'empty-sync-app' });
    const t = await makeClient();
    const result = await t.call('hv_secrets_sync', { project: 'empty-sync-app', dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.data.environments).toEqual([]);
    await t.close();
  });
});
