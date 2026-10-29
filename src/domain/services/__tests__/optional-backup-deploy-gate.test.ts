import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';

// Independent contract: the user's 2026-10-29 correction makes backups optional.
// Ordinary releases must not require a backup helper, archive, or fresh restore.
// Execute emitted shell, with only the eventual application step represented by
// a local marker. This does not claim live Railway deployment compatibility.
describe('ordinary releases do not depend on optional backup setup', () => {
  it.each(['staging', 'production'] as const)('reaches the %s application path without a backup manifest or helper', environmentName => {
    const target: BranchDeployTarget & { backupPolicy: { mode: 'daily'; credentialNames: string[] } } = {
      environmentName, kind: environmentName, branch: 'main', autoDeployOnPush: environmentName === 'staging',
      serviceNames: ['web'], providerProjectId: 'project', providerEnvironmentId: environmentName,
      providerServiceIds: ['web'], programFingerprint: 'a'.repeat(64),
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
      // Even a legacy target carrying backup metadata cannot impose release prerequisites.
      backupPolicy: { mode: 'daily', credentialNames: ['RAILWAY_API_TOKEN'] },
      releaseTarget: managedCiReleaseTarget({ provider: 'railway', environmentName,
        scope: { providerProjectId: 'project', providerEnvironmentId: environmentName },
        resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web' }] }),
    };
    const workflow = parse(buildBranchDeployWorkflow('railway', target,
      { includeStep: true, command: 'npm run db:migrate' }).content);
    const steps = workflow.jobs.deploy.steps;
    expect(steps.some((step: { name?: string }) => step.name === 'Run migrations')).toBe(true);
    expect(steps.some((step: { name?: string }) => step.name === 'Deploy image to Railway')).toBe(true);
    const backupSteps = steps.filter((step: { env?: Record<string, string> }) => step.env?.HYPERVIBE_BACKUP_ENVIRONMENT);
    const directory = mkdtempSync(join(tmpdir(), 'hv-optional-backup-deploy-'));
    try {
      const marker = join(directory, 'application-reached');
      const script = backupSteps.map((step: { run: string }) => step.run).join('\n')
        + '\nprintf reached > "$APPLICATION_MARKER"\n';
      writeFileSync(join(directory, 'generated-path.sh'), script);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(directory, 'generated-path.sh')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: directory,
          RUNNER_TEMP: directory, APPLICATION_MARKER: marker, HYPERVIBE_BACKUP_RUNNER_IMAGE: '',
          HYPERVIBE_BACKUP_ENVIRONMENT: environmentName },
      });
      expect({ exit: result.status, reached: existsSync(marker), stderr: result.stderr.trim() })
        .toEqual({ exit: 0, reached: true, stderr: '' });
      expect(readFileSync(marker, 'utf8')).toBe('reached');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
