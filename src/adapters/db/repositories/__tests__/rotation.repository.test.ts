import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initializeDatabase, SqliteAdapter } from '../../sqlite.adapter.js';
import { ProjectRepository } from '../project.repository.js';

let directory: string;
let databasePath: string;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-rotation-repository-'));
  databasePath = path.join(directory, 'test.db');
  initializeDatabase(databasePath);
  projectId = new ProjectRepository().create({ name: 'rotation-app' }).id;
  otherProjectId = new ProjectRepository().create({ name: 'unrelated-app' }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function snapshot() {
  return {
    projectId, mode: 'incident' as const, specRevision: 3, scopeFingerprint: 'a'.repeat(64),
    recordedEnvironments: [{ name: 'production' }, { name: 'staging' }],
    connections: [{ id: 'connection-1', provider: 'railway', scope: null, status: 'verified' as const }],
  };
}

async function repository() {
  const { RotationRepository } = await import('../rotation.repository.js');
  return new RotationRepository();
}

describe('RotationRepository', () => {
  it('upgrades version 11 without changing existing project state or creating a workflow', () => {
    const db = getDb();
    // Recreate the version-11 boundary if this checkout already includes migration 12.
    db.exec('DROP TABLE IF EXISTS rotation_workflows; DELETE FROM schema_migrations WHERE version = 12;');
    const before = db.prepare('SELECT * FROM projects ORDER BY id').all();
    expect(SqliteAdapter.getInstance().migrate().map(migration => migration.version)).toEqual([12]);
    expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM rotation_workflows').get()).toEqual({ count: 0 });
    expect(SqliteAdapter.getInstance().migrate()).toEqual([]);
  });

  it('persists only a strict value-free snapshot and recovers it after reopening', async () => {
    const repo = await repository();
    const prepared = repo.prepare(snapshot());
    expect(prepared.created).toBe(true);
    expect(prepared.workflow).toMatchObject(snapshot());
    expect(prepared.workflow.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(prepared.workflow.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const columns = getDb().prepare('PRAGMA table_info(rotation_workflows)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toEqual([
      'id', 'project_id', 'mode', 'spec_revision', 'scope_fingerprint', 'recorded_environments', 'connections', 'created_at', 'project_git_remote_url',
    ]);
    SqliteAdapter.resetInstance();
    initializeDatabase(databasePath);
    expect((await repository()).getById(projectId, prepared.workflow.id)).toEqual(prepared.workflow);
    expect((await repository()).latest(projectId)).not.toHaveProperty('projectGitRemoteUrl');
  });

  it('retains the original project remote when live project metadata changes', async () => {
    const repo = await repository();
    const projectGitRemoteUrl = 'https://github.com/original/app.git';
    new ProjectRepository().update(projectId, { gitRemoteUrl: projectGitRemoteUrl });
    const { workflow } = repo.prepare({ ...snapshot(), projectGitRemoteUrl });
    new ProjectRepository().update(projectId, { gitRemoteUrl: 'https://github.com/replacement/app.git' });
    SqliteAdapter.resetInstance();
    initializeDatabase(databasePath);
    const reopened = await repository();
    expect(reopened.getById(projectId, workflow.id)?.projectGitRemoteUrl).toBe(projectGitRemoteUrl);
    expect(reopened.latest(projectId)?.projectGitRemoteUrl).toBe(projectGitRemoteUrl);
    expect(new ProjectRepository().findById(projectId)?.gitRemoteUrl).toBe('https://github.com/replacement/app.git');
  });

  it('returns the same durable snapshot on retry without overwriting its baseline', async () => {
    const repo = await repository();
    const first = repo.prepare(snapshot());
    const again = repo.prepare(snapshot());
    expect(again).toEqual({ workflow: first.workflow, created: false });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM rotation_workflows').get()).toEqual({ count: 1 });
    expect(repo.prepare({ ...snapshot(), recordedEnvironments: [{ name: 'changed-input' }] })).toEqual(again);
    expect(repo.getById(projectId, first.workflow.id)?.recordedEnvironments).toEqual(snapshot().recordedEnvironments);
  });

  it('distinguishes mode, spec revision and scope fingerprint while selecting only this project', async () => {
    const repo = await repository();
    const first = repo.prepare(snapshot()).workflow;
    const routine = repo.prepare({ ...snapshot(), mode: 'routine' }).workflow;
    const revision = repo.prepare({ ...snapshot(), specRevision: 4 }).workflow;
    const scope = repo.prepare({ ...snapshot(), scopeFingerprint: 'b'.repeat(64) }).workflow;
    const unrelated = repo.prepare({ ...snapshot(), projectId: otherProjectId }).workflow;
    expect(new Set([first.id, routine.id, revision.id, scope.id, unrelated.id]).size).toBe(5);
    expect(repo.getById(otherProjectId, first.id)).toBeNull();
    expect(repo.getById(projectId, unrelated.id)).toBeNull();
    expect(repo.latest(projectId)).toEqual(scope);
    expect(repo.latest(otherProjectId)).toEqual(unrelated);
    expect(repo.latest('missing-project')).toBeNull();
  });

  it('enforces retry uniqueness and project deletion at the database boundary', async () => {
    const repo = await repository();
    const { workflow } = repo.prepare(snapshot());
    expect(() => getDb().prepare(`
      INSERT INTO rotation_workflows
        (id, project_id, mode, spec_revision, scope_fingerprint, recorded_environments, connections, created_at)
      SELECT 'duplicate-id', project_id, mode, spec_revision, scope_fingerprint, recorded_environments, connections, created_at
      FROM rotation_workflows WHERE id = ?
    `).run(workflow.id)).toThrow(/UNIQUE constraint failed/);
    new ProjectRepository().delete(projectId);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM rotation_workflows').get()).toEqual({ count: 0 });
    expect(() => repo.prepare(snapshot())).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('leaves no partial record when persistence fails, allowing the same preparation to retry', async () => {
    const repo = await repository();
    getDb().exec(`CREATE TRIGGER reject_rotation BEFORE INSERT ON rotation_workflows
      BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;`);
    expect(() => repo.prepare(snapshot())).toThrow('injected persistence failure');
    expect(repo.latest(projectId)).toBeNull();
    getDb().exec('DROP TRIGGER reject_rotation');
    expect(repo.prepare(snapshot()).created).toBe(true);
  });

  it.each([
    ['raw value', { ...snapshot(), credentials: 'do-not-echo-secret' }],
    ['assessment', { ...snapshot(), assessment: { value: 'do-not-echo-secret' } }],
    ['invalid mode', { ...snapshot(), mode: 'do-not-echo-secret' }],
    ['invalid fingerprint', { ...snapshot(), scopeFingerprint: 'do-not-echo-secret' }],
    ['invalid revision', { ...snapshot(), specRevision: -1 }],
    ['extra connection credential', { ...snapshot(), connections: [{ ...snapshot().connections[0], credentialsEncrypted: 'do-not-echo-secret' }] }],
    ['extra environment metadata', { ...snapshot(), recordedEnvironments: [{ name: 'production', key: 'do-not-echo-secret' }] }],
  ])('rejects %s before persistence without echoing invalid input', async (_label, input) => {
    const repo = await repository();
    // Build the table-driven input in this test's actual project scope.
    let failure: unknown;
    try { repo.prepare({ ...input, projectId } as never); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('do-not-echo-secret');
    expect(repo.latest(projectId)).toBeNull();
  });

  it.each([
    ['recorded_environments', '{do-not-echo-secret'],
    ['recorded_environments', '[{"name":"production","credentials":"do-not-echo-secret"}]'],
    ['recorded_environments', 'null'],
    ['connections', '[{"id":"connection-1","provider":"railway","scope":null,"status":"do-not-echo-secret"}]'],
    ['connections', '[{"id":"connection-1","provider":"railway","scope":null,"status":"verified","credentials":"do-not-echo-secret"}]'],
    ['connections', ''],
    ['mode', 'do-not-echo-secret'],
    ['created_at', 'do-not-echo-secret'],
  ])('fails closed for corrupt persisted %s', async (column, invalid) => {
    const repo = await repository();
    const { workflow } = repo.prepare(snapshot());
    getDb().prepare(`UPDATE rotation_workflows SET ${column} = ? WHERE id = ?`).run(invalid, workflow.id);
    const readers = [() => repo.getById(projectId, workflow.id), () => repo.latest(projectId)];
    if (column !== 'mode') readers.push(() => { repo.prepare(snapshot()); return null; });
    for (const read of readers) {
      let failure: unknown;
      try { read(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/persisted.*invalid/i);
      expect(String(failure)).not.toContain('do-not-echo-secret');
    }
  });
});
