import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';

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

describe('workflow mode tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-workflow-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('launch_plan defaults production launches to GCP Cloud Run', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'workflow-launch-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'launch_plan', {
      projectName: 'new-saas',
      services: ['web', 'worker'],
      domain: 'example.com',
      migrationCommand: 'npm run migrate',
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('launch');
    expect((payload.recommendation as JsonObj).target).toBe('gcp-cloud-run');
    expect((payload.desiredInfrastructure as JsonObj).services).toEqual(['web', 'worker']);
    expect((payload.desiredInfrastructure as JsonObj).migrations).toMatchObject({
      mode: 'tool',
      runInDeploy: true,
      command: 'npm run migrate',
    });
    expect((payload.readiness as JsonObj).blocked).toBe(true);
    expect(payload.nextTools).toContain('connection_create provider="cloudrun"');

    await Promise.all([client.close(), server.close()]);
  });

  it('import_plan returns the Railway discovery path before a project is adopted', async () => {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'workflow-import-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'import_plan', {
      sourceProvider: 'railway',
      externalProjectName: 'billforge',
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('import');
    expect(payload.imported).toBe(false);
    expect((payload.readiness as JsonObj).blocked).toBe(true);
    expect(payload.nextTools).toEqual(['project_import', 'setup_scan', 'infra_desired_set']);

    await Promise.all([client.close(), server.close()]);
  });

  it('move_plan stages a provider-to-provider migration for an adopted project', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const connectionRepo = new ConnectionRepository();

    const project = projectRepo.create({ name: 'billforge', defaultPlatform: 'railway' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        railwayProjectId: 'rail-project-1',
        railwayEnvironmentId: 'rail-env-1',
        services: {
          web: {
            serviceId: 'rail-web',
            url: 'https://web-production.up.railway.app',
            customDomains: ['usebillforge.com'],
          },
          worker: {
            serviceId: 'rail-worker',
            url: 'https://worker-production.up.railway.app',
          },
          cron: {
            serviceId: 'rail-cron',
            url: 'https://cron-production.up.railway.app',
          },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: {
        builder: 'nixpacks',
        startCommand: 'npm start',
        releaseCommand: 'npm run migrate',
        healthCheckPath: '/',
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'worker',
      buildConfig: {
        builder: 'nixpacks',
        startCommand: 'npm run worker',
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'cron',
      buildConfig: {
        builder: 'nixpacks',
        startCommand: 'npm run cron',
        cronSchedule: '0 * * * *',
      },
    });
    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'rail-postgres',
      bindings: {
        provider: 'railway',
      },
    });

    for (const provider of ['cloudrun', 'cloudsql']) {
      const connection = connectionRepo.create({
        provider,
        credentialsEncrypted: 'test-credentials',
      });
      connectionRepo.updateStatus(connection.id, 'verified');
    }

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'workflow-move-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'move_plan', {
      projectName: 'billforge',
      target: 'gcp-cloud-run',
    });

    expect(payload.success).toBe(true);
    expect(payload.mode).toBe('move');
    expect((payload.target as JsonObj).id).toBe('gcp-cloud-run');
    expect(payload.targetProject).toMatchObject({
      name: 'billforge-gcp-cloud-run',
      defaultPlatform: 'cloudrun',
      exists: false,
    });
    expect(payload.serviceRoles).toEqual([
      { name: 'web', role: 'web', source: 'inferred' },
      { name: 'worker', role: 'worker', source: 'inferred' },
      { name: 'cron', role: 'cron', source: 'inferred' },
    ]);
    expect((payload.generatedArgs as JsonObj).createTargetProject).toEqual({
      name: 'billforge-gcp-cloud-run',
      defaultPlatform: 'cloudrun',
    });
    expect((payload.generatedArgs as JsonObj).parallelDeployDesiredSet).toMatchObject({
      projectName: 'billforge-gcp-cloud-run',
      environmentName: 'production',
      services: ['web', 'worker'],
      crons: {
        cron: {
          schedule: '0 * * * *',
          command: 'npm run cron',
        },
      },
      databaseProvider: 'cloudsql',
      setupEmail: false,
      serviceConfig: {
        web: {
          startCommand: 'npm start',
          healthCheckPath: '/',
        },
        worker: {
          startCommand: 'npm run worker',
        },
      },
    });
    expect((payload.generatedArgs as JsonObj).parallelDeployDesiredSet).not.toHaveProperty('domain');
    expect((payload.generatedArgs as JsonObj).parallelDeployDesiredSet).not.toHaveProperty('migrations');
    expect((payload.generatedArgs as JsonObj).cutoverDesiredSet).toMatchObject({
      projectName: 'billforge-gcp-cloud-run',
      domain: 'usebillforge.com',
    });
    expect((payload.generatedArgs as JsonObj).targetMigration).toEqual({
      tool: 'db_migrate',
      args: {
        projectName: 'billforge-gcp-cloud-run',
        environment: 'production',
        serviceName: 'web',
        command: 'npm run migrate',
      },
    });
    expect((payload.generatedArgs as JsonObj).databaseCopy).toMatchObject({
      tool: 'db_migrate_provider',
      args: {
        projectName: 'billforge-gcp-cloud-run',
        environment: 'production',
        targetProvider: 'cloudsql',
        strategy: 'snapshot',
        phase: 'copy',
        services: ['web', 'worker', 'cron'],
      },
    });
    expect((payload.generatedArgs as JsonObj).databaseCutover).toMatchObject({
      tool: 'db_migrate_provider',
      args: {
        projectName: 'billforge-gcp-cloud-run',
        phase: 'cutover',
        services: ['web', 'worker', 'cron'],
      },
    });
    expect(payload.cutoverPlan).toMatchObject({
      databaseStrategy: {
        selected: 'snapshot',
        writeFreezeRequired: true,
      },
      services: {
        traffic: ['web'],
        background: ['worker'],
        scheduled: ['cron'],
        databaseEnvCutover: ['web', 'worker', 'cron'],
      },
    });
    expect(payload.migrationPlan).toMatchObject({
      strategy: 'external',
      command: 'npm run migrate',
      includedInDesiredState: false,
    });
    expect((payload.readiness as JsonObj).blocked).toBe(false);
    expect((payload.phases as Array<JsonObj>).map((phase) => phase.step)).toContain('migrate_database');
    expect((payload.risks as Array<JsonObj>).map((risk) => risk.risk)).toContain('Database move requires an explicit copy, verification, and cutover window');
    expect(payload.nextTools).toContain('project_create');
    expect(payload.nextTools).toContain('db_migrate_provider');
    expect(payload.nextTools).toContain('db_migrate');

    const preparePreview = await callTool(client, 'move_prepare', {
      projectName: 'billforge',
      target: 'gcp-cloud-run',
    });
    expect(preparePreview.mode).toBe('move_prepare');
    expect(preparePreview.preview).toBe(true);
    expect(projectRepo.findByName('billforge-gcp-cloud-run')).toBeNull();

    const preparePayload = await callTool(client, 'move_prepare', {
      projectName: 'billforge',
      target: 'gcp-cloud-run',
      confirm: true,
    });
    expect(preparePayload.success).toBe(true);
    expect(preparePayload.prepared).toBe(true);
    expect(preparePayload.targetProject).toMatchObject({
      name: 'billforge-gcp-cloud-run',
      defaultPlatform: 'cloudrun',
      created: true,
    });

    const sourceProject = projectRepo.findByName('billforge');
    const targetProject = projectRepo.findByName('billforge-gcp-cloud-run');
    expect(sourceProject?.defaultPlatform).toBe('railway');
    expect(targetProject?.defaultPlatform).toBe('cloudrun');
    expect(targetProject?.policies.desiredState).toMatchObject({
      environmentName: 'production',
      services: ['web', 'worker'],
      crons: {
        cron: {
          schedule: '0 * * * *',
          command: 'npm run cron',
        },
      },
      databaseProvider: 'cloudsql',
      setupEmail: false,
      serviceConfig: {
        web: {
          startCommand: 'npm start',
          healthCheckPath: '/',
        },
        worker: {
          startCommand: 'npm run worker',
        },
      },
    });
    expect(targetProject?.policies.desiredState).not.toHaveProperty('projectName');
    expect(targetProject?.policies.desiredState).not.toHaveProperty('domain');
    expect(targetProject?.policies.desiredState).not.toHaveProperty('migrations');

    const targetPlan = await callTool(client, 'infra_plan', {
      projectName: 'billforge-gcp-cloud-run',
    });
    const cloudPrepareStep = (targetPlan.plan as Array<JsonObj>).find((step) => step.action === 'cloud_prepare');
    expect(cloudPrepareStep).toMatchObject({
      status: 'needed',
      detail: 'Prepare GCP Cloud Run + Cloud SQL with cloud_prepare before deploy',
    });
    const deployStep = (targetPlan.plan as Array<JsonObj>).find((step) => step.action === 'deploy');
    expect(deployStep).toMatchObject({
      status: 'blocked',
      detail: 'Run cloud_prepare for GCP Cloud Run before deploying service "web"',
    });
    const cronDeployStep = (targetPlan.plan as Array<JsonObj>).find((step) => step.action === 'cron_deploy');
    expect(cronDeployStep).toMatchObject({
      status: 'blocked',
      detail: 'Run cloud_prepare for GCP Cloud Run before deploying cron job "cron"',
    });

    await Promise.all([client.close(), server.close()]);
  });
});
