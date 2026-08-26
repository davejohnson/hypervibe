import { describe, expect, it } from 'vitest';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import type { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import type { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../../entities/project.entity.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileDatabaseRestoreDrillFiles } from '../database-restore-drill.service.js';

const project = {
  id: 'project-1',
  name: 'restore-drill',
  gitRemoteUrl: 'https://github.com/owner/restore-drill.git',
} as Project;

const spec = projectSpecSchema.parse({
  version: 1,
  project: 'restore-drill',
  github: {},
  environments: {
    production: {
      hosting: { provider: 'cloudrun' },
      services: { web: {} },
      database: {
        provider: 'cloudsql',
        resilience: {
          backups: { retainedBackups: 8, pitrRetentionDays: 7 },
          restoreDrill: { schedule: { cron: '0 4 * * 1' }, verificationQuery: 'SELECT count(*) FROM users' },
        },
      },
    },
  },
});

const now = new Date();
const environment = {
  id: 'environment-1', projectId: project.id, name: 'production', platformBindings: {}, createdAt: now, updatedAt: now,
};
const component = {
  id: 'component-1',
  environmentId: environment.id,
  type: 'postgres' as const,
  externalId: 'production-postgres',
  bindings: {
    provider: 'cloudsql',
    instanceId: 'production-postgres',
    connectionName: 'gcp-project:us-central1:production-postgres',
    database: 'app',
  },
  createdAt: now,
  updatedAt: now,
};

function repos(componentValue: unknown = component) {
  return {
    environmentRepo: {
      findByProjectAndName: () => environment,
    } as unknown as EnvironmentRepository,
    componentRepo: {
      findByEnvironmentAndType: () => componentValue,
    } as unknown as ComponentRepository,
  };
}

describe('database restore-drill compiler', () => {
  it('resolves the exact bound primary through provider metadata', () => {
    const result = compileDatabaseRestoreDrillFiles({ project, spec, ...repos() });

    expect(result.issues).toEqual([]);
    expect(result.requiredSecrets).toEqual(['HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS']);
    expect(result.files.map((file) => file.path)).toEqual([
      '.github/hypervibe/cloudsql-restore-drill.mjs',
      '.github/workflows/hypervibe-db-restore-drill-production.yml',
    ]);
    const workflow = result.files.find((file) => file.path.endsWith('.yml'))?.content ?? '';
    expect(workflow).toContain('HYPERVIBE_DRILL_CONFIG_B64');
    expect(workflow).not.toContain('SELECT count(*) FROM users');
  });

  it('fails closed when the durable primary binding is unavailable', () => {
    const result = compileDatabaseRestoreDrillFiles({ project, spec, ...repos(null) });

    expect(result.files).toEqual([]);
    expect(result.requiredSecrets).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'database_restore_drill_binding_missing', environmentName: 'production' }),
    ]);
  });

  it('refuses to guess a database name for a data-bearing restore', () => {
    const { database: _database, ...bindings } = component.bindings;
    const result = compileDatabaseRestoreDrillFiles({
      project,
      spec,
      ...repos({ ...component, bindings }),
    });

    expect(result.files).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'database_restore_drill_binding_missing',
        message: expect.stringContaining('exact connection and database identities'),
      }),
    ]);
  });
});
