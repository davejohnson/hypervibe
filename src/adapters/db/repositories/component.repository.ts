import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDb } from '../sqlite.adapter.js';
import { parseJsonColumn } from '../json.codec.js';
import { componentBindingsColumnSchema } from '../column.schemas.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import type { Component, CreateComponentInput } from '../../../domain/entities/component.entity.js';
import { EnvironmentRepository } from './environment.repository.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';

/**
 * Component bindings carry live database credentials (connection URLs,
 * passwords), so they are encrypted at rest with the SecretStore. The
 * column holds {"__encrypted": "<secretbox>"} for new rows; plaintext
 * rows written before migration 10 are still readable.
 */
export function serializeComponentBindings(bindings: Record<string, unknown>): string {
  return JSON.stringify({ __encrypted: getSecretStore().encryptObject(bindings) });
}

export function deserializeComponentBindings(raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const outer = JSON.parse(raw) as Record<string, unknown>;
      if (outer && typeof outer.__encrypted === 'string') {
        const decrypted = getSecretStore().decryptObject<Record<string, unknown>>(outer.__encrypted);
        return parseJsonColumn(componentBindingsColumnSchema, JSON.stringify(decrypted), context);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to decrypt')) {
        throw new Error(`Cannot read ${context}: ${error.message}`);
      }
      // Fall through: not JSON or not the encrypted wrapper — legacy parse below.
    }
  }
  return parseJsonColumn(componentBindingsColumnSchema, raw, context);
}

export class ComponentRepository {
  create(input: CreateComponentInput): Component {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO components (id, environment_id, type, bindings, external_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.environmentId,
      input.type,
      serializeComponentBindings(input.bindings ?? {}),
      input.externalId ?? null,
      now,
      now
    );

    const created = this.findById(id)!;
    new EnvironmentRepository().syncRepoBindingsForId(created.environmentId);
    return created;
  }

  findById(id: string): Component | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM components WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByEnvironmentId(environmentId: string): Component[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM components WHERE environment_id = ? ORDER BY type').all(environmentId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByEnvironmentAndType(environmentId: string, type: string): Component | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM components WHERE environment_id = ? AND type = ?').get(environmentId, type) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  update(id: string, updates: Partial<CreateComponentInput>): Component | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE components
      SET type = ?, bindings = ?, external_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.type ?? existing.type,
      serializeComponentBindings(updates.bindings ?? existing.bindings),
      updates.externalId !== undefined ? updates.externalId : existing.externalId,
      now,
      id
    );

    const updated = this.findById(id);
    if (updated) new EnvironmentRepository().syncRepoBindingsForId(updated.environmentId);
    return updated;
  }

  updateBindings(id: string, bindings: Record<string, unknown>): Component | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const merged = { ...existing.bindings, ...bindings };

    db.prepare(`
      UPDATE components
      SET bindings = ?, updated_at = ?
      WHERE id = ?
    `).run(serializeComponentBindings(merged), now, id);

    const updated = this.findById(id);
    if (updated) new EnvironmentRepository().syncRepoBindingsForId(updated.environmentId);
    return updated;
  }

  /** Commit both halves of one reviewed local provision finalization. Compare
   * private snapshots inside SQLite's write transaction; no network/export is
   * performed until after commit, so an export failure remains retryable. */
  finalizeProvisionIfUnchanged(input: {
    component: Component; environment: Environment; externalId: string;
    bindings: Record<string, unknown>; environmentBindings: Record<string, unknown>; specRevision: number;
  }): Component | null {
    const db = getDb();
    return db.transaction(() => {
      const component = this.findById(input.component.id);
      const environment = new EnvironmentRepository().findById(input.environment.id);
      const spec = db.prepare('SELECT revision FROM project_specs WHERE project_id = ? ORDER BY revision DESC LIMIT 1')
        .get(input.environment.projectId) as { revision: number } | undefined;
      if (!component || !environment || component.environmentId !== environment.id
        || spec?.revision !== input.specRevision
        || !isDeepStrictEqual(component, input.component) || !isDeepStrictEqual(environment, input.environment)) return null;
      const now = new Date().toISOString();
      db.prepare('UPDATE components SET bindings = ?, external_id = ?, updated_at = ? WHERE id = ?')
        .run(serializeComponentBindings(input.bindings), input.externalId, now, component.id);
      db.prepare('UPDATE environments SET platform_bindings = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(input.environmentBindings), now, environment.id);
      return this.findById(component.id);
    }).immediate();
  }

  delete(id: string): boolean {
    const db = getDb();
    const existing = this.findById(id);
    const result = db.prepare('DELETE FROM components WHERE id = ?').run(id);
    if (result.changes > 0 && existing) new EnvironmentRepository().syncRepoBindingsForId(existing.environmentId);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Component {
    return {
      id: row.id as string,
      environmentId: row.environment_id as string,
      type: row.type as string,
      bindings: deserializeComponentBindings(row.bindings, `components.bindings (${row.id})`),
      externalId: row.external_id as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
