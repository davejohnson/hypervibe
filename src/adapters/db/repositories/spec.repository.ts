import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import { currentSpecWriter } from '../../../domain/spec/spec-writer.js';

export interface ProjectSpecWriter {
  version: string;
  schema: string;
}

export interface ProjectSpecRow {
  id: string;
  projectId: string;
  revision: number;
  document: unknown;
  createdAt: Date;
  /** Null for revisions written before writer identity was recorded. */
  writer: ProjectSpecWriter | null;
}

export class ProjectSpecRepository {
  insert(projectId: string, revision: number, document: unknown, writer: ProjectSpecWriter = currentSpecWriter()): ProjectSpecRow {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO project_specs (id, project_id, revision, document, created_at, writer_version, writer_schema)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, revision, JSON.stringify(document), now, writer.version, writer.schema);

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
    let document: unknown;
    try {
      document = JSON.parse(String(row.document));
    } catch {
      throw new Error(
        `Cannot read project_specs.document at revision ${String(row.revision)}: persisted JSON is corrupt. `
        + 'Hypervibe refuses to treat unreadable desired state as empty.'
      );
    }
    const writer = typeof row.writer_version === 'string' && typeof row.writer_schema === 'string'
      ? { version: row.writer_version, schema: row.writer_schema }
      : null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      revision: row.revision as number,
      document,
      createdAt: new Date(row.created_at as string),
      writer,
    };
  }
}
