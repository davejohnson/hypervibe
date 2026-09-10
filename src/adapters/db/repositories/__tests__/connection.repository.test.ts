import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeDatabase,
  SqliteAdapter,
} from '../../sqlite.adapter.js';
import { ConnectionRepository } from '../connection.repository.js';

let repository: ConnectionRepository;

function create(
  provider: string,
  scope?: string | null
) {
  return repository.create({
    provider,
    scope,
    credentialsEncrypted: `encrypted-${provider}-${scope ?? 'global'}`,
  });
}

function insertLegacyGlobal(provider: string, id = `${provider}-legacy`): void {
  const db = SqliteAdapter.getInstance().getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO connections (
      id,
      provider,
      scope,
      credentials_encrypted,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'global', ?, 'verified', ?, ?)
  `).run(id, provider, `encrypted-${id}`, now, now);
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dataDir = mkdtempSync(
    path.join(tmpdir(), 'hypervibe-connection-repository-')
  );
  initializeDatabase(path.join(dataDir, 'test.db'));
  repository = new ConnectionRepository();
});

afterEach(() => {
  SqliteAdapter.resetInstance();
});

describe('ConnectionRepository scope safety', () => {
  it('normalizes literal global scopes before persistence', () => {
    const connection = create('github', ' global ');

    expect(connection.scope).toBeNull();
    expect(repository.findByProvider('github')?.id).toBe(connection.id);
  });

  it('reads historical literal global rows without duplicating the catalog', () => {
    const canonical = create('github');
    insertLegacyGlobal('github');

    expect(repository.findByProvider('github')?.id).toBe(canonical.id);
    expect(repository.findAllByProvider('github')).toEqual([canonical]);
    expect(repository.findAll()).toEqual([canonical]);
  });

  it('falls back to a historical literal global row when no canonical row exists', () => {
    insertLegacyGlobal('railway');

    expect(repository.findByProvider('railway')).toMatchObject({
      id: 'railway-legacy',
      provider: 'railway',
      scope: null,
    });
  });

  it('tries every scoped hint before falling back to a global connection', () => {
    const global = create('github');
    const scoped = create('github', 'owner/repo');
    repository.updateStatus(global.id, 'verified');
    repository.updateStatus(scoped.id, 'verified');

    expect(repository.findBestMatchFromHints('github', [
      'github.com/owner/repo',
      'owner/repo',
    ])?.id).toBe(scoped.id);
    expect(repository.findBestVerifiedMatchFromHints('github', [
      'github.com/owner/repo',
      'owner/repo',
    ])?.id).toBe(scoped.id);
  });

  it('removes all semantic global rows when global removal is requested', () => {
    create('github');
    insertLegacyGlobal('github');

    expect(repository.deleteByProviderAndScope('github', 'global')).toBe(true);
    expect(repository.findAllByProvider('github')).toEqual([]);
  });

  it('atomically replaces an exact verified provider batch', () => {
    const cloudRun = create('cloudrun', 'owner/repo');
    const cloudSql = create('cloudsql', 'owner/repo');

    const stored = repository.upsertVerifiedBatch([
      {
        provider: 'cloudrun',
        scope: 'owner/repo',
        credentialsEncrypted: 'new-cloudrun-encrypted',
      },
      {
        provider: 'cloudsql',
        scope: 'owner/repo',
        credentialsEncrypted: 'new-cloudsql-encrypted',
      },
    ]);

    expect(stored.map((connection) => connection.id)).toEqual([cloudRun.id, cloudSql.id]);
    expect(stored.map((connection) => connection.credentialsEncrypted)).toEqual([
      'new-cloudrun-encrypted',
      'new-cloudsql-encrypted',
    ]);
    expect(stored.every((connection) => connection.status === 'verified')).toBe(true);
    expect(stored.every((connection) => connection.lastVerifiedAt instanceof Date)).toBe(true);
  });

  it('rolls back every replacement when one verified batch write fails', () => {
    const cloudRun = create('cloudrun', 'owner/repo');
    const db = SqliteAdapter.getInstance().getDb();
    db.exec(`
      CREATE TRIGGER fail_cloudsql_connection
      BEFORE INSERT ON connections
      WHEN NEW.provider = 'cloudsql'
      BEGIN
        SELECT RAISE(ABORT, 'injected cloudsql persistence failure');
      END;
    `);

    expect(() => repository.upsertVerifiedBatch([
      {
        provider: 'cloudrun',
        scope: 'owner/repo',
        credentialsEncrypted: 'replacement-cloudrun-encrypted',
      },
      {
        provider: 'cloudsql',
        scope: 'owner/repo',
        credentialsEncrypted: 'new-cloudsql-encrypted',
      },
    ])).toThrow('injected cloudsql persistence failure');

    expect(repository.findByProviderAndScope('cloudrun', 'owner/repo')).toEqual(cloudRun);
    expect(repository.findByProviderAndScope('cloudsql', 'owner/repo')).toBeNull();
  });
});
