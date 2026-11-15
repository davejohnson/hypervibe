import { z } from 'zod';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import '../providers.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { importProvider } from '../import-provider.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';

// A synthetic lifecycle owner keeps generic import/cleanup safety independent of clouds.
const fixtureDatabaseProvider = providerRegistry.get('cloudsql')!;
providerRegistry.register({
  ...fixtureDatabaseProvider,
  metadata: {
    ...fixtureDatabaseProvider.metadata, name: 'fixture-database', displayName: 'Fixture database',
    lifecycle: { databaseEngines: ['postgres'], databaseConnectivity: { compatibleHostingProviders: ['railway', 'fixture-hosting'] } },
    maturity: { lifecycle: { database: { status: 'ready-for-live' } } },
  },
  retainedCleanup: {
    resources: ['backup'],
    destroy: (adapter, target) => (adapter as { destroyRetainedBackup: (target: unknown) => Promise<{ success: boolean; message: string }> }).destroyRetainedBackup(target),
  },
});


// Synthetic provider: these tests exercise generic inspection and ownership rules,
// independently of the retired cloud cache implementation.
class FixtureCacheAdapter {
  async connect(_credentials: unknown): Promise<void> {}
  async disconnect(): Promise<void> {}
  async inspectCacheResources(_request: unknown): Promise<Record<string, unknown>> { return {}; }
}
providerRegistry.register({
  metadata: {
    name: 'fixture-cache', displayName: 'Fixture cache', category: 'cache',
    credentialsSchema: z.object({ projectId: z.string(), credentials: z.string() }),
    connectionAliases: ['cloudrun'],
    lifecycle: { cacheEngines: ['redis'], cacheConnectivity: { compatibleHostingProviders: ['railway'] } },
    maturity: { lifecycle: { cache: { status: 'ready-for-live', reason: 'Synthetic test provider.' } } },
  },
  factory: async credentials => { const adapter = new FixtureCacheAdapter(); await adapter.connect(credentials); return adapter; },
  inspection: {
    resources: ['cache'], defaultResource: 'cache',
    selectors: { cache: { mode: 'provider-resource', optional: ['project', 'scope', 'id', 'name', 'region', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId', 'region'] } },
    inspect: (adapter, request) => (adapter as FixtureCacheAdapter).inspectCacheResources(request),
  },
});

describe('retained datastore import active-binding safety', () => {
  let ctx: CommandContext;
  let project: Project;
  let targetEnvironment: Environment;
  let siblingEnvironment: Environment;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-retained-import-binding-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    project = ctx.repos.projects.create({
      name: 'retained-import-binding-safety',
      defaultPlatform: 'railway',
    });
    targetEnvironment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway' },
    });
    siblingEnvironment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  function createVerifiedConnection(provider: string) {
    const connections = new ConnectionRepository();
    const connection = connections.create({
      provider,
      credentialsEncrypted: getSecretStore().encryptObject({
        projectId: 'gcp-project',
        credentials: '{}',
      }),
    });
    connections.updateStatus(connection.id, 'verified');
  }

  it('rejects a retained database identity actively bound in another project environment', async () => {
    const externalId = 'shared-production-database';
    const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
    const otherProject = ctx.repos.projects.create({
      name: 'other-local-project',
      defaultPlatform: 'cloudrun',
    });
    const activeEnvironment = ctx.repos.environments.create({
      projectId: otherProject.id,
      name: 'production',
      platformBindings: { provider: 'cloudrun' },
    });
    ctx.repos.components.create({
      environmentId: activeEnvironment.id,
      type: 'postgres',
      externalId,
      bindings: { provider: 'fixture-database', instanceId: externalId, providerScope },
    });
    createVerifiedConnection('fixture-database');
    vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: externalId,
        name: externalId,
        engine: 'postgres',
        providerScope,
      }],
      truncated: false,
      partial: false,
    });

    const result = await importProvider(ctx, {
      provider: 'fixture-database',
      mode: 'retained-database-cleanup',
      project: project.name,
      env: targetEnvironment.name,
      id: externalId,
      confirm: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousDatabase)
      .toBeUndefined();
    expect(ctx.repos.components.findByEnvironmentId(activeEnvironment.id)).toEqual([
      expect.objectContaining({ externalId, bindings: expect.objectContaining({ providerScope }) }),
    ]);
  });

  it('rejects a retained cache identity actively bound in another project environment', async () => {
    const externalId = 'projects/gcp-project/locations/us-west1/instances/shared-cache';
    const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
    ctx.repos.components.create({
      environmentId: siblingEnvironment.id,
      type: 'redis',
      externalId,
      bindings: { provider: 'fixture-cache', instanceId: externalId, providerScope },
    });
    createVerifiedConnection('fixture-cache');
    vi.spyOn(FixtureCacheAdapter.prototype, 'connect').mockResolvedValue();
    vi.spyOn(FixtureCacheAdapter.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(FixtureCacheAdapter.prototype, 'inspectCacheResources').mockResolvedValue({
      observation: 'present',
      resource: 'cache',
      caches: [{
        id: externalId,
        name: 'shared-cache',
        engine: 'redis',
        providerScope,
      }],
      truncated: false,
      partial: false,
    });

    const result = await importProvider(ctx, {
      provider: 'fixture-cache',
      mode: 'retained-cache-cleanup',
      project: project.name,
      env: targetEnvironment.name,
      id: externalId,
      confirm: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousCache)
      .toBeUndefined();
    expect(ctx.repos.components.findByEnvironmentId(siblingEnvironment.id)).toEqual([
      expect.objectContaining({ externalId, bindings: expect.objectContaining({ providerScope }) }),
    ]);
  });

  it.each(['instanceId', 'serviceId'] as const)(
    'rejects a retained database when stale externalId conflicts with a matching bindings.%s',
    async (bindingKey) => {
      const externalId = 'shared-production-database';
      const providerScope = { projectId: 'gcp-project', region: 'us-west1' };
      const active = ctx.repos.components.create({
        environmentId: siblingEnvironment.id,
        type: 'postgres',
        externalId: 'stale-local-database-id',
        bindings: {
          provider: 'fixture-database',
          [bindingKey]: externalId,
          providerScope,
        },
      });
      createVerifiedConnection('fixture-database');
      vi.spyOn(CloudSqlAdapter.prototype, 'connect').mockResolvedValue();
      vi.spyOn(CloudSqlAdapter.prototype, 'disconnect').mockResolvedValue();
      vi.spyOn(CloudSqlAdapter.prototype, 'inspectDatabaseResources').mockResolvedValue({
        observation: 'present',
        resource: 'database',
        databases: [{
          id: externalId,
          name: externalId,
          engine: 'postgres',
          providerScope,
        }],
        truncated: false,
        partial: false,
      });

      const result = await importProvider(ctx, {
        provider: 'fixture-database',
        mode: 'retained-database-cleanup',
        project: project.name,
        env: targetEnvironment.name,
        id: externalId,
        confirm: true,
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(ctx.repos.environments.findById(targetEnvironment.id)?.platformBindings.previousDatabase)
        .toBeUndefined();
      expect(ctx.repos.components.findById(active.id)).toMatchObject({
        externalId: 'stale-local-database-id',
        bindings: expect.objectContaining({ [bindingKey]: externalId, providerScope }),
      });
    }
  );
});
