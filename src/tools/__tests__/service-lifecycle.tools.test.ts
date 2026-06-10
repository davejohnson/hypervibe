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
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';

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
  const text = result.content.find((content) => content.type === 'text')?.text;
  if (!text) throw new Error(`Tool ${name} returned no text payload`);
  return JSON.parse(text) as JsonObj;
}

describe('service lifecycle tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-service-lifecycle-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createClient() {
    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'service-lifecycle-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  function setupProject() {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const project = projectRepo.create({
      name: 'cron-project',
      defaultPlatform: 'cloudrun',
      policies: {
        desiredState: {
          environmentName: 'production',
          services: ['web'],
          crons: {
            cron: {
              schedule: '*/5 * * * *',
              command: 'npm run cron',
            },
          },
        },
      },
    });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          cron: {
            serviceId: 'gcp-project-cron-schedule',
            jobName: 'gcp-project-cron',
            schedulerJobName: 'gcp-project-cron-schedule',
            resourceType: 'scheduledJob',
          },
        },
      },
    });
    const service = serviceRepo.create({
      projectId: project.id,
      name: 'cron',
      buildConfig: {
        workloadKind: 'cron',
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarSpec: {},
    });
    return { project, environment, service };
  }

  it('updates a cron schedule and command', async () => {
    setupProject();
    const { server, client } = await createClient();

    const payload = await callTool(client, 'service_update', {
      projectName: 'cron-project',
      serviceName: 'cron',
      startCommand: 'npm run nightly',
      cronSchedule: '0 3 * * *',
    });

    expect(payload.success).toBe(true);
    const service = payload.service as JsonObj;
    expect(service.buildConfig).toMatchObject({
      workloadKind: 'cron',
      startCommand: 'npm run nightly',
      cronSchedule: '0 3 * * *',
    });
    const project = new ProjectRepository().findByName('cron-project');
    expect(project?.policies.desiredState).toMatchObject({
      crons: {
        cron: {
          schedule: '0 3 * * *',
          command: 'npm run nightly',
        },
      },
    });

    await Promise.all([client.close(), server.close()]);
  });

  it('deletes a cron locally after provider cleanup succeeds', async () => {
    const { project } = setupProject();
    const deleteService = vi.fn(async () => ({ success: true, message: 'deleted' }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { deleteService } as unknown as IProviderAdapter,
    });
    const { server, client } = await createClient();

    const payload = await callTool(client, 'service_delete', {
      projectName: 'cron-project',
      serviceName: 'cron',
      confirm: true,
    });

    expect(payload.success).toBe(true);
    expect(deleteService).toHaveBeenCalledWith('gcp-project-cron-schedule');
    expect(new ServiceRepository().findByProjectAndName(project.id, 'cron')).toBeNull();
    const reloadedProject = new ProjectRepository().findByName('cron-project');
    expect(reloadedProject?.policies.desiredState).toMatchObject({
      services: ['web'],
      crons: {},
    });
    const environment = new EnvironmentRepository().findByProjectAndName(project.id, 'production');
    expect((environment?.platformBindings.services as Record<string, unknown>).cron).toBeUndefined();

    await Promise.all([client.close(), server.close()]);
  });

  it('does not delete local cron state when provider cleanup fails', async () => {
    setupProject();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        async deleteService() {
          return { success: false, error: 'provider refused delete' };
        },
      } as unknown as IProviderAdapter,
    });
    const { server, client } = await createClient();

    const payload = await callTool(client, 'service_delete', {
      projectName: 'cron-project',
      serviceName: 'cron',
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain('Provider cleanup failed');
    const project = new ProjectRepository().findByName('cron-project');
    expect(new ServiceRepository().findByProjectAndName(project!.id, 'cron')).not.toBeNull();

    await Promise.all([client.close(), server.close()]);
  });
});
