import childProcess from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { railwayHttpFixture, projectId, stagingId } from './railway-http.fixture.js';
import { readRailwayServerVersion } from '../railway-runtime-evidence.js';
import { createRailwayVersionInspection } from '../railway-version-inspection.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('private Railway source version review', () => {
  it('only credits a bounded receipt for this SSH request and discards other output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hv-source-ssh-'));
    try {
      const sshIdentityFile = join(directory, 'key'), sshKnownHostsFile = join(directory, 'hosts');
      await writeFile(sshIdentityFile, 'fixture key', { mode: 0o600 });
      await writeFile(sshKnownHostsFile, 'fixture host key');
      const source = { projectId, environmentId: stagingId, serviceId: 'database', serviceInstanceId: 'instance', deploymentId: 'deployment',
        replicaId: 'the-replica', imageDigest: 'sha256:' + 'a'.repeat(64), volumeId: 'volume', volumeInstanceId: 'volume-instance' };
      const spawn = childProcess.spawn.bind(childProcess);
      let outcome = 'valid';
      vi.spyOn(childProcess, 'spawn').mockImplementation(((binary: string, args: string[], options: childProcess.SpawnOptions) => {
        expect(binary).toBe('/usr/bin/ssh');
        expect(args.slice(-2)).toEqual(['the-replica@ssh.railway.com', '/bin/sh -s']);
        expect(args).toContain('StrictHostKeyChecking=yes');
        expect(args).toContain('ClearAllForwardings=yes');
        const script = `let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
          const nonce = /"nonce":"([a-f0-9]{32})"/.exec(input)[1];
          const inventory = {versionNumber:170003,tables:0,estimatedRows:'0'};
          if(process.argv[1]==='raw') inventory.privateRow='synthetic-private-row';
          if(process.argv[1]==='invalid') inventory.versionNumber=0;
          console.log(JSON.stringify({nonce:process.argv[1]==='stale'?'old-request':nonce,inventory}));
        });`;
        return spawn(process.execPath, ['-e', script, outcome], options);
      }) as typeof childProcess.spawn);
      const probe = () => readRailwayServerVersion(source, { sshIdentityFile, sshKnownHostsFile });
      expect(await probe()).toEqual({ versionNumber: 170003, tables: 0, estimatedRows: '0' });
      for (outcome of ['stale', 'invalid', 'raw']) await expect(probe()).rejects.toThrow('could not be verified');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('requires the same running database replica and pinned image before counting a version reply', async () => {
    const f = await railwayHttpFixture();
    const service = f.addService('db-service', 'Postgres', stagingId);
    const instance = service.instances.get(stagingId)!;
    instance.latestDeployment = { id: 'db-deployment', status: 'SUCCESS' };
    instance.activeDeployments = [{ id: 'db-deployment' }];
    const deployment = { id: 'db-deployment', projectId, environmentId: stagingId, serviceId: service.id,
      status: 'SUCCESS', deploymentStopped: false, instances: [{ id: 'replica-one', status: 'RUNNING' }],
      meta: { image: 'postgres:17', imageDigest: 'sha256:' + 'a'.repeat(64) } };
    f.deployments.set(deployment.id, { ...deployment, snapshotId: 'db-snapshot' });
    const target = { projectId, environmentId: stagingId, serviceId: service.id };
    const volume = async () => ({ volumeId: 'volume', instanceId: 'volume-instance' });
    const inventory = { versionNumber: 170002, tables: 3, estimatedRows: '101' };
    const run = vi.fn(async () => inventory);
    const reader = createRailwayVersionInspection(() => Reflect.get(f.adapter, 'client'), volume, run);
    const review = await reader.observe(target);
    expect(review.deploymentId).toBe(deployment.id);
    await expect(reader.inspect(review)).resolves.toEqual(inventory);
    run.mockImplementationOnce(async () => { deployment.meta.imageDigest = 'sha256:' + 'b'.repeat(64); return inventory; });
    await expect(reader.inspect(review)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(f.contractErrors).toEqual([]);
  });
});
