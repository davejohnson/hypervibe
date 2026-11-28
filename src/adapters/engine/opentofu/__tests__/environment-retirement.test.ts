import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunRepository } from '../../../db/repositories/run.repository.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../db/sqlite.adapter.js';
import type { EngineConfiguration, EngineResourceMapping, EngineStateIdentity, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { OpenTofuEngine } from '../engine.js';
import { configurationDigest, engineStatePaths, ensureEngineStateDirectories } from '../workspace.js';

let dir: string;
let state: EngineStateIdentity;
const scope = { provider: 'aws' as const, region: 'us-west-2', prefix: 'hv-check', accountId: '111122223333' };
const type = 'aws_ecs_task_definition';
const address = type + '.nightly';
const mapping: EngineResourceMapping = { kind: 'service', name: 'nightly', actionId: 'service:nightly' };
const files = { 'tasks.tf.json': { resource: { [type]: { nightly: { family: 'hv-check-nightly' } } } } };
const prior: EngineConfiguration = { resources: { [address]: mapping }, files };
const runs = new RunRepository();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-retirement-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', dir);
  SqliteAdapter.resetInstance();
  initializeDatabase(path.join(dir, 'db'));
  const project = new ProjectRepository().create({ name: 'retire' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'prod' });
  state = { projectId: project.id, environmentId: environment.id, provider: 'aws', partition: 'environment' };
  ensureEngineStateDirectories(engineStatePaths(state, dir));
});
afterEach(() => { SqliteAdapter.resetInstance(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function record(id: string, outcome: string, target = scope, actionType = 'create',
  review?: { addresses: string[]; reason: string; operations?: Record<string, string> }) {
  const addresses = review?.addresses ?? [address];
  const segment = { id: 'opentofu:' + id, engine: 'opentofu', planDigest: 'd'.repeat(64),
    configurationDigest: configurationDigest(prior), addresses, ...(review?.operations ? { operations: review.operations } : {}) };
  const plan = runs.create({ ...state, type: 'plan', plan: { kind: 'hv_plan', scope: 'infrastructure-engine',
    engine: { state, planId: id, aws: target }, environmentName: 'prod', specRevision: 1,
    actions: [{ id: mapping.actionId, verified: true, type: actionType, reason: review?.reason ?? 'Fixture', resource: { ...mapping, provider: 'aws' }, metadata: { engineSegment: segment } }] } });
  const reserved = runs.reserveApply({ ...state, environmentName: 'prod', specRevision: 1, planRunId: plan.id });
  if (!reserved.reserved) throw new Error('test apply lock unavailable');
  runs.addReceipt(reserved.run.id, { step: mapping.actionId, status: outcome === 'succeeded' ? 'success' : outcome === 'not_started' ? 'blocked' : 'pending',
    result: { engineSegment: segment.id, outcomes: Object.fromEntries(addresses.map(a => [a, outcome])) }, timestamp: new Date().toISOString() });
  runs.updateStatus(reserved.run.id, outcome === 'succeeded' ? 'succeeded' : outcome === 'not_started' ? 'blocked' : 'failed');
  fs.writeFileSync(path.join(engineStatePaths(state, dir).plans, id + '.config.json'), JSON.stringify(prior));
}

async function plan(family = 'hv-check-nightly', actions = ['delete']) {
  const engine = new OpenTofuEngine({ binary: 'test', cipher: {} as never, dataDir: dir,
    appliedDeclarations: (state, scope, addresses) => runs.appliedEngineDeclarations(state, scope, addresses) });
  const directory = fs.mkdtempSync(path.join(dir, 'prepared-'));
  fs.writeFileSync(path.join(directory, 'saved.tfplan'), 'private fixture');
  // Replace the provider boundary, keeping the real engine planner, repository and review translation.
  const boundary = engine as unknown as { prepare(): Promise<unknown>; run(): Promise<unknown> };
  vi.spyOn(boundary, 'prepare').mockResolvedValue({ ok: true, directory, env: {}, redact: [] });
  const stdout = JSON.stringify({ format_version: '1.2', resource_changes: [{ type, address, mode: 'managed',
    change: { actions, before: { family }, after: null } }] });
  vi.spyOn(boundary, 'run').mockResolvedValue({ exitCode: 0, stdout });
  const result = await engine.plan({ state, planId: 'current', retirementScope: scope, backend: { provider: 'aws', providerRequirements: {} } as InfrastructureEngineBackend,
    auth: { env: {}, redact: [] }, configuration: { files: {}, resources: {} } });
  if (!result.ok) throw new Error(result.error);
  return result;
}

it('recovers an explicitly reviewable removal only for the previously applied declaration and native name', async () => {
  expect((await plan()).unmanagedDeletes).toEqual([address]);
  record('original', 'succeeded');
  expect((await plan()).actions).toContainEqual(expect.objectContaining({ id: 'service:nightly', type: 'destroy', requiresConfirm: true }));
  expect((await plan('unrelated')).unmanagedDeletes).toEqual([address]);
  expect((await plan(undefined, ['delete', 'create'])).blockers).not.toEqual([]);
  record('different-region', 'succeeded', { ...scope, region: 'us-east-1' });
  expect((await plan()).unmanagedDeletes).toEqual([address]);
});
it('refuses a modified prior configuration, a later uncertain apply, and an already retired declaration', async () => {
  record('original', 'succeeded');
  fs.writeFileSync(path.join(engineStatePaths(state, dir).plans, 'original.config.json'), JSON.stringify({ ...prior, files: {} }));
  expect((await plan()).unmanagedDeletes).toEqual([address]);
  record('retry', 'unknown');
  expect((await plan()).unmanagedDeletes).toEqual([address]);
  record('retired', 'succeeded', scope, 'destroy');
  expect((await plan()).unmanagedDeletes).toEqual([address]);
});

it('retains the last ownership evidence when a retry did not start', async () => {
  record('first-attempt', 'not_started');
  expect((await plan()).unmanagedDeletes).toEqual([address]);
  record('original', 'succeeded');
  record('retirement-preflight', 'not_started', scope, 'destroy');
  expect((await plan()).unmanagedDeletes).toEqual([]);
  record('interrupted', 'unknown');
  record('second-preflight', 'not_started');
  expect((await plan()).unmanagedDeletes).toEqual([address]);
});

it.each(['structured', 'legacy'])('recovers only surviving addresses in a mixed %s action', format => {
  const deleted = 'aws_scheduler_schedule.nightly';
  const addresses = [address, deleted];
  const reason = 'OpenTofu will update ' + address + ', delete ' + deleted + '.';
  const applied = () => runs.appliedEngineDeclarations(state, scope, addresses).map(row => row.address);
  record('mixed', 'succeeded', scope, 'destroy', { addresses, reason,
    ...(format === 'structured' ? { operations: { [address]: 'update', [deleted]: 'delete' } } : {}) });
  expect(applied()).toEqual([address]);
  if (format === 'structured') {
    record('retired', 'succeeded', scope, 'replace', { addresses, reason,
      operations: { [address]: 'delete', [deleted]: 'create' } });
    expect(applied()).toEqual([deleted]);
  } else {
    record('incomplete', 'succeeded', scope, 'destroy', { addresses, reason: 'OpenTofu will update ' + address + '.' });
    expect(applied()).toEqual([]);
  }
});
