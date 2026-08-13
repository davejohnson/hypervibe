import { describe, expect, it } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import type { Environment } from '../../entities/environment.entity.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  DATA_MIGRATION_OPERATIONS,
  planDataMigration,
} from '../data-migration-plan.service.js';

const now = new Date('2026-08-12T00:00:00Z');

function environment(id: string, name: string, platformBindings: Record<string, unknown> = {}): Environment {
  return { id, projectId: 'project', name, platformBindings, createdAt: now, updatedAt: now };
}

function component(id: string, environmentId: string, bindings: Record<string, unknown>): Component {
  return { id, environmentId, type: 'postgres', bindings, externalId: `${id}-external`, createdAt: now, updatedAt: now };
}

function fixture() {
  const spec = projectSpecSchema.parse({
    version: 1,
    project: 'migration-test',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: {} },
        database: { provider: 'railway', engine: 'postgres' },
        storage: {
          documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['web'] },
        },
      },
      production: {
        hosting: { provider: 'ecs' },
        services: { web: {} },
        database: { provider: 'rds', engine: 'postgres' },
        storage: {
          documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['web'] },
        },
        dataMigration: {
          id: 'initial-launch',
          fromEnvironment: 'staging',
          include: { database: true, storage: ['documents'] },
        },
      },
    },
  });
  const sourceEnvironment = environment('source', 'staging', {
    storage: {
      documents: { provider: 'railway', externalId: 'source-bucket', region: 'sjc', services: ['web'], envKeys: [] },
    },
    storageProviders: { railway: { projectId: 'railway-project', environmentId: 'staging-env' } },
  });
  return { spec, sourceEnvironment };
}

describe('planDataMigration', () => {
  it('plans only explicit database and storage copies with confirmation', () => {
    const { spec, sourceEnvironment } = fixture();
    const result = planDataMigration({
      targetEnvironmentName: 'production',
      targetSpec: spec.environments.production,
      targetEnvironment: environment('target', 'production'),
      targetComponents: [],
      sourceSpec: spec.environments.staging,
      sourceEnvironment,
      sourceComponents: [component('source-db', 'source', { provider: 'railway' })],
    });

    expect(result.pending).toBe(true);
    expect(result.providers).toEqual(['railway', 'rds']);
    expect(result.actions).toHaveLength(2);
    expect(result.actions.map((action) => action.metadata?.operation)).toEqual([
      DATA_MIGRATION_OPERATIONS.databaseCopy,
      DATA_MIGRATION_OPERATIONS.storageCopy,
    ]);
    expect(result.actions.every((action) => action.dataBearing && action.requiresConfirm)).toBe(true);
  });

  it('is a no-op for an already completed one-use migration id', () => {
    const { spec, sourceEnvironment } = fixture();
    const targetEnvironment = environment('target', 'production', {
      storage: {
        documents: {
          provider: 'railway', externalId: 'target-bucket', region: 'iad', services: [], envKeys: [],
          dataMigration: { id: 'initial-launch', fromEnvironment: 'staging', completedAt: now.toISOString() },
        },
      },
    });
    const result = planDataMigration({
      targetEnvironmentName: 'production',
      targetSpec: spec.environments.production,
      targetEnvironment,
      targetComponents: [component('target-db', 'target', {
        provider: 'rds',
        dataMigration: { id: 'initial-launch', fromEnvironment: 'staging', completedAt: now.toISOString() },
      })],
      sourceSpec: spec.environments.staging,
      sourceEnvironment,
      sourceComponents: [component('source-db', 'source', { provider: 'railway' })],
    });

    expect(result.pending).toBe(false);
    expect(result.actions.every((action) => action.type === 'noop')).toBe(true);
    expect(result.actions.every((action) => !action.requiresConfirm)).toBe(true);
  });

  it('blocks instead of guessing when a source binding is absent', () => {
    const { spec, sourceEnvironment } = fixture();
    const result = planDataMigration({
      targetEnvironmentName: 'production',
      targetSpec: spec.environments.production,
      targetEnvironment: environment('target', 'production'),
      targetComponents: [],
      sourceSpec: spec.environments.staging,
      sourceEnvironment,
      sourceComponents: [],
    });

    expect(result.actions.find((action) => action.resource.kind === 'database')?.metadata?.blockedReason)
      .toBe('source_database_not_tracked');
  });
});
