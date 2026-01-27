import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Environment, CreateEnvironmentInput } from '../../../domain/entities/environment.entity.js';

export class EnvironmentRepository {
  create(input: CreateEnvironmentInput): Environment {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO environments (id, project_id, name, platform_bindings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.name,
      JSON.stringify(input.platformBindings ?? {}),
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Environment | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProjectId(projectId: string): Environment[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY name').all(projectId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByProjectAndName(projectId: string, name: string): Environment | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM environments WHERE project_id = ? AND name = ?').get(projectId, name) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  update(id: string, updates: Partial<CreateEnvironmentInput>): Environment | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE environments
      SET name = ?, platform_bindings = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? existing.name,
      JSON.stringify(updates.platformBindings ?? existing.platformBindings),
      now,
      id
    );

    return this.findById(id);
  }

  updatePlatformBindings(id: string, bindings: Record<string, unknown>): Environment | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const merged = { ...existing.platformBindings, ...bindings };

    db.prepare(`
      UPDATE environments
      SET platform_bindings = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(merged), now, id);

    return this.findById(id);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM environments WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Environment {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      name: row.name as string,
      platformBindings: JSON.parse(row.platform_bindings as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
