import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import { buildRailwayProxyDatabaseUrl, resolveExternalDatabaseUrl } from '../database-ops.service.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';

const INTERNAL_VARS: Record<string, string> = {
  PGUSER: 'postgres',
  POSTGRES_PASSWORD: 'p@ss/w:rd',
  PGDATABASE: 'appdb',
  POSTGRES_DB: 'appdb',
  DATABASE_URL: 'postgresql://postgres:p@ss@postgres-db.railway.internal:5432/appdb',
};

describe('resolveExternalDatabaseUrl via Railway TCP proxy', () => {
  let tempDir: string;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-external-url-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));

    project = new ProjectRepository().create({ name: 'proxy-app', defaultPlatform: 'railway' });
    environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-proj-1',
        environmentId: 'rail-env-1',
      },
    });
    new ComponentRepository().create({
      environmentId: environment.id,
      type: 'postgres',
      externalId: 'rail-svc-db-1',
      bindings: { provider: 'railway', projectId: 'rail-proj-1' },
    });

    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'test-token' }),
    });
    connectionRepo.updateStatus(connection.id, 'verified');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('constructs a proxy URL from datastore variables when a TCP proxy exists', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue(INTERNAL_VARS);
    const getProxy = vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy').mockResolvedValue({
      id: 'proxy-1',
      domain: 'db.proxy.rlwy.net',
      proxyPort: 33333,
      applicationPort: 5432,
    });
    const ensureProxy = vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy');

    const url = await resolveExternalDatabaseUrl(project, environment);

    expect(url).toBe(`postgresql://postgres:${encodeURIComponent('p@ss/w:rd')}@db.proxy.rlwy.net:33333/appdb`);
    expect(getProxy).toHaveBeenCalledWith('rail-env-1', 'rail-svc-db-1', 5432);
    // Plan-time resolution must never create a proxy.
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it('returns null when no TCP proxy exists (never creates one)', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue(INTERNAL_VARS);
    vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy').mockResolvedValue(null);
    const ensureProxy = vi.spyOn(RailwayAdapter.prototype, 'ensureTcpProxy');

    const url = await resolveExternalDatabaseUrl(project, environment);

    expect(url).toBeNull();
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it('prefers DATABASE_PUBLIC_URL over the proxy lookup', async () => {
    vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables').mockResolvedValue({
      ...INTERNAL_VARS,
      DATABASE_PUBLIC_URL: 'postgresql://postgres:pw@public.proxy.rlwy.net:44444/appdb',
    });
    const getProxy = vi.spyOn(RailwayAdapter.prototype, 'getTcpProxy');

    const url = await resolveExternalDatabaseUrl(project, environment);

    expect(url).toBe('postgresql://postgres:pw@public.proxy.rlwy.net:44444/appdb');
    expect(getProxy).not.toHaveBeenCalled();
  });
});

describe('buildRailwayProxyDatabaseUrl', () => {
  const proxy = { domain: 'db.proxy.rlwy.net', proxyPort: 33333 };

  it('encodes the password and falls back to POSTGRES_DB then "railway" for the database', () => {
    expect(buildRailwayProxyDatabaseUrl({ PGUSER: 'u', POSTGRES_PASSWORD: 'a b', PGDATABASE: 'db1' }, proxy))
      .toBe('postgresql://u:a%20b@db.proxy.rlwy.net:33333/db1');
    expect(buildRailwayProxyDatabaseUrl({ PGUSER: 'u', POSTGRES_PASSWORD: 'x', POSTGRES_DB: 'db2' }, proxy))
      .toBe('postgresql://u:x@db.proxy.rlwy.net:33333/db2');
    expect(buildRailwayProxyDatabaseUrl({ PGUSER: 'u', POSTGRES_PASSWORD: 'x' }, proxy))
      .toBe('postgresql://u:x@db.proxy.rlwy.net:33333/railway');
  });

  it('returns null when credentials are missing', () => {
    expect(buildRailwayProxyDatabaseUrl({ POSTGRES_PASSWORD: 'x' }, proxy)).toBeNull();
    expect(buildRailwayProxyDatabaseUrl({ PGUSER: 'u' }, proxy)).toBeNull();
  });
});
