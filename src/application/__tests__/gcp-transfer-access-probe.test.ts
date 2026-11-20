import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project } from '../../domain/entities/project.entity.js';
import { setupPlansDirectory } from '../../adapters/storage/gcp-setup-report.js';
import {
  findTransferAccessProbeReport,
  loadProbe,
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
      assertReady: async () => {},
      createObject: async (m: string, before?: () => void) => {
        before?.();
        return { ...(await create(m)), name: objectName };
      },
      readObject: async () => {},
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
async function preview() {
  const p = await runGcpTransferAccessProbe(input);
  expect(p).toMatchObject({ success: true, mode: 'preview', softDeleteSeconds: 604800 });
  return String(p.planId);
}
function confirm(planId: string) {
  return runGcpTransferAccessProbe({ ...input, confirm: true, planId });
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
