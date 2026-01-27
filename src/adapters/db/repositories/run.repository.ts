import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import type { Run, CreateRunInput, RunStatus, RunReceipt } from '../../../domain/entities/run.entity.js';

export class RunRepository {
  create(input: CreateRunInput): Run {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO runs (id, project_id, environment_id, type, status, plan, receipts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.environmentId,
      input.type,
      'pending',
      JSON.stringify(input.plan ?? {}),
      JSON.stringify([]),
      now
    );

    return this.findById(id)!;
  }

  findById(id: string): Run | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  findByProjectId(projectId: string, limit = 50): Run[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByEnvironmentId(environmentId: string, limit = 50): Run[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM runs WHERE environment_id = ? ORDER BY created_at DESC LIMIT ?').all(environmentId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findRecent(limit = 20): Run[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  findByStatus(status: RunStatus): Run[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC').all(status) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  updateStatus(id: string, status: RunStatus, error?: string): Run | null {
    const db = getDb();
    const now = new Date().toISOString();

    if (status === 'running') {
      db.prepare(`
        UPDATE runs SET status = ?, started_at = ? WHERE id = ?
      `).run(status, now, id);
    } else if (status === 'succeeded' || status === 'failed') {
      db.prepare(`
        UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ?
      `).run(status, error ?? null, now, id);
    } else {
      db.prepare(`
        UPDATE runs SET status = ? WHERE id = ?
      `).run(status, id);
    }

    return this.findById(id);
  }

  addReceipt(id: string, receipt: RunReceipt): Run | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const receipts = [...existing.receipts, receipt];
    db.prepare(`
      UPDATE runs SET receipts = ? WHERE id = ?
    `).run(JSON.stringify(receipts), id);

    return this.findById(id);
  }

  updatePlan(id: string, plan: Record<string, unknown>): Run | null {
    const db = getDb();
    db.prepare(`
      UPDATE runs SET plan = ? WHERE id = ?
    `).run(JSON.stringify(plan), id);

    return this.findById(id);
  }

  private mapRow(row: Record<string, unknown>): Run {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      environmentId: row.environment_id as string,
      type: row.type as string,
      status: row.status as RunStatus,
      plan: JSON.parse(row.plan as string),
      receipts: JSON.parse(row.receipts as string),
      error: row.error as string | null,
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      createdAt: new Date(row.created_at as string),
    };
  }
}
