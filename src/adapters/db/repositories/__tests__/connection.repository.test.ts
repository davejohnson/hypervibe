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
});
