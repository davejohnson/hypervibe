import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import '../../../ci/providers.js';
import { executeManagedBackup } from '../../../application/managed-backup.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { createLocalRecoveryStore } from '../local-recovery-store.js';
import { createRecoverySet } from '../recovery-set.service.js';
import { recordRecoveryExecution } from '../recovery-set-health.service.js';
import { managedBackupTargetHash, type ManagedBackupTarget } from '../managed-backup-target.service.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';

const image = `ghcr.io/example/backup@sha256:${'b'.repeat(64)}`;
const stores: Array<Awaited<ReturnType<typeof createLocalRecoveryStore>>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.cleanup();
});

// Real recovery-set, health and operation-receipt producers use owned local
// storage here. Only provider observation/transport and the Docker boundary are
// synthetic; this is receipt compatibility, not live cloud recovery evidence.
async function produceHealth(environmentName: 'staging' | 'production', state: 'healthy' | 'unhealthy' | 'unknown') {
  const archive = await createLocalRecoveryStore(); stores.push(archive);
  const source = await createLocalRecoveryStore(); stores.push(source);
  const identity = (externalId: string) => ({ provider: 'railway', externalId,
    instanceScope: { projectId: 'project', environmentId: environmentName } });
  const target: ManagedBackupTarget = { version: 1, project: 'receipt-contract', environment: environmentName,
    runnerImage: image, hosting: { provider: 'railway', providerScope: identity('archive').instanceScope },
    destination: { name: 'archive', identity: identity('archive') },
    objects: [{ name: 'documents', identity: identity('documents') }], fileReferenceQueries: [],
    retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
  if (state === 'healthy') {
    const bytes = Buffer.from('synthetic document bytes');
    await source.client.put('document.txt', { body: Readable.from([bytes]), size: bytes.length }, { ifAbsent: true });
    const setId = randomUUID();
    await createRecoverySet({ runId: setId, project: target.project, environment: environmentName,
      contractHash: managedBackupTargetHash(target), destination: target.destination.identity, archive: archive.client,
      objects: [{ ...target.objects[0], client: source.client }] });
    await recordRecoveryExecution({ target, archive: archive.client, setId, jobId: 'synthetic-local-cleanup' });
  }
  if (state === 'unknown') vi.spyOn(archive.client, 'list').mockRejectedValue(new Error('private-error-sentinel'));
  const storage = { name: 'railway', observe: async () => [{ ...target.destination.identity, status: 'ready' }],
    openObjectTransfer: async () => archive.client };
  vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({});
  vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'storage').mockResolvedValue(storage);
  const now = new Date();
  const environment: Environment = { id: environmentName, projectId: 'project', name: environmentName,
    platformBindings: {}, createdAt: now, updatedAt: now };
  const receipt = await executeManagedBackup({ target, environment, operation: 'health', repository: 'owner/project',
    runId: '123', credentials: { RAILWAY_API_TOKEN: 'synthetic-control-token' } });
  expect(receipt.status).toBe(state);
  return { target, receipt };
}

function deployTarget(environmentName: 'staging' | 'production'): BranchDeployTarget {
  return { environmentName, kind: environmentName, branch: 'main', autoDeployOnPush: environmentName === 'staging',
    serviceNames: ['web'], providerProjectId: 'project', providerEnvironmentId: environmentName, providerServiceIds: ['service'],
    programFingerprint: 'a'.repeat(64), runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    backupPolicy: { mode: 'daily', runnerImage: image, credentialNames: ['RAILWAY_API_TOKEN'] },
    releaseTarget: managedCiReleaseTarget({ provider: 'railway', environmentName,
      scope: { providerProjectId: 'project', providerEnvironmentId: environmentName },
      resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'service' }] }) };
}

function runGate(environmentName: 'staging' | 'production', target: ManagedBackupTarget, rawReceipt: string,
  options: { stale?: boolean; missing?: boolean; exitCode?: number } = {}) {
  const workflow = parse(buildBranchDeployWorkflow('railway', deployTarget(environmentName),
    { includeStep: true, command: 'npm run db:migrate' }).content);
  const step = workflow.jobs.deploy.steps.find((candidate: { name?: string }) => candidate.name === 'Verify retained backup health');
  const directory = mkdtempSync(join(tmpdir(), 'hv-backup-receipt-gate-'));
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin);
    mkdirSync(join(directory, '.github/hypervibe'), { recursive: true });
    writeFileSync(join(directory, `.github/hypervibe/backups-${environmentName}.json`), JSON.stringify(target));
    const output = join(directory, `hypervibe-deploy-backup-${environmentName}`); mkdirSync(output);
    if (options.stale) writeFileSync(join(output, 'receipt.json'), JSON.stringify({ version: 1,
      environment: environmentName, status: 'healthy', reasonCodes: [] }));
    const fixture = join(directory, 'controller-receipt.json'); writeFileSync(fixture, rawReceipt);
    const boundary = join(directory, 'boundary.json'), deployed = join(directory, 'deployment-reached');
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args.find(value => value.includes('dst=/output')).match(/src=([^,]+)/)[1];
fs.writeFileSync(process.env.TEST_BOUNDARY, JSON.stringify({ args, staleAtStart: fs.existsSync(output + '/receipt.json') }));
if (process.env.TEST_MISSING !== 'true') fs.copyFileSync(process.env.TEST_RECEIPT, output + '/receipt.json');
process.exit(Number(process.env.TEST_EXIT_CODE));
`, { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      step.run + '\nprintf reached > "$TEST_DEPLOYED"'], { cwd: directory, encoding: 'utf8', timeout: 10_000, env: {
      PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_WORKSPACE: directory,
      HYPERVIBE_BACKUP_ENVIRONMENT: step.env.HYPERVIBE_BACKUP_ENVIRONMENT,
      HYPERVIBE_BACKUP_RUNNER_IMAGE: step.env.HYPERVIBE_BACKUP_RUNNER_IMAGE,
      TEST_RECEIPT: fixture, TEST_BOUNDARY: boundary, TEST_DEPLOYED: deployed,
      TEST_MISSING: String(options.missing ?? false), TEST_EXIT_CODE: String(options.exitCode ?? 0),
    } });
    const invocation = JSON.parse(readFileSync(boundary, 'utf8'));
    expect(invocation.staleAtStart).toBe(false);
    expect(invocation.args).toEqual(expect.arrayContaining(['HYPERVIBE_BACKUP_OPERATION=health', image,
      '/opt/hypervibe/dist/ci/backup-controller.js']));
    expect(result.stderr).not.toContain('private-error-sentinel');
    return { status: result.status, deployed: existsSync(deployed) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe.each(['staging', 'production'] as const)('%s backup producer through generated deployment gate', environmentName => {
  it('admits the current healthy operation receipt produced from a restored recovery set', async () => {
    const { target, receipt } = await produceHealth(environmentName, 'healthy');
    expect(runGate(environmentName, target, JSON.stringify(receipt))).toEqual({ status: 0, deployed: true });
  });

  it('retains support for the legacy healthy receipt format', async () => {
    const { target, receipt } = await produceHealth(environmentName, 'healthy');
    expect(runGate(environmentName, target, JSON.stringify({ ...receipt, version: 1 }))).toEqual({ status: 0, deployed: true });
  });

  it.each(['unknown', 'unhealthy'] as const)('blocks an actual %s health observation', async status => {
    const { target, receipt } = await produceHealth(environmentName, status);
    expect(runGate(environmentName, target, JSON.stringify(receipt))).toEqual({ status: 1, deployed: false });
  });

  it.each(['failed', 'malformed', 'wrong-environment', 'unknown-version', 'unknown-diagnostic', 'legacy-diagnostic',
    'unknown-field', 'invalid-count', 'contradictory-healthy', 'stale-receipt', 'failed-controller'])(
    'blocks %s without reaching deployment', async fault => {
      const { target, receipt } = await produceHealth(environmentName, 'healthy');
      let changed: unknown = receipt;
      if (fault === 'failed') changed = { ...receipt, status: 'failed' };
      if (fault === 'wrong-environment') changed = { ...receipt, environment: environmentName === 'production' ? 'staging' : 'production' };
      if (fault === 'unknown-version') changed = { ...receipt, version: 99 };
      if (fault === 'unknown-diagnostic' || fault === 'legacy-diagnostic') changed = { ...receipt,
        version: fault === 'legacy-diagnostic' ? 1 : 2, diagnostic: { stage: 'private-error-sentinel', category: 'unknown' } };
      if (fault === 'unknown-field') changed = { ...receipt, version: 1, error: 'private-error-sentinel' };
      if (fault === 'invalid-count') changed = { ...receipt, version: 1, counts: { applied: -1, skipped: 0 } };
      if (fault === 'contradictory-healthy') changed = { ...receipt, reasonCodes: ['cleanup-unverified'] };
      const result = runGate(environmentName, target, fault === 'malformed' ? '{private-error-sentinel' : JSON.stringify(changed), {
        stale: fault === 'stale-receipt', missing: fault === 'stale-receipt', exitCode: fault === 'failed-controller' ? 23 : 0,
      });
      expect(result).toEqual({ status: fault === 'failed-controller' ? 23 : 1, deployed: false });
    });
});
