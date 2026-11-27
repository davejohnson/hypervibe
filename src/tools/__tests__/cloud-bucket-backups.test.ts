import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { gcpEngine } from '../../application/cloud-engines.js';
import { recordEnginePlan } from '../../application/engine-shared.js';
import { observeCloudBucketBackup } from '../../application/cloud-bucket-backups.js';
import { ConvergeExecutor, planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { SpecStore } from '../../domain/spec/spec.store.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-bucket-plan-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'test.sqlite')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'uploaded-files', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
  const store = new SpecStore();
  store.replace(project, { version: 1, project: project.name, environments: { production: { hosting: { provider: 'cloudrun' },
    storage: { documents: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: [] } } } } });
  return { ctx, project, environment, store, commands: createCommandRegistry(ctx) };
}

it('routes only explicit bucket backup intent to its own reviewed plan, through the public command', async () => {
  const { ctx, project, environment, store, commands } = fixture();
  const configurationDigest = 'a'.repeat(64), planId = 'selected';
  const state = { provider: 'gcp', projectId: project.id, environmentId: 'separate-archive-state', partition: 'environment' };
  const engine = { bucketBackup: { provider: 'gcp', programs: [{ storageName: 'documents', source: 'gs://files', archive: 'gs://archive',
    configurationDigest, planId, state, scopeFingerprint: 'b'.repeat(64) }] } };
  const action: PlanAction = { id: 'bucket-backup:documents', type: 'create', verified: true, billable: true, requiresConfirm: true,
    resource: { kind: 'storage', provider: 'gcp', name: 'daily copy' }, reason: 'Archive files daily.',
    metadata: { engineSegment: { id: 'opentofu:selected', engine: 'opentofu', planDigest: 'e'.repeat(64), configurationDigest,
      engineVersion: '1', providerVersions: {}, addresses: ['google_storage_bucket.archive'] } } };
  const plan = vi.spyOn(gcpEngine, 'planBucketBackups').mockImplementation(async (_ctx, params) => recordEnginePlan({
    projectId: project.id, environmentId: environment.id, environmentName: environment.name, specRevision: params.specRevision,
    scope: 'bucket-backups', actions: [action], engine, warnings: [],
  }));
  const input = { project: project.name, env: environment.name, scope: 'backups' };
  expect((await commands.execute('hv_plan', input)).ok).toBe(false);
  expect(plan).not.toHaveBeenCalled();
  store.merge(project, { environments: { production: { storage: { documents: { automatedBackups: true } } } } });
  expect((await commands.execute('hv_plan', { ...input, envVars: { UNRELATED: 'deploy' } })).ok).toBe(false);
  expect(plan).not.toHaveBeenCalled();
  const result = await commands.execute('hv_plan', input);
  expect(result).toMatchObject({ ok: true, data: { confirmActions: [action.id], actions: [{ id: action.id }] } });
  const id = (result.data as { planId: string }).planId;
  const loaded = new ConvergeExecutor().loadPlan(id);
  if ('error' in loaded) throw Error(loaded.error);
  expect(loaded.document.scope).toBe('bucket-backups');
  expect(ctx.repos.runs.findById(id)?.environmentId).toBe(environment.id);
  for (const patch of [{ scope: 'infrastructure-engine' }, { overrides: { services: ['web'] } },
    { actions: [{ ...action, requiresConfirm: false }] }, { actions: [{ ...action, type: 'destroy' }] },
    { actions: [{ ...action, id: 'bucket-backup:other' }] }, { actions: [{ ...action, metadata: {} }] }]) {
    expect(planRunDocumentSchema.safeParse({ ...loaded.document, ...patch }).success).toBe(false);
  }
});

it('requires a completed backup of the selected source and archive in the past 24 hours', async () => {
  const { project, store, environment, commands } = fixture();
  store.merge(project, { environments: { production: { storage: { documents: { automatedBackups: true } } } } });
  const spec = store.get(project)!.spec.environments.production!;
  const read = vi.spyOn(gcpEngine, 'observeBucketBackup');
  const observe = () => observeCloudBucketBackup(project, environment, spec, 'documents');
  const point = { source: 'source-id', archive: 'archive-id', latestAt: new Date().toISOString() };
  read.mockResolvedValue(point);
  expect(await observe()).toEqual(point);
  const lastBackup = new Date(Date.now() - 3 * 86400000).toISOString(), day = lastBackup.slice(0, 10);
  const files = [{ date: day, manifestKey: 'history/day/manifest.json' }];
  read.mockResolvedValue({ ...point, latestAt: lastBackup, archiveLocation: 'gs://archive', recoveryPoints: files });
  vi.spyOn(gcpEngine, 'planBucketBackups').mockResolvedValue({ planRunId: 'unchanged', specRevision: 2,
    environmentName: environment.name, actions: [], confirmActions: [], warnings: [] });
  const review = await commands.execute('hv_plan', { project: project.name, env: environment.name, scope: 'backups' });
  expect(review).toMatchObject({ ok: true, data: { confirmActions: [], bucketBackups: [{
    storageName: 'documents', archive: 'gs://archive', status: 'overdue', lastBackup, recoveryPoints: files,
  }] } });
  for (const bad of [{ latestAt: new Date(Date.now() - 25 * 3600000).toISOString() }, { latestAt: 'unknown' },
    { latestAt: new Date(Date.now() + 3600000).toISOString() }, { archive: point.source }]) {
    read.mockResolvedValue({ ...point, ...bad });
    expect(await observe()).toBeUndefined();
  }
  read.mockRejectedValue(new Error('unavailable'));
  expect(await observe()).toBeUndefined();
});
