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
      railwayProjectId: 'rail-old-project',
      environmentId: 'rail-old-env',
      railwayEnvironmentId: 'rail-old-env',
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
              railwayEnvironmentId: 'rail-new-env',
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
});
