import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../sqlite.adapter.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { EnvironmentRepository } from '../repositories/environment.repository.js';
import { RunRepository } from '../repositories/run.repository.js';
import { ConnectionRepository } from '../repositories/connection.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';

let directory: string;
let databasePath: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-schema12-'));
  databasePath = path.join(directory, 'state.db');
  initializeDatabase(databasePath);
});
afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

// Use the historical SQL, not the migration under test, to construct prior state.
function historicalState(): Database.Database {
  SqliteAdapter.resetInstance();
  const db = new Database(databasePath);
  db.exec('DROP TABLE IF EXISTS provider_login_sessions; DELETE FROM schema_migrations WHERE version >= 12;');
  db.exec(readFileSync(new URL('./fixtures/schema-12-login.sql', import.meta.url), 'utf8'));
  return db;
}

it('opens and reopens historical schema 12 without changing encrypted sessions, active leases, connections or recovery runs', () => {
  const project = new ProjectRepository().create({ name: 'preserved-test-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging' });
  const credentialsEncrypted = getSecretStore().encryptObject({ authMode: 'browser', loginSessionId: 'synthetic-session' });
  const connection = new ConnectionRepository().create({ provider: 'azure-container-apps', scope: 'example/preserved-test-app', credentialsEncrypted });
  const recovery = new RunRepository().create({ projectId: project.id, environmentId: environment.id, type: 'plan',
    plan: { kind: 'hv_plan', environmentName: 'staging', specRevision: 1, actions: [], observedFingerprint: null } });
  const db = historicalState();
  const encrypted = getSecretStore().encryptObject({ version: 1, phase: 'verified', providerState: { syntheticRefresh: 'not-a-real-token' } });
  db.prepare('INSERT INTO provider_login_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'synthetic-session', 'azure-container-apps', 'example/preserved-test-app', encrypted, 'active-owner', Date.now() + 120_000, 1700000000000);
  const rows = (connection: Database.Database) => ({
    migrations: connection.prepare('SELECT * FROM schema_migrations WHERE version <= 12 ORDER BY version').all(),
    sessions: connection.prepare('SELECT * FROM provider_login_sessions').all(),
    connections: connection.prepare('SELECT * FROM connections').all(),
    runs: connection.prepare('SELECT * FROM runs').all(),
  });
  const before = rows(db);
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const adapter = initializeDatabase(databasePath);
    expect(adapter.migrate()).toEqual([]);
    expect(rows(adapter.getDb())).toEqual(before);
    expect(adapter.getDb().prepare('SELECT version, name FROM schema_migrations WHERE version > 12').all()).toEqual([
      { version: 13, name: 'reconcile_historical_apply_serialization' },
    ]);
    expect(new ConnectionRepository().findById(connection.id)?.credentialsEncrypted).toBe(credentialsEncrypted);
    expect(new RunRepository().findById(recovery.id)?.plan).toEqual(recovery.plan);
    SqliteAdapter.resetInstance();
  }
});

it('bridges canonical schema 11 to 13 without fabricating historical login state or changing records', () => {
  const db = SqliteAdapter.getInstance().getDb();
  db.exec('DROP TABLE IF EXISTS provider_login_sessions; DELETE FROM schema_migrations WHERE version >= 12;');
  const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  expect(SqliteAdapter.getInstance().migrate().map(({ version, name }) => ({ version, name }))).toEqual([
    { version: 13, name: 'reconcile_historical_apply_serialization' },
  ]);
  expect(db.prepare('SELECT * FROM schema_migrations WHERE version < 12 ORDER BY version').all()).toEqual(before);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%provider_login%'").all()).toEqual([]);
  expect(db.prepare('SELECT * FROM schema_migrations WHERE version = 12').all()).toEqual([]);
});

it.each(['name', 'missing-table', 'missing-column', 'wrong-index'] as const)('rejects incompatible schema 12 (%s) before applying any missing migration', (corruption) => {
  const db = historicalState();
  db.exec('DELETE FROM schema_migrations WHERE version = 11;');
  if (corruption === 'name') db.exec("UPDATE schema_migrations SET name = 'unrelated-schema' WHERE version = 12;");
  if (corruption === 'missing-table') db.exec('DROP TABLE provider_login_sessions;');
  if (corruption === 'missing-column') db.exec('ALTER TABLE provider_login_sessions DROP COLUMN lease_until;');
  if (corruption === 'wrong-index') db.exec('DROP INDEX idx_provider_login_scope; CREATE INDEX idx_provider_login_scope ON provider_login_sessions(scope, provider);');
  const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  db.close();
  expect(() => initializeDatabase(databasePath)).toThrow(/historical schema|migration identity|base migration history/i);
  expect(SqliteAdapter.getInstance().getDb().prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);
});
