import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { createToolContext } from '../context.js';
import { registerHvDbTools } from '../hv-db.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-db-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-db-test', version: '1.0.0' });
  registerHvDbTools(server, createToolContext());
  const client = new Client({ name: 'hv-db-test-client', version: '1.0.0' });
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

function seedDbProject() {
  const project = new ProjectRepository().create({ name: 'db-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    bindings: { provider: 'supabase', connectionString: 'postgres://user:secretpw@db.example.com:5432/app' },
    externalId: 'db-1',
  });
  return { project, environment };
}

describe('hv_db_query', () => {
  const URL = 'postgres://user:pw@localhost:5432/app';

  it('rejects multi-statement SQL before connecting', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: 'SELECT 1; DROP TABLE users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('Multi-statement');
    await t.close();
  });

  it('blocks mutations without allowMutations', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: 'DELETE FROM users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.hint).toContain('allowMutations');
    await t.close();
  });

  it('is not evaded by comment-prefixed mutations', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: URL, sql: '/* hi */ DROP TABLE users' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });
});

describe('hv_db_migrate', () => {
  it('confirm-gates reset mode with a masked URL preview', async () => {
    seedDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_migrate', { project: 'db-app', env: 'staging', mode: 'reset' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    const details = JSON.stringify(result.error.details);
    expect(details).not.toContain('secretpw');
    expect(details).toContain('***');
    await t.close();
  });

  it('requires a command for seed mode', async () => {
    seedDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_migrate', { project: 'db-app', env: 'staging', mode: 'seed' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.hint).toContain('releaseCommand');
    await t.close();
  });

  it('confirm-gates seed mode and masks database URLs', async () => {
    seedDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_migrate', {
      project: 'db-app',
      env: 'staging',
      mode: 'seed',
      command: 'npm run db:seed',
      targetConnectionUrl: 'postgres://user:secretpw@db.example.com:5432/app',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(JSON.stringify(result)).not.toContain('secretpw');
    expect(JSON.stringify(result)).toContain('postgres://***:***@db.example.com:5432/app');
    await t.close();
  });

  it('runs seed mode without leaking database URLs printed by the command', async () => {
    seedDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_migrate', {
      project: 'db-app',
      env: 'staging',
      mode: 'seed',
      command: 'node -e "console.log(process.env.DATABASE_URL)"',
      targetConnectionUrl: 'postgres://user:secretpw@db.example.com:5432/app',
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data.stdout).toContain('postgres://***:***@db.example.com:5432/app');
    expect(JSON.stringify(result)).not.toContain('secretpw');
    await t.close();
  });
});

describe('hv_db_url', () => {
  it('masks credentials by default and suppresses raw reveal in tool output', async () => {
    seedDbProject();
    const t = await makeClient();

    const masked = await t.call('hv_db_url', { project: 'db-app', env: 'staging' });
    expect(masked.ok).toBe(true);
    expect(masked.data.masked).toBe(true);
    expect(masked.data.databaseUrl).not.toContain('secretpw');
    expect(masked.data.databaseUrl).toContain('***');

    const revealed = await t.call('hv_db_url', { project: 'db-app', env: 'staging', reveal: true });
    expect(revealed.data.masked).toBe(true);
    expect(revealed.data.revealSuppressed).toBe(true);
    expect(revealed.data.databaseUrl).not.toContain('secretpw');
    expect(revealed.hint).toContain('Raw database URLs are not returned');
    await t.close();
  });

  it('returns NOT_FOUND when no database is resolvable', async () => {
    const project = new ProjectRepository().create({ name: 'no-db-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const t = await makeClient();
    const result = await t.call('hv_db_url', { project: 'no-db-app', env: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });
});

describe('hv_db_migrate mode="move"', () => {
  const SOURCE_URL = 'postgresql://postgres:oldpass@db.supabase.co:5432/postgres';
  const TARGET_URL = 'postgresql://app:newpass@railway.internal:5432/app';

  function seedStagedMigration() {
    const project = new ProjectRepository().create({ name: 'move-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        connectionUrl: TARGET_URL,
        previousProvider: 'supabase',
        previousBindings: { provider: 'supabase', connectionString: SOURCE_URL },
      },
    });
  }

  it('confirm-gates the move with masked source and target', async () => {
    seedStagedMigration();

    const t = await makeClient();
    const result = await t.call('hv_db_migrate', { project: 'move-app', env: 'production', mode: 'move' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.error.details.source.provider).toBe('supabase');
    expect(result.error.details.target.provider).toBe('railway');
    // URLs are masked — passwords never reach chat.
    expect(JSON.stringify(result)).not.toContain('oldpass');
    expect(JSON.stringify(result)).not.toContain('newpass');
    expect(result.error.details.strategy.writeFreezeRequired).toBe(true);
    await t.close();
  });

  it('returns NOT_FOUND with guidance when no previous database is recorded', async () => {
    const project = new ProjectRepository().create({ name: 'nosrc-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: { provider: 'railway', connectionUrl: TARGET_URL },
    });

    const t = await makeClient();
    const result = await t.call('hv_db_migrate', { project: 'nosrc-app', env: 'production', mode: 'move' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('previous database');
    await t.close();
  });
});
