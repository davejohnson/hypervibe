import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, initializeDatabase, SqliteAdapter } from '../../sqlite.adapter.js';
import { ProjectRepository } from '../project.repository.js';
import { EnvironmentRepository } from '../environment.repository.js';
import { ComponentRepository } from '../component.repository.js';

const SECRET_URL = 'postgresql://app:sup3rs3cret@db.internal:5432/app';

describe('component bindings encryption at rest', () => {
  let tempDir: string;
  let environmentId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-component-enc-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    const project = new ProjectRepository().create({ name: 'enc-app', defaultPlatform: 'railway' });
    environmentId = new EnvironmentRepository().create({ projectId: project.id, name: 'production' }).id;
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores bindings as ciphertext and round-trips through the repository', () => {
    const repo = new ComponentRepository();
    const component = repo.create({
      environmentId,
      type: 'postgres',
      bindings: { provider: 'railway', connectionUrl: SECRET_URL, password: 'sup3rs3cret' },
    });

    // Repository reads decrypt transparently.
    expect(component.bindings.connectionUrl).toBe(SECRET_URL);

    // The raw column never contains the plaintext credential.
    const raw = getDb().prepare('SELECT bindings FROM components WHERE id = ?').get(component.id) as { bindings: string };
    expect(raw.bindings).not.toContain('sup3rs3cret');
    expect(JSON.parse(raw.bindings)).toHaveProperty('__encrypted');

    // updateBindings keeps the ciphertext wrapper.
    repo.updateBindings(component.id, { host: 'db.internal' });
    const rawAfter = getDb().prepare('SELECT bindings FROM components WHERE id = ?').get(component.id) as { bindings: string };
    expect(rawAfter.bindings).not.toContain('sup3rs3cret');
    expect(repo.findById(component.id)!.bindings).toMatchObject({
      connectionUrl: SECRET_URL,
      host: 'db.internal',
    });
  });

  it('still reads legacy plaintext rows written before migration 10', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO components (id, environment_id, type, bindings, external_id, created_at, updated_at)
      VALUES ('legacy-1', ?, 'postgres', ?, NULL, ?, ?)
    `).run(environmentId, JSON.stringify({ provider: 'railway', connectionUrl: SECRET_URL }), now, now);

    const component = new ComponentRepository().findById('legacy-1')!;
    expect(component.bindings.connectionUrl).toBe(SECRET_URL);
  });

  it('migration 10 encrypts pre-existing plaintext rows', () => {
    const db = getDb();
    const now = new Date().toISOString();
    // Simulate a pre-migration row and re-run the data migration by
    // deleting its schema_migrations marker.
    db.prepare(`
      INSERT INTO components (id, environment_id, type, bindings, external_id, created_at, updated_at)
      VALUES ('plain-1', ?, 'postgres', ?, NULL, ?, ?)
    `).run(environmentId, JSON.stringify({ provider: 'railway', connectionUrl: SECRET_URL }), now, now);
    db.prepare('DELETE FROM schema_migrations WHERE version = 10').run();

    SqliteAdapter.getInstance().migrate();

    const raw = db.prepare('SELECT bindings FROM components WHERE id = ?').get('plain-1') as { bindings: string };
    expect(raw.bindings).not.toContain('sup3rs3cret');
    expect(JSON.parse(raw.bindings)).toHaveProperty('__encrypted');
    expect(new ComponentRepository().findById('plain-1')!.bindings.connectionUrl).toBe(SECRET_URL);
  });
});
