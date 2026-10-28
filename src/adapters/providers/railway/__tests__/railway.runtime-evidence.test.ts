import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { GraphQLClient } from 'graphql-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { createRailwayRuntimeEvidence, type RailwayRuntimeCredentials } from '../railway-runtime-evidence.js';
import { railwayHttpFixture, projectId, stagingId } from './railway-http.fixture.js';

// Actual GraphQL transport is executed against Railway's pinned official SDL.
// Provider state and SSH replies below are reconstructed/synthetic. The separate
// rotation API contract executes the fixed remote program against real PostgreSQL.
// Official native SSH source selects exact deployment-instance usernames:
// https://github.com/railwayapp/cli/blob/v5.27.0/src/commands/ssh/native.rs
const target = { projectId, environmentId: stagingId, serviceId: 'runtime-worker', deploymentId: 'runtime-deployment' };
const hashes = { DATABASE_URL: hashEnvValue('synthetic-runtime-url'), POSTGRES_DB_URL: hashEnvValue('synthetic-runtime-url') };
const unknown = { state: 'unknown', authentication: 'unknown' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'hv-runtime-reader-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

type Reply = { version: number; nonce: string; state: string; replicaHash: string; envVarHashes: Record<string, string>; authentication: string };
async function fixture(options: { credentials?: RailwayRuntimeCredentials; inventory?: (number: number, fixture: Awaited<ReturnType<typeof railwayHttpFixture>>) => void;
  response?: (instanceId: string, reply: Reply) => Reply; failure?: boolean } = {}) {
  let reads = 0;
  let f: Awaited<ReturnType<typeof railwayHttpFixture>>;
  f = await railwayHttpFixture({ responseOverride: ({ query }) => {
    if (query.includes('DatabaseRuntimeInstances')) options.inventory?.(++reads, f);
    return undefined;
  } });
  const service = f.addService(target.serviceId, 'worker', stagingId);
  const instance = service.instances.get(stagingId)!;
  instance.latestDeployment = { id: target.deploymentId, status: 'SUCCESS' };
  instance.activeDeployments = [{ id: target.deploymentId }];
  f.deployments.set(target.deploymentId, { ...target, id: target.deploymentId, snapshotId: 'runtime-snapshot', status: 'SUCCESS', deploymentStopped: false,
    instances: [{ id: 'instance-a', status: 'RUNNING' }, { id: 'instance-b', status: 'RUNNING' }] });
  const credentials = options.credentials ?? { sshIdentityFile: join(directory, 'existing-key'), sshKnownHostsFile: join(directory, 'existing-host-trust') };
  await writeFile(join(directory, 'existing-key'), 'synthetic-key', { mode: 0o600 });
  await writeFile(join(directory, 'existing-host-trust'), 'synthetic-host-trust', { mode: 0o600 });
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(((file: string, args: string[], configuration: childProcess.SpawnOptions) => {
    expect(file).toBe('/usr/bin/ssh');
    expect(configuration).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    const instanceId = args.find(value => value.endsWith('@ssh.railway.com'))!.split('@')[0];
    const process = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
    process.stdout = new PassThrough(); process.kill = vi.fn();
    let input = '';
    process.stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk.toString(); callback(); }, final(callback) {
      const request = JSON.parse(input.match(/\nmain\((\{.*\})\);\n$/s)![1]);
      const reply: Reply = { version: 1, nonce: request.nonce, state: 'verified', replicaHash: hashEnvValue(`independent-runtime-${instanceId}`),
        envVarHashes: { ...hashes }, authentication: request.authentication ? 'authenticated' : 'unchecked' };
      queueMicrotask(() => {
        // Even an SSH failure that prints a secret to stdout must be discarded;
        // stderr is never piped to or returned by the reader.
        process.stdout.write(options.failure ? 'Host key verification failed: synthetic-sensitive-value' : JSON.stringify(options.response?.(instanceId, reply) ?? reply));
        process.emit('close', options.failure ? 255 : 0);
      });
      callback();
    } });
    return process;
  }) as unknown as typeof childProcess.spawn);
  const reader = createRailwayRuntimeEvidence(() => Reflect.get(f.adapter, 'client') as GraphQLClient, () => credentials);
  return { ...f, instance, spawn, reader, credentials, read: () => reader.read(target, { keys: Object.keys(hashes) }) };
}

describe('existing-access Railway runtime evidence', () => {
  it('covers every independently identified replica and rechecks the exact provider inventory', async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({ state: 'verified', envVarHashes: hashes, instanceIds: ['instance-a', 'instance-b'], authentication: 'unchecked' });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.contractErrors).toEqual([]); expect(f.mutations).toEqual([]);
  });

  it.each(['missing-key', 'missing-host-trust', 'absent-files', 'relative-path', 'public-key-file-mode'])('does not spawn SSH with %s', async kind => {
    const credentials: RailwayRuntimeCredentials = { sshIdentityFile: join(directory, 'existing-key'), sshKnownHostsFile: join(directory, 'existing-host-trust') };
    if (kind === 'missing-key') delete credentials.sshIdentityFile;
    if (kind === 'missing-host-trust') delete credentials.sshKnownHostsFile;
    if (kind === 'absent-files') credentials.sshIdentityFile = join(directory, 'absent-key');
    if (kind === 'relative-path') credentials.sshIdentityFile = 'relative-key';
    const f = await fixture({ credentials });
    if (kind === 'public-key-file-mode') await chmod(credentials.sshIdentityFile!, 0o644);
    expect(await f.read()).toEqual(unknown); expect(f.spawn).not.toHaveBeenCalled(); expect(f.mutations).toEqual([]);
  });

  it('returns only unknown for failed host trust without creating access or exposing SSH diagnostics', async () => {
    const f = await fixture({ failure: true });
    expect(await f.read()).toEqual(unknown);
    expect(f.spawn).toHaveBeenCalled(); expect(f.mutations).toEqual([]);
    for (const [, args] of f.spawn.mock.calls) {
      expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('UpdateHostKeys=no');
    }
  });

  it.each(['key-percent', 'trust-percent', 'key-control', 'trust-control'])('rejects %s path interpretation before spawning SSH', async kind => {
    const f = await fixture();
    const value = join(directory, kind.includes('percent') ? '%r-existing-file' : 'existing\nfile');
    await writeFile(value, 'synthetic-existing-file', { mode: 0o600 });
    if (kind.startsWith('key')) f.credentials.sshIdentityFile = value;
    else f.credentials.sshKnownHostsFile = value;
    expect(await f.read()).toEqual(unknown); expect(f.spawn).not.toHaveBeenCalled();
  });

  it('quotes an existing host-trust path with spaces as one OpenSSH option value', async () => {
    const f = await fixture();
    const value = join(directory, 'known hosts');
    await writeFile(value, 'synthetic-existing-host-trust', { mode: 0o600 });
    f.credentials.sshKnownHostsFile = value;
    expect(await f.read()).toMatchObject({ state: 'verified' });
    for (const [, args] of f.spawn.mock.calls) expect(args).toContain(`UserKnownHostsFile="${value}"`);
  });

  it.each(['duplicate', 'missing', 'exited', 'stopped', 'overlapping-deployment', 'wrong-project'])('refuses %s provider inventory before SSH', async kind => {
    const f = await fixture(); const deployment = f.deployments.get(target.deploymentId)!;
    if (kind === 'duplicate') deployment.instances = [{ id: 'instance-a', status: 'RUNNING' }, { id: 'instance-a', status: 'RUNNING' }];
    if (kind === 'missing') deployment.instances = [];
    if (kind === 'exited') deployment.instances![0].status = 'EXITED';
    if (kind === 'stopped') deployment.deploymentStopped = true;
    if (kind === 'overlapping-deployment') f.instance.activeDeployments!.push({ id: 'old-deployment' });
    if (kind === 'wrong-project') deployment.projectId = 'different-project';
    expect(await f.read()).toEqual(unknown); expect(f.spawn).not.toHaveBeenCalled(); expect(f.contractErrors).toEqual([]);
  });

  it.each(['added-instance', 'removed-instance', 'replaced-service-instance', 'latest-deployment-changed'])('discards results after %s during SSH', async kind => {
    const f = await fixture({ inventory: (read, wire) => {
      if (read !== 2) return;
      const deployment = wire.deployments.get(target.deploymentId)!;
      const instance = wire.services.get(target.serviceId)!.instances.get(stagingId)!;
      if (kind === 'added-instance') deployment.instances!.push({ id: 'instance-c', status: 'RUNNING' });
      if (kind === 'removed-instance') deployment.instances!.pop();
      if (kind === 'replaced-service-instance') instance.id = 'different-service-instance';
      if (kind === 'latest-deployment-changed') instance.latestDeployment = { id: 'new-deployment', status: 'SUCCESS' };
    } });
    expect(await f.read()).toEqual(unknown); expect(f.spawn).toHaveBeenCalledTimes(2); expect(f.mutations).toEqual([]);
  });

  it.each(['disagreeing-values', 'same-replica', 'wrong-nonce', 'missing-key', 'extra-key'])('rejects %s runtime replies', async kind => {
    const f = await fixture({ response: (id, reply) => {
      if (kind === 'disagreeing-values' && id === 'instance-b') reply.envVarHashes.POSTGRES_DB_URL = hashEnvValue('different-runtime-url');
      if (kind === 'same-replica') reply.replicaHash = hashEnvValue('one-runtime-replica');
      if (kind === 'wrong-nonce') reply.nonce = 'uncorrelated-response';
      if (kind === 'missing-key') delete reply.envVarHashes.POSTGRES_DB_URL;
      if (kind === 'extra-key') reply.envVarHashes.UNREQUESTED = hashEnvValue('another-value');
      return reply;
    } });
    expect(await f.read()).toEqual(unknown);
  });

  it('does not report authentication success when one covered replica rejects a fresh connection', async () => {
    const f = await fixture({ response: (id, reply) => ({ ...reply, authentication: id === 'instance-a' ? 'authenticated' : 'rejected' }) });
    expect(await f.reader.read(target, { keys: Object.keys(hashes), authentication: { username: 'app', database: 'railway' } }))
      .toMatchObject({ state: 'verified', authentication: 'rejected', instanceIds: ['instance-a', 'instance-b'] });
  });
});
