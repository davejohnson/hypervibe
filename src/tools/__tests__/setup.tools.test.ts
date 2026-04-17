import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter, type RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';

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

describe('setup tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-setup-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('setup_configure resolves Railway project from Hypervibe bindings and updates the service instance', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const serviceRepo = new ServiceRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({ name: 'billforge', defaultPlatform: 'railway' });
    const localService = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        railwayProjectId: 'rail-project-1',
      },
    });

    const connection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const projectDetails: RailwayProjectDetails = {
      id: 'rail-project-1',
      name: 'billforge',
      environments: {
        edges: [{ node: { id: 'env-prod', name: 'production' } }],
      },
      services: {
        edges: [{
          node: {
            id: 'svc-web',
            name: 'web',
            icon: 'node',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [{
                node: {
                  environmentId: 'env-prod',
                  domains: {
                    serviceDomains: [],
                    customDomains: [],
                  },
                  startCommand: undefined,
                  healthcheckPath: undefined,
                  numReplicas: 1,
                  sleepApplication: false,
                },
              }],
            },
          },
        }],
      },
      plugins: { edges: [] },
    };

    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    const getProjectDetails = vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(projectDetails);
    const findProjectByName = vi.spyOn(RailwayAdapter.prototype, 'findProjectByName').mockResolvedValue(null);
    const updateServiceInstanceConfig = vi
      .spyOn(RailwayAdapter.prototype, 'updateServiceInstanceConfig')
      .mockResolvedValue({ success: true, message: 'updated' });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'setup-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'setup_configure', {
      projectName: 'billforge',
      environmentName: 'production',
      serviceName: 'web',
      startCommand: 'npm start',
      healthCheckPath: '/health',
    });

    expect(payload.success).toBe(true);
    expect(getProjectDetails).toHaveBeenCalledWith('rail-project-1');
    expect(findProjectByName).not.toHaveBeenCalled();
    expect(updateServiceInstanceConfig).toHaveBeenCalledWith({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: '/health',
      cronSchedule: undefined,
    });
    expect(serviceRepo.findById(localService.id)?.buildConfig).toMatchObject({
      builder: 'nixpacks',
      startCommand: 'npm start',
      healthCheckPath: '/health',
    });

    await Promise.all([client.close(), server.close()]);
  });

  it('setup_configure links a Railway service to the project GitHub repo and branch', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const serviceRepo = new ServiceRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:davejohnson/billforge.git',
    });
    const localService = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        railwayProjectId: 'rail-project-1',
      },
    });

    const connection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const projectDetails: RailwayProjectDetails = {
      id: 'rail-project-1',
      name: 'billforge',
      environments: {
        edges: [{ node: { id: 'env-prod', name: 'production' } }],
      },
      services: {
        edges: [{
          node: {
            id: 'svc-web',
            name: 'web',
            icon: 'node',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [{
                node: {
                  environmentId: 'env-prod',
                  domains: {
                    serviceDomains: [],
                    customDomains: [],
                  },
                  startCommand: undefined,
                  healthcheckPath: undefined,
                  numReplicas: 1,
                  sleepApplication: false,
                },
              }],
            },
          },
        }],
      },
      plugins: { edges: [] },
    };

    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(projectDetails);
    vi.spyOn(RailwayAdapter.prototype, 'findProjectByName').mockResolvedValue(null);
    const connectServiceToRepo = vi
      .spyOn(RailwayAdapter.prototype, 'connectServiceToRepo')
      .mockResolvedValue({ success: true, message: 'connected' });
    const updateServiceInstanceConfig = vi
      .spyOn(RailwayAdapter.prototype, 'updateServiceInstanceConfig')
      .mockResolvedValue({ success: true, message: 'updated' });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'setup-client-repo-link', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'setup_configure', {
      projectName: 'billforge',
      environmentName: 'production',
      serviceName: 'web',
      branch: 'main',
      startCommand: 'npm start',
    });

    expect(payload.success).toBe(true);
    expect(connectServiceToRepo).toHaveBeenCalledWith({
      serviceId: 'svc-web',
      repo: 'davejohnson/billforge',
      branch: 'main',
    });
    expect(updateServiceInstanceConfig).toHaveBeenCalledWith({
      serviceId: 'svc-web',
      environmentId: 'env-prod',
      startCommand: 'npm start',
      healthcheckPath: undefined,
      cronSchedule: undefined,
    });
    expect(serviceRepo.findById(localService.id)?.buildConfig).toMatchObject({
      builder: 'nixpacks',
      startCommand: 'npm start',
    });

    await Promise.all([client.close(), server.close()]);
  });

  it('setup_configure returns Railway GitHub app guidance when repo access is denied', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const connectionRepo = new ConnectionRepository();
    const secretStore = getSecretStore();

    const project = projectRepo.create({
      name: 'billforge',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'git@github.com:davejohnson/billforge.git',
    });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project-1',
        railwayProjectId: 'rail-project-1',
      },
    });

    const connection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: secretStore.encryptObject({ apiToken: 'token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const projectDetails: RailwayProjectDetails = {
      id: 'rail-project-1',
      name: 'billforge',
      environments: {
        edges: [{ node: { id: 'env-prod', name: 'production' } }],
      },
      services: {
        edges: [{
          node: {
            id: 'svc-web',
            name: 'web',
            icon: 'node',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [{
                node: {
                  environmentId: 'env-prod',
                  domains: {
                    serviceDomains: [],
                    customDomains: [],
                  },
                  startCommand: undefined,
                  healthcheckPath: undefined,
                  numReplicas: 1,
                  sleepApplication: false,
                },
              }],
            },
          },
        }],
      },
      plugins: { edges: [] },
    };

    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(projectDetails);
    vi.spyOn(RailwayAdapter.prototype, 'findProjectByName').mockResolvedValue(null);
    vi
      .spyOn(RailwayAdapter.prototype, 'connectServiceToRepo')
      .mockResolvedValue({ success: false, message: 'failed', error: 'User does not have access to the repo' });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'setup-client-repo-access', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'setup_configure', {
      projectName: 'billforge',
      environmentName: 'production',
      serviceName: 'web',
      branch: 'main',
    });

    expect(payload.success).toBe(false);
    expect(payload.error).toBe('User does not have access to the repo');
    expect(payload.help).toMatchObject({
      code: 'railway_github_repo_access',
      helpTool: 'railway_setup_help',
      repo: 'davejohnson/billforge',
    });
    expect(payload.nextSteps).toContain('Then rerun infra_apply or setup_configure.');

    await Promise.all([client.close(), server.close()]);
  });

  it('railway_setup_help returns Railway GitHub app instructions', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'setup-client-railway-help', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'railway_setup_help', {
      repo: 'davejohnson/billforge',
    });

    expect(payload.success).toBe(true);
    expect(String(payload.instructions)).toContain('Install Railway GitHub App');
    expect(String(payload.instructions)).toContain('Create a **classic** GitHub PAT');
    expect(payload.help).toMatchObject({
      code: 'railway_github_repo_access',
      repo: 'davejohnson/billforge',
    });

    await Promise.all([client.close(), server.close()]);
  });
});
