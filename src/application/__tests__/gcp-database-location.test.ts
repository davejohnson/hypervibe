/**
 * One resolver answers "where is this environment's database": Google project,
 * instance and database name. Everything else asks it, so a database on a
 * shared server in another project needs no second code path.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { engineDatabaseComponent } from '../../domain/services/database-access.service.js';
import { gcpDatabaseLocation } from '../gcp-database-location.js';
import { grantWorkerWakeRead, type DatabaseCredentialMetadata } from '../infrastructure-engine-database.js';
import { planDatabaseCredential } from '../infrastructure-engine.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shared = { instanceName: 'hv-shared-db', gcpProjectId: 'shared-project', databaseName: 'demo_prod' };

afterEach(() => vi.unstubAllGlobals());

describe('gcpDatabaseLocation', () => {
  it('has no location when the binding records no database', () => {
    expect(gcpDatabaseLocation('env-project', undefined)).toBeUndefined();
    expect(gcpDatabaseLocation('env-project', {})).toBeUndefined();
    expect(gcpDatabaseLocation('env-project', { database: { instanceName: '' } })).toBeUndefined();
    expect(gcpDatabaseLocation('env-project', { database: { instanceName: 7 } } as never)).toBeUndefined();
  });

  it('defaults to the environment\'s own project and the database named app', () => {
    expect(gcpDatabaseLocation('env-project', { database: { instanceName: 'hv-prod-db-a1b2c3' } }))
      .toEqual({ gcpProjectId: 'env-project', instanceName: 'hv-prod-db-a1b2c3', databaseName: 'app' });
  });

  it('respects another project and database name recorded on the binding', () => {
    expect(gcpDatabaseLocation('env-project', { database: shared })).toEqual(shared);
  });
});

describe('readers follow the location', () => {
  const environment = (database: Record<string, unknown>) => ({
    id: 'env-1', name: 'production', createdAt: 'now', updatedAt: 'now',
    platformBindings: { provider: 'cloudrun', projectId: 'env-project', region: 'us-central1', engine: { database } },
  }) as unknown as Environment;
  const plan = async (database: Record<string, unknown>) => {
    const actions = await planDatabaseCredential({
      token: 'token', context: { gcpProjectId: 'env-project', region: 'us-central1', environment: environment(database) }, environmentName: 'production',
      database: gcpDatabaseLocation('env-project', { database: database as never })!, databaseSecretId: 'production-database-url',
      labels: { 'managed-by': 'hypervibe' }, observation: { ready: false, generation: 0 }, desiredGeneration: 1, dependsOn: [], servicesUpdating: false,
    }) as PlanAction[];
    return actions[0]!.metadata as unknown as DatabaseCredentialMetadata;
  };

  it('the query path targets the instance in the recorded project', () => {
    const component = engineDatabaseComponent(environment(shared))!;
    expect(component.externalId).toBe('hv-shared-db');
    expect(component.bindings.providerScope).toEqual({ projectId: 'shared-project', region: 'us-central1' });
    expect(engineDatabaseComponent(environment({ instanceName: 'hv-prod-db-a1b2c3' }))!.bindings.providerScope).toEqual({ projectId: 'env-project', region: 'us-central1' });
  });

  it('the login plan names the recorded project and database, and keeps the secret in the environment\'s project', async () => {
    expect(await plan(shared)).toMatchObject({
      gcpProjectId: 'env-project', secretId: 'production-database-url',
      instanceGcpProjectId: 'shared-project', instanceName: 'hv-shared-db', databaseName: 'demo_prod',
    });
  });

  it('the login plan for an environment\'s own instance is unchanged', async () => {
    expect(JSON.stringify(await plan({ instanceName: 'hv-prod-db-a1b2c3' }))).toBe(JSON.stringify({
      operation: 'gcpDatabaseCredentialEnsure', mode: 'initialize', gcpProjectId: 'env-project', instanceName: 'hv-prod-db-a1b2c3',
      secretId: 'production-database-url', labels: { 'managed-by': 'hypervibe' }, databaseName: 'app', generation: 1,
    }));
  });

  it('a login step asks Cloud SQL in the recorded project and Secret Manager in the environment\'s', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return url.includes('sqladmin') ? Response.json({ state: 'RUNNABLE', connectionName: 'shared-project:us-central1:hv-shared-db' }) : new Response('{}', { status: 403 });
    }));
    const result = await grantWorkerWakeRead('token', {}, { id: 'worker-wake-grant:postgres', type: 'update', resource: { kind: 'database', name: 'postgres', provider: 'gcp' },
      metadata: { operation: 'gcpWorkerWakeGrant', gcpProjectId: 'env-project', instanceGcpProjectId: 'shared-project', instanceName: 'hv-shared-db', databaseName: 'demo_prod',
        secretId: 'production-database-url', iamUser: 'hv-runtime@env-project.iam' } } as unknown as PlanAction);
    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://sqladmin.googleapis.com/v1/projects/shared-project/instances/hv-shared-db');
    expect(urls[1]).toContain('projects/env-project/secrets/production-database-url');
  });
});

describe('nothing but the resolver reads a database binding directly', () => {
  // Reads such as `binding.database?.instanceName` assume the instance is in the environment's own project.
  // The scan is by text: it cannot see a read through an intermediate variable.
  const DIRECT_READ = /\.database\??\.instanceName\b/;
  const allowed: Record<string, string> = {
    'src/adapters/providers/gcp/tofu/gcp-dedicated-database.ts': 'reads the generator input for the instance it creates, never a saved binding',
  };

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    });
  }

  const readers = sourceFiles(sourceRoot)
    .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => DIRECT_READ.test(line)))
    .map((file) => `src/${path.relative(sourceRoot, file).split(path.sep).join('/')}`).sort();

  it('recognises the reads it is meant to stop', () => {
    expect(DIRECT_READ.test('const name = engineBinding.database?.instanceName')).toBe(true);
    expect(DIRECT_READ.test('sqlAdmin(token, project, `instances/${binding.database.instanceName}`)')).toBe(true);
    expect(DIRECT_READ.test('database: { instanceName: located.instanceName }')).toBe(false);
  });

  it('finds no direct reader outside the listed files', () => {
    expect(readers.filter((file) => !allowed[file])).toEqual([]);
  });

  it('lists no file that has stopped reading it', () => {
    expect(Object.keys(allowed).filter((file) => !readers.includes(file))).toEqual([]);
  });
});
