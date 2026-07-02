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
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CLOUD_PREPARE_PROFILES } from '../../domain/services/cloud-prepare.js';
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

function seedVerifiedConnection(provider: string): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({
    provider,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'test-token' }),
  });
  repo.updateStatus(connection.id, 'verified');
}

async function makeClient() {
  const server = new McpServer({ name: 'hv-deploy-test', version: '1.0.0' });
  registerHvDeployTools(server, createToolContext());
  const client = new Client({ name: 'hv-deploy-test-client', version: '1.0.0' });
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
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: { hosting: { provider: 'railway' }, services: { web: {} } },
      },
    });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'gate-app', env: 'production' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFIRM_REQUIRED');
    await t.close();
  });

  it('requires a spec: deploys are plan-gated', async () => {
    const project = new ProjectRepository().create({ name: 'specless-app' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'specless-app', env: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.hint).toContain('hv_spec_set');
    await t.close();
  });

  it('does not direct-deploy Railway GitHub Actions branch deploy environments', async () => {
    const project = new ProjectRepository().create({
      name: 'rail-ci-app',
      defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/davejohnson/rail-ci-app',
    });
    new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      environments: {
        production: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web' } },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
        },
      },
    });
    const adapterSpy = vi.spyOn(adapterFactory, 'getHostingAdapter');

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'rail-ci-app', env: 'production' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('does not build or push the image');
    expect(result.hint).toContain('hv_ci_trigger');
    expect(result.hint).toContain('deploy-railway-production.yml');
    expect(adapterSpy).not.toHaveBeenCalled();
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
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' },
          services: { web: { workloadKind: 'web', healthCheckPath: '/health' } },
        },
      },
    });
    seedVerifiedConnection('railway');

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
    const cloudrunPrepared = {
      cloudPreparation: {
        cloudrun: {
          provider: 'cloudrun',
          version: CLOUD_PREPARE_PROFILES.cloudrun.version,
          preparedAt: new Date().toISOString(),
          requiredApis: CLOUD_PREPARE_PROFILES.cloudrun.requiredApis,
          requiredRoles: CLOUD_PREPARE_PROFILES.cloudrun.requiredRoles,
        },
      },
    };
    const project = new ProjectRepository().create({ name: 'dbenv-app', defaultPlatform: 'cloudrun', policies: cloudrunPrepared });
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
    new SpecStore().replace(project, {
      version: 1,
      project: project.name,
      environments: {
        production: {
          hosting: { provider: 'cloudrun' },
          services: { web: {} },
          database: { provider: 'cloudsql' },
        },
      },
    });
    seedVerifiedConnection('cloudrun');
    seedVerifiedConnection('cloudsql');
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'cloudsql' } as never,
    });

    const t = await makeClient();
    const result = await t.call('hv_deploy', { project: 'dbenv-app', env: 'production' });
    expect(result.ok).toBe(true);

    expect(deployCalls).toHaveLength(1);
    // The managed database URL is injected even though the caller passed no envVars.
    expect(deployCalls[0].DATABASE_URL).toBe('postgresql://app:pw@34.44.202.227:5432/app');

    // Sugar path: the deploy is recorded as a plan + apply run pair.
    expect(typeof result.data.planId).toBe('string');
    expect(typeof result.data.applyRunId).toBe('string');
    await t.close();
  });
});

describe('hv_rollback', () => {
  it('records the rollback as a plan/apply run pair with per-service receipts', async () => {
    const project = new ProjectRepository().create({ name: 'rollback-pair-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });

    // A prior successful deploy run with a deploy_web receipt is the target.
    const runRepo = new RunRepository();
    const priorRun = runRepo.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'deploy',
      plan: { steps: [] },
    });
    runRepo.addReceipt(priorRun.id, { step: 'deploy_web', status: 'success', timestamp: new Date().toISOString() });
    runRepo.updateStatus(priorRun.id, 'succeeded');

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
      async ensureProject() { return { success: true, message: 'ok', data: { projectId: 'rp', environmentId: 're' } }; },
      async deploy(service) {
        return {
          serviceId: service.id,
          externalId: 'rail-web',
          url: 'https://web.up.railway.app',
          status: 'deployed',
          receipt: { success: true, message: 'deployed' },
        };
      },
      async setEnvVars() { return { success: true, message: 'ok' }; },
      async getDeployStatus() { return { status: 'deployed', url: 'https://web.up.railway.app' }; },
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fakeAdapter });

    const t = await makeClient();
    const result = await t.call('hv_rollback', { project: 'rollback-pair-app', env: 'staging' });
    expect(result.ok).toBe(true);
    expect(result.data.rollbackFromRunId).toBe(priorRun.id);
    expect(typeof result.data.planId).toBe('string');
    expect(typeof result.data.applyRunId).toBe('string');
    expect(result.data.services).toEqual(['web']);

    // The synthetic plan run carries the rollback action with fromRunId.
    const planRun = runRepo.findById(result.data.planId)!;
    expect(planRun.type).toBe('plan');
    const doc = planRun.plan as Record<string, any>;
    expect(doc.actions).toHaveLength(1);
    expect(doc.actions[0].id).toBe('service:web:rollback');
    expect(doc.actions[0].metadata).toMatchObject({ operation: 'rollbackRedeploy', fromRunId: priorRun.id });

    // The apply run has a per-service receipt.
    const applyRun = runRepo.findById(result.data.applyRunId)!;
    expect(applyRun.type).toBe('apply');
    expect(applyRun.receipts.some((receipt) => receipt.step === 'service:web:rollback' && receipt.status === 'success')).toBe(true);
    await t.close();
  });

  it('still validates toRunId against successful deploy runs', async () => {
    const project = new ProjectRepository().create({ name: 'rollback-invalid-app', defaultPlatform: 'railway' });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });

    const t = await makeClient();
    const result = await t.call('hv_rollback', {
      project: 'rollback-invalid-app',
      env: 'staging',
      toRunId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('not a successful deploy run');
    await t.close();
  });

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
