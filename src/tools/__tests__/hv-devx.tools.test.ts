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
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { tunnelManager } from '../../adapters/providers/tunnel/tunnel.manager.js';
import { createToolContext } from '../context.js';
import { registerHvDevxTools } from '../hv-devx.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-devx-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-devx-test', version: '1.0.0' });
  registerHvDevxTools(server, createToolContext());
  const client = new Client({ name: 'hv-devx-test-client', version: '1.0.0' });
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

async function seedRuns() {
  const project = new ProjectRepository().create({ name: 'devx-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  const runRepo = new RunRepository();
  const older = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'one' } });
  runRepo.updateStatus(older.id, 'succeeded');
  // created_at has millisecond precision; ensure a strict ordering between the two runs.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = runRepo.create({ projectId: project.id, environmentId: environment.id, type: 'deploy', plan: { step: 'two' } });
  runRepo.updateStatus(newer.id, 'failed', 'boom');
  return { project, environment, older, newer };
}

describe('hv_upgrade', () => {
  it('reports package, storage, schema, repo, and local state status', async () => {
    new ProjectRepository().create({ name: 'upgrade-app' });
    const t = await makeClient();

    const status = await t.call('hv_upgrade');
    expect(status.ok).toBe(true);
    expect(status.data.hypervibe.version).toBeTypeOf('string');
    expect(status.data.storage.databasePath).toContain('test.db');
    expect(status.data.sqlite.needsMigration).toBe(false);
    expect(status.data.sqlite.currentVersion).toBe(status.data.sqlite.latestVersion);
    expect(status.data.localState.projects).toBe(1);
    expect(status.data.repo).toHaveProperty('spec');
    expect(status.next).toEqual(['hv_status', 'hv_plan']);
    await t.close();
  });

  it('can explicitly migrate a stale local database', async () => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(tempDir, 'stale.db'));
    const t = await makeClient();

    const migrated = await t.call('hv_upgrade', { action: 'migrate' });
    expect(migrated.ok).toBe(true);
    expect(migrated.data.sqlite.needsMigration).toBe(false);
    expect(migrated.data.sqlite.currentVersion).toBe(migrated.data.sqlite.latestVersion);
    expect(migrated.data.sqlite.appliedNow.length).toBeGreaterThan(0);
    await t.close();
  });
});

describe('hv_runs', () => {
  it('lists seeded runs with the latest run surfaced first', async () => {
    const { newer } = await seedRuns();
    const t = await makeClient();

    const list = await t.call('hv_runs', { project: 'devx-app' });
    expect(list.ok).toBe(true);
    expect(list.data.count).toBe(2);
    expect(list.data.latest.id).toBe(newer.id);
    expect(list.data.latest.status).toBe('failed');
    expect(list.data.runs[0]).toMatchObject({
      id: newer.id,
      type: 'deploy',
      status: 'failed',
      project: 'devx-app',
      environment: 'staging',
      error: 'boom',
    });
    expect(list.hint).toContain(newer.id);
    await t.close();
  });

  it('gets a single run with plan and receipts', async () => {
    const { older } = await seedRuns();
    const t = await makeClient();

    const get = await t.call('hv_runs', { action: 'get', runId: older.id });
    expect(get.ok).toBe(true);
    expect(get.data.run.id).toBe(older.id);
    expect(get.data.run.status).toBe('succeeded');
    expect(get.data.run.plan).toEqual({ step: 'one' });
    expect(get.data.run.receipts).toEqual([]);

    const missing = await t.call('hv_runs', { action: 'get', runId: '00000000-0000-0000-0000-000000000000' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('NOT_FOUND');

    const noId = await t.call('hv_runs', { action: 'get' });
    expect(noId.ok).toBe(false);
    expect(noId.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('lists audit events via action="audit"', async () => {
    new AuditRepository().create({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });
    const t = await makeClient();

    const audit = await t.call('hv_runs', { action: 'audit', auditAction: 'deploy.started' });
    expect(audit.ok).toBe(true);
    expect(audit.data.count).toBe(1);
    expect(audit.data.events[0]).toMatchObject({
      action: 'deploy.started',
      resourceType: 'run',
      resourceId: 'run-1',
      details: { foo: 'bar' },
    });
    await t.close();
  });
});

describe('hv_tunnel', () => {
  it('dispatches start to the tunnel manager and returns the tunnel info', async () => {
    const start = vi.spyOn(tunnelManager, 'start').mockResolvedValue({
      id: 'cloudflared-3000',
      provider: 'cloudflared',
      localPort: 3000,
      publicUrl: 'https://test.trycloudflare.com',
      status: 'running',
    });
    const t = await makeClient();

    const res = await t.call('hv_tunnel', { action: 'start', port: 3000 });
    expect(res.ok).toBe(true);
    expect(res.data.tunnel.publicUrl).toBe('https://test.trycloudflare.com');
    expect(res.hint).toContain('https://test.trycloudflare.com');
    expect(start).toHaveBeenCalledWith(3000, 'cloudflared', { ngrokAuthToken: undefined });

    const noPort = await t.call('hv_tunnel', { action: 'start' });
    expect(noPort.ok).toBe(false);
    expect(noPort.error.code).toBe('VALIDATION');
    await t.close();
  });

  it('dispatches stop/status/list, deriving tunnelId from port when omitted', async () => {
    const stop = vi.spyOn(tunnelManager, 'stop').mockResolvedValue(true);
    vi.spyOn(tunnelManager, 'getStatus').mockReturnValue(null);
    vi.spyOn(tunnelManager, 'listTunnels').mockReturnValue([{
      id: 'cloudflared-4000',
      provider: 'cloudflared',
      localPort: 4000,
      publicUrl: 'https://other.trycloudflare.com',
      status: 'running',
    }]);
    const t = await makeClient();

    const stopped = await t.call('hv_tunnel', { action: 'stop', port: 3000 });
    expect(stopped.ok).toBe(true);
    expect(stop).toHaveBeenCalledWith('cloudflared-3000');

    const status = await t.call('hv_tunnel', { action: 'status', tunnelId: 'cloudflared-3000' });
    expect(status.ok).toBe(false);
    expect(status.error.code).toBe('NOT_FOUND');

    const list = await t.call('hv_tunnel', { action: 'list' });
    expect(list.ok).toBe(true);
    expect(list.data.count).toBe(1);
    expect(list.data.tunnels[0].id).toBe('cloudflared-4000');
    await t.close();
  });
});

describe('hv_local_bootstrap', () => {
  it('writes compose.yaml/.env.local and registers components, then lists them', async () => {
    new ProjectRepository().create({ name: 'devx-local-app' });
    const t = await makeClient();

    const boot = await t.call('hv_local_bootstrap', {
      project: 'devx-local-app',
      outputDir: tempDir,
      components: ['postgres', 'redis'],
    });
    expect(boot.ok).toBe(true);
    expect(boot.data.components).toEqual(['postgres', 'redis']);
    expect(boot.data.files.compose).toBe(path.join(tempDir, 'compose.yaml'));

    const list = await t.call('hv_local_bootstrap', { action: 'components', project: 'devx-local-app', env: 'local' });
    expect(list.ok).toBe(true);
    expect(list.data.environments).toHaveLength(1);
    expect(list.data.environments[0].components.map((c: { type: string }) => c.type).sort()).toEqual(['postgres', 'redis']);
    await t.close();
  });
});
