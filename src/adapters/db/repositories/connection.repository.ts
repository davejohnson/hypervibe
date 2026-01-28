import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Connection, CreateConnectionInput, ConnectionStatus } from '../../../domain/entities/connection.entity.js';

export class ConnectionRepository {
  create(input: CreateConnectionInput): Connection {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const scope = input.scope ?? null;

    db.prepare(`
      INSERT INTO connections (id, provider, scope, credentials_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.provider,
      scope,
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

  /**
   * Find a global (unscoped) connection for a provider.
   * This is the original behavior - returns the connection where scope is NULL.
   */
  findByProvider(provider: string): Connection | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM connections WHERE provider = ? AND scope IS NULL').get(provider) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Find a connection by provider and exact scope match.
   */
  findByProviderAndScope(provider: string, scope: string | null): Connection | null {
    const db = getDb();
    let row: Record<string, unknown> | undefined;

    if (scope === null) {
      row = db.prepare('SELECT * FROM connections WHERE provider = ? AND scope IS NULL').get(provider) as Record<string, unknown> | undefined;
    } else {
      row = db.prepare('SELECT * FROM connections WHERE provider = ? AND scope = ?').get(provider, scope) as Record<string, unknown> | undefined;
    }

    return row ? this.mapRow(row) : null;
  }

  /**
   * Find all connections for a provider (all scopes).
   */
  findAllByProvider(provider: string): Connection[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM connections WHERE provider = ? ORDER BY scope NULLS LAST').all(provider) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find the best matching connection for a provider and scope hint.
   * Priority:
   * 1. Exact match (scope = "davejohnson/infraprint")
   * 2. Wildcard match (scope = "clientorg/*" matches "clientorg/repo")
   * 3. Global fallback (scope = NULL)
   */
  findBestMatch(provider: string, scopeHint?: string | null): Connection | null {
    const db = getDb();

    // If no scope hint, return global
    if (!scopeHint) {
      return this.findByProvider(provider);
    }

    // Try exact match first
    const exact = this.findByProviderAndScope(provider, scopeHint);
    if (exact) {
      return exact;
    }

    // Try wildcard match
    // Get all scoped connections for this provider and check for wildcard matches
    const rows = db.prepare(
      'SELECT * FROM connections WHERE provider = ? AND scope IS NOT NULL AND scope LIKE \'%/*\''
    ).all(provider) as Record<string, unknown>[];

    for (const row of rows) {
      const scope = row.scope as string;
      // scope is like "clientorg/*", check if scopeHint starts with "clientorg/"
      const prefix = scope.slice(0, -1); // Remove the "*" to get "clientorg/"
      if (scopeHint.startsWith(prefix)) {
        return this.mapRow(row);
      }
    }

    // Fall back to global
    return this.findByProvider(provider);
  }

  findAll(): Connection[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM connections ORDER BY provider, scope NULLS LAST').all() as Record<string, unknown>[];
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

  /**
   * Upsert a connection by provider and scope.
   * If a connection exists for this provider+scope, update credentials.
   * Otherwise, create a new connection.
   */
  upsert(input: CreateConnectionInput): Connection {
    const scope = input.scope ?? null;
    const existing = this.findByProviderAndScope(input.provider, scope);
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

  /**
   * Delete a connection by provider and scope.
   */
  deleteByProviderAndScope(provider: string, scope: string | null): boolean {
    const db = getDb();
    let result;

    if (scope === null) {
      result = db.prepare('DELETE FROM connections WHERE provider = ? AND scope IS NULL').run(provider);
    } else {
      result = db.prepare('DELETE FROM connections WHERE provider = ? AND scope = ?').run(provider, scope);
    }

    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Connection {
    return {
      id: row.id as string,
      provider: row.provider as string,
      scope: row.scope as string | null,
      credentialsEncrypted: row.credentials_encrypted as string,
      status: row.status as ConnectionStatus,
      lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
