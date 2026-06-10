import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';

export interface ProjectSpecRow {
  id: string;
  projectId: string;
  revision: number;
  document: unknown;
  createdAt: Date;
}

export class ProjectSpecRepository {
  insert(projectId: string, revision: number, document: unknown): ProjectSpecRow {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO project_specs (id, project_id, revision, document, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, projectId, revision, JSON.stringify(document), now);

    return this.findLatest(projectId)!;
  }

  findLatest(projectId: string): ProjectSpecRow | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM project_specs WHERE project_id = ? ORDER BY revision DESC LIMIT 1'
    ).get(projectId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByRevision(projectId: string, revision: number): ProjectSpecRow | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM project_specs WHERE project_id = ? AND revision = ?'
    ).get(projectId, revision) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): ProjectSpecRow {
    let document: unknown = {};
    try {
      document = JSON.parse(row.document as string);
    } catch {
      console.warn(`[hypervibe] Corrupt JSON in project_specs.document (${row.id})`);
    }
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      revision: row.revision as number,
      document,
      createdAt: new Date(row.created_at as string),
    };
  }
}
