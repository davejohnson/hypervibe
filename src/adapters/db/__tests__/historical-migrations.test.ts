import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../sqlite.adapter.js';

// Object definitions come from recorded schema-only observation and historical
// source, independently of the reconciliation implementation. Rows are synthetic.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/historical-migration-objects.json', import.meta.url), 'utf8')) as {
  companion: Array<{ sql: string }>;
  rotation: Array<{ sql: string }>;
  login: Array<{ sql: string }>;
};
let directory: string;
let adapter: SqliteAdapter;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-history-'));
  adapter = initializeDatabase(path.join(directory, 'state.db'));
  const db = adapter.getDb();
  db.exec(`
    DROP INDEX idx_runs_succeeded_apply_plan;
    DROP INDEX idx_runs_running_apply_environment;
    DELETE FROM schema_migrations WHERE version >= 11;
    INSERT INTO projects(id, name) VALUES ('project', 'history-fixture');
    INSERT INTO environments(id, project_id, name) VALUES ('environment', 'project', 'production');
    INSERT INTO runs(id, project_id, environment_id, type, status, plan)
      VALUES ('prior-plan', 'project', 'environment', 'plan', 'succeeded', '{"retained":"synthetic"}');
  `);
});

afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function historicalState(companion = true, kind: 'rotation' | 'login' = 'rotation'): void {
  const db = adapter.getDb();
  if (companion) {
    for (const object of fixture.companion) db.exec(object.sql);
    db.exec(`INSERT INTO companion_meta(id,schema_version,min_reader_schema_version,max_reader_schema_version,writer_version,updated_at)
      VALUES(1,1,1,1,'historical-fixture','2026-07-19');`);
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (11,?,?)')
      .run('companion_read_model_v1', '2026-07-19 23:26:55');
  } else {
    // Canonical migration 11 is independent of either additive historical 12.
    adapter.migrate();
    db.exec('DELETE FROM schema_migrations WHERE version > 11');
  }
  for (const object of fixture[kind]) db.exec(object.sql);
  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (12,?,?)')
    .run(kind === 'rotation' ? 'rotation_workflow_snapshots' : 'provider_login_sessions', '2026-10-22 05:03:56');
  if (kind === 'rotation') db.exec(`
    INSERT INTO rotation_workflows(id,project_id,mode,spec_revision,scope_fingerprint,recorded_environments,connections,created_at)
      VALUES('retained-rotation','project','database',4,'fingerprint','["production"]','{"encrypted":"synthetic"}','2026-10-22');
  `);
  else db.exec(`INSERT INTO provider_login_sessions(id,provider,state_encrypted,created_at)
    VALUES('retained-login','railway','synthetic-ciphertext',1);`);
}

function snapshot(): unknown {
  const db = adapter.getDb();
  return {
    history: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    objects: db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
    runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
  };
}

describe('historical migration reconciliation', () => {
  it.each([
    [true, 'rotation'], [false, 'rotation'], [false, 'login'],
  ] as const)('preserves exact historical records and data (companion=%s, additive=%s)', (companion, kind) => {
    historicalState(companion, kind);
    const db = adapter.getDb();
    const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const table = kind === 'rotation' ? 'rotation_workflows' : 'provider_login_sessions';
    const historicalRows = db.prepare(`SELECT * FROM ${table}`).all();
    const companionRows = companion ? db.prepare('SELECT * FROM companion_meta').all() : null;

    expect(adapter.migrate().map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 13, name: 'reconcile_historical_apply_serialization' },
    ]);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version <= 12 ORDER BY version').all()).toEqual(history);
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(historicalRows);
    if (companion) expect(db.prepare('SELECT * FROM companion_meta').all()).toEqual(companionRows);
    expect(db.prepare('SELECT plan FROM runs WHERE id = ?').get('prior-plan')).toEqual({ plan: '{"retained":"synthetic"}' });
    expect(adapter.migrate()).toEqual([]);

    db.exec(`INSERT INTO runs(id,project_id,environment_id,type,status,plan)
      VALUES('running-one','project','environment','apply','running','{"planRunId":"one"}');`);
    expect(() => db.exec(`INSERT INTO runs(id,project_id,environment_id,type,status,plan)
      VALUES('running-two','project','environment','apply','running','{"planRunId":"two"}');`)).toThrow(/UNIQUE/);
    db.exec("UPDATE runs SET status = 'succeeded' WHERE id = 'running-one'");
    expect(() => db.exec(`INSERT INTO runs(id,project_id,environment_id,type,status,plan)
      VALUES('duplicate-success','project','environment','apply','succeeded','{"planRunId":"one"}');`)).toThrow(/UNIQUE/);
  });

  it.each([11, 12])('rejects an unknown migration identity at version %s before writing', (version) => {
    historicalState();
    adapter.getDb().prepare('UPDATE schema_migrations SET name = ? WHERE version = ?').run('unrecognized_history', version);
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/Unrecognized migration identity/);
    expect(snapshot()).toEqual(before);
  });

  it.each(['missing-table', 'changed-trigger', 'wrong-index'])('rejects incompatible historical objects: %s', (damage) => {
    historicalState();
    const db = adapter.getDb();
    if (damage === 'missing-table') db.exec('DROP TABLE rotation_workflows');
    if (damage === 'changed-trigger') db.exec(`
      DROP TRIGGER companion_dirty_components_update;
      CREATE TRIGGER companion_dirty_components_update AFTER UPDATE ON components BEGIN SELECT 1; END;
    `);
    if (damage === 'wrong-index') db.exec(`
      DROP INDEX idx_rotation_workflows_project_created;
      CREATE INDEX idx_rotation_workflows_project_created ON rotation_workflows(mode);
    `);
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/historical schema object/);
    expect(snapshot()).toEqual(before);
  });

  it.each(['running', 'succeeded'])('preserves conflicting %s run history and rolls back the bridge', (status) => {
    historicalState();
    const db = adapter.getDb();
    const insert = db.prepare(`INSERT INTO runs(id,project_id,environment_id,type,status,plan)
      VALUES(?,'project','environment','apply',?,'{"planRunId":"same"}')`);
    insert.run('conflict-one', status);
    insert.run('conflict-two', status);
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/Cannot install apply serialization/);
    expect(snapshot()).toEqual(before);
  });

  it('does not trust an existing index name as proof of apply serialization', () => {
    historicalState();
    const db = adapter.getDb();
    db.exec('CREATE INDEX idx_runs_running_apply_environment ON runs(environment_id)');
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/apply serialization index/);
    expect(snapshot()).toEqual(before);
  });

  it('validates historical objects again after the bridge has been recorded', () => {
    historicalState();
    adapter.migrate();
    adapter.getDb().exec('DROP INDEX idx_rotation_workflows_project_created');
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/historical schema object/);
    expect(snapshot()).toEqual(before);
  });

  it('refuses missing apply safety indexes after the bridge has been recorded', () => {
    historicalState();
    adapter.migrate();
    adapter.getDb().exec('DROP INDEX idx_runs_running_apply_environment');
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/apply serialization index/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects historical objects without their recorded migration identity', () => {
    historicalState();
    adapter.getDb().exec('DELETE FROM schema_migrations WHERE version = 12');
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/Unattributed historical schema object/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects incomplete historical base records instead of replaying old data migrations', () => {
    historicalState();
    adapter.getDb().exec('DELETE FROM schema_migrations WHERE version = 10');
    const before = snapshot();
    expect(() => adapter.migrate()).toThrow(/Incomplete base migration history/);
    expect(snapshot()).toEqual(before);
  });
});
