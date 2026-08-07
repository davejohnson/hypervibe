import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter } from '../../adapters/providers/stripe/stripe.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvObservabilityTools } from '../hv-observability.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';

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
  registerHvObservabilityTools(createMcpCommandRegistrar(server), createToolContext());
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

  it('reads Stripe webhooks through the selected environment-scoped connection', async () => {
    const project = new ProjectRepository().create({ name: 'stripe-observability-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', services: {} },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          payments: {
            stripe: {
              environment: 'production',
              services: ['web'],
              credentials: { secretKeyEnvVar: 'STRIPE_SECRET_KEY' },
            },
          },
        },
      },
    }));

    const connections = new ConnectionRepository();
    const global = connections.create({
      provider: 'stripe',
      credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_test_global' }),
    });
    connections.updateStatus(global.id, 'verified');
    const production = connections.create({
      provider: 'stripe',
      scope: 'production',
      credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_live_production' }),
    });
    connections.updateStatus(production.id, 'verified');
    const listWebhooks = vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([{
      id: 'we_live',
      url: 'https://example.com/stripe',
      status: 'enabled',
      enabled_events: ['invoice.paid'],
      created: 1,
      description: 'Production webhook',
      metadata: {},
    }]);

    const t = await makeClient();
    const result = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      mode: 'live',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      project: project.name,
      environment: 'staging',
      stripeEnvironment: 'production',
      mode: 'live',
      webhooks: [{ id: 'we_live', enabledEvents: 1 }],
    });
    expect(listWebhooks).toHaveBeenCalledWith('live');

    const mismatch = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      mode: 'sandbox',
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error.code).toBe('VALIDATION');

    const foreignSelector = await t.call('hv_logs', {
      project: project.name,
      env: 'staging',
      source: 'stripe-webhooks',
      service: 'web',
    });
    expect(foreignSelector.ok).toBe(false);
    expect(foreignSelector.error.code).toBe('VALIDATION');
    expect(foreignSelector.error.details.invalid).toEqual(['service']);
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

  it('checks a declared domain without a provider-specific URL binding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({ name: 'domain-health' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'cloudrun',
        services: {
          web: { serviceId: 'cloudrun-web' },
        },
      },
    });
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'cloudrun' },
          services: {
            web: {
              workloadKind: 'web',
              public: true,
              healthCheckPath: '/healthz',
            },
          },
          domain: 'staging.example.com',
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
    expect(result.data.baseUrl).toBe('https://staging.example.com');
    expect(result.data.check.url).toBe('https://staging.example.com/healthz');
    await t.close();
  });

  it('surfaces production deployment failures after a successful staging endpoint check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const project = new ProjectRepository().create({
      name: 'cross-environment-health',
      defaultPlatform: 'railway',
    });
    for (const environment of ['staging', 'production']) {
      new EnvironmentRepository().create({
        projectId: project.id,
        name: environment,
        platformBindings: {
          provider: 'railway',
          services: {
            web: {
              serviceId: `${environment}-web`,
              url: `https://${environment}.example.com`,
            },
            worker: { serviceId: `${environment}-worker` },
          },
        },
      });
    }
    new SpecStore().replace(project, projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: Object.fromEntries(['staging', 'production'].map((environment) => [
        environment,
        {
          hosting: { provider: 'railway' },
          services: {
            web: { workloadKind: 'web', public: true, healthCheckPath: '/health' },
            worker: { workloadKind: 'worker' },
          },
          deploy: environment === 'production'
            ? { strategy: 'manual' }
            : { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      ])),
    }));
    vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        getDeployStatus: async (_environment: unknown, serviceId: string) => ({
          status: serviceId.startsWith('production-') ? 'CRASHED' : 'deployed',
        }),
      } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_health', {
      project: project.name,
      env: 'staging',
      service: 'web',
    });

    expect(result.ok).toBe(true);
    expect(result.data.check.ok).toBe(true);
    expect(result.data.deploymentHealth.state).toBe('failed');
    expect(result.data.deploymentHealth.failures).toEqual([
      { environment: 'production', provider: 'railway', service: 'web', status: 'CRASHED' },
      { environment: 'production', provider: 'railway', service: 'worker', status: 'CRASHED' },
    ]);
    expect(result.hint).toContain('production/web');
    await t.close();
  });
});
