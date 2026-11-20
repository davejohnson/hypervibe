import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { CloudSqlAdapter } from '../../../adapters/providers/gcp/cloudsql.adapter.js';
import { ProjectSpecRepository } from '../../../adapters/db/repositories/spec.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import {
  maskDatabaseUrl,
  resolveEnvironmentDatabaseUrl,
} from '../database-ops.service.js';

describe('database-ops.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-database-ops-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    { name: 'repository-default Cloud SQL', selected: false, scoped: true, credentialProject: 'gcp-project', available: true },
    { name: 'a removed selector pointing to a different repository project', selected: false, scoped: true, credentialProject: 'staging-project', available: false },
    { name: 'a dedicated Cloud SQL component', selected: true, scoped: true, credentialProject: 'gcp-project', available: true },
    { name: 'a cached URL with no native project ownership', selected: true, scoped: false, credentialProject: 'gcp-project', available: false },
  ])('resolves the cached URL only for the bound database: $name', async ({ selected, scoped, credentialProject, available }) => {
    const observe = vi.spyOn(CloudSqlAdapter.prototype as unknown as { getInstance(id: string): Promise<unknown> }, 'getInstance')
      .mockRejectedValue(new Error('Cloud SQL control plane unavailable'));
    const projectRepo = new ProjectRepository();
    const envRepo = new EnvironmentRepository();
    const serviceRepo = new ServiceRepository();
    const componentRepo = new ComponentRepository();
    const connectionRepo = new ConnectionRepository();

    const project = projectRepo.create({ name: 'cloudsql-query-project', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/example/app.git' });
    new ProjectSpecRepository().insert(project.id, 1, { version: 1, project: project.name, environments: {
      production: { hosting: { provider: 'cloudrun', ...(selected ? { gcpProjectId: 'gcp-project' } : {}) }, services: { web: {} } },
    } });
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
      ...(scoped ? { externalId: 'cloudsql-postgres' } : {}),
      bindings: {
        provider: 'cloudsql',
        ...(scoped ? { providerScope: { projectId: 'gcp-project', region: 'us-central1' } } : {}),
        connectionString: 'postgresql://postgres:password@203.0.113.10:5432/app',
        username: 'postgres',
        password: 'password',
        database: 'app',
        port: 5432,
      },
    });
    const connection = connectionRepo.create({
      provider: 'cloudsql',
      scope: selected ? 'example/app#gcp:gcp-project' : 'example/app',
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: credentialProject,
        region: 'us-central1',
        credentials: JSON.stringify({
          type: 'service_account',
          project_id: credentialProject,
          private_key: 'not-a-real-key',
          client_email: `deploy@${credentialProject}.iam.gserviceaccount.com`,
        }),
      }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');

    const url = await resolveEnvironmentDatabaseUrl(project, environment, 'web');

    expect(url).toBe(available ? 'postgresql://postgres:password@203.0.113.10:5432/app' : null);
    expect(observe).toHaveBeenCalledTimes(available ? 1 : 0);
  });

  it('masks credentials in database URLs', () => {
    expect(maskDatabaseUrl('postgres://user:secretpw@db.example.com:5432/app'))
      .toBe('postgres://***:***@db.example.com:5432/app');
    expect(maskDatabaseUrl('postgres://user@db.example.com:5432/app'))
      .toBe('postgres://***@db.example.com:5432/app');
  });

});
