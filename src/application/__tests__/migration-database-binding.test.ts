import { describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { migrationDatabaseBindingConflict, migrationDatabaseComponentBindingConflict } from '../migration-database-binding.js';
import type { CommandContext } from '../context.js';
import type { Component } from '../../domain/entities/component.entity.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Project } from '../../domain/entities/project.entity.js';
import type { ProjectSpec } from '../../domain/spec/spec.schema.js';

const project = { id: 'project', name: 'fixture' } as Project;
const azureId = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/Databases/providers/Microsoft.DBforPostgreSQL/flexibleServers/App';
function fixture(provider: string, scope: Record<string, string>, externalId = 'database') {
  const source = { id: 'source', name: 'source', projectId: project.id, platformBindings: {} } as Environment;
  const target: Environment = { ...source, id: 'target', name: 'target', platformBindings: {} };
  const components: Component[] = [source, target].map(environment => ({ id: `${environment.id}-db`, environmentId: environment.id,
    type: 'postgres', externalId, bindings: { provider, providerScope: { ...scope } },
    createdAt: new Date(0), updatedAt: new Date(0) } satisfies Component));
  const ctx = { repos: { components: { findByEnvironmentId: vi.fn((id: string) => components.filter(component => component.environmentId === id)) } } } as unknown as CommandContext;
  const spec = { environments: { source: { database: { provider } }, target: { database: { provider } } } } as unknown as ProjectSpec;
  return { source, target, components, ctx, spec, check: () => migrationDatabaseBindingConflict(ctx, project, spec, source, target) };
}

describe('persisted migration database identity veto', () => {
  it.each([
    ['railway', { projectId: 'railway-project', environmentId: 'railway-environment' }, 'service'],
    ['cloudsql', { projectId: 'gcp-project' }, 'instance'],
    ['rds', { accountId: '123456789012', region: 'us-east-1' }, 'instance'],
    ['azure-postgres', { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'Databases' }, azureId],
  ] as const)('vetoes the same complete %s native instance despite separate environments and credentials', (provider, scope, id) => {
    const f = fixture(provider, scope, id);
    Object.assign(f.components[0]!.bindings, { database: 'first', username: 'first', password: 'never-print-source' });
    Object.assign(f.components[1]!.bindings, { database: 'second', username: 'second', password: 'never-print-target' });
    expect(f.check()).toMatch(/same database instance/);
    expect(f.check()).not.toContain('never-print');
  });

  it.each([
    ['railway', { projectId: 'project', environmentId: 'one' }, 'environmentId', 'two'],
    ['cloudsql', { projectId: 'one' }, 'projectId', 'two'],
    ['rds', { accountId: '123456789012', region: 'us-east-1' }, 'region', 'us-west-2'],
  ] as const)('does not equate %s identifiers in different native scopes', (provider, scope, key, value) => {
    const f = fixture(provider, scope);
    (f.components[1]!.bindings.providerScope as Record<string, string>)[key] = value;
    expect(f.check()).toBeUndefined();
    expect(migrationDatabaseComponentBindingConflict({ environment: f.source, component: f.components[0]! },
      { environment: f.target, component: f.components[1]! })).toBeUndefined();
  });

  it('canonicalizes Azure ARM casing and keeps different subscriptions separate', () => {
    const f = fixture('azure-postgres', {}, azureId);
    f.components[1]!.externalId = azureId.toUpperCase();
    expect(f.check()).toMatch(/same database instance/);
    f.components[1]!.externalId = azureId.replaceAll('11111111', '22222222');
    expect(f.check()).toBeUndefined();
  });

  it('compares an RDS ARN with its scoped, case-insensitive instance identifier', () => {
    const f = fixture('rds', { accountId: '123456789012', region: 'us-east-1' }, 'APP');
    f.components[1]!.externalId = 'arn:aws:rds:us-east-1:123456789012:db:app';
    expect(f.check()).toMatch(/same database instance/);
  });

  it('compares GCP engine and legacy component identities without using desired names', () => {
    const f = fixture('cloudsql', { projectId: 'gcp-project' }, 'actual-instance');
    f.components.splice(1);
    f.target.platformBindings = { provider: 'cloudrun', projectId: 'gcp-project', engine: { kind: 'opentofu', database: { instanceName: 'actual-instance' } } };
    expect(f.check()).toMatch(/same database instance/);
    f.target.platformBindings.projectId = 'other-project';
    expect(f.check()).toBeUndefined();
  });

  it('does not use a shared identifier, host or password without complete native scope', () => {
    const f = fixture('rds', {}, 'same-name');
    f.components.forEach(component => Object.assign(component.bindings, { host: 'same-host', password: 'same-password' }));
    expect(f.check()).toBeUndefined();
    expect(migrationDatabaseBindingConflict(f.ctx, project, f.spec, f.source, undefined)).toBeUndefined();
  });

  it('does not invent AWS cluster identity from a login timestamp or generated name', () => {
    const f = fixture('rds', {});
    f.components.length = 0;
    f.source.platformBindings = { aws: { kind: 'opentofu', databaseLoginAt: '2026-11-13' } };
    f.target.platformBindings = { ...f.source.platformBindings };
    expect(f.check()).toBeUndefined();
  });

  it('rejects a desired provider that contradicts persisted native identity', () => {
    const f = fixture('cloudsql', { projectId: 'one' });
    f.spec.environments.source!.database!.provider = 'rds';
    expect(f.check()).toMatch(/identities conflict/);
  });

  it.each([null, [], 'never-print-secret'])('handles malformed provider scope without throwing or exposing it', providerScope => {
    const f = fixture('railway', { projectId: 'one', environmentId: 'one' });
    f.components[0]!.bindings.providerScope = providerScope;
    expect(f.check()).toMatch(/identities conflict/);
    expect(f.check()).not.toContain('never-print-secret');
  });

  it('rejects contradictory scope, duplicate components and engine/component identities', () => {
    const f = fixture('cloudsql', { projectId: 'one' });
    f.components[0]!.bindings.projectId = 'other';
    expect(f.check()).toMatch(/identities conflict/);
    delete f.components[0]!.bindings.projectId;
    f.components.push({ ...f.components[0]!, id: 'ambiguous' });
    expect(f.check()).toMatch(/identities conflict/);
    f.components.pop();
    f.source.platformBindings = { projectId: 'one', engine: { database: { instanceName: 'other' } } };
    expect(f.check()).toMatch(/identities conflict/);
  });

  it('protects a candidate that aliases an active component or native instance', () => {
    const f = fixture('cloudsql', { projectId: 'one' });
    const source = { environment: f.source, component: f.components[0]! };
    const target = { environment: f.target, component: f.components[1]! };
    expect(migrationDatabaseComponentBindingConflict(source, target)).toMatch(/existing database instance/);
    f.components[1]!.bindings.providerScope = {};
    expect(migrationDatabaseComponentBindingConflict(source, target)).toMatch(/identities are incomplete.*preserved/);
    f.components[1]!.id = f.components[0]!.id;
    expect(migrationDatabaseComponentBindingConflict(source, target)).toMatch(/existing database component/);
  });

  it('permits distinct candidate instances in the same environment', () => {
    const f = fixture('cloudsql', { projectId: 'one' });
    const candidate = { ...f.components[0]!, id: 'new-component', externalId: 'new-instance' };
    expect(migrationDatabaseComponentBindingConflict({ environment: f.source, component: f.components[0]! },
      { environment: f.source, component: candidate })).toBeUndefined();
  });

  it.each([0, 1])('preserves a candidate when database %i has incomplete native scope', index => {
    const f = fixture('rds', { accountId: '123456789012', region: 'us-east-1' }, 'shared-database');
    f.components[index]!.bindings.providerScope = { accountId: '123456789012' };
    expect(migrationDatabaseComponentBindingConflict({ environment: f.source, component: f.components[0]! },
      { environment: f.target, component: f.components[1]! })).toMatch(/identities are incomplete.*preserved/);
    // The early setup check still leaves incomplete bindings unknown.
    expect(f.check()).toBeUndefined();
  });
});
