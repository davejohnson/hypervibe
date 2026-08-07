import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { ISecretManagerAdapter } from '../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../domain/registry/secretmanager.registry.js';
import * as hostingEnv from '../../domain/services/hosting-env.service.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { createToolContext } from '../context.js';
import { registerHvSecretsTools } from '../hv-secrets.tools.js';
import { parseToolEnvelope } from './tool-result.js';

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
  registerHvSecretsTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'hv-secrets-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      return parseToolEnvelope(await client.callTool({ name, arguments: args })) as Record<string, any>;
    },
    async names() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('reduced secret command surface', () => {
  it('lists sources by default and keeps secret managers read-only', async () => {
    const client = await makeClient();
    expect(await client.names()).toEqual(['hv_secrets']);
    const result = await client.call('hv_secrets');
    expect(result.ok).toBe(true);
    expect(result.data.sources).toContainEqual({ source: 'vault', status: 'missing' });
    expect(result.data.sources).toContainEqual({ source: 'github', status: 'missing' });
    expect(await client.names()).not.toContain('hv_secrets_sync');
    expect(await client.names()).not.toContain('hv_secrets_set');
    await client.close();
  });
});

describe('secret reads', () => {
  it('validates explicit project context for manager reads', async () => {
    new ProjectRepository().create({ name: 'known-project', defaultPlatform: 'railway' });
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: 'does-not-exist',
      provider: 'vault',
      path: 'apps/prod',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('AMBIGUOUS_PROJECT');
    await client.close();
  });

  it('fully redacts hosting values', async () => {
    const project = new ProjectRepository().create({ name: 'hosting-read-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    vi.spyOn(hostingEnv, 'readHostingEnvVars').mockResolvedValue({
      success: true,
      provider: 'railway',
      variables: { API_KEY: 'provider-secret-value' },
    });
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.data.vars).toEqual({ API_KEY: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain('provider-secret-value');
    await client.close();
  });

  it('fully redacts manager values and never exposes mutation methods', async () => {
    const repo = new ConnectionRepository();
    const connection = repo.create({
      provider: 'vault',
      credentialsEncrypted: getSecretStore().encryptObject({ address: 'https://vault.example', token: 'token' }),
    });
    repo.updateStatus(connection.id, 'verified');
    const adapter: ISecretManagerAdapter = {
      name: 'vault',
      async connect() {},
      async verify() { return { success: true }; },
      async getSecret() { return { value: 'manager-secret-value', version: '3' }; },
      async listSecrets() { return []; },
    };
    vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(adapter);
    const client = await makeClient();

    const result = await client.call('hv_secrets', {
      provider: 'vault',
      path: 'apps/prod',
      key: 'API_KEY',
    });

    expect(result.data).toEqual({
      secretRef: 'vault://apps/prod#API_KEY',
      value: '[redacted]',
      present: true,
      version: '3',
    });
    expect(JSON.stringify(result)).not.toContain('manager-secret-value');
    expect('setSecret' in adapter).toBe(false);
    await client.close();
  });
});
