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
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { createToolContext } from '../context.js';
import { registerHvObservabilityTools } from '../hv-observability.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

let tempDir: string;

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-obs-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'hv-obs-test', version: '1.0.0' });
  registerHvObservabilityTools(server, createToolContext());
  const client = new Client({ name: 'hv-obs-test-client', version: '1.0.0' });
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

describe('hv_logs', () => {
  it('errors when the environment is missing', async () => {
    new ProjectRepository().create({ name: 'obs-app' });
    const t = await makeClient();
    const result = await t.call('hv_logs', { project: 'obs-app', env: 'staging', source: 'service' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('hints at hv_apply when no services are bound', async () => {
    const project = new ProjectRepository().create({ name: 'obs-empty-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: {} },
    });
    const t = await makeClient();
    const result = await t.call('hv_logs', { project: 'obs-empty-app', env: 'staging', source: 'service' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('hv_apply');
    await t.close();
  });

  it('reports stripe-webhooks errors as structured envelopes', async () => {
    const t = await makeClient();
    const result = await t.call('hv_logs', { source: 'stripe-webhooks' });
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('Stripe');
    await t.close();
  });
});

describe('hv_errors', () => {
  it.each([
    ['list', { totalFound: 0, errors: [] }],
    ['summary', {
      summary: { totalServices: 0, totalErrors: 0, failedDeployments: 0, healthyServices: 0 },
      services: [],
    }],
  ] as const)('keeps provider-neutral runtime error %s visibility', async (action, expected) => {
    const project = new ProjectRepository().create({ name: `errors-${action}-app` });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', services: {} },
    });
    const t = await makeClient();
    const result = await t.call('hv_errors', {
      project: project.name,
      env: 'production',
      action,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      environment: 'production',
      provider: 'railway',
      ...expected,
    });
    await t.close();
  });
});

describe('hv_health', () => {
  it('checks an explicit URL with mocked fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const t = await makeClient();
    const result = await t.call('hv_health', { url: 'https://example.com/health' });
    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(true);
    expect(result.data.check.status).toBe(200);
    await t.close();
  });

  it('surfaces failing checks with a logs hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const t = await makeClient();
    const result = await t.call('hv_health', { url: 'https://example.com/health' });
    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(false);
    expect(result.hint).toContain('hv_logs');
    await t.close();
  });

  it('errors when the service has no URL binding', async () => {
    const project = new ProjectRepository().create({ name: 'health-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway', services: {} } });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    const t = await makeClient();
    const result = await t.call('hv_health', { project: 'health-app', env: 'staging', service: 'web' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    await t.close();
  });

  it('checks a repo-backed service without a cached service row or provider connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({ name: 'fresh-clone-health' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        services: {
          web: { serviceId: 'svc-web', url: 'https://web.example.com' },
        },
      },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: {
            web: {
              workloadKind: 'web',
              public: true,
              healthCheckPath: '/healthz',
            },
          },
        },
      },
    }));

    const t = await makeClient();
    const result = await t.call('hv_health', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.service).toBe('web');
    expect(result.data.baseUrl).toBe('https://web.example.com');
    expect(result.data.check.url).toBe('https://web.example.com/healthz');
    expect(result.data.check.ok).toBe(true);
    await t.close();
  });
});
