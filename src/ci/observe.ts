import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { runtimeObserverAccess } from '../adapters/runtime-observer-auth.js';
import { readRuntimeObservations } from '../adapters/runtime-observation/index.js';
import { engineCiCommitInputs } from '../application/engine-ci-execution.js';
import { pollRuntime, type JobSchedules } from '../application/runtime-observation-poll.js';
import { admitRuntimeObserver } from '../domain/spec/runtime-observation.js';
import { projectSpecSchema } from '../domain/spec/spec.schema.js';
import { restoreObservationCursor } from './observation-history.js';

async function observerContext(environmentName: string, env: NodeJS.ProcessEnv) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const repositoryId = env.GITHUB_REPOSITORY_ID ?? '';
  const github = { repository: repo, ref: env.GITHUB_REF ?? '', sha: env.GITHUB_SHA ?? '', eventName: env.GITHUB_EVENT_NAME ?? '',
    runId: env.GITHUB_RUN_ID ?? '', runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '', requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? '' };
  if (env.GITHUB_ACTIONS !== 'true' || !['workflow_dispatch', 'schedule'].includes(github.eventName) || github.runAttempt !== '1'
      || !/^\d+$/.test(github.runId) || !/^\d+$/.test(repositoryId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(environmentName)
      || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !env.RUNNER_TEMP || !env.GITHUB_TOKEN
      || env.GITHUB_WORKFLOW_REF !== `${repo}/.github/workflows/hypervibe-observe-${environmentName}.yml@${github.ref}`) {
    throw new Error('Runtime observation requires the configured GitHub Actions workflow on its trusted branch.');
  }
  const files = await engineCiCommitInputs(env.GITHUB_WORKSPACE ?? '.', github.sha);
  const binding = admitRuntimeObserver({ ...files, environmentName, repository: repo, ref: github.ref, sha: github.sha });
  const spec = projectSpecSchema.parse(files.rawSpec).environments[environmentName];
  return { github, repo, repositoryId, binding, spec, dir: path.join(env.RUNNER_TEMP, 'hv-observe') };
}

export async function runObserve(environmentName: string, env: NodeJS.ProcessEnv = process.env) {
  const { github, repo, repositoryId, binding, spec, dir } = await observerContext(environmentName, env);
  const services = spec.services;
  const schedules: JobSchedules = {};
  for (const [name, service] of Object.entries(services)) {
    if (service.workloadKind === 'cron' && service.cronSchedule) schedules[name] = { cronSchedule: service.cronSchedule, timeZone: service.timeZone };
  }
  const api = new GitHubAdapter();
  api.connect({ apiToken: env.GITHUB_TOKEN! });
  const now = new Date();
  const history = await restoreObservationCursor(api, { repository: repo, repositoryId, environment: environmentName, branch: binding.branch,
    runId: github.runId, provider: binding.provider }, now);
  const access = await runtimeObserverAccess(binding, github);
  const { report, cursor } = await pollRuntime({ binding, repositoryId, schedules, previous: history.cursor, gap: history.gap, now,
    read: (window, opts) => readRuntimeObservations(binding, window, access, opts) });
  await mkdir(path.join(dir, 'reports'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'reports', `${environmentName}.json`), JSON.stringify(report), { mode: 0o600 });
  await writeFile(path.join(dir, 'next-cursor.json'), JSON.stringify({ ...cursor, hostedReview: spec.runtimeObservation?.hostedReview || undefined }), { mode: 0o600 });
  return report;
}

export async function deliverObservations(environmentName: string, env: NodeJS.ProcessEnv = process.env) {
  const { github, spec, dir, binding, repo, repositoryId } = await observerContext(environmentName, env);
  if (!spec.runtimeObservation?.hostedReview) throw new Error('Hosted review is disabled in the committed environment.');
  const report = JSON.parse(await readFile(path.join(dir, 'reports', environmentName + '.json'), 'utf8'));
  const api = new GitHubAdapter();
  api.connect({ apiToken: env.GITHUB_TOKEN! });
  const { replayHostedReports } = await import('./hosted-observations.js');
  const scope = { repository: repo, repositoryId, environment: environmentName, branch: binding.branch, runId: github.runId, provider: binding.provider };
  const receipt = path.join(dir, 'hosted-receipt.json');
  return replayHostedReports({ api, scope, github, report, now: new Date(), warn: message => console.warn('::warning::' + message),
    acknowledge: async progress => {
      await writeFile(receipt + '.tmp', JSON.stringify({ version: 1, repositoryId, environment: environmentName, provider: binding.provider, ...progress }), { mode: 0o600 });
      await rename(receipt + '.tmp', receipt);
    },
  });
}
