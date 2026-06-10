import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { SpecStore, desiredStateToSpec, deepMergeSpec } from '../spec.store.js';
import type { Project } from '../../entities/project.entity.js';

function freshDb() {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-spec-'));
  const adapter = SqliteAdapter.getInstance(path.join(dir, 'test.db'));
  adapter.migrate();
}

function makeProject(policies: Record<string, unknown> = {}): Project {
  return new ProjectRepository().create({
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    defaultPlatform: 'railway',
    policies,
  });
}

describe('desiredStateToSpec', () => {
  it('returns null when no legacy desired state exists', () => {
    expect(desiredStateToSpec({ policies: {} } as unknown as Project)).toBeNull();
  });

  it('converts a legacy desired state into a v1 spec', () => {
    const project = {
      name: 'myapp',
      defaultPlatform: 'railway',
      policies: {
        desiredState: {
          environmentName: 'production',
          services: ['api'],
          crons: { nightly: { schedule: '0 3 * * *', command: 'npm run nightly' } },
          domain: 'myapp.dev',
          databaseProvider: 'supabase',
          setupEmail: true,
          serviceConfig: { api: { startCommand: 'npm start', healthCheckPath: '/health', public: true } },
          envVars: { NODE_ENV: 'production' },
          deploy: { strategy: 'branch', branches: { production: 'main', staging: 'develop' } },
          migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
        },
      },
    } as unknown as Project;

    const spec = desiredStateToSpec(project)!;
    expect(spec.version).toBe(1);
    const env = spec.environments.production;
    expect(env.hosting.provider).toBe('railway');
    expect(env.services.api).toMatchObject({ workloadKind: 'web', startCommand: 'npm start', public: true });
    expect(env.services.nightly).toMatchObject({ workloadKind: 'cron', cronSchedule: '0 3 * * *', startCommand: 'npm run nightly' });
    expect(env.database).toEqual({ provider: 'supabase', engine: 'postgres' });
    expect(env.domain).toBe('myapp.dev');
    expect(env.email.enabled).toBe(true);
    expect(env.deploy).toEqual({ strategy: 'branch', branch: 'main' });
    expect(env.migrations).toMatchObject({ mode: 'releaseCommand', command: 'npm run migrate' });
  });
});

describe('deepMergeSpec', () => {
  it('merges objects recursively and replaces scalars', () => {
    const merged = deepMergeSpec(
      { a: { x: 1, y: 2 }, keep: true },
      { a: { y: 3 } }
    ) as Record<string, unknown>;
    expect(merged).toEqual({ a: { x: 1, y: 3 }, keep: true });
  });

  it('deletes keys set to null', () => {
    const merged = deepMergeSpec(
      { services: { api: { startCommand: 'x' }, worker: {} } },
      { services: { worker: null } }
    ) as { services: Record<string, unknown> };
    expect(Object.keys(merged.services)).toEqual(['api']);
  });
});

describe('SpecStore', () => {
  beforeEach(freshDb);

  it('returns null for a project with no spec or legacy state', () => {
    const store = new SpecStore();
    expect(store.get(makeProject())).toBeNull();
  });

  it('lazily converts legacy desiredState to revision 1', () => {
    const project = makeProject({
      desiredState: { environmentName: 'staging', services: ['api'], databaseProvider: 'railway' },
    });
    const store = new SpecStore();
    const result = store.get(project)!;
    expect(result.revision).toBe(1);
    expect(result.spec.environments.staging.database?.provider).toBe('railway');
    // Stable on re-read
    expect(store.get(project)!.revision).toBe(1);
  });

  it('bumps revision on replace and merge, and serves old revisions', () => {
    const project = makeProject();
    const store = new SpecStore();

    const v1 = store.replace(project, {
      version: 1,
      project: project.name,
      environments: { staging: { hosting: { provider: 'railway' }, services: { api: {} } } },
    });
    expect(v1.revision).toBe(1);

    const v2 = store.merge(project, {
      environments: { staging: { services: { worker: { workloadKind: 'worker' } } } },
    });
    expect(v2.revision).toBe(2);
    expect(Object.keys(v2.spec.environments.staging.services)).toEqual(['api', 'worker']);

    expect(store.getRevision(project.id, 1)!.environments.staging.services).not.toHaveProperty('worker');
  });

  it('rejects invalid specs', () => {
    const project = makeProject();
    const store = new SpecStore();
    expect(() => store.replace(project, { version: 1, project: project.name, environments: { staging: {} } })).toThrow();
  });
});
