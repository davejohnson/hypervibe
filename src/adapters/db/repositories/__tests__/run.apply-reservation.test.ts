import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EnvironmentRepository } from '../environment.repository.js';
import { ProjectRepository } from '../project.repository.js';
import { RunRepository } from '../run.repository.js';
import { getDb, initializeDatabase, SqliteAdapter } from '../../sqlite.adapter.js';

describe('apply-run reservation persistence', () => {
  let tempDir: string;
  let projectId: string;
  let environmentId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-apply-reservation-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    const project = new ProjectRepository().create({ name: 'apply-reservation-test' });
    projectId = project.id;
    environmentId = new EnvironmentRepository().create({
      projectId,
      name: 'production',
    }).id;
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function planRunId(name: string): string {
    return new RunRepository().create({
      projectId,
      environmentId,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'production',
        specRevision: 1,
        observedFingerprint: null,
        actions: [],
        name,
      },
    }).id;
  }

  it('enforces active-environment and successful-plan uniqueness in SQLite', () => {
    const repository = new RunRepository();
    const firstPlanId = planRunId('first');
    const reservation = repository.reserveApply({
      projectId,
      environmentId,
      planRunId: firstPlanId,
      environmentName: 'production',
      specRevision: 1,
    });
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) throw new Error('Expected the first apply reservation to succeed.');

    const now = new Date().toISOString();
    expect(() => getDb().prepare(`
      INSERT INTO runs (
        id, project_id, environment_id, type, status, plan, receipts, started_at, created_at
      )
      VALUES ('raw-running-conflict', ?, ?, 'apply', 'running', ?, '[]', ?, ?)
    `).run(
      projectId,
      environmentId,
      JSON.stringify({ planRunId: planRunId('second') }),
      now,
      now
    )).toThrow(/UNIQUE constraint failed/i);

    repository.updateStatus(reservation.run.id, 'succeeded');
    expect(() => getDb().prepare(`
      INSERT INTO runs (
        id, project_id, environment_id, type, status, plan, receipts, started_at, completed_at, created_at
      )
      VALUES ('raw-success-conflict', ?, ?, 'apply', 'succeeded', ?, '[]', ?, ?, ?)
    `).run(
      projectId,
      environmentId,
      JSON.stringify({ planRunId: firstPlanId }),
      now,
      now,
      now
    )).toThrow(/UNIQUE constraint failed: index 'idx_runs_succeeded_apply_plan'/i);
  });

  it('installs the migration over malformed legacy run JSON without weakening the indexes', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.exec(`
      DROP INDEX idx_runs_succeeded_apply_plan;
      DROP INDEX idx_runs_running_apply_environment;
      DELETE FROM schema_migrations WHERE version = 11;
    `);
    db.prepare(`
      INSERT INTO runs (
        id, project_id, environment_id, type, status, plan, receipts, completed_at, created_at
      )
      VALUES ('legacy-malformed-apply', ?, ?, 'apply', 'succeeded', '{broken', '[]', ?, ?)
    `).run(projectId, environmentId, now, now);

    expect(() => SqliteAdapter.getInstance().migrate()).not.toThrow();
    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_runs_%_apply_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      'idx_runs_running_apply_environment',
      'idx_runs_succeeded_apply_plan',
    ]);
  });

  it('atomically conflicts when either apply locks the other environment', () => {
    const sourceEnvironmentId = new EnvironmentRepository().create({
      projectId,
      name: 'staging',
    }).id;
    const repository = new RunRepository();
    const migration = repository.reserveApply({
      projectId,
      environmentId,
      planRunId: planRunId('migration'),
      environmentName: 'production',
      specRevision: 1,
      lockEnvironmentIds: [sourceEnvironmentId],
    });
    expect(migration.reserved).toBe(true);

    const sourcePlanId = new RunRepository().create({
      projectId,
      environmentId: sourceEnvironmentId,
      type: 'plan',
      plan: { kind: 'hv_plan', environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions: [] },
    }).id;
    expect(repository.reserveApply({
      projectId,
      environmentId: sourceEnvironmentId,
      planRunId: sourcePlanId,
      environmentName: 'staging',
      specRevision: 1,
    })).toMatchObject({ reserved: false, reason: 'environment_in_progress' });
  });

  it('refuses to bypass the atomic reservation through generic run creation', () => {
    expect(() => new RunRepository().create({
      projectId,
      environmentId,
      type: 'apply',
      plan: { planRunId: planRunId('generic-create') },
    })).toThrow('Apply runs must be created with RunRepository.reserveApply().');
  });
});
