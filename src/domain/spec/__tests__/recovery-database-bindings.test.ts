import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { runWithWorkspaceDirectories } from '../../../lib/workspace-context.js';
import { mergeRepoPlatformBindings, readRepoBindingsFile, writeRepoBindingsForEnvironment } from '../repo-bindings-file.js';
import { projectRecoveryDatabases, recoveryDatabaseBindings } from '../../services/recovery-database-bindings.js';
import type { Component } from '../../entities/component.entity.js';

const roots: string[] = [];
afterEach(() => { SqliteAdapter.resetInstance(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(managed: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'hv-recovery-db-export-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
  mkdirSync(path.join(root, '.hypervibe'));
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ version: 1, project: 'app', runtime: { kind: 'node', version: '24' },
    environments: { production: { hosting: { provider: 'railway' }, services: {},
      ...(managed ? { backups: { mode: 'daily', runnerImage: `ghcr.io/owner/helper@sha256:${'a'.repeat(64)}` } } : {}) } } }));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(root, 'test-state.db'));
  return root;
}

describe('portable non-secret database recovery bindings', () => {
  it.each([false, true])('exports fresh component create, replacement and deletion only for a managed program: %s', async managed => {
    const root = workspace(managed);
    await runWithWorkspaceDirectories([root], async () => {
      const project = new ProjectRepository().create({ name: 'app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: 'railway' });
      const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production',
        platformBindings: { provider: 'railway', projectId: 'provider-project', environmentId: 'provider-env' } });
      const repository = new ComponentRepository();
      const component = repository.create({ environmentId: environment.id, type: 'postgres', externalId: 'database-original',
        bindings: { provider: 'railway', password: 'must-not-export', connectionString: 'postgres://must-not-export' } });
      const read = () => readRepoBindingsFile('app', root)!.document.environments.production.platformBindings.recoveryDatabases;
      expect(read()).toEqual(managed ? [{ componentId: component.id, provider: 'railway', engine: 'postgres', externalId: 'database-original' }] : undefined);
      repository.update(component.id, { externalId: 'database-replacement' });
      expect(read()).toEqual(managed ? [{ componentId: component.id, provider: 'railway', engine: 'postgres', externalId: 'database-replacement' }] : undefined);
      repository.updateBindings(component.id, { provider: 'cloudsql' });
      expect(read()).toEqual(managed ? [{ componentId: component.id, provider: 'cloudsql', engine: 'postgres', externalId: 'database-replacement' }] : undefined);
      expect(readFileSync(path.join(root, '.hypervibe/bindings.json'), 'utf8')).not.toContain('must-not-export');
      repository.delete(component.id);
      expect(read()).toEqual(managed ? [] : undefined);
      // Exporting unrelated legacy environments must not load encrypted components.
      if (!managed) {
        const load = vi.fn(() => { throw new Error('must not read'); });
        writeRepoBindingsForEnvironment(project, environment, root, load); expect(load).not.toHaveBeenCalled();
      }
    });
  });
  it('includes retained bound PostgreSQL components while excluding another environment and non-database components', () => {
    const base: Component = { id: 'retained-db', environmentId: 'env', type: 'postgres', externalId: 'old-db',
      bindings: { provider: 'railway', retired: true, password: 'secret' }, createdAt: new Date(), updatedAt: new Date() };
    expect(projectRecoveryDatabases([base, { ...base, id: 'foreign', environmentId: 'different' },
      { ...base, id: 'cache', type: 'redis' }, { ...base, id: 'unbound', externalId: null }], 'env'))
      .toEqual([{ componentId: 'retained-db', provider: 'railway', engine: 'postgres', externalId: 'old-db' }]);
  });
  it('exports the actual native resource kind without inferring one or exporting other component fields', async () => {
    const root = workspace(true);
    await runWithWorkspaceDirectories([root], async () => {
      const project = new ProjectRepository().create({ name: 'app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: 'railway' });
      const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production',
        platformBindings: { provider: 'railway', projectId: 'provider-project', environmentId: 'provider-env' } });
      const component = new ComponentRepository().create({ environmentId: environment.id, type: 'postgres', externalId: 'native-db',
        bindings: { provider: 'railway', resourceKind: 'service', password: 'must-not-export' } });
      const exported = readRepoBindingsFile('app', root)!.document.environments.production.platformBindings;
      const expected = [{ componentId: component.id, provider: 'railway', engine: 'postgres', externalId: 'native-db', resourceKind: 'service' }];
      expect(exported.recoveryDatabases).toEqual(expected);
      expect(mergeRepoPlatformBindings({}, exported).recoveryDatabases).toEqual(expected);
      expect(readFileSync(path.join(root, '.hypervibe/bindings.json'), 'utf8')).not.toContain('must-not-export');
    });
  });
  it.each([null, {}, [{ componentId: 'id', provider: 'railway', engine: 'postgres', externalId: 'postgres://secret' }],
    [{ componentId: 'id', provider: 'railway', engine: 'postgres', externalId: 'db', resourceKind: 'postgres://secret' }],
    [{ componentId: 'id', provider: 'railway', engine: 'postgres', externalId: 'db', password: 'secret' }]])(
    'rejects malformed portable identities before sanitizer/import: %j', value => {
      expect(() => recoveryDatabaseBindings(value)).toThrow(/recovery database/i);
      expect(() => mergeRepoPlatformBindings({}, { recoveryDatabases: value })).toThrow(/recovery database/i);
    });
});
