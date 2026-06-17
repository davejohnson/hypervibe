import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter, type RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import { createToolContext } from '../context.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-lifecycle-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeClient() {
  const server = new McpServer({ name: 'lifecycle-tools-test', version: '0.0.0' });
  registerLifecycleTools(server, createToolContext());
  const client = new Client({ name: 'lifecycle-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return parseToolEnvelope(result) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe('hv_destroy', () => {
  it('gates project deletion behind confirm and then deletes local records', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'doomed-app' });
    envRepo.create({ projectId: project.id, name: 'staging', platformBindings: {} });
    serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {} });

    const preview = await t.call('hv_destroy', { project: 'doomed-app', scope: 'project' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details.environments).toEqual(['staging']);
    expect(preview.error.details.services).toEqual(['web']);
    expect(projectRepo.findByName('doomed-app')).not.toBeNull();

    const destroyed = await t.call('hv_destroy', { project: 'doomed-app', scope: 'project', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.scope).toBe('project');
    expect(destroyed.data.deleted.services).toEqual(['web']);
    expect(projectRepo.findByName('doomed-app')).toBeNull();
    await t.close();
  });

  it('deletes a local environment record with confirm', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({ name: 'env-app' });
    envRepo.create({ projectId: project.id, name: 'staging', platformBindings: {} });

    const preview = await t.call('hv_destroy', { project: 'env-app', scope: 'environment', env: 'staging' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');

    const destroyed = await t.call('hv_destroy', { project: 'env-app', scope: 'environment', env: 'staging', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.environment).toBe('staging');
    expect(envRepo.findByProjectAndName(project.id, 'staging')).toBeNull();
    await t.close();
  });

  it('requires name for service scope and removes the service plus its binding', async () => {
    const t = await makeClient();
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'svc-app' });
    const env = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', services: { web: { serviceId: 's-1' } } },
    });
    serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {} });

    const missingName = await t.call('hv_destroy', { project: 'svc-app', scope: 'service' });
    expect(missingName.ok).toBe(false);
    expect(missingName.error.code).toBe('VALIDATION');

    const preview = await t.call('hv_destroy', { project: 'svc-app', scope: 'service', name: 'web' });
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect(preview.error.details.bindingsRemovedFrom).toEqual(['staging']);

    const destroyed = await t.call('hv_destroy', { project: 'svc-app', scope: 'service', name: 'web', confirm: true });
    expect(destroyed.ok).toBe(true);
    expect(destroyed.data.deleted.bindingsRemovedFrom).toEqual(['staging']);
    expect(serviceRepo.findByProjectAndName(project.id, 'web')).toBeNull();

    const bindings = envRepo.findById(env.id)!.platformBindings as { services?: Record<string, unknown> };
    expect(bindings.services?.web).toBeUndefined();
    await t.close();
  });
});

describe('hv_import', () => {
  const details: RailwayProjectDetails = {
    id: 'rp-1',
    name: 'demo-app',
    environments: {
      edges: [{ node: { id: 'env-prod', name: 'production' } }],
    },
    services: {
      edges: [{
        node: {
          id: 'svc-web',
          name: 'web',
          repoTriggers: { edges: [{ node: { repository: 'acme/demo-app', branch: 'main' } }] },
          serviceInstances: {
            edges: [{
              node: {
                environmentId: 'env-prod',
                domains: { serviceDomains: [], customDomains: [] },
                startCommand: 'npm start',
                healthcheckPath: undefined,
                numReplicas: 1,
                sleepApplication: false,
              },
            }],
          },
        },
      }],
    },
    plugins: { edges: [{ node: { id: 'plug-1', name: 'Postgres' } }] },
  };

  function createRailwayConnection() {
    new ConnectionRepository().create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
  }

  function mockAdapter() {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'listProjects').mockResolvedValue([{ id: 'rp-1', name: 'demo-app' }]);
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(details);
    vi.spyOn(RailwayAdapter.prototype, 'findProjectByName').mockResolvedValue({ id: 'rp-1', name: 'demo-app' });
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({ DATABASE_URL: 'postgres://x' });
  }

  it('returns MISSING_CONNECTION when no Railway connection exists', async () => {
    const t = await makeClient();
    const result = await t.call('hv_import', {});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    expect(result.next).toContain('hv_connect');
    await t.close();
  });

  it('lists importable Railway projects when no name is given', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {});
    expect(result.ok).toBe(true);
    expect(result.data.projects).toEqual([
      { name: 'demo-app', railwayId: 'rp-1', environmentCount: 1, serviceCount: 1 },
    ]);
    await t.close();
  });

  it('returns raw inspection data with auto-detected mappings when no mappings are given', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', { name: 'demo-app' });
    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(false);
    expect(result.data.autoDetected).toEqual({ production: 'production' });
    expect(result.data.needsMapping).toEqual([]);
    expect(result.data.envVarNames).toEqual(['DATABASE_URL']);
    expect(result.data.components).toEqual([{ type: 'postgres', railwayId: 'plug-1' }]);
    expect(result.next).toContain('hv_import');
    await t.close();
  });

  it('performs the import when mappings are provided', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {
      name: 'demo-app',
      environmentMappings: { production: 'production' },
    });
    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(true);

    const project = new ProjectRepository().findByName('demo-app');
    expect(project).not.toBeNull();
    expect(project!.defaultPlatform).toBe('railway');

    const env = new EnvironmentRepository().findByProjectAndName(project!.id, 'production');
    expect(env).not.toBeNull();
    const bindings = env!.platformBindings as { projectId?: string; services?: Record<string, { serviceId: string }> };
    expect(bindings.projectId).toBe('rp-1');
    expect(bindings.services?.web?.serviceId).toBe('svc-web');

    expect(new ServiceRepository().findByProjectAndName(project!.id, 'web')).not.toBeNull();
    await t.close();
  });

  it('blocks re-import of an existing Hypervibe project without force', async () => {
    createRailwayConnection();
    mockAdapter();
    new ProjectRepository().create({ name: 'demo-app' });
    const t = await makeClient();

    const result = await t.call('hv_import', { name: 'demo-app' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('already exists');
    await t.close();
  });
});
