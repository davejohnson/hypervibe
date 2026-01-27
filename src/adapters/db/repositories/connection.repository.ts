import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Connection, CreateConnectionInput, ConnectionStatus } from '../../../domain/entities/connection.entity.js';

export class ConnectionRepository {
  create(input: CreateConnectionInput): Connection {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO connections (id, provider, credentials_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.provider,
      input.credentialsEncrypted,
      'pending',
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Connection | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProvider(provider: string): Connection | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM connections WHERE provider = ?').get(provider) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findAll(): Connection[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM connections ORDER BY provider').all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  updateStatus(id: string, status: ConnectionStatus): Connection | null {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE connections
      SET status = ?, last_verified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status === 'verified' ? now : null, now, id);

    return this.findById(id);
  }

  updateCredentials(id: string, credentialsEncrypted: string): Connection | null {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE connections
      SET credentials_encrypted = ?, status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(credentialsEncrypted, now, id);

    return this.findById(id);
  }

  upsert(input: CreateConnectionInput): Connection {
    const existing = this.findByProvider(input.provider);
    if (existing) {
      return this.updateCredentials(existing.id, input.credentialsEncrypted)!;
    }
    return this.create(input);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Connection {
    return {
      id: row.id as string,
      provider: row.provider as string,
      credentialsEncrypted: row.credentials_encrypted as string,
      status: row.status as ConnectionStatus,
      lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
