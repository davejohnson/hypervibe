import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  resolveEnvironmentDatabaseUrl,
  runDatabaseMigration,
  runDatabaseSeed,
} from '../database-ops.service.js';

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
