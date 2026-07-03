import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { DeployOrchestrator } from '../deploy.orchestrator.js';
import type { IHostingAdapter } from '../../ports/hosting.port.js';

describe('DeployOrchestrator local rollback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-deploy-rollback-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores prior environment bindings after a failed deploy rollback', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'rollback-project', defaultPlatform: 'railway' });
    const originalBindings = {
      provider: 'railway',
      projectId: 'rail-old-project',
      environmentId: 'rail-old-env',
      services: {
        web: {
          serviceId: 'rail-old-service',
          url: 'https://old.example.com',
        },
      },
    };
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: originalBindings,
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });

    const adapter: IHostingAdapter = {
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
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'created',
          data: {
            created: true,
            projectId: 'rail-new-project',
            environmentId: 'rail-new-env',
          },
        };
      },
      async deploy() {
        return {
          serviceId: 'deploy-run-1',
          externalId: 'rail-new-service',
          url: 'https://new.example.com',
          status: 'deploying',
          receipt: {
            success: true,
            message: 'deploy started',
            data: {
              createdService: true,
              environmentId: 'rail-new-env',
            },
          },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'ok' };
      },
      async getDeployStatus() {
        return { status: 'failed' };
      },
      async deleteProject() {
        return { success: true };
      },
      async deleteService() {
        return { success: true };
      },
    };

    const orchestrator = new DeployOrchestrator();
    const result = await orchestrator.execute({
      project,
      environment,
      services: [service],
      adapter,
    });

    expect(result.success).toBe(false);
    const restored = envRepo.findById(environment.id);
    expect(restored?.platformBindings).toEqual(originalBindings);
  });

  it('stores provider-neutral bindings for non-Railway deploys', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'cloud-project', defaultPlatform: 'cloudrun' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-old-project',
        environmentId: 'rail-old-env',
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
    });

    const adapter: IHostingAdapter = {
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
        supportsObserve: false,
      },
      async connect() {},
      async verify() {
        return { success: true };
      },
      async ensureProject() {
        return {
          success: true,
          message: 'using gcp project',
          data: {
            projectId: 'gcp-project',
            environmentId: 'us-central1',
          },
        };
      },
      async deploy() {
        return {
          serviceId: service.id,
          externalId: 'cloudrun-web',
          url: 'https://web.example.run.app',
          status: 'deploying',
          receipt: {
            success: true,
            message: 'deploy started',
            data: {
              environmentId: 'us-central1',
            },
          },
        };
      },
      async setEnvVars() {
        return { success: true, message: 'ok' };
      },
      async getDeployStatus() {
        return { status: 'deployed', url: 'https://web.example.run.app' };
      },
    };

    const orchestrator = new DeployOrchestrator();
    const result = await orchestrator.execute({
      project,
      environment,
      services: [service],
      adapter,
    });

    expect(result.success).toBe(true);
    expect(result.urls).toEqual(['https://web.example.run.app']);
    expect(result.serviceUrls).toEqual({ web: 'https://web.example.run.app' });
    expect(result.primaryUrl).toBe('https://web.example.run.app');
    const updated = envRepo.findById(environment.id);
    expect(updated?.platformBindings).toEqual({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      environmentId: 'us-central1',
      services: {
        web: {
          serviceId: 'cloudrun-web',
          url: 'https://web.example.run.app',
          workloadKind: 'web',
        },
      },
    });
  });
});

describe('DeployOrchestrator run plan secrecy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-deploy-plan-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never persists env var values in the run plan — key names only', () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'plan-secrecy-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({ projectId: project.id, name: 'staging' });
    const service = serviceRepo.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });

    const orchestrator = new DeployOrchestrator();
    const plan = orchestrator.buildPlan({
      project,
      environment,
      services: [service],
      envVars: {
        DATABASE_URL: 'postgres://user:sup3rsecret@host:5432/app',
        SENDGRID_API_KEY: 'SG.very-secret-value',
      },
      adapter: { name: 'railway' } as unknown as IHostingAdapter,
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('sup3rsecret');
    expect(serialized).not.toContain('SG.very-secret-value');

    const setEnvStep = plan.steps.find((step) => step.action === 'setEnvVars')!;
    expect(setEnvStep.params).toEqual({ envVarKeys: ['DATABASE_URL', 'SENDGRID_API_KEY'] });
  });
});
