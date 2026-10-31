import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { initializeDatabase, SqliteAdapter, getDb } from '../../sqlite.adapter.js';
import { ProjectRepository } from '../project.repository.js';
import { EnvironmentRepository } from '../environment.repository.js';
import { RunRepository } from '../run.repository.js';
import { CloudScopePreparationRepository } from '../cloud-scope-preparation.repository.js';

const schema = z.object({ schemaVersion: z.literal(1), installationId: z.string().guid(), revision: z.number().int().nonnegative(),
  intent: z.object({ appId: z.string(), environment: z.string(), source: z.string(), nativeScope: z.object({ projectId: z.string() }) }).strict(),
  plan: z.object({ digest: z.string() }).strict(), completed: z.record(z.string(), z.unknown()), attempts: z.array(z.object({ id: z.string(), status: z.string() }).strict()),
  status: z.enum(['review-required', 'pending', 'scope-ready']) }).strict();
type Record = z.infer<typeof schema>;
let directory: string;
let scope: { projectId: string; environmentId: string; environmentName: string };
let repository: CloudScopePreparationRepository<Record>;
const parse = (value: unknown) => schema.parse(value);
function record(installationId: string = randomUUID()): Record {
  return { schemaVersion: 1, installationId, revision: 0,
    intent: { appId: scope.projectId, environment: scope.environmentName, source: 'reviewed-source', nativeScope: { projectId: 'isolated-test-project' } },
    plan: { digest: 'reviewed-plan' }, completed: {}, attempts: [], status: 'review-required' };
}
function attempted(current: Record): Record {
  return { ...structuredClone(current), revision: current.revision + 1, attempts: [{ id: randomUUID(), status: 'attempted' }], status: 'pending' };
}
beforeEach(() => {
  SqliteAdapter.resetInstance(); directory = mkdtempSync(path.join(tmpdir(), 'hv-cloud-scope-journal-'));
  initializeDatabase(path.join(directory, 'state.db'));
  const project = new ProjectRepository().create({ name: 'operator-test-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'connect-test' });
  scope = { projectId: project.id, environmentId: environment.id, environmentName: environment.name };
  repository = new CloudScopePreparationRepository(scope, parse);
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

it('persists one exact revision winner and retains native uncertainty after reopening', async () => {
  const first = record(); expect(await repository.compareAndSwap(first.installationId, null, first)).toBe(true);
  const left = await repository.read(first.installationId); const right = await repository.read(first.installationId);
  expect(left).toEqual(first); expect(right).toEqual(first);
  const next = attempted(left!);
  expect(await repository.compareAndSwap(first.installationId, 0, next)).toBe(true);
  expect(await repository.compareAndSwap(first.installationId, 0, attempted(right!))).toBe(false);
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db'));
  expect(await repository.read(first.installationId)).toEqual(next);
  expect(await repository.findByScope()).toEqual([next]);
});

it('fences a second reviewed proposal when the first begins an attempt, even after completion or source changes', async () => {
  const first = record(), second = record();
  expect(await repository.compareAndSwap(first.installationId, null, first)).toBe(true);
  expect(await repository.compareAndSwap(second.installationId, null, second)).toBe(true);
  const next = attempted(first);
  expect(await repository.compareAndSwap(first.installationId, 0, next)).toBe(true);
  expect(await repository.compareAndSwap(second.installationId, 0, attempted(second))).toBe(false);
  expect(await repository.compareAndSwap(first.installationId, 1, { ...next, revision: 2, status: 'scope-ready' })).toBe(true);
  const replacement = record(); replacement.intent.source = 'later-source'; replacement.intent.nativeScope.projectId = 'another-test-project';
  expect(await repository.compareAndSwap(replacement.installationId, null, replacement)).toBe(false);
  expect(await repository.read(second.installationId)).toEqual(second);
});

it('isolates projects and environments and never overwrites an ordinary plan with a colliding id', async () => {
  const first = record(); await repository.compareAndSwap(first.installationId, null, first);
  const staging = new EnvironmentRepository().create({ projectId: scope.projectId, name: 'staging' });
  const other = new CloudScopePreparationRepository({ ...scope, environmentId: staging.id, environmentName: staging.name }, parse);
  expect(await other.read(first.installationId)).toBeNull(); expect(await other.findByScope()).toEqual([]);
  const otherRecord = record(first.installationId); otherRecord.intent.environment = 'staging';
  expect(await other.compareAndSwap(first.installationId, null, otherRecord)).toBe(false);
  const ordinary = new RunRepository().create({ projectId: scope.projectId, environmentId: scope.environmentId, type: 'plan', plan: { kind: 'hv_plan' } });
  const colliding = record(ordinary.id);
  expect(await repository.compareAndSwap(colliding.installationId, null, colliding)).toBe(false);
  expect(new RunRepository().findById(ordinary.id)?.plan).toEqual({ kind: 'hv_plan' });
  const foreign = new ProjectRepository().create({ name: 'another-app' });
  const wrong = new CloudScopePreparationRepository({ ...scope, projectId: foreign.id }, parse);
  await expect(wrong.findByScope()).rejects.toThrow(/scope/i);
});

it.each(['scope', 'intent', 'plan', 'revision', 'identity'] as const)('rejects an invalid %s transition without changing the journal', async change => {
  const first = record(); await repository.compareAndSwap(first.installationId, null, first);
  const next = attempted(first);
  if (change === 'scope') next.intent.environment = 'production';
  if (change === 'intent') next.intent.source = 'different-source';
  if (change === 'plan') next.plan = { digest: 'different-plan' };
  if (change === 'revision') next.revision = 3;
  if (change === 'identity') next.installationId = randomUUID();
  await expect(repository.compareAndSwap(first.installationId, 0, next)).rejects.toThrow(/journal|scope|revision/i);
  expect(await repository.read(first.installationId)).toEqual(first);
});

it('retains malformed history as unknown instead of opening a second allocation', async () => {
  const first = record(); await repository.compareAndSwap(first.installationId, null, first);
  getDb().prepare('UPDATE runs SET plan = ? WHERE id = ?').run('{broken', first.installationId);
  await expect(repository.findByScope()).rejects.toThrow(/journal/i);
  const second = record(); await expect(repository.compareAndSwap(second.installationId, null, second)).rejects.toThrow(/journal/i);
  expect(getDb().prepare('SELECT plan FROM runs WHERE id = ?').get(first.installationId)).toEqual({ plan: '{broken' });
});

it('bounds history before interpreting rows and never drops older attempted evidence', async () => {
  const now = new Date().toISOString();
  const insert = getDb().prepare("INSERT INTO runs (id, project_id, environment_id, type, status, plan, receipts, created_at) VALUES (?, ?, ?, 'cloud-scope-preparation', 'pending', ?, '[]', ?)");
  for (let index = 0; index < 101; index++) {
    const value = record(); insert.run(value.installationId, scope.projectId, scope.environmentId, JSON.stringify(value), now);
  }
  await expect(repository.findByScope()).rejects.toThrow(/history.*limit/i);
  const next = record(); await expect(repository.compareAndSwap(next.installationId, null, next)).rejects.toThrow(/history.*limit/i);
});

it('refuses a 101st proposal while preserving read and recovery access to all 100 retained records', async () => {
  const retained = Array.from({ length: 100 }, () => record());
  for (const value of retained) expect(await repository.compareAndSwap(value.installationId, null, value)).toBe(true);
  const overflow = record();
  await expect(repository.compareAndSwap(overflow.installationId, null, overflow)).rejects.toThrow(/history.*limit/i);
  expect(await repository.read(overflow.installationId)).toBeNull();
  expect(await repository.findByScope()).toHaveLength(100);
  expect(await repository.compareAndSwap(retained[0].installationId, 0, attempted(retained[0]))).toBe(true);
  expect((await repository.read(retained[0].installationId))?.attempts).toHaveLength(1);
});

it('never imports an already-attempted or completed record as a fresh allocation', async () => {
  for (const forged of [
    { ...attempted(record()), revision: 0 },
    { ...record(), status: 'scope-ready' as const },
    { ...record(), completed: { 'gcp:project': { projectNumber: '123456' } } },
  ]) await expect(repository.compareAndSwap(forged.installationId, null, forged)).rejects.toThrow(/journal/i);
  expect(await repository.findByScope()).toEqual([]);
});

it('never erases or substitutes an attempted operation or a retained creation proof', async () => {
  const first = record(); await repository.compareAndSwap(first.installationId, null, first);
  const next = attempted(first); await repository.compareAndSwap(first.installationId, 0, next);
  for (const attempts of [[], [{ id: randomUUID(), status: 'attempted' }]]) {
    await expect(repository.compareAndSwap(first.installationId, 1, { ...next, revision: 2, attempts })).rejects.toThrow(/journal/i);
  }
  const completed = { ...next, revision: 2, status: 'scope-ready' as const,
    completed: { 'gcp:project': { projectNumber: '123456', createTime: '2026-10-25T00:00:00Z' } } };
  expect(await repository.compareAndSwap(first.installationId, 1, completed)).toBe(true);
  for (const proof of [{}, { 'gcp:project': { projectNumber: '987654' } }]) {
    await expect(repository.compareAndSwap(first.installationId, 2, { ...completed, revision: 3, completed: proof })).rejects.toThrow(/journal/i);
  }
  expect(await repository.read(first.installationId)).toEqual(completed);
});
