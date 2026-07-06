import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from '../adapter.factory.js';
import { runEnvironmentTask } from '../environment-task.service.js';

describe('environment-task.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-environment-task-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTaskFixture() {
    const projectRepo = new ProjectRepository();
    const environmentRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'task-app', defaultPlatform: 'cloudrun' });
    const environment = environmentRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'aaa-cron',
      buildConfig: { workloadKind: 'cron' },
      envVarSpec: {},
    });
    const web = serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { workloadKind: 'web' },
      envVarSpec: {},
    });

    return { project, environment, web };
  }

  it('runs a one-off command through the bound web service environment', async () => {
    const { project, environment, web } = createTaskFixture();
    const runJob = vi.fn(async () => ({
      jobId: 'task-1',
      status: 'completed' as const,
      output: 'seeded',
      receipt: {
        success: true,
        message: 'task completed',
      },
    }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudrun',
        connect: async () => {},
        verify: async () => ({ success: true }),
        runJob,
      },
    } as any);

    const result = await runEnvironmentTask({
      project,
      environment,
      command: 'npm run db:seed',
      purpose: 'database seed command',
    });

    expect(result).toMatchObject({
      success: true,
      provider: 'cloudrun',
      service: web.name,
      command: 'npm run db:seed',
      jobId: 'task-1',
      status: 'completed',
    });
    expect(runJob).toHaveBeenCalledWith(environment, expect.objectContaining({ name: web.name }), 'npm run db:seed');
  });

  it('does not mark a task complete when the provider only reports it as running', async () => {
    const { project, environment, web } = createTaskFixture();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'cloudrun',
        connect: async () => {},
        verify: async () => ({ success: true }),
        runJob: async () => ({
          jobId: 'task-1',
          status: 'running' as const,
          receipt: {
            success: true,
            message: 'task started',
          },
        }),
      },
    } as any);

    const result = await runEnvironmentTask({
      project,
      environment,
      command: 'npm run db:seed',
      purpose: 'database seed command',
    });

    expect(result).toMatchObject({
      success: false,
      provider: 'cloudrun',
      service: web.name,
      command: 'npm run db:seed',
      status: 'running',
    });
    if (result.success) {
      throw new Error('expected environment task to fail while still running');
    }
    expect(result.error).toContain('did not report successful completion');
  });
});
