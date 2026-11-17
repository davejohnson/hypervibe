import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineCiCommitInputs, executeEngineCiRelease, type EngineCiReleaseReceipt } from '../application/engine-ci-execution.js';

/** Thin process adapter for the reviewed engine release workflow. */
export async function runEngineCiReleaseFromProcess(env: NodeJS.ProcessEnv = process.env): Promise<EngineCiReleaseReceipt> {
  let receipt: EngineCiReleaseReceipt;
  try {
    if (env.GITHUB_ACTIONS !== 'true') throw new Error('This entry point requires GitHub Actions.');
    const sha = env.GITHUB_SHA ?? ''; const sourceDirectory = resolve(env.GITHUB_WORKSPACE ?? '.');
    const input = await engineCiCommitInputs(sourceDirectory, sha);
    receipt = await executeEngineCiRelease({ ...input, sourceDirectory, environmentName: env.HYPERVIBE_CI_ENVIRONMENT ?? '', github: {
      repository: env.GITHUB_REPOSITORY ?? '', ref: env.GITHUB_REF ?? '', sha, eventName: env.GITHUB_EVENT_NAME ?? '', runId: env.GITHUB_RUN_ID ?? '', runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
      requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '', requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? '',
    } });
  } catch { receipt = { version: 1, status: 'blocked', message: 'The committed CI release inputs could not be verified. No release was started.' }; }
  if (!['skipped', 'released'].includes(receipt.status)) process.exitCode = 1;
  const json = JSON.stringify(receipt, null, 2) + '\n';
  console.log(json);
  try {
    if (env.HYPERVIBE_CI_RECEIPT_PATH) writeFileSync(resolve(env.HYPERVIBE_CI_RECEIPT_PATH), json, { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${receipt.message}\n`);
  } catch {
    process.exitCode = 1;
    console.error('The release receipt could not be saved. Preserve the terminal receipt and inspect the workload state before retrying.');
  }
  return receipt;
}
