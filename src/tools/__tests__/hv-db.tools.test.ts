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
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
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

function seedInternalRailwayDbProject() {
  const project = new ProjectRepository().create({ name: 'rail-db-app', defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
    },
  });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    externalId: 'rail-db-svc-1',
    bindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      connectionUrl: '${{Postgres.DATABASE_URL}}',
    },
  });
  return { project, environment };
}

function seedServiceSpecificRailwayDbProject() {
  const project = new ProjectRepository().create({ name: 'rail-service-db-app', defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
      environmentId: 'rail-env-1',
      services: {
        web: { serviceId: 'svc-web' },
        worker: { serviceId: 'svc-worker' },
      },
    },
  });
  new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  new ServiceRepository().create({ projectId: project.id, name: 'worker', buildConfig: {}, envVarSpec: {} });
  new ComponentRepository().create({
    environmentId: environment.id,
    type: 'postgres',
    externalId: 'rail-db-svc-1',
    bindings: {
      provider: 'railway',
      projectId: 'rail-proj-1',
    },
  });
  const connection = new ConnectionRepository().create({
    provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-token' }),
  });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  return { project, environment };
}

describe('hv_db_query', () => {
  const URL = 'postgres://user:pw@localhost:5432/app';

  it('rejects provider template refs before reaching the database adapter', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', { connectionUrl: '${{Postgres.DATABASE_URL}}', sql: 'SELECT 1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('not a supported Postgres URL');
    await t.close();
  });

  it('rejects private provider hosts passed as direct query URLs', async () => {
    const t = await makeClient();
    const result = await t.call('hv_db_query', {
      connectionUrl: 'postgresql://user:pw@postgres.railway.internal:5432/app',
      sql: 'SELECT 1',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('not externally reachable');
    await t.close();
  });

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

  it('reports internal managed database targets as unreachable instead of unknown database type', async () => {
    seedInternalRailwayDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_query', { project: 'rail-db-app', env: 'production', sql: 'SELECT 1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('externally reachable Postgres URL');
    expect(result.error.message).not.toContain('Unknown database type');
    expect(result.error.details.canCreateTcpProxy).toBe(true);
    expect(result.hint).toContain('internal-only');
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

  it('previews reset mode for internal managed databases without passing provider refs to the adapter', async () => {
    seedInternalRailwayDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_migrate', { project: 'rail-db-app', env: 'production', mode: 'reset' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.error.message).toContain('drops ALL tables');
    expect(result.error.details.reachable).toBe(false);
    expect(result.error.details.canCreateTcpProxy).toBe(true);
    expect(result.hint).toContain('confirm=true');
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

  it('does not return provider runtime refs as database URLs', async () => {
    seedInternalRailwayDbProject();
    const t = await makeClient();
    const result = await t.call('hv_db_url', { project: 'rail-db-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(result)).not.toContain('${{Postgres.DATABASE_URL}}');
    expect(result.hint).toContain('internal-only');
    await t.close();
  });

  it('uses the requested service binding when resolving from Railway bindings', async () => {
    seedServiceSpecificRailwayDbProject();
    const getDatabaseUrl = vi.spyOn(RailwayAdapter.prototype, 'getDatabaseUrl')
      .mockImplementation(async (_projectId, _environmentId, serviceId) =>
        serviceId === 'svc-worker'
          ? 'postgresql://worker:workerpw@worker-db.example.com:5432/app'
          : 'postgresql://web:webpw@web-db.example.com:5432/app'
      );
    const t = await makeClient();

    const result = await t.call('hv_db_url', {
      project: 'rail-service-db-app',
      env: 'production',
      service: 'worker',
    });

    expect(result.ok).toBe(true);
    expect(result.data.source).toBe('rail-service-db-app/production/worker');
    expect(result.data.databaseUrl).toContain('worker-db.example.com');
    expect(result.data.databaseUrl).not.toContain('workerpw');
    expect(getDatabaseUrl).toHaveBeenCalledWith('rail-proj-1', 'rail-env-1', 'svc-worker');
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
