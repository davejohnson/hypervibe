import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type {
  IntegrationKey,
  CreateIntegrationKeyInput,
  IntegrationProvider,
  IntegrationKeyMode,
} from '../../../domain/entities/integration.entity.js';

export class IntegrationRepository {
  create(input: CreateIntegrationKeyInput): IntegrationKey {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO integration_keys (id, provider, mode, keys_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.provider, input.mode, input.keysEncrypted, now, now);

    return this.findById(id)!;
  }

  findById(id: string): IntegrationKey | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM integration_keys WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProviderAndMode(
    provider: IntegrationProvider,
    mode: IntegrationKeyMode
  ): IntegrationKey | null {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM integration_keys WHERE provider = ? AND mode = ?')
      .get(provider, mode) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProvider(provider: IntegrationProvider): IntegrationKey[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM integration_keys WHERE provider = ? ORDER BY mode')
      .all(provider) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findAll(): IntegrationKey[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM integration_keys ORDER BY provider, mode')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  update(id: string, keysEncrypted: string): IntegrationKey | null {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE integration_keys
      SET keys_encrypted = ?, updated_at = ?
      WHERE id = ?
    `).run(keysEncrypted, now, id);

    return this.findById(id);
  }

  upsert(input: CreateIntegrationKeyInput): IntegrationKey {
    const existing = this.findByProviderAndMode(input.provider, input.mode);
    if (existing) {
      return this.update(existing.id, input.keysEncrypted)!;
    }
    return this.create(input);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM integration_keys WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): IntegrationKey {
    return {
      id: row.id as string,
      provider: row.provider as IntegrationProvider,
      mode: row.mode as IntegrationKeyMode,
      keysEncrypted: row.keys_encrypted as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
