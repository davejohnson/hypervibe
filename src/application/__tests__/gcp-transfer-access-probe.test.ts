import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/entities/project.entity.js';
import * as probeStorage from '../../adapters/storage/transfer-access-probe.js';
import { setupPlansDirectory } from '../../adapters/storage/gcp-setup-report.js';
import {
  findTransferAccessProbeReport,
  loadProbe,
  probeActions,
  storeProbe,
  readDestroyedTransferProbeVersions,
} from '../../adapters/storage/transfer-access-probe.js';
import { transferSlot } from '../../adapters/providers/gcp/tofu/transfer-slot.js';
import * as readiness from '../gcp-transfer-access-readiness.js';
import * as fixtures from '../../adapters/providers/gcp/gcp-transfer-probe-fixtures.js';
import * as jobs from '../migration-transfer-gcp.js';
import { runGcpTransferAccessProbe } from '../gcp-transfer-access-probe.js';

const target = {
  projectId: 'test-project',
  targetRegion: 'us-central1',
  sourceEnvironmentId: 'source-id',
  sourceRailwayProjectId: 'rail-project',
  sourceRailwayEnvironmentId: 'rail-env',
  targetEnvironmentId: 'dest-id',
};
const scope = {
  target,
  targetEnvironmentName: 'production-gcp',
  projectNumber: '123456',
  runtimeEmail: 'runtime@test-project.iam.gserviceaccount.com',
  runtimeUniqueId: '12',
  bucket: 'test-project-hv-build-source',
  bucketTimeCreated: '2026-01-01T00:00:00Z',
  copyUniqueId: '34',
  secretCreateTime: '2026-02-01T00:00:00Z',
};
const slot = transferSlot(target);
const version = {
  name: 'projects/123456/secrets/' + slot.secretId + '/versions/1',
  createTime: '2026-03-01T00:00:00Z',
  projectNumber: '123456',
  secretCreateTime: scope.secretCreateTime,
  etag: 'v1',
};
const destroyed = {
  name: version.name,
  createTime: version.createTime,
  projectNumber: '123456',
  secretCreateTime: scope.secretCreateTime,
  state: 'DESTROYED' as const,
};
const project = { id: 'local-project', name: 'demo', gitRemoteUrl: 'https://github.com/example/demo' } as Project;
const input = {
  project,
  target,
  targetEnvironmentName: scope.targetEnvironmentName,
  sourceEnvironmentName: 'production',
  runtimeEmail: scope.runtimeEmail,
  deployEmail: 'deploy@test-project.iam.gserviceaccount.com',
  token: async () => 'operator-test-token',
  confirm: false,
};
const log: string[] = [];
const sign = vi.fn(() => 'PRIVATE_SIGNED_URL_NEVER_STORED');
const ready = { scope, evidenceDigest: 'one', inventoryDigest: 'empty', softDeleteSeconds: 604800, sign };
const inspect = () => ({ ...ready });
const create = vi.fn();
const readObject = vi.fn();
const assertReady = vi.fn();
const assertFileReady = vi.fn();
const denied = { outcome: 'denied', media: { status: 403, classification: 'permission-denied' } };
const readable = { outcome: 'readable', media: { status: 206, classification: 'readable' } };
const inconclusive = { outcome: 'inconclusive', media: { status: 401, classification: 'inconclusive' } };
const destroy = vi.fn();
const del = vi.fn();
const add = vi.fn();
const runJob = vi.fn();
const recoverVersion = vi.fn();
let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-access-plan-test-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', dataDir);
  const dir = setupPlansDirectory({ projectId: project.id, gcpProjectId: target.projectId });
  fs.mkdirSync(dir, { recursive: true });
  fs.closeSync(fs.openSync(path.join(path.dirname(dir), 'setup-lock.sqlite'), 'a', 0o600));
  log.length = 0;
  vi.spyOn(readiness, 'originalProbeScope').mockReturnValue(scope);
  vi.spyOn(readiness, 'inspectProbeReadiness').mockImplementation(async () => inspect());
  create.mockImplementation(async () => {
    log.push('create-file');
    return { name: '', bucket: scope.bucket, generation: '123' };
  });
  del.mockImplementation(async () => {
    log.push('delete-file');
  });
  add.mockImplementation(async () => {
    log.push('add-version');
    return version;
  });
  destroy.mockImplementation(async () => {
    log.push('destroy-version');
    return destroyed;
  });
  recoverVersion.mockRejectedValue(new Error('unconfirmed'));
  vi.spyOn(fixtures, 'transferProbeFixtures').mockImplementation((_token, _scope, id) => {
    const objectName = `migrations/production-gcp/hypervibe-access-probe-${id}`;
    return {
      objectName,
      secretName: 'projects/123456/secrets/' + slot.secretId,
      assertReady, assertFileReady,
      createObject: async (m: string, before?: () => void) => {
        before?.();
        return { ...(await create(m)), name: objectName };
      },
      readObject,
      addVersion: async (m: string, url: string, o: unknown, before?: () => void) => {
        before?.();
        return add(m, url, o);
      },
      destroyVersion: destroy,
      deleteObject: del,
      recoverObject: async () => null,
      recoverVersion,
    } as ReturnType<typeof fixtures.transferProbeFixtures>;
  });
  runJob.mockImplementation(async (_ctx, { role }) => {
    log.push(role);
    return { ok: true };
  });
  vi.spyOn(jobs, 'runAccessProbeJob').mockImplementation(runJob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function preview(fileOnly?: boolean) {
  const p = await runGcpTransferAccessProbe({ ...input, fileOnly });
  expect(p).toMatchObject({ success: true, mode: 'preview', softDeleteSeconds: 604800 });
  return String(p.planId);
}
function confirm(planId: string, fileOnly?: boolean) {
  return runGcpTransferAccessProbe({ ...input, confirm: true, planId, fileOnly });
}
it('saves a native HTML review without creating resources and runs exactly the approved checks once', async () => {
  const id = await preview();
  expect(log).toEqual([]);
  const report = findTransferAccessProbeReport(project.id, target.projectId, id)!;
  const html = fs.readFileSync(report.htmlPath, 'utf8');
  expect(html).toContain('7 days');
  expect(html).toContain('15-minute');
  expect(html).toContain(scope.runtimeEmail);
  expect(await confirm(id)).toMatchObject({ success: true, mode: 'confirm' });
  expect(log).toEqual(['create-file', 'add-version', 'copy', 'app', 'destroy-version', 'delete-file']);
  expect(readDestroyedTransferProbeVersions(project.id, target.projectId, slot.secretId)).toEqual([destroyed]);
  expect(JSON.stringify(loadProbe(project.id, target.projectId, id))).not.toMatch(
    /PRIVATE_SIGNED_URL|operator-test-token/,
  );
  expect(await confirm(id)).toMatchObject({ success: true });
  expect(create).toHaveBeenCalledTimes(1);
  expect(runJob).toHaveBeenCalledTimes(2);
});
it('rejects stale or cross-target confirmation before any mutation', async () => {
  const id = await preview();
  vi.mocked(readiness.inspectProbeReadiness).mockResolvedValue({ ...ready, evidenceDigest: 'changed' });
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(await confirm('probe-wrong')).toMatchObject({ success: false });
  expect(
    await runGcpTransferAccessProbe({ ...input, sourceEnvironmentName: 'different', confirm: true, planId: id }),
  ).toMatchObject({ success: false });
  expect(log).toEqual([]);
});
it('finishes interrupted cleanup without repeating the jobs or creating another version', async () => {
  const id = await preview();
  del.mockRejectedValueOnce(new Error('uncertain delete'));
  expect(await confirm(id)).toMatchObject({ success: false, error: expect.stringContaining(id) });
  expect(await runGcpTransferAccessProbe(input)).toMatchObject({ success: false, error: expect.stringContaining(id) });
  expect(await confirm(id)).toMatchObject({ success: true });
  expect(add).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(del).toHaveBeenCalledTimes(2);
  expect(runJob).toHaveBeenCalledTimes(2);
});
it('cleans up an unexpected app result and keeps production transfer blocked', async () => {
  const id = await preview();
  runJob
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false, error: 'Unexpected access to the disposable file.' });
  expect(await confirm(id)).toMatchObject({ success: false, error: expect.stringContaining('Unexpected access') });
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(del).toHaveBeenCalledTimes(1);
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(runJob).toHaveBeenCalledTimes(2);
});
it('never repeats an uncertain version write, and only cleans up a version subsequently identified by Google', async () => {
  const id = await preview();
  add.mockRejectedValueOnce(new Error('lost response'));
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(destroy).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledTimes(1);
  recoverVersion.mockResolvedValue(version);
  expect(await confirm(id)).toMatchObject({ success: false, error: expect.stringContaining('did not finish') });
  expect(destroy).toHaveBeenCalledWith(version);
  expect(runJob).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledTimes(1);
});
it.each(['object', 'version'] as const)(
  'allows a fresh review after a confirmed Google %s rejection',
  async (resource) => {
    const id = await preview();
    (resource === 'object' ? create : add).mockRejectedValueOnce(new fixtures.ProbeCreateRejected(resource));
    expect(await confirm(id)).toMatchObject({ success: false, error: expect.stringContaining('cleaned up') });
    expect(await runGcpTransferAccessProbe(input)).toMatchObject({ success: true, mode: 'preview' });
    expect(destroy).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(resource === 'object' ? 0 : 1);
  },
);

it('saves the one-file review and verifies its exact generation with one app job and no credentials handoff', async () => {
  const id = await preview(true);
  const saved = () => loadProbe(project.id, target.projectId, id)!;
  const { plan } = saved();
  expect(plan.fileOnly).toBe(true);
  expect(plan.actions.map(action => action.id)).toEqual(['file', 'app', 'cleanup']);
  const html = fs.readFileSync(findTransferAccessProbeReport(project.id, target.projectId, id)!.htmlPath, 'utf8');
  expect(html).toContain(scope.runtimeEmail);
  expect(html).toContain(plan.objectName);
  expect(html).toContain('7 days');
  expect(html).not.toMatch(/15-minute|two jobs|two test jobs|Add a test version/i);
  expect(log).toEqual([]);
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(log).toEqual([]);
  runJob.mockResolvedValueOnce({ ok: true, fileEvidence: denied });
  const result = await confirm(id, true);
  expect(result).toMatchObject({ success: true, fileEvidence: denied, operatorReadVerified: true });
  const marker = create.mock.calls[0][0];
  const object = { bucket: scope.bucket, name: plan.objectName, generation: '123' };
  expect(readObject).toHaveBeenCalledWith(object, marker);
  expect(readObject.mock.invocationCallOrder[0]).toBeLessThan(runJob.mock.invocationCallOrder[0]);
  expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ runtimeServiceAccountEmail: scope.runtimeEmail }), {
    role: 'file-app', expectedEmail: scope.runtimeEmail, projectNumber: scope.projectNumber,
    bucket: scope.bucket, object: plan.objectName, generation: object.generation,
  });
  expect(del).toHaveBeenCalledWith(object);
  expect(assertFileReady).toHaveBeenCalledTimes(2);
  expect(assertReady).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(saved().run).toMatchObject({ status: 'passed', fileEvidence: denied });
  expect(saved().run.marker).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(await confirm(id, true)).toMatchObject({ success: true, fileEvidence: denied });
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(runJob).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
});
it('prevents a full review from being used for a file-only test', async () => {
  const id = await preview();
  expect(loadProbe(project.id, target.projectId, id)!.plan.fileOnly).toBeUndefined();
  expect(await confirm(id, true)).toMatchObject({ success: false });
  expect(log).toEqual([]);
});
it.each([readable, inconclusive])('preserves the app file result after failed verification and cleanup ($outcome)', async fileEvidence => {
  const id = await preview(true);
  runJob.mockResolvedValueOnce({ ok: false, fileEvidence, error: 'RAW_PROVIDER_BODY' });
  const result = await confirm(id, true);
  expect(result).toMatchObject({ success: false, fileEvidence });
  expect(JSON.stringify(result)).not.toContain('RAW_PROVIDER_BODY');
  expect(loadProbe(project.id, target.projectId, id)!.run).toMatchObject({ status: 'failed', fileEvidence });
  expect(del).toHaveBeenCalledTimes(1);
  expect(await confirm(id, true)).toMatchObject({ success: false, fileEvidence });
  expect(runJob).toHaveBeenCalledTimes(1);
});
it('does not certify a missing file denial or expose an unrecognized evidence record', async () => {
  const id = await preview(true);
  runJob.mockResolvedValueOnce({ ok: true, fileEvidence: { outcome: 'denied', media: { status: 200, classification: 'RAW_PROVIDER_BODY' } } });
  const result = await confirm(id, true);
  expect(result).toMatchObject({ success: false });
  expect(result.fileEvidence).toBeUndefined();
  expect(JSON.stringify(loadProbe(project.id, target.projectId, id))).not.toContain('RAW_PROVIDER_BODY');
  expect(del).toHaveBeenCalledTimes(1);
});
it('skips the app job and cleans up if the operator cannot verify the exact bytes', async () => {
  const id = await preview(true);
  readObject.mockRejectedValueOnce(new Error('wrong bytes'));
  expect(await confirm(id, true)).toMatchObject({ success: false });
  expect(runJob).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(del).toHaveBeenCalledTimes(1);
});
it('recovers the file job as the app and keeps its outcome across interruption without resubmission', async () => {
  const id = await preview(true);
  const receipt = { gcpProjectId: target.projectId, region: target.targetRegion, jobId: 'short-job', secretIds: [] };
  runJob.mockImplementationOnce(async ctx => {
    ctx.recordTransferResources(receipt);
    return { ok: false, fileEvidence: readable };
  });
  const recover = vi.spyOn(jobs, 'recoverTerminalTransferResources').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await confirm(id, true)).toMatchObject({ success: false, fileEvidence: readable, error: expect.stringContaining(id) });
  expect(await confirm(id)).toMatchObject({ success: false });
  expect(recover).toHaveBeenCalledTimes(1);
  expect(del).not.toHaveBeenCalled();
  expect(await confirm(id, true)).toMatchObject({ success: false, fileEvidence: readable });
  expect(recover).toHaveBeenNthCalledWith(2, expect.objectContaining({ runtimeServiceAccountEmail: scope.runtimeEmail }), receipt);
  expect(runJob).toHaveBeenCalledTimes(1);
  expect(add).not.toHaveBeenCalled();
  expect(loadProbe(project.id, target.projectId, id)!.run.status).toBe('failed');
});

it.each([true, false])('uses verified execution evidence separately from pending cleanup (verified = %s)', async accessPassed => {
  const id = await preview(true);
  runJob.mockImplementationOnce(async ctx => {
    ctx.recordTransferResources({ gcpProjectId: target.projectId, region: target.targetRegion, jobId: 'short-job', secretIds: [] });
    return { ok: false, accessPassed, fileEvidence: denied };
  });
  vi.spyOn(jobs, 'recoverTerminalTransferResources').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await confirm(id, true)).toMatchObject({ success: false, fileEvidence: denied, error: expect.stringContaining(id) });
  expect(del).not.toHaveBeenCalled();
  expect(await confirm(id, true)).toMatchObject({ success: accessPassed, fileEvidence: denied });
  expect(runJob).toHaveBeenCalledTimes(1);
  expect(del).toHaveBeenCalledTimes(1);
});

it('rejects a file plan with different reviewed dependencies before creating the file', async () => {
  const sourceId = await preview(true);
  const { plan } = loadProbe(project.id, target.projectId, sourceId)!;
  const id = 'probe-22222222-2222-4222-a222-222222222222';
  plan.planId = id;
  plan.objectName = plan.objectName.replace(sourceId.slice(6), id.slice(6));
  plan.actions = probeActions(plan);
  plan.actions[1].dependsOn = [];
  storeProbe(plan, { status: 'ready' }, true);
  expect(await confirm(id, true)).toMatchObject({ success: false, error: expect.stringContaining('changed') });
  expect(log).toEqual([]);
});

it('exports and finishes cleanup for an untagged full run approved with an older worker', async () => {
  const id = 'probe-33333333-3333-4333-a333-333333333333';
  const objectName = `migrations/production-gcp/hypervibe-access-probe-${id.slice(6)}`;
  const legacy = {
    planId: id, createdAt: new Date().toISOString(), projectId: project.id, projectName: project.name,
    sourceName: input.sourceEnvironmentName, scope, deployEmail: input.deployEmail,
    evidenceDigest: ready.evidenceDigest, inventoryDigest: ready.inventoryDigest,
    softDeleteSeconds: ready.softDeleteSeconds, workloadDigest: 'old-worker-digest', objectName,
  };
  const plan = { ...legacy, actions: probeActions(legacy) };
  const object = { bucket: scope.bucket, name: objectName, generation: '987' };
  storeProbe(plan, { status: 'running', version, object, copyPassed: true, appPassed: true }, true);
  const report = findTransferAccessProbeReport(project.id, target.projectId, id)!;
  expect(fs.readFileSync(report.htmlPath, 'utf8')).toContain('15-minute');
  expect(await confirm(id, true)).toMatchObject({ success: false });
  expect(log).toEqual([]);
  expect(await confirm(id)).toMatchObject({ success: true });
  expect(log).toEqual(['destroy-version', 'delete-file']);
  expect(del).toHaveBeenCalledWith(object);
  expect(runJob).not.toHaveBeenCalled();
});

it('retains the job receipt and verified execution when recording the deletion fails once', async () => {
  const id = await preview(true);
  const receipt = { gcpProjectId: target.projectId, region: target.targetRegion, jobId: 'short-job', secretIds: [] };
  const write = probeStorage.storeProbe;
  let failNextWrite = false;
  vi.spyOn(probeStorage, 'storeProbe').mockImplementation((...args) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('Transient journal failure');
    }
    return write(...args);
  });
  runJob.mockImplementationOnce(async ctx => {
    ctx.recordTransferResources(receipt);
    failNextWrite = true;
    expect(() => ctx.recordTransferResources(null)).toThrow('Transient journal failure');
    return { ok: false, accessPassed: true, fileEvidence: denied };
  });
  const recover = vi.spyOn(jobs, 'recoverTerminalTransferResources').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await confirm(id, true)).toMatchObject({ success: false, error: expect.stringContaining(id) });
  expect(loadProbe(project.id, target.projectId, id)!.run).toMatchObject({ status: 'running', job: receipt, appPassed: true });
  expect(await confirm(id, true)).toMatchObject({ success: true, fileEvidence: denied });
  expect(recover).toHaveBeenCalledTimes(2);
  expect(runJob).toHaveBeenCalledTimes(1);
});
