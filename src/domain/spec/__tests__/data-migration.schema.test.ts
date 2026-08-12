import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function project(targetMigration: Record<string, unknown>) {
  return {
    version: 1,
    project: 'portable-move',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        database: { provider: 'railway', engine: 'postgres' },
        storage: {
          documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['web'] },
        },
        services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
      },
      production: {
        hosting: { provider: 'ecs' },
        database: { provider: 'rds', engine: 'postgres' },
        storage: {
          documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['web'] },
        },
        services: { web: { workloadKind: 'web', startCommand: 'npm start' } },
        dataMigration: targetMigration,
      },
    },
  };
}

describe('dataMigration spec', () => {
  it('accepts one-use cross-provider database and storage migration intent', () => {
    const parsed = projectSpecSchema.parse(project({
      id: 'initial-production-launch',
      fromEnvironment: 'staging',
      include: { database: true, storage: ['documents'] },
    }));

    expect(parsed.environments.production.dataMigration).toEqual({
      id: 'initial-production-launch',
      fromEnvironment: 'staging',
      include: { database: true, storage: ['documents'] },
    });
  });

  it.each([
    [{ id: 'launch', fromEnvironment: 'production', include: { database: true } }, 'different environment'],
    [{ id: 'launch', fromEnvironment: 'missing', include: { database: true } }, 'unknown environment'],
    [{ id: 'launch', fromEnvironment: 'staging', include: {} }, 'must select'],
    [{ id: 'launch', fromEnvironment: 'staging', include: { storage: ['documents', 'documents'] } }, 'duplicate'],
    [{ id: 'launch', fromEnvironment: 'staging', include: { storage: ['photos'] } }, 'matching declarations'],
  ])('rejects unsafe or incomplete intent %#', (migration, message) => {
    const parsed = projectSpecSchema.safeParse(project(migration));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain(message);
    }
  });
});
