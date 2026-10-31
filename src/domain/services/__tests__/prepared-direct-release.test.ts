import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { completePreparedDirectRelease, createPreparedDirectReleaseControl, reviewPreparedDirectReleaseActions } from '../prepared-direct-release.service.js';
import type { PlanAction } from '../../plan/plan.types.js';
import type { PreparedDirectReleaseTarget } from '../../ports/hosting-prepared.port.js';

// Real SQLite/CAS authority boundary. Native lifetime, revision and final
// configuration evidence is exercised independently by the Cloud Run transport suite.
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hv-direct-release-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'state.db')).migrate(); });
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const target: PreparedDirectReleaseTarget = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64),
  workload: 'web', provider: 'cloudrun', projectId: 'test-project', environmentId: 'us-central1', resourceId: 'prepared-web', resourceUid: 'original-native-uid',
  holdingRevision: 'projects/test-project/locations/us-central1/services/prepared-web/revisions/holding-00001', configurationDigest: 'c'.repeat(64),
  imageUri: `us-central1-docker.pkg.dev/test-project/images/app@sha256:${'d'.repeat(64)}` };
function fixture(command?: string) {
  const projects = new ProjectRepository(), environments = new EnvironmentRepository(), project = projects.create({ name: 'app' });
  const receipt = { purpose: 'local-holding', marker: 'immutable original receipt' };
  const environment = environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: target.provider, projectId: target.projectId, environmentId: target.environmentId, localPreparedHosting: receipt,
    services: { web: { serviceId: target.resourceId, resourceUid: target.resourceUid, imageUri: 'original-holding-image' } },
    preparedHosting: { schemaVersion: 1, installationId: target.installationId, planDigest: target.planDigest, receiptDigest: target.receiptDigest,
      pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: target.configurationDigest } },
  } });
  const state = { authorized: true, concurrent: false };
  const originalAction: PlanAction = { id: 'service:web', type: 'update', verified: true, requiresConfirm: true,
    resource: { kind: 'service', provider: 'cloudrun', name: 'web' }, reason: 'Review the first immutable application release.' };
  const load = () => environments.findById(environment.id)!;
  if (command) originalAction.diff = [{ field: 'releaseCommand', to: command }];
  const action = reviewPreparedDirectReleaseActions([originalAction], load(), { web: target.imageUri })[0]!;
  const control = (planRunId = 'plan-1', reviewed = action, confirmed = true) => createPreparedDirectReleaseControl({ planRunId, action: reviewed, confirmed, expectedImage: target.imageUri,
    load, authorize: () => state.authorized, save: (before, next) => {
      if (state.concurrent) environments.updatePlatformBindings(before.id, { independent: 'preserve' });
      return !!environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, next);
    } });
  return { environments, receipt, state, action, load, control };
}
describe('prepared direct release durable authority', () => {
  it('orders a prepared worker after the service that owns its release migration', () => {
    const f = fixture('npm run db:migrate:production'), environment = f.load();
    (environment.platformBindings.preparedHosting as any).pendingFirstRelease.push('worker');
    (environment.platformBindings.preparedHosting as any).firstReleaseConfigurationDigests.worker = 'e'.repeat(64);
    (environment.platformBindings.services as any).worker = { serviceId: 'prepared-worker', resourceUid: 'worker-uid' };
    const worker = { ...f.action, id: 'service:worker', resource: { ...f.action.resource, name: 'worker' }, diff: [{ field: 'startCommand', to: 'npm run worker' }], metadata: {} };
    const reviewed = reviewPreparedDirectReleaseActions([worker, f.action], environment, { web: target.imageUri, worker: target.imageUri });
    expect(reviewed[0]!.dependsOn).toContain('service:web');
  });
  it('persists monotonic migration progress and requires a confirmed continuation after restart', async () => {
    const f = fixture('npm run db:migrate:production'), commandTarget = { ...target, releaseCommandHash: String((f.action.metadata?.preparedReleaseReview as any).releaseCommandHash) };
    const control = f.control(), attempt = await control.begin(commandTarget);
    await expect(control.checkpoint(attempt.id, { rolloutAttempted: true })).rejects.toThrow();
    await control.checkpoint(attempt.id, { releaseTask: { phase: 'create-started', jobName: 'exact-job' } });
    await expect(control.checkpoint(attempt.id, { releaseTask: { phase: 'job-ready', jobName: 'different-job', jobUid: 'uid', jobEtag: 'etag' } })).rejects.toThrow();
    await control.checkpoint(attempt.id, { releaseTask: { phase: 'job-ready', jobName: 'exact-job', jobUid: 'uid', jobEtag: 'etag' } });
    await control.settle(attempt.id, 'uncertain');
    const [review] = reviewPreparedDirectReleaseActions([f.action], f.load(), { web: target.imageUri });
    expect(review?.metadata?.preparedReleaseContinuation).toBe(attempt.id);
    const next = { releaseTask: { phase: 'run-started' as const, jobName: 'exact-job', jobUid: 'uid', jobEtag: 'etag' } };
    await expect(f.control('plan-2', review, false).checkpoint(attempt.id, next)).rejects.toThrow();
    await f.control('plan-2', review).checkpoint(attempt.id, next);
    await expect(f.control('plan-2', review).checkpoint(attempt.id, next)).rejects.toThrow();
    expect((await f.control('plan-2', review).read(commandTarget))?.releaseTask?.phase).toBe('run-started');
  });
  it('records before dispatch and never replays an uncertain attempt, including a new apply plan', async () => {
    const f = fixture(), control = f.control(), attempt = await control.begin(target);
    expect(await control.read(target)).toEqual(attempt);
    await control.settle(attempt.id, 'uncertain');
    expect(await f.control('plan-2').read(target)).toMatchObject({ id: attempt.id, status: 'uncertain' });
    await expect(f.control('plan-2').begin(target)).rejects.toThrow();
    expect((f.load().platformBindings.preparedDirectReleaseAttempts as any).web.id).toBe(attempt.id);
    expect(reviewPreparedDirectReleaseActions([f.action], f.load(), { web: target.imageUri })[0]).toMatchObject({ verified: false, requiresConfirm: false,
      metadata: { blockedReason: expect.stringContaining('unresolved') } });
  });
  it('requires a new saved review and actual confirmation for the exact rejected attempt', async () => {
    const f = fixture(), original = await f.control().begin(target); await f.control().settle(original.id, 'rejected');
    const [review] = reviewPreparedDirectReleaseActions([f.action], f.load(), { web: target.imageUri });
    expect(review).toMatchObject({ requiresConfirm: true, metadata: { preparedReleaseRetry: original.id } });
    await expect(f.control('plan-1', review).begin(target)).rejects.toThrow();
    await expect(f.control('plan-2').begin(target)).rejects.toThrow();
    await expect(f.control('plan-2', review, false).begin(target)).rejects.toThrow();
    const retried = await f.control('plan-2', review).begin(target);
    expect(retried.id).not.toBe(original.id); expect(retried.status).toBe('attempted');
    await expect(f.control('plan-3', review).begin(target)).rejects.toThrow();
  });
  it.each(['source', 'confirmation', 'noop', 'identity', 'image', 'review-scope', 'concurrent'] as const)('blocks %s changes without overwriting recovery state', async change => {
    const f = fixture(); if (change === 'source') f.state.authorized = false; if (change === 'concurrent') f.state.concurrent = true;
    const next = { ...target, ...(change === 'identity' ? { resourceUid: 'replaced-uid' } : {}), ...(change === 'image' ? { imageUri: target.imageUri.replace(/d/g, 'e') } : {}) };
    const control = f.control('plan-1', change === 'noop' ? { ...f.action, type: 'noop' } : change === 'review-scope'
      ? { ...f.action, metadata: { ...f.action.metadata, preparedReleaseReview: { receiptDigest: 'e'.repeat(64) } } } : f.action, change !== 'confirmation');
    await expect(control.begin(next)).rejects.toThrow();
    expect(f.load().platformBindings.preparedDirectReleaseAttempts).toBeUndefined();
    if (change === 'concurrent') expect(f.load().platformBindings.independent).toBe('preserve');
  });
  it('preserves prerequisite actions and requires exact fresh native completion before ignoring an image-selector-only diff', async () => {
    const f = fixture();
    const prerequisite = { ...f.action, id: 'runtime-identity:web', metadata: { operation: 'runtimeIdentity' } };
    expect(reviewPreparedDirectReleaseActions([prerequisite], f.load(), { web: target.imageUri })).toEqual([prerequisite]);
    const attempt = await f.control().begin(target);
    const evidence = { schemaVersion: 1 as const, kind: 'native-direct' as const, attemptId: attempt.id, target,
      revision: target.holdingRevision.replace('holding-00001', 'application-00002'), generation: '2' };
    f.environments.updatePlatformBindings(f.load().id, completePreparedDirectRelease(f.load(), evidence));
    const drift = { ...f.action, diff: [{ field: 'env:IMAGE_URI' }] };
    expect(reviewPreparedDirectReleaseActions([drift], f.load(), { web: target.imageUri })[0].type).toBe('update');
    expect(reviewPreparedDirectReleaseActions([drift], f.load(), { web: target.imageUri }, [evidence])[0].type).toBe('noop');
    expect(reviewPreparedDirectReleaseActions([drift], f.load(), { web: target.imageUri }, [{ ...evidence, target: { ...target, resourceUid: 'replacement' } }])[0].type).toBe('update');
    expect(reviewPreparedDirectReleaseActions([{ ...drift, diff: [{ field: 'env:SETTING' }] }], f.load(), { web: target.imageUri }, [evidence])[0].type).toBe('update');
  });
  it('atomically retains exact native completion and retires only this pending release, with idempotent export recovery', async () => {
    const f = fixture(), attempt = await f.control().begin(target);
    const evidence = { schemaVersion: 1, kind: 'native-direct', attemptId: attempt.id, target,
      revision: target.holdingRevision.replace('holding-00001', 'application-00002'), generation: '2' };
    expect(() => completePreparedDirectRelease(f.load(), { ...evidence, revision: target.holdingRevision })).toThrow();
    const before = f.load(), next = completePreparedDirectRelease(before, evidence);
    expect(f.environments.compareAndSwapPlatformBindings(before.id, before.platformBindings, { ...next,
      services: { web: { serviceId: target.resourceId, resourceUid: target.resourceUid, imageUri: target.imageUri } } })).toBeTruthy();
    expect(f.load().platformBindings.preparedHosting).toMatchObject({ pendingFirstRelease: [], receiptDigest: target.receiptDigest });
    expect(f.load().platformBindings.localPreparedHosting).toEqual(f.receipt);
    expect(completePreparedDirectRelease(f.load(), evidence)).toEqual(f.load().platformBindings);
  });
});
