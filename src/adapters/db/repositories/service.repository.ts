import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Service, CreateServiceInput } from '../../../domain/entities/service.entity.js';

export class ServiceRepository {
  create(input: CreateServiceInput): Service {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO services (id, project_id, name, build_config, env_var_spec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.name,
      JSON.stringify(input.buildConfig ?? {}),
      JSON.stringify(input.envVarSpec ?? {}),
      now,
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Service | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProjectId(projectId: string): Service[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY name').all(projectId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByProjectAndName(projectId: string, name: string): Service | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM services WHERE project_id = ? AND name = ?').get(projectId, name) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  update(id: string, updates: Partial<CreateServiceInput>): Service | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE services
      SET name = ?, build_config = ?, env_var_spec = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? existing.name,
      JSON.stringify(updates.buildConfig ?? existing.buildConfig),
      JSON.stringify(updates.envVarSpec ?? existing.envVarSpec),
      now,
      id
    );

    return this.findById(id);
  }

  delete(id: string): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM services WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): Service {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      name: row.name as string,
      buildConfig: JSON.parse(row.build_config as string),
      envVarSpec: JSON.parse(row.env_var_spec as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
