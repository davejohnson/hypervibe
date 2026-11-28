import { randomUUID } from 'crypto';
import { lstatSync } from 'node:fs';
import { runPlanReportPath, writeRunPlanReport } from '../../storage/plan-report-files.js';
import { getDb } from '../sqlite.adapter.js';
import { parseJsonColumn } from '../json.codec.js';
import { runPlanColumnSchema, runReceiptsColumnSchema } from '../column.schemas.js';
import type { Run, CreateRunInput, RunStatus, RunReceipt } from '../../../domain/entities/run.entity.js';
import { engineSegmentOf, type AppliedEngineDeclaration, type EngineRetirementScope, type EngineStateIdentity } from '../../../domain/ports/infrastructure-engine.port.js';
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

/** A grouped action can remove one address while creating or updating another. */
function retainedAfterApply(action: PlanAction, address: string): boolean {
  const segment = engineSegmentOf(action);
  if (!segment || new Set(segment.addresses).size !== segment.addresses.length
    || (action.type === 'destroy' && segment.addresses.length === 1)) return false;
  if (segment.operations !== undefined) {
    const operation = segment.operations?.[address];
    return operation === 'create' || operation === 'update' || operation === 'replace' || operation === 'import';
  }
  if (action.type === 'create' || action.type === 'update' || segment.addresses.length === 1) return true;

  // Older plans recorded the individual operations in their generated review sentence.
  // Require an exact clause for every segment address, in the same order, before using it.
  const prefix = 'OpenTofu will ';
  if (typeof action.reason !== 'string' || !action.reason.startsWith(prefix) || !action.reason.endsWith('.')) return false;
  const clauses = action.reason.slice(prefix.length, -1).split(', ');
  if (clauses.length !== segment.addresses.length) return false;
  const operations = clauses.map((clause, index) => {
    const match = /^(create|update|replace|delete|adopt the explicitly selected existing) (\S+)$/.exec(clause);
    return match?.[2] === segment.addresses[index] ? match?.[1] : undefined;
  });
  return operations.every(Boolean) && (action.type !== 'destroy' || operations.includes('delete'))
    && operations[segment.addresses.indexOf(address)] !== 'delete';
}

export class RunRepository {
  /** Only the latest attempt that could have changed the resource can prove ownership. */
  appliedEngineDeclarations(state: EngineStateIdentity, scope: EngineRetirementScope, addresses: string[]): AppliedEngineDeclaration[] {
    if (!addresses.length || state.partition !== 'environment' || state.provider !== scope.provider) return [];
    const rows = getDb().prepare(`
      WITH history AS (
        SELECT o.key AS address, o.value AS outcome, p.plan AS document, a.value AS action,
          r.value AS receipt, ROW_NUMBER() OVER (PARTITION BY o.key ORDER BY u.rowid DESC, r.key DESC) AS latest
        FROM runs u JOIN runs p ON p.id = json_extract(u.plan, '$.planRunId')
        JOIN json_each(u.receipts) r JOIN json_each(r.value, '$.result.outcomes') o
        JOIN json_each(p.plan, '$.actions') a ON json_extract(a.value, '$.id') = json_extract(r.value, '$.step')
        WHERE u.project_id = ? AND u.environment_id = ? AND u.type = 'apply'
          AND p.project_id = u.project_id AND p.environment_id = u.environment_id AND p.type = 'plan'
          AND o.key IN (SELECT value FROM json_each(?))
          AND o.value IS NOT 'not_started'
          AND json_extract(r.value, '$.result.engineSegment') = 'opentofu:' || json_extract(p.plan, '$.engine.planId')
      )
      SELECT address, json_extract(document, '$.engine.planId') AS planId,
        json_extract(action, '$.metadata.engineSegment.configurationDigest') AS configurationDigest,
        json_extract(action, '$.id') AS actionId, json_extract(action, '$.resource.kind') AS kind,
        json_extract(action, '$.resource.name') AS name, json_extract(document, ?) AS target, action
      FROM history
      WHERE latest = 1 AND outcome = 'succeeded'
        AND json_extract(document, '$.kind') = 'hv_plan' AND json_extract(document, '$.scope') = 'infrastructure-engine'
        AND json_extract(document, '$.engine.teardown') IS NOT 1
        AND json_extract(document, '$.engine.state.provider') = ?
        AND json_extract(document, '$.engine.state.partition') = 'environment'
        AND json_extract(document, '$.engine.state.projectId') = ? AND json_extract(document, '$.engine.state.environmentId') = ?
        AND json_extract(action, '$.resource.provider') = ? AND json_extract(action, '$.verified') = 1
        AND json_extract(action, '$.type') IN ('create', 'update', 'replace', 'destroy')
        AND json_extract(action, '$.metadata.engineSegment.id') = json_extract(receipt, '$.result.engineSegment')
        AND address IN (SELECT value FROM json_each(action, '$.metadata.engineSegment.addresses'))
    `).all(state.projectId, state.environmentId, JSON.stringify(addresses), '$.engine.' + scope.provider,
      scope.provider, state.projectId, state.environmentId, scope.provider) as Array<AppliedEngineDeclaration & { target: string | null; action: string }>;
    return rows.flatMap(({ target: rawTarget, action, ...proof }) => {
      const target = JSON.parse(rawTarget ?? 'null') as Record<string, unknown> | null;
      if (!target || !Object.entries(scope).every(([key, value]) => key === 'provider' || target[key] === value)) return [];
      return retainedAfterApply(JSON.parse(action) as PlanAction, proof.address) ? [proof] : [];
    });
  }

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
