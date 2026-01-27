import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Component, CreateComponentInput } from '../../../domain/entities/component.entity.js';

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
      JSON.stringify(input.bindings ?? {}),
      input.externalId ?? null,
      now,
      now
    );

    return this.findById(id)!;
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
      JSON.stringify(updates.bindings ?? existing.bindings),
      updates.externalId ?? existing.externalId,
      now,
      id
    );

    return this.findById(id);
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
    `).run(JSON.stringify(merged), now, id);

    return this.findById(id);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM components WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Component {
    return {
      id: row.id as string,
      environmentId: row.environment_id as string,
      type: row.type as string,
      bindings: JSON.parse(row.bindings as string),
      externalId: row.external_id as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
