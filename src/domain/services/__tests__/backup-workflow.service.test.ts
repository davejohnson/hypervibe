import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { compileBackupWorkflow } from '../backup-workflow.service.js';

const image = `ghcr.io/example/hypervibe-backup@sha256:${'a'.repeat(64)}`;
const contract = { version: 1, environment: 'staging', runnerImage: image };
function compiled() {
  const files = compileBackupWorkflow({ project: 'example', environment: 'staging', runnerImage: image,
    contractHash: canonicalJsonSha256(contract), providerCredentialNames: ['RAILWAY_API_TOKEN'], contract });
  return { files, workflow: parse(files.find(file => file.path.endsWith('.yml'))!.content) };
}

describe('managed backup workflow', () => {
  it('schedules only the daily backup and keeps health available on demand', () => {
    const { workflow, files } = compiled();
    expect(workflow.on.schedule).toEqual([{ cron: '17 3 * * *' }]);
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual(['backup', 'health']);
    expect(workflow.concurrency).toEqual({ group: 'hypervibe-deploy-staging', 'cancel-in-progress': false });
    expect(workflow.jobs.backup.if).toContain('github.event.repository.default_branch');
    expect(workflow.jobs.backup.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['backup']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.backup.steps).toContainEqual(expect.objectContaining({
      if: 'always()', uses: 'actions/upload-artifact@v7', with: expect.objectContaining({ path: '${{ runner.temp }}/hypervibe-backup-staging/receipt.json' }),
    }));
    const run = workflow.jobs.backup.steps.find((step: { name?: string }) => step.name === 'Run managed backup controller');
    expect(run.env).toMatchObject({ HYPERVIBE_BACKUP_RUNNER_IMAGE: image, HYPERVIBE_BACKUP_CONTRACT_HASH: canonicalJsonSha256(contract), RAILWAY_API_TOKEN: '${{ secrets.RAILWAY_API_TOKEN }}' });
    expect(Object.keys(run.env).some(key => key.includes('DATABASE_URL'))).toBe(false);
    expect(JSON.parse(files.find(file => file.path.endsWith('.json'))!.content)).toEqual(contract);
  });

  it('executes the emitted Docker boundary with only named credentials and blocks repeated backup attempts', () => {
    const { workflow } = compiled();
    const step = workflow.jobs.backup.steps.find((entry: { name?: string }) => entry.name === 'Run managed backup controller');
    const directory = mkdtempSync(join(tmpdir(), 'hv-backup-workflow-'));
    try {
      const bin = join(directory, 'bin'); mkdirSync(bin);
      mkdirSync(join(directory, '.github/hypervibe'), { recursive: true });
      writeFileSync(join(directory, '.github/hypervibe/backups-staging.json'), JSON.stringify(contract));
      const boundary = join(directory, 'boundary.json');
      writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.BOUNDARY, JSON.stringify({args:process.argv.slice(2),operation:process.env.HYPERVIBE_BACKUP_OPERATION}))\nprocess.exitCode = Number(process.env.TEST_CONTROLLER_EXIT_CODE || 0)\n', { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_WORKSPACE: directory,
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', HYPERVIBE_BACKUP_INPUT_OPERATION: 'backup',
        HYPERVIBE_BACKUP_RUNNER_IMAGE: image, HYPERVIBE_BACKUP_TRIGGER_SCHEDULE: '', BOUNDARY: boundary,
        RAILWAY_API_TOKEN: 'provider-secret', GITHUB_TOKEN: 'github-secret', UNRELATED_APP_SECRET: 'must-not-forward',
      };
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env, encoding: 'utf8' });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const { args, operation } = JSON.parse(readFileSync(boundary, 'utf8')) as { args: string[]; operation: string };
      expect(operation).toBe('backup');
      expect(args).toContain(image);
      expect(args).toContain('/opt/hypervibe/dist/ci/backup-controller.js');
      expect(args).toContain('RAILWAY_API_TOKEN');
      expect(args).not.toContain('UNRELATED_APP_SECRET');
      expect(JSON.stringify(args)).not.toContain('provider-secret');
      expect(args.some(arg => arg.includes('/input/contract.json,readonly'))).toBe(true);
      const failed = spawnSync('bash', ['-c', step.run], { cwd: directory,
        env: { ...env, TEST_CONTROLLER_EXIT_CODE: '9' }, encoding: 'utf8' });
      expect(failed.status).toBe(9);
      const retry = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8' });
      expect(retry.status).not.toBe(0);
      const health = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env: { ...env, GITHUB_RUN_ATTEMPT: '2', HYPERVIBE_BACKUP_INPUT_OPERATION: 'health' }, encoding: 'utf8' });
      expect(health.status).toBe(0);
      expect(JSON.parse(readFileSync(boundary, 'utf8')).operation).toBe('health');
      const schedule = (cron: string) => spawnSync('bash', ['-e', '-c', step.run], { cwd: directory,
        env: { ...env, GITHUB_EVENT_NAME: 'schedule', HYPERVIBE_BACKUP_TRIGGER_SCHEDULE: cron }, encoding: 'utf8' });
      expect(schedule('17 3 * * *').status).toBe(0);
      expect(JSON.parse(readFileSync(boundary, 'utf8')).operation).toBe('backup');
      rmSync(boundary);
      expect(schedule('47 * * * *').status).not.toBe(0);
      expect(existsSync(boundary)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
