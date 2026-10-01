import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import type { Project } from '../../entities/project.entity.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { resolveReviewedBranchDeployTargets, managedCiReleaseTarget } from '../managed-ci-targets.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
import { buildGitHubBackupDeployGate, buildGitLabBackupDeployGate } from '../backup-deploy-gate.service.js';

const image = `ghcr.io/example/backup@sha256:${'b'.repeat(64)}`;
function target(): BranchDeployTarget {
  return { environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true,
    serviceNames: ['web'], providerProjectId: 'project', providerEnvironmentId: 'environment', providerServiceIds: ['service'],
    programFingerprint: 'a'.repeat(64), runtime: { kind: 'node', version: '24', installCommand: 'npm ci' },
    backupPolicy: { mode: 'daily', runnerImage: image, credentialNames: ['RAILWAY_API_TOKEN'] },
    releaseTarget: managedCiReleaseTarget({ provider: 'railway', environmentName: 'staging', scope: { providerProjectId: 'project', providerEnvironmentId: 'environment' }, resources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'service' }] }),
  };
}

describe('deployment backup health gate', () => {
  it('derives implicit daily protection for persistent specs and explicit exclusion for opted-out specs', () => {
    const find = vi.spyOn(EnvironmentRepository.prototype, 'findByProjectAndName').mockReturnValue(null);
    const project: Project = { id: 'project', name: 'test', defaultPlatform: 'railway', policies: {}, createdAt: new Date(), updatedAt: new Date() };
    try {
      const spec = projectSpecSchema.parse({ version: 1, project: 'test', environments: { staging: {
        hosting: { provider: 'railway' }, database: { provider: 'railway', engine: 'postgres' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci' },
      } } });
      expect(resolveReviewedBranchDeployTargets(project, spec).targets[0].backupPolicy).toMatchObject({ mode: 'daily' });
      spec.environments.staging.backups = { mode: 'disabled', reason: 'Disposable test environment' };
      expect(resolveReviewedBranchDeployTargets(project, spec).targets[0].backupPolicy).toMatchObject({ mode: 'disabled' });
      delete spec.environments.staging.database;
      delete spec.environments.staging.backups;
      expect(resolveReviewedBranchDeployTargets(project, spec).targets[0].backupPolicy).toBeUndefined();
    } finally { find.mockRestore(); }
  });

  it('places the generated GitHub health gate before migrations and provider deployment and exempts immutable rollback', () => {
    const workflow = parse(buildBranchDeployWorkflow('railway', target(), { includeStep: true, command: 'npm run db:migrate' }).content);
    const steps = workflow.jobs.deploy.steps;
    const gate = steps.findIndex((step: { name?: string }) => step.name === 'Verify retained backup health');
    const migration = steps.findIndex((step: { name?: string }) => step.name === 'Run migrations');
    expect(gate).toBeGreaterThan(steps.findIndex((step: { id?: string }) => step.id === 'deployment_contract'));
    expect(gate).toBeLessThan(migration);
    expect(steps[gate].if).toBe("steps.deploy.outputs.operation != 'rollback'");
    expect(steps[gate].env.RAILWAY_API_TOKEN).toBe('${{ secrets.RAILWAY_API_TOKEN }}');
  });

  it.each(['healthy', 'unhealthy', 'missing', 'wrong-environment', 'no-contract', 'no-image'])('executes a fresh health observation and blocks %s unless proven healthy', status => {
    const branch = target();
    if (status === 'no-image') delete branch.backupPolicy!.runnerImage;
    const step = parse('steps:\n' + buildGitHubBackupDeployGate(branch).steps).steps[0];
    const directory = mkdtempSync(join(tmpdir(), 'hv-deploy-backup-'));
    try {
      const bin = join(directory, 'bin'); mkdirSync(bin);
      mkdirSync(join(directory, '.github/hypervibe'), { recursive: true });
      if (status !== 'no-contract') writeFileSync(join(directory, '.github/hypervibe/backups-staging.json'), JSON.stringify({ version: 1, environment: 'staging', runnerImage: image }));
      writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);const m=a.find(x=>x.includes("dst=/output"));if(!m)process.exit(4);const d=m.match(/src=([^,]+)/)[1];if(process.env.TEST_STATUS!=="missing")fs.writeFileSync(d+"/receipt.json",JSON.stringify({version:1,environment:process.env.TEST_STATUS==="wrong-environment"?"production":"staging",status:process.env.TEST_STATUS==="unhealthy"?"unhealthy":"healthy",reasonCodes:[]}));\n', { mode: 0o755 });
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_WORKSPACE: directory,
        HYPERVIBE_BACKUP_ENVIRONMENT: 'staging', HYPERVIBE_BACKUP_RUNNER_IMAGE: branch.backupPolicy?.runnerImage ?? '',
        HYPERVIBE_BACKUP_DEPLOY_SHA: 'a'.repeat(40), TEST_STATUS: status,
      } });
      expect(result.status === 0).toBe(status === 'healthy');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('explicitly blocks unsupported GitLab daily recovery checks while retaining the rollback path', () => {
    const script = buildGitLabBackupDeployGate(target());
    expect(spawnSync('sh', ['-eu', '-c', script], { env: { ...process.env, HYPERVIBE_ROLLBACK: 'false' } }).status).not.toBe(0);
    expect(spawnSync('sh', ['-eu', '-c', script], { env: { ...process.env, HYPERVIBE_ROLLBACK: 'true' } }).status).toBe(0);
    expect(buildGitLabBackupDeployGate({ ...target(), backupPolicy: { mode: 'disabled' } })).toBe('');
  });
});
