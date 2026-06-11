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
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

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

describe('db tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-db-tools-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans db_migrate dry runs against non-Railway deployed services', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'cloud-project', defaultPlatform: 'cloudrun' });
    envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: {
            serviceId: 'gcp-project-web',
            imageUri: 'us-docker.pkg.dev/gcp-project/apps/web:sha',
          },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
    });

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'db-tools-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'db_migrate', {
      projectName: 'cloud-project',
      environment: 'production',
      command: 'npm run migrate',
      dryRun: true,
    });

    expect(payload).toMatchObject({
      success: true,
      dryRun: true,
      provider: 'cloudrun',
      project: 'cloud-project',
      environment: 'production',
      service: 'web',
      command: 'npm run migrate',
    });

    await Promise.all([client.close(), server.close()]);
  });

  it('plans snapshot provider migrations across explicit service targets', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();

    const project = projectRepo.create({ name: 'cloud-project', defaultPlatform: 'cloudrun' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
          worker: { serviceId: 'gcp-project-worker' },
          cron: { serviceId: 'gcp-project-cron' },
        },
      },
    });
    for (const name of ['web', 'worker', 'cron']) {
      serviceRepo.create({
        projectId: project.id,
        name,
        buildConfig: name === 'cron' ? { cronSchedule: '0 * * * *' } : {},
      });
    }
    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'source-postgres',
      bindings: {
        provider: 'railway',
        connectionString: 'postgres://user:password@source.example.com:5432/app',
      },
    });

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'db-provider-tools-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'db_migrate_provider', {
      projectName: 'cloud-project',
      environment: 'production',
      targetProvider: 'cloudsql',
      phase: 'plan',
      strategy: 'snapshot',
      services: ['web', 'worker', 'cron'],
    });

    expect(payload).toMatchObject({
      success: true,
      phase: 'plan',
      strategy: {
        selected: 'snapshot',
        status: 'available',
        writeFreezeRequired: true,
        continuousReplication: false,
      },
      target: {
        provider: 'cloudsql',
        services: ['web', 'worker', 'cron'],
      },
    });
    expect(payload.warnings).toContain('Snapshot mode requires a write freeze or maintenance window. Writes after pg_dump starts are not replicated.');
    expect(payload.steps).toContain('cutover: set DATABASE_URL, DIRECT_URL, DATABASE_URL_PREV on web, worker, cron');

    const blocked = await callTool(client, 'db_migrate_provider', {
      projectName: 'cloud-project',
      environment: 'production',
      targetProvider: 'cloudsql',
      phase: 'copy',
      strategy: 'logical_replication',
      services: ['web', 'worker'],
      confirm: true,
    });

    expect(blocked).toMatchObject({
      success: false,
      phase: 'copy',
      strategy: 'logical_replication',
    });
    expect(blocked.error).toContain('not implemented yet');

    await Promise.all([client.close(), server.close()]);
  });

  it('resolves db_query through a Cloud SQL component instead of requiring Railway', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const connectionRepo = new ConnectionRepository();

    const project = projectRepo.create({ name: 'cloudsql-query-project', defaultPlatform: 'cloudrun' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
    });
    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'cloudsql-postgres',
      bindings: {
        provider: 'cloudsql',
        connectionString: 'postgresql://postgres:password@203.0.113.10:5432/app',
        username: 'postgres',
        password: 'password',
        database: 'app',
        port: 5432,
      },
    });
    const connection = connectionRepo.create({
      provider: 'cloudsql',
      scope: 'cloudsql-query-project',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'gcp-project',
          private_key: 'not-a-real-key',
          client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
        }),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'db-query-cloudsql-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'db_query', {
      projectName: 'cloudsql-query-project',
      environment: 'production',
      serviceName: 'web',
      sql: 'DROP TABLE "Users";',
    });

    expect(payload).toMatchObject({
      success: false,
      error: 'Mutation query blocked for safety',
      queryType: 'mutation',
    });
    expect(payload.error).not.toBe('Environment not deployed to Railway');

    await Promise.all([client.close(), server.close()]);
  });

  it('allows db_query to target the default postgres database for Cloud SQL repair', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const connectionRepo = new ConnectionRepository();

    const project = projectRepo.create({ name: 'cloudsql-postgres-repair-project', defaultPlatform: 'cloudrun' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'us-central1',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
    });
    serviceRepo.create({
      projectId: project.id,
      name: 'web',
      buildConfig: { builder: 'dockerfile' },
    });
    componentRepo.create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'cloudsql-postgres',
      bindings: {
        provider: 'cloudsql',
        connectionString: 'postgresql://postgres:password@203.0.113.10:5432/app',
        username: 'postgres',
        password: 'password',
        database: 'app',
        port: 5432,
      },
    });
    const connection = connectionRepo.create({
      provider: 'cloudsql',
      scope: 'cloudsql-postgres-repair-project',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: 'gcp-project',
          private_key: 'not-a-real-key',
          client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
        }),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const { createLegacyTestServer } = await import('./legacy-server.helper.js');
    const server = createLegacyTestServer();
    const client = new Client({ name: 'db-query-cloudsql-postgres-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const payload = await callTool(client, 'db_query', {
      projectName: 'cloudsql-postgres-repair-project',
      environment: 'production',
      serviceName: 'web',
      databaseName: 'postgres',
      sql: 'CREATE DATABASE app;',
    });

    expect(payload).toMatchObject({
      success: false,
      error: 'Mutation query blocked for safety',
      queryType: 'mutation',
      source: 'cloudsql-postgres-repair-project/production/web/postgres',
    });
    expect(payload.hint).toContain('allowMutations=true');

    await Promise.all([client.close(), server.close()]);
  });
});
