import { randomUUID } from 'crypto';
import { lstatSync } from 'node:fs';
import { runPlanReportPath, writeRunPlanReport } from '../../storage/plan-report-files.js';
import { getDb } from '../sqlite.adapter.js';
import { parseJsonColumn } from '../json.codec.js';
import { runPlanColumnSchema, runReceiptsColumnSchema } from '../column.schemas.js';
import type { Run, CreateRunInput, RunStatus, RunReceipt } from '../../../domain/entities/run.entity.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';

export interface ReserveApplyInput {
  projectId: string;
  environmentId: string;
  planRunId: string;
  environmentName: string;
  specRevision: number;
  /** Additional environment ids whose durable data this apply reads/writes. */
  lockEnvironmentIds?: string[];
  /** Exact shared resource identities; unlike environment locks, these span projects. */
  lockResourceKeys?: string[];
}

export type ReserveApplyResult =
  | { reserved: true; run: Run }
  | {
    reserved: false;
    reason: 'already_applied' | 'plan_in_progress' | 'environment_in_progress' | 'resource_in_progress';
    conflictingRunId: string;
  };

function isSavedPlan(run: Run): boolean {
  return run.type === 'plan' && 'kind' in run.plan && run.plan.kind === 'hv_plan';
}

export class RunRepository {
  create(input: CreateRunInput): Run {
    if (input.type === 'apply') {
      throw new Error('Apply runs must be created with RunRepository.reserveApply().');
    }

    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    // A report write failure must not leave an undisclosed executable plan.
    return db.transaction(() => {
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

      const run = this.findById(id)!;
      if (isSavedPlan(run)) writeRunPlanReport(run);
      return run;
    })();
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

      const requestedEnvironmentIds = new Set([
        input.environmentId,
        ...(input.lockEnvironmentIds ?? []),
      ]);
      const resourceKeys = (value: unknown): string[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !key.trim()))
          throw new Error('Apply resource lock identities are unreadable; existing mutation authority was preserved.');
        return value as string[];
      };
      const requestedResourceKeys = new Set(resourceKeys(input.lockResourceKeys));
      const activeApplies = db.prepare(`
        SELECT *
        FROM runs
        WHERE type = 'apply'
          AND status = 'running'
          AND (project_id = ? OR ? = 1)
        ORDER BY created_at ASC
      `).all(input.projectId, requestedResourceKeys.size > 0 ? 1 : 0) as Record<string, unknown>[];
      let conflictReason: 'plan_in_progress' | 'environment_in_progress' | 'resource_in_progress' = 'environment_in_progress';
      const activeApply = activeApplies.find((candidate) => {
        const activeDocument = parseJsonColumn(
          runPlanColumnSchema,
          candidate.plan,
          `runs.plan (${candidate.id})`
        ) as Record<string, unknown>;
        const locked = Array.isArray(activeDocument.lockEnvironmentIds)
          ? activeDocument.lockEnvironmentIds.filter((value): value is string => typeof value === 'string')
          : [];
        const environmentConflict = candidate.project_id === input.projectId
          && (requestedEnvironmentIds.has(candidate.environment_id as string)
            || locked.some(environmentId => requestedEnvironmentIds.has(environmentId)));
        const resourceConflict = requestedResourceKeys.size > 0
          && resourceKeys(activeDocument.lockResourceKeys).some(key => requestedResourceKeys.has(key));
        if (!environmentConflict && !resourceConflict) return false;
        conflictReason = activeDocument.planRunId === input.planRunId ? 'plan_in_progress'
          : environmentConflict ? 'environment_in_progress' : 'resource_in_progress';
        return true;
      });
      if (activeApply) {
        return {
          reserved: false,
          reason: conflictReason,
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
          lockEnvironmentIds: [...requestedEnvironmentIds],
          ...(requestedResourceKeys.size ? { lockResourceKeys: [...requestedResourceKeys].sort() } : {}),
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

  findSuccessfulApplyForStep(projectId: string, environmentId: string, step: string): Run | null {
    const row = getDb().prepare(`
      SELECT runs.* FROM runs WHERE project_id = ? AND environment_id = ?
        AND type = 'apply' AND status = 'succeeded'
        AND EXISTS (SELECT 1 FROM json_each(runs.receipts) WHERE json_extract(value, '$.step') = ?
          AND json_extract(value, '$.status') = 'success')
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, environmentId, step) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Durable release provenance must not expire behind unrelated recent activity. */
  findSuccessfulReleases(projectId: string, environmentIds: readonly string[]): Run[] {
    if (environmentIds.length === 0) return [];
    const rows = getDb().prepare(`
      SELECT * FROM runs
      WHERE project_id = ?
        AND environment_id IN (${environmentIds.map(() => '?').join(', ')})
        AND type = 'apply'
        AND status = 'succeeded'
      ORDER BY created_at DESC
    `).all(projectId, ...environmentIds) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((run) => run.receipts.some((receipt) => receipt.status === 'success' && receipt.step.startsWith('release:')));
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
    return db.transaction(() => {
      db.prepare('UPDATE runs SET plan = ? WHERE id = ?').run(JSON.stringify(plan), id);
      const run = this.findById(id);
      if (run && isSavedPlan(run)) writeRunPlanReport(run);
      return run;
    })();
  }

  /** Preserve other plan fields, including frozen inputs, when the command finishes its review. */
  updatePlanReview(id: string, review: { actions?: PlanAction[]; reviewBlockers: string[] }): void {
    getDb().transaction(() => {
      const run = this.findById(id);
      if (run && isSavedPlan(run)) this.updatePlan(id, { ...run.plan, ...review });
    }).immediate();
  }

  /** Read and export one exact saved plan without racing a revision to its actions. */
  planReport(id: string, regenerate = false): { htmlPath: string } | undefined {
    return getDb().transaction(() => {
      const run = this.findById(id);
      if (!run || !isSavedPlan(run)) return undefined;
      const htmlPath = runPlanReportPath(id);
      if (!regenerate && lstatSync(htmlPath, { throwIfNoEntry: false })?.isFile()) return { htmlPath };
      return writeRunPlanReport(run);
    }).immediate();
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
