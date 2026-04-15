import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';

type JsonObj = Record<string, unknown>;

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<JsonObj> {
  const result = await client.request(
    {
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema
  );
  const text = result.content.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

describe('infra_apply multi-service convergence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-infra-multi-service-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('provisions one shared database and deploys all desired services in a single apply', async () => {
    const projectRepo = new ProjectRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({ name: 'multi-service-project', defaultPlatform: 'railway' });

    const provisionCalls: string[] = [];
    const deployCalls: string[] = [];

    const fakeDatabaseAdapter: IDatabaseAdapter = {
      name: 'railway',
      capabilities: {
        supportedDatabases: ['postgres'],
        supportedCaches: [],
        supportsPooling: false,
        supportsReadReplicas: false,
        supportsPointInTimeRecovery: false,
        serverlessOptimized: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async provision(type, environment) {
        provisionCalls.push(`${type}:${environment.name}`);
        return {
          component: {
            id: '',
            environmentId: environment.id,
            type: 'postgres',
            bindings: {
              provider: 'railway',
              connectionString: 'postgres://shared-db',
            },
            externalId: 'rail-db-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: true,
            message: 'db ready',
            data: {
              projectId: 'rail-project-1',
              railwayProjectId: 'rail-project-1',
              ensureProjectCreated: false,
            },
          },
          connectionUrl: 'postgres://shared-db',
          envVars: {
            DATABASE_URL: 'postgres://shared-db',
            DIRECT_URL: 'postgres://shared-db',
          },
        };
      },
      async getConnectionUrl() {
        return 'postgres://shared-db';
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service) {
        deployCalls.push(service.name);
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              railwayEnvironmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'multi-service-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'infra_apply', {
      projectName: project.name,
      environmentName: 'staging',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(payload.services).toEqual(['web', 'worker']);
    expect(provisionCalls).toEqual(['postgres:staging']);
    expect(deployCalls).toEqual(['web', 'worker']);
    const createdServices = serviceRepo.findByProjectId(project.id).map((service) => service.name);
    expect(createdServices).toEqual(['web', 'worker']);

    await Promise.all([client.close(), server.close()]);
  });

  it('marks db_provision ok in preview when a matching managed postgres already exists', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const componentRepo = new ComponentRepository();
    const project = projectRepo.create({ name: 'existing-db-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'production' });

    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        pluginName: 'postgres-db',
        connectionUrl: 'postgres://shared-db',
      },
      externalId: 'rail-db-1',
    });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'existing-db-preview-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'infra_apply', {
      projectName: project.name,
      environmentName: 'production',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: false,
    });

    const plan = payload.plan as Array<Record<string, unknown>>;
    const dbPlan = plan.find((item) => item.action === 'db_provision');
    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('preview');
    expect(dbPlan?.status).toBe('ok');
    expect(dbPlan?.detail).toBe('Postgres already managed on railway');

    await Promise.all([client.close(), server.close()]);
  });

  it('reuses an existing managed postgres component during apply', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const project = projectRepo.create({ name: 'reuse-db-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'production' });

    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'railway',
        pluginName: 'postgres-db',
        connectionUrl: 'postgres://shared-db',
      },
      externalId: 'rail-db-existing',
    });

    const deployCalls: string[] = [];
    const deployEnvVarCalls: Array<{ serviceName: string; vars: Record<string, string> }> = [];

    const databaseAdapterSpy = vi.spyOn(adapterFactory, 'getDatabaseAdapter');
    const fakeHostingAdapter: IHostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: false,
        supportsReleaseCommand: true,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsAutoScaling: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'bound',
          data: {
            projectId: 'rail-project-1',
            environmentId: 'rail-env-1',
          },
        };
      },
      async deploy(service, _environment, vars) {
        deployCalls.push(service.name);
        deployEnvVarCalls.push({ serviceName: service.name, vars });
        return {
          serviceId: `deploy-${service.name}`,
          externalId: `rail-${service.name}`,
          url: `https://${service.name}.example.com`,
          status: 'deployed',
          receipt: {
            success: true,
            message: 'deployed',
            data: {
              railwayEnvironmentId: 'rail-env-1',
            },
          },
        };
      },
      async setEnvVars() {
        return {
          success: true,
          message: 'vars synced',
        };
      },
      async getDeployStatus(_environment, deploymentId) {
        return {
          status: 'deployed',
          url: `https://${deploymentId}.example.com`,
        };
      },
    };

    databaseAdapterSpy.mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: {
          supportedDatabases: ['postgres'],
          supportedCaches: [],
          supportsPooling: false,
          supportsReadReplicas: false,
          supportsPointInTimeRecovery: false,
          serverlessOptimized: false,
        },
        async connect() {},
        async verify() {
          return { success: true };
        },
        async provision() {
          throw new Error('db provision should not be called when a matching component already exists');
        },
        async getConnectionUrl() {
          return 'postgres://shared-db';
        },
        async destroy() {
          return { success: true, message: 'destroyed' };
        },
      } as IDatabaseAdapter,
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: fakeHostingAdapter,
    });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'reuse-db-apply-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'infra_apply', {
      projectName: project.name,
      environmentName: 'production',
      services: ['web', 'worker'],
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(databaseAdapterSpy).not.toHaveBeenCalled();
    expect(deployCalls).toEqual(['web', 'worker']);
    expect(serviceRepo.findByProjectId(project.id).map((service) => service.name)).toEqual(['web', 'worker']);
    expect(deployEnvVarCalls).toEqual([
      {
        serviceName: 'web',
        vars: {
          DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
          DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
        },
      },
      {
        serviceName: 'worker',
        vars: {
          DATABASE_URL: '${{postgres-db.DATABASE_URL}}',
          DIRECT_URL: '${{postgres-db.DATABASE_PRIVATE_URL}}',
        },
      },
    ]);

    await Promise.all([client.close(), server.close()]);
  });
});
