import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

describe('managed backup workflow', () => {
  it('binds a reviewed digest and daily backup/hourly health to the default branch deployment lock', () => {
    const { workflow, files } = compiled();
    expect(workflow.on.schedule).toEqual([{ cron: '17 3 * * *' }, { cron: '47 * * * *' }]);
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual(['backup', 'health']);
    expect(workflow.concurrency).toEqual({ group: 'hypervibe-deploy-staging', 'cancel-in-progress': false });
    expect(workflow.jobs.backup.if).toContain('github.event.repository.default_branch');
    expect(workflow.jobs.backup.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.alert.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
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
      writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.BOUNDARY, JSON.stringify({args:process.argv.slice(2),operation:process.env.HYPERVIBE_BACKUP_OPERATION}))\n', { mode: 0o755 });
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
      const retry = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, encoding: 'utf8' });
      expect(retry.status).not.toBe(0);
      const health = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env: { ...env, GITHUB_RUN_ATTEMPT: '2', HYPERVIBE_BACKUP_INPUT_OPERATION: 'health' }, encoding: 'utf8' });
      expect(health.status).toBe(0);
      for (const [cron, expected] of [['17 3 * * *', 'backup'], ['47 * * * *', 'health']]) {
        const scheduled = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], { cwd: directory,
          env: { ...env, GITHUB_EVENT_NAME: 'schedule', HYPERVIBE_BACKUP_TRIGGER_SCHEDULE: cron }, encoding: 'utf8' });
        expect(scheduled.status).toBe(0);
        expect(JSON.parse(readFileSync(boundary, 'utf8')).operation).toBe(expected);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['missing', 'malformed', 'oversized', 'unknown', 'wrong-environment', 'failed-job', 'unknown-reason'])('keeps an alert open for %s evidence', async mode => {
    const { workflow } = compiled();
    const step = workflow.jobs.alert.steps.find((entry: { uses?: string }) => entry.uses?.startsWith('actions/github-script@'));
    const directory = mkdtempSync(join(tmpdir(), 'hv-backup-alert-'));
    try {
      const receipt = join(directory, 'receipt.json');
      if (mode !== 'missing') writeFileSync(receipt, mode === 'oversized' ? 's'.repeat(16385) : mode === 'malformed' ? 'raw-secret-invalid-json' : JSON.stringify({ version: 1, environment: mode === 'wrong-environment' ? 'production' : 'staging', status: mode === 'unknown' ? 'unknown' : 'healthy', reasonCodes: mode === 'unknown-reason' ? ['raw-secret-invalid-json'] : [] }));
      const requests: Array<{ url: string; method: string; body: unknown }> = [];
      const fetch = async (url: string, options: { method?: string; body?: string } = {}) => {
        requests.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
        return { ok: true, json: async () => options.method && options.method !== 'GET' ? { number: 12 } : [{ number: 12, body: '<!-- hypervibe:backup-health:staging -->', user: { login: 'github-actions[bot]' } }] };
      };
      await new AsyncFunction('require', 'process', 'context', 'fetch', 'core', step.with.script)(createRequire(import.meta.url), { env: { HYPERVIBE_BACKUP_RECEIPT_PATH: receipt, HYPERVIBE_BACKUP_ENVIRONMENT: 'staging', HYPERVIBE_BACKUP_JOB_RESULT: mode === 'failed-job' ? 'failure' : 'success', GITHUB_TOKEN: 'alert-token' } }, { repo: { owner: 'owner', repo: 'repo' }, runId: 12 }, fetch, { notice() {} });
      expect(requests.some(request => (request.body as { state?: string })?.state === 'closed')).toBe(false);
      expect(requests.filter(request => request.method !== 'GET')).toHaveLength(1);
      expect(JSON.stringify(requests)).not.toContain('raw-secret-invalid-json');
      expect(JSON.stringify(requests)).not.toContain('alert-token');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('closes only its own bot alert after a valid healthy receipt', async () => {
    const { workflow } = compiled();
    const step = workflow.jobs.alert.steps.find((entry: { uses?: string }) => entry.uses?.startsWith('actions/github-script@'));
    const directory = mkdtempSync(join(tmpdir(), 'hv-backup-alert-'));
    try {
      const receipt = join(directory, 'receipt.json');
      writeFileSync(receipt, JSON.stringify({ version: 1, environment: 'staging', status: 'healthy', reasonCodes: [] }));
      const writes: unknown[] = [];
      const fetch = async (_url: string, options: { method?: string; body?: string } = {}) => ({ ok: true, json: async () => {
        if (options.method && options.method !== 'GET') { writes.push(JSON.parse(options.body!)); return { number: 12 }; }
        return [{ number: 12, body: '<!-- hypervibe:backup-health:staging -->', user: { login: 'github-actions[bot]' } },
          { number: 13, body: '<!-- hypervibe:backup-health:staging -->', user: { login: 'human' } }];
      } });
      await new AsyncFunction('require', 'process', 'context', 'fetch', 'core', step.with.script)(createRequire(import.meta.url), { env: { HYPERVIBE_BACKUP_RECEIPT_PATH: receipt, HYPERVIBE_BACKUP_ENVIRONMENT: 'staging', HYPERVIBE_BACKUP_JOB_RESULT: 'success', GITHUB_TOKEN: 'alert-token' } }, { repo: { owner: 'owner', repo: 'repo' }, runId: 12 }, fetch, { notice() {} });
      expect(writes).toEqual([expect.objectContaining({ state: 'closed' })]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('creates one alert when no existing bot issue covers unknown evidence', async () => {
    const { workflow } = compiled();
    const step = workflow.jobs.alert.steps.find((entry: { uses?: string }) => entry.uses?.startsWith('actions/github-script@'));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch = async (url: string, options: { method: string; body?: string }) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => options.method === 'GET' ? [] : { number: 12 } };
    };
    await new AsyncFunction('require', 'process', 'context', 'fetch', 'core', step.with.script)(createRequire(import.meta.url), { env: {
      HYPERVIBE_BACKUP_RECEIPT_PATH: '/missing-backup-test/receipt.json', HYPERVIBE_BACKUP_ENVIRONMENT: 'staging', HYPERVIBE_BACKUP_JOB_RESULT: 'failure', GITHUB_TOKEN: 'alert-token',
    } }, { repo: { owner: 'owner', repo: 'repo' }, runId: 12 }, fetch, { notice() {} });
    expect(requests).toEqual([
      expect.objectContaining({ method: 'GET', url: 'https://api.github.com/repos/owner/repo/issues?state=open&per_page=100&page=1' }),
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ title: '[Hypervibe] Backup protection needs attention (staging)' }) }),
    ]);
  });
});
