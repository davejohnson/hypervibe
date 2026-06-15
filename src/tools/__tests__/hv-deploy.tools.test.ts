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
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
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

  it('fails when provider status is deployed but the configured web health endpoint is not serving', async () => {
    const project = new ProjectRepository().create({ name: 'rail-health-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new ServiceRepository().create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web', healthCheckPath: '/health' },
      envVarSpec: {},
    });

    const fakeAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() { return { success: true, message: 'ok', data: { projectId: 'rail-project', environmentId: 'rail-env' } }; },
      async deploy() {
        return {
          serviceId: 'web',
          externalId: 'rail-web',
          url: 'https://web-production-e5e09.up.railway.app',
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      async getDeployStatus() {
        return { status: 'deployed', url: 'https://web-production-e5e09.up.railway.app' };
      },
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Application not found', { status: 404 }) as any
    );

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'rail-health-app', env: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_ERROR');
    expect(result.error.details.status).toBe('failed');
    expect(result.error.details.errors.join('\n')).toContain('web: HTTP 404 at https://web-production-e5e09.up.railway.app/health');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://web-production-e5e09.up.railway.app/health',
      expect.objectContaining({ method: 'GET' })
    );
    await t.close();
  });
});

describe('hv_deploy database env injection', () => {
  it('injects the managed database env vars into every deploy', async () => {
    const project = new ProjectRepository().create({ name: 'dbenv-app', defaultPlatform: 'cloudrun' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', services: { web: { serviceId: 'gcp-project-web' } } },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'cloudsql',
        connectionUrl: 'postgresql://app:pw@34.44.202.227:5432/app',
      },
      externalId: 'production-postgres',
    });

    const deployCalls: Array<Record<string, string>> = [];
    const fakeAdapter: IHostingAdapter = {
      name: 'cloudrun',
      capabilities: {
        supportedBuilders: ['dockerfile'],
        supportsAutoWiring: false,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: false,
        managedTls: true,
        supportsAutoScaling: true,
        supportsObserve: true,
      },
      async connect() {},
      async verify() { return { success: true }; },
      async ensureProject() { return { success: true, message: 'ok', data: { projectId: 'gcp-project' } }; },
      async deploy(service, _environment, envVars) {
        deployCalls.push({ ...envVars });
        return {
          serviceId: service.id,
          externalId: 'gcp-project-web',
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      async getDeployStatus() { return { status: 'deployed' }; },
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'dbenv-app', env: 'production' });
    expect(result.ok).toBe(true);

    expect(deployCalls).toHaveLength(1);
    // The managed database URL is injected even though the caller passed no envVars.
    expect(deployCalls[0].DATABASE_URL).toBe('postgresql://app:pw@34.44.202.227:5432/app');
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
