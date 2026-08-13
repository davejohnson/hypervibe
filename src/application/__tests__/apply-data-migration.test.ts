import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { createCommandContext } from '../context.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import type { DatabaseAccessLease } from '../../domain/services/database-access.service.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';

vi.mock('../../domain/services/database-access.service.js', async (original) => {
  const actual = await original<typeof import('../../domain/services/database-access.service.js')>();
  return {
    ...actual,
    acquireManagedDatabaseAccess: vi.fn(),
    acquireDatabaseComponentAccess: vi.fn(),
  };
});

vi.mock('../../domain/services/postgres-transfer.service.js', async (original) => {
  const actual = await original<typeof import('../../domain/services/postgres-transfer.service.js')>();
  return { ...actual, transferPostgresDatabase: vi.fn() };
});

import {
  acquireDatabaseComponentAccess,
  acquireManagedDatabaseAccess,
} from '../../domain/services/database-access.service.js';
import { transferPostgresDatabase } from '../../domain/services/postgres-transfer.service.js';
import { applyDataMigrationAction } from '../apply-data-migration.js';

function lease(url: string): DatabaseAccessLease {
  return {
    id: `lease:${url}`,
    provider: 'database',
    mode: 'existing',
    createdByInvocation: false,
    withConnection: (operation) => operation(url),
    release: vi.fn(async () => ({ status: 'no_op' as const })),
  };
}

describe('applyDataMigrationAction database copy', () => {
  beforeEach(() => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-data-migration-')), 'test.db')).migrate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(acquireManagedDatabaseAccess).mockReset();
    vi.mocked(acquireDatabaseComponentAccess).mockReset();
    vi.mocked(transferPostgresDatabase).mockReset();
  });

  function setup() {
    const project = new ProjectRepository().create({ name: 'migration-apply', defaultPlatform: 'railway' });
    const sourceEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
    const targetEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
    const source = new ComponentRepository().create({
      environmentId: sourceEnvironment.id,
      type: 'postgres',
      bindings: { provider: 'railway', instanceId: 'source-db' },
      externalId: 'source-db',
    });
    const target = new ComponentRepository().create({
      environmentId: targetEnvironment.id,
      type: 'postgres',
      bindings: { provider: 'rds', instanceId: 'old-production-db', connectionString: 'postgres://old' },
      externalId: 'old-production-db',
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        staging: {
          hosting: { provider: 'railway' }, services: { web: {} },
          database: { provider: 'railway', engine: 'postgres' },
        },
        production: {
          hosting: { provider: 'railway' }, services: { web: {} },
          database: { provider: 'rds', engine: 'postgres' },
          dataMigration: {
            id: 'initial-launch', fromEnvironment: 'staging',
            include: { database: true, storage: [] },
          },
        },
      },
    });
    const action: PlanAction = {
      id: 'data-migration:initial-launch:database',
      type: 'update',
      resource: { kind: 'database', name: 'postgres', provider: 'rds' },
      verified: true,
      reason: 'copy',
      dataBearing: true,
      billable: true,
      requiresConfirm: true,
      metadata: {
        operation: 'dataMigrationDatabaseCopy',
        migrationId: 'initial-launch',
        sourceEnvironment: 'staging',
        targetEnvironment: 'production',
        sourceProvider: 'railway',
        targetProvider: 'rds',
        sourceComponentId: source.id,
        sourceExternalId: source.externalId,
        engine: 'postgres',
      },
    };
    return { project, sourceEnvironment, targetEnvironment, source, target, spec, action };
  }

  function adapter() {
    return {
      name: 'rds',
      capabilities: {
        supportedDatabases: ['postgres'], supportsPooling: false, supportsReadReplicas: true,
        supportsPointInTimeRecovery: true, serverlessOptimized: false,
      },
      connect: vi.fn(),
      verify: vi.fn(),
      provision: vi.fn(async (_type, environment) => ({
        component: {
          id: 'provider-candidate', environmentId: environment.id, type: 'postgres',
          bindings: { provider: 'rds', instanceId: 'new-production-db', connectionString: 'postgres://new' },
          externalId: 'new-production-db', createdAt: new Date(), updatedAt: new Date(),
        },
        receipt: { success: true, message: 'provisioned' },
      })),
      observeDatabase: vi.fn(),
      getConnectionUrl: vi.fn(),
      destroy: vi.fn(async () => ({ success: true, message: 'destroyed' })),
    } satisfies IDatabaseAdapter;
  }

  it('switches the binding only after verification and retains the old target', async () => {
    const fixture = setup();
    const targetAdapter = adapter();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: targetAdapter });
    vi.mocked(acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease: lease('postgres://source') });
    vi.mocked(acquireDatabaseComponentAccess).mockResolvedValue({ ok: true, lease: lease('postgres://target') });
    vi.mocked(transferPostgresDatabase).mockResolvedValue({
      manifest: { sourceVersion: '160004', extensions: ['plpgsql'], tables: [{ schema: 'public', table: 'users', rows: '12' }], totalRows: '12', dumpBytes: 4096 },
      targetVersion: '160004',
    });

    const result = await applyDataMigrationAction({
      ctx: createCommandContext(), project: fixture.project, spec: fixture.spec,
      targetEnvironmentName: 'production', action: fixture.action,
    });

    expect(result).toMatchObject({ success: true, data: { tableCount: 1, totalRows: '12', dumpBytes: 4096 } });
    const active = new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'postgres')!;
    expect(active.externalId).toBe('new-production-db');
    expect(active.bindings).toMatchObject({
      dataMigration: { id: 'initial-launch', fromEnvironment: 'staging', totalRows: '12' },
      dataMigrationPreviousTarget: { provider: 'rds', externalId: 'old-production-db' },
    });
    expect(new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'data-migration:initial-launch:postgres')).toBeNull();
    expect(targetAdapter.destroy).not.toHaveBeenCalled();
  });

  it('keeps the old binding active and removes a failed fresh target', async () => {
    const fixture = setup();
    const targetAdapter = adapter();
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: targetAdapter });
    vi.mocked(acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease: lease('postgres://source') });
    vi.mocked(acquireDatabaseComponentAccess).mockResolvedValue({ ok: true, lease: lease('postgres://target') });
    vi.mocked(transferPostgresDatabase).mockRejectedValue(new Error('verification mismatch'));

    const result = await applyDataMigrationAction({
      ctx: createCommandContext(), project: fixture.project, spec: fixture.spec,
      targetEnvironmentName: 'production', action: fixture.action,
    });

    expect(result).toMatchObject({ success: false, message: 'Database snapshot transfer or verification failed' });
    const active = new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'postgres')!;
    expect(active.externalId).toBe('old-production-db');
    expect(active.bindings.dataMigration).toBeUndefined();
    expect(targetAdapter.destroy).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'new-production-db' }));
    expect(new ComponentRepository().findByEnvironmentAndType(fixture.targetEnvironment.id, 'data-migration:initial-launch:postgres')).toBeNull();
  });
});
