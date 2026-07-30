import { randomUUID } from 'crypto';
import { getDb } from '../sqlite.adapter.js';
import { parseJsonColumn } from '../json.codec.js';
import { runPlanColumnSchema, runReceiptsColumnSchema } from '../column.schemas.js';
import type { Run, CreateRunInput, RunStatus, RunReceipt } from '../../../domain/entities/run.entity.js';

export interface ReserveApplyInput {
  projectId: string;
  environmentId: string;
  planRunId: string;
  environmentName: string;
  specRevision: number;
}

export type ReserveApplyResult =
  | { reserved: true; run: Run }
  | {
    reserved: false;
    reason: 'already_applied' | 'plan_in_progress' | 'environment_in_progress';
    conflictingRunId: string;
  };

export class RunRepository {
  create(input: CreateRunInput): Run {
    if (input.type === 'apply') {
      throw new Error('Apply runs must be created with RunRepository.reserveApply().');
    }

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

  /**
   * Atomically reserves mutation authority for a persisted plan.
   *
   * BEGIN IMMEDIATE serializes the conflict checks with the insert across
   * processes sharing this SQLite database. Schema constraints independently
   * enforce one running apply per environment and one successful apply per
   * plan, so a future caller cannot accidentally weaken the invariant.
   */
  reserveApply(input: ReserveApplyInput): ReserveApplyResult {
    const db = getDb();
    return db.transaction((): ReserveApplyResult => {
      const priorApplied = db.prepare(`
        SELECT *
        FROM runs
        WHERE type = 'apply'
          AND status = 'succeeded'
          AND json_valid(plan)
          AND json_type(plan, '$.planRunId') = 'text'
          AND json_extract(plan, '$.planRunId') = ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(input.planRunId) as Record<string, unknown> | undefined;
      if (priorApplied) {
        return {
          reserved: false,
          reason: 'already_applied',
          conflictingRunId: priorApplied.id as string,
        };
      }

      const activeApply = db.prepare(`
        SELECT *
        FROM runs
        WHERE type = 'apply'
          AND status = 'running'
          AND environment_id = ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(input.environmentId) as Record<string, unknown> | undefined;
      if (activeApply) {
        const activeDocument = parseJsonColumn(
          runPlanColumnSchema,
          activeApply.plan,
          `runs.plan (${activeApply.id})`
        ) as Record<string, unknown>;
        return {
          reserved: false,
          reason: activeDocument.planRunId === input.planRunId
            ? 'plan_in_progress'
            : 'environment_in_progress',
          conflictingRunId: activeApply.id as string,
        };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO runs (
          id,
          project_id,
          environment_id,
          type,
          status,
          plan,
          receipts,
          started_at,
          created_at
        )
        VALUES (?, ?, ?, 'apply', 'running', ?, ?, ?, ?)
      `).run(
        id,
        input.projectId,
        input.environmentId,
        JSON.stringify({
          planRunId: input.planRunId,
          environmentName: input.environmentName,
          specRevision: input.specRevision,
        }),
        JSON.stringify([]),
        now,
        now
      );

      return { reserved: true, run: this.findById(id)! };
    }).immediate();
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
    } else if (status === 'succeeded' || status === 'failed' || status === 'pending' || status === 'blocked' || status === 'cancelled') {
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
      plan: parseJsonColumn(runPlanColumnSchema, row.plan, `runs.plan (${row.id})`) as Run['plan'],
      receipts: parseJsonColumn(runReceiptsColumnSchema, row.receipts, `runs.receipts (${row.id})`) as RunReceipt[],
      error: row.error as string | null,
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      createdAt: new Date(row.created_at as string),
    };
  }
}
