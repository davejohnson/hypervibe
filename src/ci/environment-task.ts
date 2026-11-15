import './providers.js';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { executeManagedEnvironmentTask, ManagedTaskExecutionError } from '../application/managed-environment-task.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { projectSpecSchema } from '../domain/spec/spec.schema.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';

/** Interface-specific CI entry: only a reviewed named task, never an exec API. */
export async function runManagedEnvironmentTaskFromProcess(): Promise<void> {
  const env = process.env;
  const path = env.HYPERVIBE_TASK_RECEIPT_PATH;
  let attempted = false;
  try {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !env.GITHUB_TOKEN || env.HYPERVIBE_TASK_RUN_ATTEMPT !== '1') throw new Error('A new manual Actions dispatch is required.');
    const rawSpec = JSON.parse(readFileSync(resolve('.hypervibe/spec.json'), 'utf8'));
    const spec = projectSpecSchema.parse(rawSpec);
    const task = spec.github?.actions[env.HYPERVIBE_TASK_ID ?? ''];
    if (task?.kind !== 'environment-task' || task.environment !== env.HYPERVIBE_TASK_ENVIRONMENT
        || env.GITHUB_REF !== `refs/heads/${spec.environments[task.environment]?.deploy?.branch}`
        || env.HYPERVIBE_TASK_CONTRACT_HASH !== canonicalJsonSha256(task)) {
      throw new Error('The named task does not match the reviewed job environment and branch.');
    }
    const bindings = JSON.parse(readFileSync(resolve('.hypervibe/bindings.json'), 'utf8'));
    const github = await providerRegistry.createAdapter<GitHubAdapter>('github', { apiToken: env.GITHUB_TOKEN });
    const result = await executeManagedEnvironmentTask({
      spec, rawSpec, bindings, taskId: env.HYPERVIBE_TASK_ID ?? '',
      inputs: JSON.parse(env.HYPERVIBE_TASK_INPUTS_JSON ?? '{}'),
      repository: env.GITHUB_REPOSITORY ?? '', sha: env.GITHUB_SHA ?? '',
      executionId: env.HYPERVIBE_TASK_RUN_ID ?? '',
      github, credentials: env,
    });
    // A completed application execution stays attempted even if publishing its
    // evidence fails. A filesystem error cannot prove that no task ran.
    attempted = true;
    const json = JSON.stringify(result, null, 2) + '\n';
    if (path) writeFileSync(path, json, { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Environment task completed.\n\n\x60\x60\x60json\n${json}\x60\x60\x60\n`);
    console.log(json);
  } catch (error) {
    // Provider exceptions can echo credentials, resolved values or application
    // logs. Render only this value-free failure at the CI output boundary.
    attempted = attempted || (error instanceof ManagedTaskExecutionError && error.attempted);
    const receipt = { version: 1, status: attempted ? 'failed' : 'blocked', applied: attempted ? 'unknown' : 0, skipped: attempted ? 'unknown' : 0,
      ...(/^[0-9]+$/.test(env.HYPERVIBE_TASK_RUN_ID ?? '') ? { executionId: env.HYPERVIBE_TASK_RUN_ID } : {}),
      message: attempted
        ? 'Task execution, receipt, or cleanup could not be verified. Review the staging outcome before retrying; no automatic retry was attempted.'
        : 'Task prerequisites could not be verified. No task was started. Check that this default-branch revision deployed successfully and its bindings and machine credentials are configured.' };
    const json = JSON.stringify(receipt, null, 2) + '\n';
    console.error(json);
    process.exitCode = 1;
    // Failure evidence is best effort; repeated filesystem failures must not
    // suppress the safe terminal receipt or escape with an unredacted error.
    try { if (path) writeFileSync(path, json, { mode: 0o600 }); } catch { /* Console receipt remains available. */ }
    try { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, receipt.message + '\n'); } catch { /* Console receipt remains available. */ }
  }
}
