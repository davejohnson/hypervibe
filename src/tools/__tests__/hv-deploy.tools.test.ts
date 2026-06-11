import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { createToolContext } from '../context.js';
import { registerHvDeployTools } from '../hv-deploy.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-deploy-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-deploy-test', version: '1.0.0' });
  registerHvDeployTools(server, createToolContext());
  const client = new Client({ name: 'hv-deploy-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_deploy', () => {
  it('returns a structured error for unknown projects', async () => {
    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'nope' });
    expect(result.ok).toBe(false);
    expect(['NOT_FOUND', 'AMBIGUOUS_PROJECT']).toContain(result.error.code);
    await t.close();
  });

  it('confirm-gates protected environments', async () => {
    const project = new ProjectRepository().create({
      name: 'gate-app',
      policies: { protectedEnvironments: ['production'] },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'gate-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });
});

describe('hv_rollback', () => {
  it('confirm-gates protected environments', async () => {
    const project = new ProjectRepository().create({
      name: 'rollback-gate-app',
      policies: { protectedEnvironments: ['production'] },
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });

    const t = await makeClient();
    const result = await t.call('hv_rollback', { project: 'rollback-gate-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });
});
