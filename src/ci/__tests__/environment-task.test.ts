import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as filesystem from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { runManagedEnvironmentTaskFromProcess } from '../environment-task.js';
import { executeManagedEnvironmentTask } from '../../application/managed-environment-task.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('../../application/managed-environment-task.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../application/managed-environment-task.js')>(),
  executeManagedEnvironmentTask: vi.fn(),
}));

const actualReadFileSync = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync;

let directory: string;
const previousExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readFileSync).mockReset().mockImplementation(actualReadFileSync);
  vi.mocked(executeManagedEnvironmentTask).mockReset();
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('public named task CI entry', () => {
  it('refuses a rerun before reading configuration or creating any adapter', async () => {
    vi.mocked(readFileSync).mockClear();
    directory = mkdtempSync(join(tmpdir(), 'task-ci-'));
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_TOKEN', 'private-token-value');
    vi.stubEnv('HYPERVIBE_TASK_RUN_ID', '123');
    vi.stubEnv('HYPERVIBE_TASK_RUN_ATTEMPT', '2');
    vi.stubEnv('HYPERVIBE_TASK_RECEIPT_PATH', join(directory, 'receipt.json'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(directory, 'summary.md'));
    const adapter = vi.spyOn(providerRegistry, 'createAdapter');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runManagedEnvironmentTaskFromProcess();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
    const output = readFileSync(join(directory, 'receipt.json'), 'utf8');
    expect(JSON.parse(output)).toMatchObject({ status: 'blocked', applied: 0, skipped: 0, executionId: '123' });
    expect(output).not.toContain('private-token-value');
    expect(process.exitCode).toBe(1);
  });

  function manualDispatch() {
    directory = mkdtempSync(join(tmpdir(), 'task-ci-'));
    const rawSpec = {
      version: 1, project: 'example',
      github: { repository: 'owner/example', actions: { 'tester-setup': {
        kind: 'environment-task', environment: 'staging', service: 'web',
        command: ['node', 'scripts/tester-setup.js'],
      } } },
      environments: { staging: {
        hosting: { provider: 'railway' }, services: { web: {} },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      } },
    };
    const spec = projectSpecSchema.parse(rawSpec);
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(rawSpec)).mockReturnValueOnce('{}');
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_TOKEN', 'private-token-value');
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/example');
    vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
    vi.stubEnv('HYPERVIBE_TASK_RUN_ID', '123');
    vi.stubEnv('HYPERVIBE_TASK_RUN_ATTEMPT', '1');
    vi.stubEnv('HYPERVIBE_TASK_ID', 'tester-setup');
    vi.stubEnv('HYPERVIBE_TASK_ENVIRONMENT', 'staging');
    vi.stubEnv('HYPERVIBE_TASK_INPUTS_JSON', '{}');
    vi.stubEnv('HYPERVIBE_TASK_CONTRACT_HASH', canonicalJsonSha256(spec.github!.actions['tester-setup']));
    vi.stubEnv('HYPERVIBE_TASK_RECEIPT_PATH', join(directory, 'receipt.json'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(directory, 'summary.md'));
    vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({});
    vi.mocked(executeManagedEnvironmentTask).mockResolvedValue({
      version: 1, status: 'completed', executionId: '123',
      application: { mode: 'applied', counts: { applied: 2, skipped: 1 } },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { log, error };
  }

  it.each(['receipt-once', 'receipt-persistent', 'summary-once', 'summary-persistent', 'both-persistent'])(
    'preserves attempted work when post-execution output fails (%s)', async (failure) => {
      const { log, error } = manualDispatch();
      const fail = () => { throw new Error('private-token-value echoed by filesystem'); };
      if (failure.startsWith('receipt') || failure === 'both-persistent') {
        const write = vi.spyOn(filesystem, 'writeFileSync');
        if (failure === 'receipt-once') write.mockImplementationOnce(fail);
        else write.mockImplementation(fail);
      }
      if (failure.startsWith('summary') || failure === 'both-persistent') {
        const append = vi.spyOn(filesystem, 'appendFileSync');
        if (failure === 'summary-once') append.mockImplementationOnce(fail);
        else append.mockImplementation(fail);
      }

      await expect(runManagedEnvironmentTaskFromProcess()).resolves.toBeUndefined();
      expect(executeManagedEnvironmentTask).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      const receipt = JSON.parse(error.mock.calls[0][0] as string);
      expect(receipt).toMatchObject({
        version: 1, status: 'failed', applied: 'unknown', skipped: 'unknown', executionId: '123',
      });
      expect(receipt.message).toContain('Review the staging outcome before retrying');
      expect(receipt.message).not.toContain('No task was started');
      expect(log).not.toHaveBeenCalled();
      expect([...log.mock.calls, ...error.mock.calls].flat().join('')).not.toContain('private-token-value');
      expect(process.exitCode).toBe(1);
    },
  );

  it('retains a safe blocked receipt when prerequisite failure outputs cannot be persisted', async () => {
    const { error } = manualDispatch();
    vi.stubEnv('HYPERVIBE_TASK_RUN_ATTEMPT', '2');
    const fail = () => { throw new Error('private-token-value echoed by filesystem'); };
    vi.spyOn(filesystem, 'writeFileSync').mockImplementation(fail);
    vi.spyOn(filesystem, 'appendFileSync').mockImplementation(fail);
    await expect(runManagedEnvironmentTaskFromProcess()).resolves.toBeUndefined();
    expect(executeManagedEnvironmentTask).not.toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({ status: 'blocked', applied: 0, skipped: 0 });
    expect(error.mock.calls.flat().join('')).not.toContain('private-token-value');
    expect(process.exitCode).toBe(1);
  });

  it.each(['contract', 'branch', 'schema'])(
    'keeps real %s prerequisites ahead of application execution', async (failure) => {
      const { error } = manualDispatch();
      if (failure === 'contract') vi.stubEnv('HYPERVIBE_TASK_CONTRACT_HASH', '0'.repeat(64));
      if (failure === 'branch') vi.stubEnv('GITHUB_REF', 'refs/heads/unreviewed');
      if (failure === 'schema') vi.mocked(readFileSync).mockReset().mockReturnValueOnce('{"version":1}');
      await runManagedEnvironmentTaskFromProcess();
      expect(executeManagedEnvironmentTask).not.toHaveBeenCalled();
      expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({ status: 'blocked', applied: 0, skipped: 0 });
    },
  );
});
