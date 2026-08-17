import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectActionableConnectionSetup, parseToolEnvelope } from './tool-result.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter, type RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { NeonAdapter } from '../../adapters/providers/neon/neon.adapter.js';
import type { ObservedService, ObservedState } from '../../domain/ports/observe.port.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { registerLifecycleTools } from '../lifecycle.tools.js';
import { createToolContext } from '../context.js';
import '../../application/providers.js';

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
  registerLifecycleTools(createMcpCommandRegistrar(server), createToolContext());
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

async function makeFullClient() {
  const { createServer } = await import('../../server.js');
  const server = createServer();
  const client = new Client({ name: 'lifecycle-roundtrip-test', version: '1.0.0' });
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

describe('hv_inspect / hv_import', () => {
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
                domains: {
                  serviceDomains: [{ domain: 'web-production.up.railway.app' }],
                  customDomains: [{ domain: 'demo-app.example.com' }],
                },
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

  function createRailwayConnection(verified = false) {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
    return verified ? repository.updateStatus(connection.id, 'verified')! : connection;
  }

  function mockAdapter(projectDetails: RailwayProjectDetails = details) {
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'listProjects').mockResolvedValue([{ id: projectDetails.id, name: projectDetails.name }]);
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(projectDetails);
    vi.spyOn(RailwayAdapter.prototype, 'findProjectByName').mockResolvedValue({ id: projectDetails.id, name: projectDetails.name });
    vi.spyOn(RailwayAdapter.prototype, 'findProjectsByName').mockResolvedValue([{ id: projectDetails.id, name: projectDetails.name }]);
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({ DATABASE_URL: 'postgres://x' });
  }

  function railwayService(input: {
    id: string;
    name: string;
    domain?: string;
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
  }): RailwayProjectDetails['services']['edges'][number] {
    return {
      node: {
        id: input.id,
        name: input.name,
        repoTriggers: { edges: [] },
        serviceInstances: {
          edges: [{
            node: {
              environmentId: 'env-prod',
              domains: {
                serviceDomains: input.domain ? [{ domain: input.domain }] : [],
                customDomains: [],
              },
              startCommand: input.startCommand,
              preDeployCommand: input.releaseCommand ? [input.releaseCommand] : undefined,
              healthcheckPath: input.healthCheckPath,
              cronSchedule: input.cronSchedule,
            },
          }],
        },
      },
    };
  }

  function observedService(input: {
    id: string;
    name: string;
    workloadKind?: ObservedService['workloadKind'];
    url?: string;
    startCommand?: string;
    releaseCommand?: string;
    healthCheckPath?: string;
    cronSchedule?: string;
    envVarKeys?: string[];
    customDomains?: string[];
    customDomainStatus?: ObservedService['customDomainStatus'];
  }): ObservedService {
    const envVarKeys = input.envVarKeys ?? [];
    return {
      name: input.name,
      externalId: input.id,
      workloadKind: input.workloadKind ?? 'web',
      ...(input.url ? { url: input.url } : {}),
      customDomains: input.customDomains ?? [],
      ...(input.customDomainStatus ? { customDomainStatus: input.customDomainStatus } : {}),
      config: {
        ...(input.startCommand ? { startCommand: input.startCommand } : {}),
        ...(input.releaseCommand ? { releaseCommand: input.releaseCommand } : {}),
        ...(input.healthCheckPath ? { healthCheckPath: input.healthCheckPath } : {}),
        ...(input.cronSchedule ? { cronSchedule: input.cronSchedule } : {}),
        public: Boolean(input.url),
      },
      sourceState: 'disconnected',
      envVarKeys,
      envVarHashes: Object.fromEntries(envVarKeys.map((key) => [key, `hash:${key}`])),
      status: 'running',
    };
  }

  it('hv_inspect returns MISSING_CONNECTION when no Railway connection exists', async () => {
    new ProjectRepository().create({
      name: 'inspect-app',
      gitRemoteUrl: 'https://github.com/davejohnson/inspect-app',
    });
    const t = await makeClient();
    const result = await t.call('hv_inspect', { provider: 'railway', project: 'inspect-app' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('MISSING_CONNECTION');
    expectActionableConnectionSetup(result.error.details.connectionSetup, {
      provider: 'railway',
      project: 'inspect-app',
      scope: 'davejohnson/inspect-app',
    });
    expect(result.next).toContain('hv_connections');
    await t.close();
  });

  it('hv_inspect lists every registered provider and its read capabilities without opening connections', async () => {
    const t = await makeClient();
    const result = await t.call('hv_inspect', {});

    expect(result.ok).toBe(true);
    expect(result.data.providers.map((provider: { provider: string }) => provider.provider).sort())
      .toEqual(providerRegistry.names().sort());
    expect(result.data.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', resources: expect.arrayContaining(['repository', 'ref', 'pages']) }),
      expect.objectContaining({ provider: 'cloudflare', resources: expect.arrayContaining(['zone', 'dns']) }),
      expect.objectContaining({ provider: 'railway', resources: expect.arrayContaining(['project', 'environment']) }),
    ]));
    expect(providerRegistry.namesFor('storage').sort()).toEqual(['azureblob', 'gcs', 'railway', 's3']);
    for (const provider of providerRegistry.namesFor('hosting')) {
      expect(providerRegistry.get(provider)?.inspection?.resources, provider)
        .toContain('environment');
      expect(
        providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.teardownBoundary,
        provider
      ).toMatch(/^(services|environment|project)$/);
    }
    await t.close();
  });

  it('hv_inspect uses provider-scoped forensics instead of passing a current-provider binding to an abandoned provider', async () => {
    const project = new ProjectRepository().create({ name: 'migrated-inspect-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment-uuid',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype, 'disconnect').mockResolvedValue();
    const configureTarget = vi.spyOn(CloudRunAdapter.prototype, 'configureTarget')
      .mockImplementation(() => undefined);
    const inspectEnvironmentResources = vi.spyOn(
      CloudRunAdapter.prototype as any,
      'inspectEnvironmentResources'
    ).mockResolvedValue({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [{ id: 'legacy-web', name: 'web', workloadKind: 'web' }],
    });
    const observe = vi.spyOn(CloudRunAdapter.prototype, 'observe')
      .mockRejectedValue(new Error('current Railway bindings must not reach Cloud Run observe'));
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudrun',
      project: project.name,
      env: 'production',
      region: 'europe-west1',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'cloudrun',
      mode: 'environment-forensics',
      project: project.name,
      environment: 'production',
      currentHostingProvider: 'railway',
      inspected: {
        observation: 'present',
        resource: 'environment',
        services: [{ id: 'legacy-web', name: 'web' }],
      },
    });
    expect(inspectEnvironmentResources).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({ id: project.id, name: project.name }),
      environment: expect.objectContaining({ name: 'production' }),
      binding: undefined,
    }));
    expect(observe).not.toHaveBeenCalled();
    expect(configureTarget).toHaveBeenCalledWith({ region: 'europe-west1' });
    await t.close();
  });

  it('hv_import can confirmation-gate and retain provider-neutral forensic results for cleanup', async () => {
    const project = new ProjectRepository().create({ name: 'migrated-cleanup-app' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider: 'cloudrun',
      credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'gcp-project', credentials: '{}' }),
    });
    connections.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudRunAdapter.prototype, 'disconnect').mockResolvedValue();
    const configureTarget = vi.spyOn(CloudRunAdapter.prototype, 'configureTarget')
      .mockImplementation(() => undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'inspectEnvironmentResources').mockResolvedValue({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [
        { id: 'legacy-web', name: 'web', workloadKind: 'web', resourceType: 'service', managedByHypervibe: true },
        {
          id: 'legacy-daily-schedule', name: 'daily', workloadKind: 'cron', resourceType: 'scheduledJob',
          jobName: 'legacy-daily', schedulerJobName: 'legacy-daily-schedule', managedByHypervibe: true,
        },
      ],
      partial: false,
    });
    const t = await makeClient();
    const input = {
      provider: 'cloudrun',
      mode: 'retained-cleanup',
      project: project.name,
      env: environment.name,
      region: 'europe-west1',
    };

    const preview = await t.call('hv_import', input);
    expect(preview.ok).toBe(false);
    expect(preview.error.code).toBe('CONFIRM_REQUIRED');
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, unknown>)
      .previousHosting).toBeUndefined();

    const retained = await t.call('hv_import', { ...input, confirm: true });
    expect(retained.ok).toBe(true);
    expect(retained.data).toMatchObject({
      retainedCleanup: { provider: 'cloudrun', project: project.name, environment: 'production' },
    });
    expect((new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, unknown>)
      .previousHosting).toMatchObject({
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'legacy-web', resourceType: 'service' },
          daily: {
            serviceId: 'legacy-daily-schedule',
            jobName: 'legacy-daily',
            schedulerJobName: 'legacy-daily-schedule',
            resourceType: 'scheduledJob',
          },
        },
      });
    expect(configureTarget).toHaveBeenCalledWith({ region: 'europe-west1' });
    await t.close();
  });

  it('hv_inspect resolves an exact Cloudflare DNS record id within the selected zone', async () => {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'cloudflare',
      scope: 'example.com',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cf-token' }),
    });
    repository.updateStatus(connection.id, 'verified');
    vi.spyOn(CloudflareAdapter.prototype, 'connect').mockImplementation(() => undefined);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([
      {
        id: 'record-1',
        zone_id: 'zone-1',
        zone_name: 'example.com',
        name: 'example.com',
        type: 'CNAME',
        content: 'app.example.net',
        proxiable: true,
        proxied: true,
        ttl: 1,
        created_on: '2026-08-08T00:00:00.000Z',
        modified_on: '2026-08-08T00:00:00.000Z',
      },
      {
        id: 'record-2',
        zone_id: 'zone-1',
        zone_name: 'example.com',
        name: '_verify.example.com',
        type: 'TXT',
        content: 'verify-token',
        proxiable: false,
        proxied: false,
        ttl: 1,
        created_on: '2026-08-08T00:00:00.000Z',
        modified_on: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'cloudflare',
      scope: 'example.com',
      resource: 'dns',
      id: 'record-2',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      resource: 'dns',
      observation: 'present',
      zone: { id: 'zone-1', name: 'example.com' },
      records: [{ id: 'record-2', name: '_verify.example.com', type: 'TXT' }],
    });
    await t.close();
  });

  it('hv_inspect rejects selectors that would otherwise be silently ignored', async () => {
    const project = new ProjectRepository().create({ name: 'inspect-selector-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const t = await makeClient();

    const missingProvider = await t.call('hv_inspect', { project: project.name });
    expect(missingProvider.ok).toBe(false);
    expect(missingProvider.error.code).toBe('VALIDATION');
    expect(missingProvider.error.details.selectors).toEqual(['project']);
    expect(missingProvider.hint).toContain('hv_inspect({}) with no parameters');
    expect(missingProvider.hint).toContain('provider, project, and env');

    const untypedSelector = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      id: 'provider-id',
    });
    expect(untypedSelector.ok).toBe(false);
    expect(untypedSelector.error.code).toBe('VALIDATION');
    expect(untypedSelector.error.details.invalid).toEqual(['id']);
    expect(untypedSelector.hint).toContain('provider, project, and env');

    const mixedModes = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      resource: 'project',
    });
    expect(mixedModes.ok).toBe(false);
    expect(mixedModes.error.code).toBe('VALIDATION');

    const connectionWithEnv = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'staging',
      resource: 'connection',
    });
    expect(connectionWithEnv.ok).toBe(false);
    expect(connectionWithEnv.error.code).toBe('VALIDATION');
    expect(connectionWithEnv.error.details.invalid).toEqual(['env']);

    const neonConnection = new ConnectionRepository().create({
      provider: 'neon',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'neon-token' }),
    });
    new ConnectionRepository().updateStatus(neonConnection.id, 'verified');
    vi.spyOn(NeonAdapter.prototype, 'connect').mockResolvedValue();
    const observeDatabase = vi.spyOn(NeonAdapter.prototype, 'observeDatabase').mockResolvedValue({
      provider: 'neon',
      engine: 'postgres',
      externalId: 'neon-project-1',
      name: 'selected-db',
      status: 'ready',
    });
    const selectedDatabase = await t.call('hv_inspect', {
      provider: 'neon',
      project: project.name,
      env: 'staging',
      resource: 'database',
      name: 'selected-db',
    });
    expect(selectedDatabase.ok).toBe(true);
    expect(selectedDatabase.data).toMatchObject({
      provider: 'neon',
      mode: 'database',
      project: project.name,
      environment: 'staging',
      observed: { externalId: 'neon-project-1', name: 'selected-db' },
    });
    expect(observeDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'staging' }),
      null,
      { resourceName: 'selected-db' }
    );
    await t.close();
  });

  it('hv_inspect exposes bounded provider domain verification for a selected environment', async () => {
    const project = new ProjectRepository().create({ name: 'inspect-domain-app' });
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 'env-prod' },
    });
    createRailwayConnection(true);
    vi.spyOn(RailwayAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(RailwayAdapter.prototype, 'observe').mockResolvedValue({
      provider: 'railway',
      observedAt: '2026-08-07T00:00:00.000Z',
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 'env-prod',
      services: [observedService({
        id: 'svc-web',
        name: 'web',
        url: 'https://web-production.up.railway.app',
        customDomains: ['example.com'],
        customDomainStatus: {
          'example.com': {
            providerVerified: false,
            dnsConfigured: false,
            dnsRecords: [{
              name: '_railway-verify',
              type: 'TXT',
              value: 'railway-verify=public-token',
              purpose: 'verification',
            }],
          },
        },
      })],
      databases: [],
      partial: false,
      warnings: [],
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'railway',
      project: project.name,
      env: 'production',
    });

    expect(result.ok).toBe(true);
    expect(result.data.observed.services[0]).toMatchObject({
      customDomains: ['example.com'],
      customDomainStatus: {
        'example.com': {
          providerVerified: false,
          dnsConfigured: false,
          dnsRecords: [expect.objectContaining({ type: 'TXT', purpose: 'verification' })],
        },
      },
    });
    await t.close();
  });

  it('hv_inspect routes GitHub branch reads through the registered provider inspector', async () => {
    const repository = new ConnectionRepository();
    const connection = repository.create({
      provider: 'github',
      scope: 'davejohnson/hypervibe',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'token' }),
    });
    repository.updateStatus(connection.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'connect').mockImplementation(() => undefined);
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
      ref: 'refs/heads/hypervibe/github-infrastructure',
      object: { sha: 'abc123' },
    });
    const t = await makeClient();

    const result = await t.call('hv_inspect', {
      provider: 'github',
      scope: 'davejohnson/hypervibe',
      resource: 'branch',
      name: 'hypervibe/github-infrastructure',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      provider: 'github',
      mode: 'provider-resource',
      observation: 'present',
      ref: { name: 'refs/heads/hypervibe/github-infrastructure', sha: 'abc123' },
    });
    await t.close();
  });

  it('hv_import without an adoption target points agents to hv_inspect without opening a provider connection', async () => {
    const t = await makeClient();
    const result = await t.call('hv_import', { provider: 'railway' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.hint).toContain('hv_inspect');
    expect(result.next).toContain('hv_inspect');
    await t.close();
  });

  it('hv_inspect lists importable Railway projects when no name is given', async () => {
    createRailwayConnection(true);
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway' });
    expect(result.ok).toBe(true);
    expect(result.data.projects).toEqual([
      { name: 'demo-app', railwayId: 'rp-1', environmentCount: 1, serviceCount: 1 },
    ]);
    await t.close();
  });

  it('hv_inspect returns raw inspection data with auto-detected mappings without writing local state', async () => {
    createRailwayConnection(true);
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway', name: 'demo-app' });
    expect(result.ok).toBe(true);
    expect(result.data.inspected).toBe(true);
    expect(result.data.imported).toBe(false);
    expect(result.data.autoDetected).toEqual({ production: 'production' });
    expect(result.data.needsMapping).toEqual([]);
    expect(result.data.envVarNames).toEqual(['DATABASE_URL']);
    expect(result.data.components).toEqual([{ type: 'postgres', id: 'plug-1', name: 'Postgres' }]);
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import without mappings fails and points to hv_inspect', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', { provider: 'railway', name: 'demo-app' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('environmentMappings');
    expect(result.hint).toContain('hv_inspect');
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import requires confirmation before writing adoption bindings', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    expect(result.error.details.project).toEqual({ name: 'demo-app', id: 'rp-1' });
    expect(new ProjectRepository().findByName('demo-app')).toBeNull();
    await t.close();
  });

  it('hv_import performs the import when mappings are provided and confirmed', async () => {
    createRailwayConnection();
    mockAdapter();
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(true);

    const project = new ProjectRepository().findByName('demo-app');
    expect(project).not.toBeNull();
    expect(project!.defaultPlatform).toBe('railway');

    const env = new EnvironmentRepository().findByProjectAndName(project!.id, 'production');
    expect(env).not.toBeNull();
    const bindings = env!.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId: string; url?: string; customDomains?: string[] }>;
    };
    expect(bindings.projectId).toBe('rp-1');
    expect(bindings.services?.web).toEqual({
      serviceId: 'svc-web',
      url: 'https://web-production.up.railway.app',
      customDomains: ['demo-app.example.com'],
    });

    expect(new ServiceRepository().findByProjectAndName(project!.id, 'web')).not.toBeNull();
    const component = new ComponentRepository().findByEnvironmentAndType(env!.id, 'postgres');
    expect(component?.bindings).toMatchObject({
      provider: 'railway',
      projectId: 'rp-1',
      environmentId: 'env-prod',
      resourceKind: 'plugin',
      pluginName: 'Postgres',
    });
    await t.close();
  });

  it('validates the complete imported spec before writing any local records', async () => {
    createRailwayConnection();
    const invalidStorageDetails: RailwayProjectDetails = {
      ...details,
      environments: {
        edges: [{
          node: {
            id: 'env-prod',
            name: 'production',
            config: {
              buckets: {
                'bucket-unsupported-region': {
                  region: 'moon-1',
                  isDeleted: false,
                },
              },
            },
          },
        }],
      },
      buckets: {
        edges: [{
          node: {
            id: 'bucket-unsupported-region',
            name: 'uploads',
          },
        }],
      },
    };
    mockAdapter(invalidStorageDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: invalidStorageDetails.id,
      environmentMappings: { production: 'production' },
      storageMappings: { 'bucket-unsupported-region': 'uploads' },
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details.reason).toContain('region');
    expect(new ProjectRepository().findByName(details.name)).toBeNull();
    await t.close();
  });

  it('keeps unmapped Railway datastore candidates unmanaged instead of importing them as app services', async () => {
    createRailwayConnection();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          railwayService({ id: 'svc-postgres-unmanaged', name: 'Postgres reporting' }),
        ],
      },
    };
    mockAdapter(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: serviceBackedDetails.id,
      environmentMappings: { production: 'production' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName(details.name)!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'Postgres reporting')).toBeNull();
    expect(result.data.spec.environments.production.services['Postgres reporting']).toBeUndefined();
    expect(result.data.spec.environments.production.database).toBeUndefined();
    await t.close();
  });

  it('explicitly adopts a service-backed Railway Postgres as a component, not an app service', async () => {
    createRailwayConnection();
    mockAdapter();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          {
            node: {
              id: 'svc-postgres',
              name: 'Postgres',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'env-prod',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          },
        ],
      },
    };
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      databaseMappings: { 'svc-postgres': 'postgres' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName('demo-app')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'Postgres')).toBeNull();
    expect(new ComponentRepository().findByEnvironmentAndType(environment.id, 'postgres')).toMatchObject({
      externalId: 'svc-postgres',
      bindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'env-prod',
        resourceKind: 'service',
        serviceId: 'svc-postgres',
        pluginName: 'Postgres',
      },
    });
    await t.close();
  });

  it('round-trips explicit Railway Redis adoption as a cache component', async () => {
    createRailwayConnection();
    mockAdapter();
    const serviceBackedDetails: RailwayProjectDetails = {
      ...details,
      plugins: { edges: [] },
      services: {
        edges: [
          ...details.services.edges,
          {
            node: {
              id: 'svc-redis',
              name: 'redis-cache',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'env-prod',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          },
        ],
      },
    };
    vi.spyOn(RailwayAdapter.prototype, 'getProjectDetails').mockResolvedValue(serviceBackedDetails);
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      cacheMappings: { 'svc-redis': 'redis' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    const project = new ProjectRepository().findByName('demo-app')!;
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production')!;
    expect(new ServiceRepository().findByProjectAndName(project.id, 'redis-cache')).toBeNull();
    expect(new ComponentRepository().findByEnvironmentAndType(environment.id, 'redis')).toMatchObject({
      externalId: 'svc-redis',
      bindings: {
        provider: 'railway',
        projectId: 'rp-1',
        environmentId: 'env-prod',
        resourceKind: 'service',
        serviceId: 'svc-redis',
        pluginName: 'redis-cache',
        connectionUrl: '${{redis-cache.REDIS_URL}}',
      },
    });
    await t.close();
  });

  it.each([
    {
      label: 'legacy plugin databases, caches, and each service workload shape',
      projectDetails: {
        id: 'rp-legacy',
        name: 'legacy-shapes',
        environments: {
          edges: [{ node: { id: 'env-prod', name: 'production' } }],
        },
        services: {
          edges: [
            railwayService({
              id: 'svc-web',
              name: 'web',
              domain: 'legacy-shapes.up.railway.app',
              startCommand: 'npm start',
              releaseCommand: 'npm run migrate',
              healthCheckPath: '/health',
            }),
            railwayService({
              id: 'svc-worker',
              name: 'worker',
              startCommand: 'npm run worker',
            }),
            railwayService({
              id: 'svc-cron',
              name: 'cron',
              startCommand: 'npm run cron',
              cronSchedule: '*/5 * * * *',
            }),
          ],
        },
        plugins: {
          edges: [
            { node: { id: 'plugin-postgres', name: 'Postgres' } },
            { node: { id: 'plugin-redis', name: 'Redis' } },
          ],
        },
      } satisfies RailwayProjectDetails,
      importArgs: {},
      observed: {
        provider: 'railway',
        observedAt: '2026-07-30T00:00:00.000Z',
        projectExists: true,
        projectId: 'rp-legacy',
        environmentId: 'env-prod',
        services: [
          observedService({
            id: 'svc-web',
            name: 'web',
            url: 'https://legacy-shapes.up.railway.app',
            startCommand: 'npm start',
            releaseCommand: 'npm run migrate',
            healthCheckPath: '/health',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
          observedService({
            id: 'svc-worker',
            name: 'worker',
            startCommand: 'npm run worker',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
          observedService({
            id: 'svc-cron',
            name: 'cron',
            workloadKind: 'cron',
            startCommand: 'npm run cron',
            cronSchedule: '*/5 * * * *',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
        ],
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'plugin-postgres',
          name: 'Postgres',
          status: 'unknown',
        }],
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'plugin-redis',
          name: 'Redis',
          status: 'unknown',
        }],
        storage: [],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      } satisfies ObservedState,
      expectedServices: ['cron', 'web', 'worker'],
      expectedStorage: [],
    },
    {
      label: 'service-backed datastores and explicitly mapped object storage',
      projectDetails: {
        id: 'rp-service-backed',
        name: 'service-backed-shapes',
        environments: {
          edges: [{
            node: {
              id: 'env-prod',
              name: 'production',
              config: { buckets: { 'bucket-uploads': { region: 'sjc', isDeleted: false } } },
            },
          }],
        },
        services: {
          edges: [
            railwayService({
              id: 'svc-web',
              name: 'web',
              domain: 'service-backed-shapes.up.railway.app',
              startCommand: 'npm start',
            }),
            railwayService({ id: 'svc-postgres', name: 'Postgres' }),
            railwayService({ id: 'svc-redis', name: 'redis-cache' }),
          ],
        },
        plugins: { edges: [] },
        buckets: {
          edges: [{ node: { id: 'bucket-uploads', name: 'provider-upload-bucket' } }],
        },
      } satisfies RailwayProjectDetails,
      importArgs: {
        databaseMappings: { 'svc-postgres': 'postgres' },
        cacheMappings: { 'svc-redis': 'redis' },
        storageMappings: { 'bucket-uploads': 'uploads' },
      },
      observed: {
        provider: 'railway',
        observedAt: '2026-07-30T00:00:00.000Z',
        projectExists: true,
        projectId: 'rp-service-backed',
        environmentId: 'env-prod',
        services: [
          observedService({
            id: 'svc-web',
            name: 'web',
            url: 'https://service-backed-shapes.up.railway.app',
            startCommand: 'npm start',
            envVarKeys: ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL'],
          }),
        ],
        databases: [{
          provider: 'railway',
          engine: 'postgres',
          externalId: 'svc-postgres',
          name: 'Postgres',
          status: 'unknown',
        }],
        caches: [{
          provider: 'railway',
          engine: 'redis',
          externalId: 'svc-redis',
          name: 'redis-cache',
          status: 'unknown',
        }],
        storage: [{
          provider: 'railway',
          kind: 'object',
          externalId: 'bucket-uploads',
          name: 'provider-upload-bucket',
          region: 'sjc',
          status: 'ready',
        }],
        completeness: {
          project: 'complete',
          environment: 'complete',
          services: 'complete',
          databases: 'complete',
          caches: 'complete',
          storage: 'complete',
        },
        partial: false,
        warnings: [],
      } satisfies ObservedState,
      expectedServices: ['web'],
      expectedStorage: ['uploads'],
    },
  ])('inspect → import → status is mutation-safe for $label', async ({
    projectDetails,
    importArgs,
    observed,
    expectedServices,
    expectedStorage,
  }) => {
    createRailwayConnection(true);
    mockAdapter(projectDetails);
    const observe = vi.spyOn(RailwayAdapter.prototype, 'observe').mockResolvedValue(observed);
    const t = await makeFullClient();

    const inspection = await t.call('hv_inspect', {
      provider: 'railway',
      id: projectDetails.id,
    });
    expect(inspection.ok).toBe(true);
    expect(inspection.data.project.id).toBe(projectDetails.id);

    const imported = await t.call('hv_import', {
      provider: 'railway',
      id: projectDetails.id,
      environmentMappings: { production: 'production' },
      ...importArgs,
      confirm: true,
    });
    expect(imported.ok).toBe(true);
    expect(imported.data.specRevision).toBe(1);
    expect(Object.keys(imported.data.spec.environments.production.services).sort()).toEqual(expectedServices);
    expect(Object.keys(imported.data.spec.environments.production.storage ?? {}).sort()).toEqual(expectedStorage);

    const status = await t.call('hv_status', {
      project: projectDetails.name,
      env: 'production',
    });
    expect(status.ok).toBe(true);
    expect(status.data.drift.filter((action: { type: string }) =>
      action.type === 'create' || action.type === 'destroy'
    )).toEqual([]);
    expect(status.data.drift).toEqual([]);
    expect(status.data.inSync).toBe(true);

    observe.mockResolvedValue({ ...observed, caches: [] });
    const missingCacheStatus = await t.call('hv_status', {
      project: projectDetails.name,
      env: 'production',
    });
    expect(missingCacheStatus.data.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cache:railway',
        type: 'create',
        resource: expect.objectContaining({ kind: 'cache', provider: 'railway' }),
      }),
    ]));

    await t.close();
  });

  it('blocks re-import of an existing Hypervibe project without force', async () => {
    createRailwayConnection();
    mockAdapter();
    new ProjectRepository().create({ name: 'demo-app' });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      name: 'demo-app',
      environmentMappings: { production: 'production' },
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('already exists');
    await t.close();
  });

  it('hv_inspect does not guess when multiple Railway projects share an import name', async () => {
    createRailwayConnection(true);
    mockAdapter();
    vi.spyOn(RailwayAdapter.prototype, 'findProjectsByName').mockResolvedValue([
      { id: 'rp-1', name: 'demo-app' },
      { id: 'rp-2', name: 'demo-app' },
    ]);
    const t = await makeClient();

    const result = await t.call('hv_inspect', { provider: 'railway', name: 'demo-app' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('Multiple Railway resources matched');
    expect(result.error.details.projects).toEqual([
      { name: 'demo-app', id: 'rp-1' },
      { name: 'demo-app', id: 'rp-2' },
    ]);
    expect(result.hint).toContain('id');
    await t.close();
  });

  it('force re-adopts a selected Railway project into an existing Hypervibe project', async () => {
    createRailwayConnection();
    mockAdapter();
    const existing = new ProjectRepository().create({ name: 'demo-app', defaultPlatform: 'cloudrun' });
    new EnvironmentRepository().create({
      projectId: existing.id,
      name: 'production',
      platformBindings: { provider: 'railway', projectId: 'old-rp' },
    });
    const t = await makeClient();

    const result = await t.call('hv_import', {
      provider: 'railway',
      id: 'rp-1',
      force: true,
      environmentMappings: { production: 'production' },
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data.imported).toBe(true);
    expect(result.data.project.id).toBe(existing.id);
    const project = new ProjectRepository().findById(existing.id);
    expect(project?.defaultPlatform).toBe('railway');
    const env = new EnvironmentRepository().findByProjectAndName(existing.id, 'production');
    expect(env?.platformBindings).toMatchObject({
      provider: 'railway',
      projectId: 'rp-1',
      environmentId: 'env-prod',
      services: { web: { serviceId: 'svc-web' } },
    });
    expect(new ServiceRepository().findByProjectAndName(existing.id, 'web')).not.toBeNull();
    await t.close();
  });
});
