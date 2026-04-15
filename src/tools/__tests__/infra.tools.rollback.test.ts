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
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';

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

describe('infra_apply local rollback coverage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-infra-rollback-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores environment bindings when database provision mutates local state then fails', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'rollback-bootstrap-project', defaultPlatform: 'railway' });
    const originalBindings = {
      provider: 'railway',
      projectId: 'rail-original-project',
      railwayProjectId: 'rail-original-project',
      environmentId: 'rail-original-env',
      railwayEnvironmentId: 'rail-original-env',
    };
    const environment = envRepo.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: originalBindings,
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'nixpacks' },
    });

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
      async provision(_type, env) {
        envRepo.updatePlatformBindings(env.id, {
          provider: 'railway',
          projectId: 'rail-stale-project',
          railwayProjectId: 'rail-stale-project',
          environmentId: 'rail-stale-env',
          railwayEnvironmentId: 'rail-stale-env',
          services: {
            web: { serviceId: 'rail-stale-service' },
          },
        });
        return {
          component: {
            id: '',
            environmentId: env.id,
            type: 'postgres',
            bindings: {},
            externalId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          receipt: {
            success: false,
            message: 'provision failed',
            error: 'forced failure after local mutation',
          },
        };
      },
      async getConnectionUrl() {
        return null;
      },
      async destroy() {
        return { success: true, message: 'destroyed' };
      },
    };

    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({
      success: true,
      adapter: fakeDatabaseAdapter,
    });

    const { createServer } = await import('../../server.js');
    const server = createServer();
    const client = new Client({ name: 'rollback-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'infra_apply', {
      projectName: project.name,
      environmentName: 'staging',
      serviceName: 'web',
      databaseProvider: 'railway',
      setupEmail: false,
      confirm: true,
    });

    expect(payload.success).toBe(false);
    expect(String(payload.summary && (payload.summary as JsonObj).error)).toContain('forced failure');
    const restored = envRepo.findById(environment.id);
    expect(restored?.platformBindings).toEqual(originalBindings);

    await Promise.all([client.close(), server.close()]);
  });
});
