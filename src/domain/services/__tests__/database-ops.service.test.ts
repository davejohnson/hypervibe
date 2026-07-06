import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import {
  maskDatabaseUrl,
  resolveDatabaseTaskRunner,
  resolveEnvironmentDatabaseUrl,
  runDatabaseMigration,
  runDatabaseSeed,
} from '../database-ops.service.js';
import { adapterFactory } from '../adapter.factory.js';

describe('database-ops.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-database-ops-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans migration dry runs against non-Railway deployed services', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();

    const project = projectRepo.create({ name: 'cloud-project', defaultPlatform: 'cloudrun' });
    const env = envRepo.create({
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

    const payload = await runDatabaseMigration({
      project,
      env,
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
  });

  it('resolves the database URL through a Cloud SQL component instead of requiring Railway', async () => {
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

    const url = await resolveEnvironmentDatabaseUrl(project, environment, 'web');

    expect(url).toBe('postgresql://postgres:password@203.0.113.10:5432/app');
  });

  it('masks credentials in database URLs', () => {
    expect(maskDatabaseUrl('postgres://user:secretpw@db.example.com:5432/app'))
      .toBe('postgres://***:***@db.example.com:5432/app');
    expect(maskDatabaseUrl('postgres://user@db.example.com:5432/app'))
      .toBe('postgres://***@db.example.com:5432/app');
  });

  it('runs seed commands locally with DATABASE_URL and masks command output', async () => {
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const project = projectRepo.create({ name: 'seed-project', defaultPlatform: 'railway' });
    const environment = envRepo.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const payload = await runDatabaseSeed({
      project,
      env: environment,
      command: 'node -e "console.log(process.env.DATABASE_URL)"',
      targetConnectionUrl: 'postgres://user:secretpw@db.example.com:5432/app',
    });

    expect(payload.success).toBe(true);
    expect(String(payload.stdout)).toContain('postgres://***:***@db.example.com:5432/app');
    expect(JSON.stringify(payload)).not.toContain('secretpw');
  });
});

describe('resolveDatabaseTaskRunner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-task-runner-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(bindings: Record<string, unknown>) {
    const project = new ProjectRepository().create({ name: 'runner-app', defaultPlatform: 'railway' });
    const env = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: bindings });
    return { project, env };
  }

  it('prefers the environment runner when the adapter supports runJob and a service is bound', async () => {
    const { project, env } = seed({ provider: 'railway', services: { web: { serviceId: 'svc-1' } } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { runJob: async () => ({}) } as never,
    });

    expect(await resolveDatabaseTaskRunner(project, env)).toEqual({ runner: 'environment' });
  });

  it('falls back to local with a reason when the adapter has no runJob', async () => {
    const { project, env } = seed({ provider: 'railway', services: { web: { serviceId: 'svc-1' } } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {} as never });

    const result = await resolveDatabaseTaskRunner(project, env);
    expect(result.runner).toBe('local');
    expect(result.reason).toContain('does not support in-environment');
  });

  it('falls back to local when no service is deployed yet', async () => {
    const { project, env } = seed({ provider: 'railway', services: {} });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { runJob: async () => ({}) } as never,
    });

    const result = await resolveDatabaseTaskRunner(project, env);
    expect(result.runner).toBe('local');
    expect(result.reason).toContain('Deploy first');
  });

  it('rejects explicit runIn=environment when only local would work', async () => {
    const { project, env } = seed({ provider: 'railway', services: {} });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { runJob: async () => ({}) } as never,
    });

    const result = await runDatabaseSeed({
      project,
      env,
      command: 'npm run db:seed',
      runIn: 'environment',
    });
    expect(result.success).toBe(false);
    expect(String(result.hint)).toContain('runIn="local"');
  });

  it('seed dry run reports the environment runner without touching database URLs', async () => {
    const { project, env } = seed({ provider: 'railway', services: { web: { serviceId: 'svc-1' } } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { runJob: async () => ({}) } as never,
    });

    const preview = await runDatabaseSeed({ project, env, command: 'npm run db:seed', dryRun: true });
    expect(preview).toMatchObject({ success: true, dryRun: true, runner: 'environment' });
    expect(preview.target).toBeUndefined();
  });

  it('an explicit target URL forces the local runner', async () => {
    const { project, env } = seed({ provider: 'railway', services: { web: { serviceId: 'svc-1' } } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { runJob: async () => ({}) } as never,
    });

    const preview = await runDatabaseSeed({
      project,
      env,
      command: 'npm run db:seed',
      targetConnectionUrl: 'postgresql://u:p@db.example.com:5432/app',
      dryRun: true,
    });
    expect(preview).toMatchObject({ success: true, runner: 'local' });
  });
});
