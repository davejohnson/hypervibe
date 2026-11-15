import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import '../../../adapters/providers/aws/rds.adapter.js';
import type { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import type { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../../entities/project.entity.js';
import type { ProviderDatabaseRestoreDrillMetadata } from '../../ports/database-restore-drill.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
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
  const metadata = providerRegistry.getMetadata('cloudsql')!;
  const originalOrchestration = metadata.orchestration;
  beforeEach(() => {
    // Synthetic compiler contract only; no real provider currently implements
    // engine-owned restore drills. Retain shared identity-boundary coverage.
    metadata.orchestration = { ...originalOrchestration, databaseRestoreDrill: {
      resolveSource: ({ component }) => typeof component.bindings.database !== 'string'
        ? { status: 'binding_missing', message: 'A database identity is required.' }
        : { status: 'resolved', databaseName: component.bindings.database, source: {
          provider: 'cloudsql', primaryExternalId: component.externalId!,
          providerScope: { projectId: 'gcp-project', region: 'us-central1' }, resourceIdentity: {},
        } },
      buildWorkflow: (target) => ({ files: [{ path: 'contract-fixture.json', content: JSON.stringify(target), review: { title: 'Contract fixture', summary: 'No provider operation' } }], requiredSecrets: [] }),
    } };
  });
  afterEach(() => { metadata.orchestration = originalOrchestration; });

  it('resolves the exact bound primary through a synthetic provider contract', () => {
    const result = compileDatabaseRestoreDrillFiles({ project, spec, ...repos() });
    expect(result.issues).toEqual([]);
    expect(result.requiredSecrets).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['contract-fixture.json']);
    expect(JSON.parse(result.files[0].content).source.primaryExternalId).toBe('production-postgres');
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
        message: 'A database identity is required.',
      }),
    ]);
  });

  it('compiles an RDS identity without a Cloud SQL connection name through a registered contract fixture', () => {
    // Contract fixture only: this is NOT implemented RDS restore-drill support.
    // Independent identity evidence: AWS RestoreDBInstanceFromDBSnapshot identifies
    // snapshots and instance names, not a Cloud SQL project:region:instance string.
    // https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_RestoreDBInstanceFromDBSnapshot.html
    const source = {
      provider: 'rds',
      primaryExternalId: 'production-postgres',
      providerScope: { accountId: '123456789012', region: 'us-west-2' },
      resourceIdentity: {},
    };
    const resolveSource = vi.fn<ProviderDatabaseRestoreDrillMetadata['resolveSource']>(() => ({ status: 'resolved', source, databaseName: 'app' }));
    const buildWorkflow = vi.fn((target: unknown) => ({
      files: [{ path: 'contract-fixture.json', content: JSON.stringify(target), review: { title: 'Contract fixture', summary: 'No provider operation' } }],
      requiredSecrets: [],
    }));
    const metadata = providerRegistry.getMetadata('rds')!;
    const original = metadata.orchestration;
    metadata.orchestration = {
      ...original,
      databaseRestoreDrill: { resolveSource, buildWorkflow },
    };
    const rdsComponent = {
      ...component,
      bindings: { provider: 'rds', database: 'app', providerScope: source.providerScope, password: 'secret-sentinel' },
    };
    const rdsSpec = structuredClone(spec);
    rdsSpec.environments.production.database!.provider = 'rds';
    try {
      const result = compileDatabaseRestoreDrillFiles({ project, spec: rdsSpec, ...repos(rdsComponent) });
      expect(result.issues).toEqual([]);
      expect(resolveSource).toHaveBeenCalledWith({ environment, component: rdsComponent });
      expect(buildWorkflow).toHaveBeenCalledWith(expect.objectContaining({ source, databaseName: 'app' }));
      expect(result.files).toHaveLength(1);
      expect(result.files[0].content).not.toMatch(/secret-sentinel|connectionName|sourceInstanceId/);
    } finally {
      metadata.orchestration = original;
    }
  });

  it('rejects a component from another environment even when its provider identity is valid', () => {
    const result = compileDatabaseRestoreDrillFiles({
      project, spec, ...repos({ ...component, environmentId: 'other-environment' }),
    });
    expect(result.files).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'database_restore_drill_binding_missing' }),
    ]);
  });

  it.each([
    { provider: 'rds' },
    { primaryExternalId: 'different-primary' },
    { resourceIdentity: { password: 'secret-sentinel' } },
    { providerScope: {} },
  ])('rejects invalid provider-resolved identity without compiling or leaking bindings %j', (identity) => {
    const compiler = providerRegistry.getMetadata('cloudsql')!.orchestration!.databaseRestoreDrill!;
    const resolveSource = vi.spyOn(compiler, 'resolveSource').mockReturnValue({
      status: 'resolved',
      databaseName: 'app',
      source: {
        provider: 'cloudsql', primaryExternalId: 'production-postgres',
        providerScope: { projectId: 'gcp-project', region: 'us-central1' },
        resourceIdentity: {}, ...identity,
      },
    });
    const buildWorkflow = vi.spyOn(compiler, 'buildWorkflow');
    try {
      const result = compileDatabaseRestoreDrillFiles({ project, spec, ...repos() });
      expect(result.files).toHaveLength(0);
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'database_restore_drill_identity_invalid' }),
      ]);
      expect(buildWorkflow).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('secret-sentinel');
    } finally {
      resolveSource.mockRestore();
      buildWorkflow.mockRestore();
    }
  });
});
