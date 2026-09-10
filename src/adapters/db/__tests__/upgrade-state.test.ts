import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../sqlite.adapter.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { EnvironmentRepository } from '../repositories/environment.repository.js';
import { ComponentRepository } from '../repositories/component.repository.js';
import { ServiceRepository } from '../repositories/service.repository.js';
import { RunRepository } from '../repositories/run.repository.js';
import { SpecStore } from '../../../domain/spec/spec.store.js';
import { diffEnvironment } from '../../../domain/plan/diff.engine.js';
import { ConvergeExecutor, fingerprintObservedState } from '../../../domain/plan/converge.executor.js';
import { resolveDevOpsSelection } from '../../../domain/spec/devops-selection.js';
import { environmentDeploymentContractHash } from '../../../domain/services/deployment-contract.service.js';
import type { ObservedState } from '../../../domain/ports/observe.port.js';

let directory: string;
let databasePath: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-upgrade-'));
  databasePath = path.join(directory, 'state.db');
  const old = new Database(databasePath);
  old.exec(readFileSync(new URL('./fixtures/schema-6.sql', import.meta.url), 'utf8'));
  old.prepare('INSERT INTO projects (id, name, default_platform, git_remote_url, policies) VALUES (?, ?, ?, ?, ?)').run(
    'project', 'upgrade-app', 'railway', 'https://github.com/example/upgrade-app.git', JSON.stringify({
      desiredState: {
        environmentName: 'production', services: ['web'], databaseProvider: 'railway',
        serviceConfig: { web: { startCommand: 'npm start', public: true } },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      },
    })
  );
  old.prepare('INSERT INTO environments (id, project_id, name, platform_bindings) VALUES (?, ?, ?, ?)').run(
    'environment', 'project', 'production', JSON.stringify({
      railwayProjectId: 'rail-project', railwayEnvironmentId: 'rail-env',
      services: { web: { serviceId: 'rail-web' } },
    })
  );
  old.prepare('INSERT INTO services (id, project_id, name, build_config) VALUES (?, ?, ?, ?)').run(
    'service', 'project', 'web', JSON.stringify({ startCommand: 'npm start', public: true })
  );
  old.prepare('INSERT INTO components (id, environment_id, type, external_id, bindings) VALUES (?, ?, ?, ?, ?)').run(
    'database', 'environment', 'postgres', 'rail-db', JSON.stringify({
      provider: 'railway', projectId: 'rail-project', environmentId: 'rail-env',
      password: 'synthetic-upgrade-fixture', resourceKind: 'service',
    })
  );
  old.close();
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function observed(): ObservedState {
  return {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'rail-project', environmentId: 'rail-env',
    services: [{
      name: 'web', externalId: 'rail-web', workloadKind: 'web', customDomains: [],
      config: { startCommand: 'npm start', public: true }, sourceState: 'disconnected',
      envVarKeys: [], envVarHashes: {}, status: 'running',
    }],
    databases: [{
      provider: 'railway', engine: 'postgres', externalId: 'rail-db', status: 'running',
      providerScope: { projectId: 'rail-project', environmentId: 'rail-env' },
    }],
    partial: false, warnings: [],
  };
}

it('migrates legacy bindings and plaintext data, reopens, and plans only noops for the same provider identities', () => {
  const adapter = initializeDatabase(databasePath);
  const encrypted = adapter.getDb().prepare('SELECT bindings FROM components WHERE id = ?').get('database') as { bindings: string };
  expect(JSON.parse(encrypted.bindings)).toHaveProperty('__encrypted');
  expect(encrypted.bindings).not.toContain('synthetic-upgrade-fixture');
  const project = new ProjectRepository().findById('project')!;
  const initial = new SpecStore().get(project)!;
  const releaseHash = environmentDeploymentContractHash(initial.spec, 'production');

  SqliteAdapter.resetInstance();
  initializeDatabase(databasePath);
  expect(SqliteAdapter.getInstance().migrate()).toEqual([]);
  const stored = new SpecStore().get(project)!;
  expect(stored.revision).toBe(initial.revision);
  expect(environmentDeploymentContractHash(stored.spec, 'production')).toBe(releaseHash);
  expect(resolveDevOpsSelection(stored.spec)).toMatchObject({
    source: 'legacy-github', code: { provider: 'github', scope: 'example/upgrade-app' },
    ci: { provider: 'github-actions' },
  });
  const environment = new EnvironmentRepository().findById('environment')!;
  expect(environment.platformBindings).toMatchObject({ provider: 'railway', projectId: 'rail-project', environmentId: 'rail-env' });
  expect(environment.platformBindings).not.toHaveProperty('railwayProjectId');
  const components = new ComponentRepository().findByEnvironmentId(environment.id);
  expect(components[0]).toMatchObject({ externalId: 'rail-db', bindings: { password: 'synthetic-upgrade-fixture' } });
  const result = diffEnvironment({
    spec: stored.spec.environments.production, envName: 'production', observed: observed(),
    local: {
      projectExists: true, environmentExists: true, components,
      services: new ServiceRepository().findByProjectId(project.id), bindings: environment.platformBindings,
    },
  });
  expect(result.actions.filter((action) => action.type !== 'noop')).toEqual([]);
  expect(result.unmanaged).toEqual([]);
});

it.each(['spec', 'masked-key'] as const)('rejects a persisted pre-upgrade plan after %s drift without invoking a mutation handler', async (drift) => {
  initializeDatabase(databasePath);
  const project = new ProjectRepository().findById('project')!;
  const initial = new SpecStore().get(project)!;
  const run = new RunRepository().create({
    projectId: project.id, environmentId: 'environment', type: 'plan',
    plan: {
      kind: 'hv_plan', environmentName: 'production', specRevision: initial.revision,
      observedFingerprint: fingerprintObservedState(observed()),
      actions: [{ id: 'service:web', type: 'update', verified: true, reason: 'saved configuration update',
        resource: { kind: 'service', name: 'web', provider: 'railway' } }],
    },
  });
  SqliteAdapter.resetInstance();
  initializeDatabase(databasePath);
  if (drift === 'spec') new SpecStore().merge(project, { runtime: { kind: 'node', version: '24' } });
  const fresh = observed();
  if (drift === 'masked-key') fresh.services[0].envVarKeys = ['EXTERNALLY_ADDED_SECRET'];
  const handler = vi.fn();
  const result = await new ConvergeExecutor().execute({
    planRunId: run.id, currentSpecRevision: new SpecStore().get(project)!.revision,
    freshObservedFingerprint: fingerprintObservedState(fresh), handler,
  });
  expect(result).toMatchObject({ success: false, receipts: [], error: expect.stringMatching(/changed.*plan/i) });
  expect(handler).not.toHaveBeenCalled();
});
