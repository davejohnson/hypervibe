import { assertHealthCheckPath } from '../domain/spec/health-check-path.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { admitEngineCiRelease } from '../domain/spec/engine-ci-binding.js';
import type { GitHubOidcContext } from '../domain/ports/engine-ci.port.js';
import type { EngineReleaseResult } from '../domain/ports/infrastructure-engine.port.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { cloudEngines } from './cloud-engines.js';
import { packageLocalCommit, runLocalCommitRelease, selectReleaseWorkloads } from './engine-release.js';
import { SqliteAdapter } from '../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../adapters/secrets/secret-store.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';

const exec = promisify(execFile);
export interface EngineCiReleaseReceipt {
  version: 1; status: 'skipped' | 'blocked' | 'released' | 'failed' | 'unknown'; message: string;
  repository?: string; environment?: string; revision?: string; runId?: string; runAttempt?: string;
  results?: Array<{ service: string; status: EngineReleaseResult['status']; serviceId: string; imageUri?: string; taskDefinitionArn?: string; url?: string }>;
}
export interface EngineCiReleaseInput { sourceDirectory: string; rawSpec: unknown; bindings: unknown; environmentName: string; github: GitHubOidcContext }

/** Read tracked admission documents from the exact commit; dirty workspace files are never authority. */
export async function engineCiCommitInputs(directory: string, sha: string): Promise<{ rawSpec: unknown; bindings: unknown }> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('The CI source revision is invalid.');
  const read = async (file: string) => {
    try { return JSON.parse((await exec('git', ['-C', directory, 'show', `${sha}:${file}`], { maxBuffer: 4 * 1024 * 1024 })).stdout); }
    catch { throw new Error(`The committed ${file} could not be read.`); }
  };
  const rawSpec = await read('.hypervibe/spec.json');
  // An absent bindings file is a neutral not-yet-applied environment, not permission to create it.
  const files = (await exec('git', ['-C', directory, 'ls-tree', '--name-only', sha, '.hypervibe/bindings.json'])).stdout.trim();
  return { rawSpec, bindings: files ? await read('.hypervibe/bindings.json') : undefined };
}

/** Runs in a dedicated CI process. All provider effects are image-only capabilities; no engine is invoked. */
export async function executeEngineCiRelease(input: EngineCiReleaseInput): Promise<EngineCiReleaseReceipt> {
  let attempted = false;
  const context = { repository: input.github.repository, environment: input.environmentName, revision: input.github.sha,
    ...(/^\d+$/.test(input.github.runId) ? { runId: input.github.runId } : {}), ...(/^\d+$/.test(input.github.runAttempt) ? { runAttempt: input.github.runAttempt } : {}) };
  try {
    const admitted = admitEngineCiRelease({ rawSpec: input.rawSpec, bindings: input.bindings, environmentName: input.environmentName,
      repository: input.github.repository, ref: input.github.ref, sha: input.github.sha });
    if (admitted.status === 'skipped') return { version: 1, status: 'skipped', message: admitted.message };
    const { spec, binding } = admitted;
    if (!['push', 'workflow_dispatch'].includes(input.github.eventName) || !/^\d+$/.test(input.github.runId) || !/^\d+$/.test(input.github.runAttempt)) throw new Error('Invalid CI event identity.');
    const directory = input.sourceDirectory;
    const head = (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    const remote = (await exec('git', ['-C', directory, 'remote', 'get-url', 'origin'])).stdout.trim();
    if (head !== input.github.sha || parseGitHubRepoFromRemote(remote) !== binding.repository) throw new Error('The checkout does not match the admitted repository and revision.');
    const committed = await engineCiCommitInputs(directory, head);
    if (canonicalJsonSha256(committed.rawSpec) !== canonicalJsonSha256(input.rawSpec) || canonicalJsonSha256(committed.bindings ?? null) !== canonicalJsonSha256(input.bindings ?? null)) throw new Error('CI admission documents differ from the source commit.');
    const environment = spec.environments[input.environmentName]!;
    for (const service of Object.values(environment.services)) if ((service.workloadKind ?? 'web') === 'web') assertHealthCheckPath(service.healthCheckPath ?? '/');
    if (Object.values(environment.services).some((s) => (s.workloadKind ?? 'web') === 'web' && s.public === false)) return { version: 1, status: 'blocked', message: 'CI cannot verify private web services on AWS or Azure yet. No build or release was started.' };
    if (environment.migrations?.mode === 'releaseCommand' || Object.values(environment.services).some((s) => s.releaseCommand)) throw new Error('Release commands are not implemented for these engine CI releases.');
    if (binding.provider === 'aws') {
      const web = Object.values(environment.services).filter((s) => (s.workloadKind ?? 'web') === 'web');
      // One image carries one web command; Lambda currently has no per-service
      // override. An omitted command is not proof of equivalence to an explicit one.
      if (new Set(web.map((s) => s.startCommand)).size > 1) return { version: 1, status: 'blocked', message: 'AWS web services share one image and cannot use different start commands in CI yet. Declare the same startCommand for every web service before releasing.' };
      if (web.some((s) => s.startCommand)) {
        const dockerfile = (await exec('git', ['-C', directory, 'ls-tree', '--name-only', head, 'Dockerfile'])).stdout.trim();
        if (dockerfile) return { version: 1, status: 'blocked', message: 'AWS web startCommand with a repository Dockerfile is not supported yet. Use the generated Dockerfile path or declare the command in the repository Dockerfile before releasing.' };
      }
    }
    const workloads = selectReleaseWorkloads(environment, undefined);
    if ('blocked' in workloads || workloads.selected.length === 0 || workloads.selected.length > 20) throw new Error('CI release requires between one and twenty exact workload bindings.');
    const provider = cloudEngines.find((entry) => entry.hostingProvider === binding.provider);
    if (!provider?.ciRelease) throw new Error('The selected engine does not implement CI image releases.');
    const target = await provider.ciRelease(binding, { ...input.github, deadlineMs: Date.now() + 35 * 60_000 }, spec);
    await target.preflight();
    const source = await packageLocalCommit(directory, { format: target.format, dockerfileName: target.dockerfileName, addFiles: target.addFiles, commitSha: head,
      dockerfileFor: (repositoryDockerfile) => target.dockerfileFor({ repositoryDockerfile, runtime: spec.runtime, startCommand: workloads.startCommand }) });
    if ('blocked' in source || source.commitSha !== head) throw new Error('The exact release source could not be packaged.');
    const dataDir = mkdtempSync(join(tmpdir(), 'hypervibe-ci-release-'));
    const previous = { data: process.env.HYPERVIBE_DATA_DIR, key: process.env.HYPERVIBE_SECRET_KEY, repo: process.env.HYPERVIBE_DISABLE_REPO_SPEC };
    const started = Date.now();
    try {
      process.env.HYPERVIBE_DATA_DIR = dataDir; process.env.HYPERVIBE_SECRET_KEY = crypto.randomBytes(32).toString('hex'); process.env.HYPERVIBE_DISABLE_REPO_SPEC = '1';
      SqliteAdapter.resetInstance(); SecretStore.resetInstance(); SqliteAdapter.getInstance(join(dataDir, 'receipt.db')).migrate();
      const project = new ProjectRepository().create({ name: spec.project, gitRemoteUrl: spec.gitRemoteUrl, defaultPlatform: binding.provider });
      const localEnvironment = new EnvironmentRepository().create({ projectId: project.id, name: binding.environmentName, platformBindings: { services: binding.services } });
      let stopped = false;
      const execution = await runLocalCommitRelease({ project, spec, environmentName: binding.environmentName, specRevision: 1 }, source, workloads.selected, {
        cloudName: target.cloudName, provider: binding.provider, environmentId: localEnvironment.id, buildPhrase: target.buildPhrase, firstImage: false, createdNoun: 'workloads',
        resourceOf: (name) => binding.services[name]!.serviceId,
        build: async (packaged) => {
          attempted = true;
          try {
            const built = await target.build(packaged);
            if ('error' in built) { stopped = true; return { error: 'The cloud image build did not finish successfully. Inspect its managed build logs before retrying.', ...(built.unknown ? { unknown: true } : {}) }; }
            if (!/@sha256:[a-f0-9]{64}$/.test(built.image)) { stopped = true; return { error: 'The cloud did not confirm an immutable image digest.', unknown: true }; }
            return { image: built.image };
          } catch { stopped = true; return { error: 'The cloud build outcome could not be verified. Inspect its managed build logs before retrying.', unknown: true }; }
        },
        recordImage: () => undefined,
        releaseWorkload: async (workload) => {
          if (stopped || Date.now() - started > 35 * 60_000) { stopped = true; return { service: workload.name, status: 'unknown', message: 'An earlier release step or the release deadline stopped further workload updates.' }; }
          try {
            const result = await target.releaseWorkload(workload); if (result.status !== 'released') stopped = true;
            const safe: EngineReleaseResult = { service: workload.name, status: result.status, imageUri: workload.image,
              message: result.status === 'released' ? 'The exact workload reported the released image.' : 'The exact workload release was not confirmed; inspect its logs before retrying.' };
            if (result.taskDefinitionArn && /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[a-zA-Z0-9_-]+:\d+$/.test(result.taskDefinitionArn)) safe.taskDefinitionArn = result.taskDefinitionArn;
            if (result.url) { const url = new URL(result.url); if (url.protocol === 'https:' && !url.username && !url.password) { url.search = ''; url.hash = ''; safe.url = url.toString(); } }
            return safe;
          } catch { stopped = true; return { service: workload.name, status: 'unknown', message: 'The exact workload release outcome could not be verified; no later workload was updated.' }; }
        },
      });
      if ('blocked' in execution) return { version: 1, ...context, status: 'blocked', message: 'The image-only release could not start.' };
      const results = execution.results.map((result) => ({ service: result.service, status: result.status, serviceId: binding.services[result.service]?.serviceId ?? 'image',
        ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.taskDefinitionArn ? { taskDefinitionArn: result.taskDefinitionArn } : {}), ...(result.url ? { url: result.url } : {}) }));
      const status = results.some((r) => r.status === 'unknown') ? 'unknown' : results.some((r) => r.status === 'failed') ? 'failed' : 'released';
      return { version: 1, ...context, status, results, message: status === 'released' ? 'The admitted commit was released to the exact applied workloads.' : 'The release did not finish successfully. Inspect the returned workload states before retrying.' };
    } finally {
      SqliteAdapter.resetInstance(); SecretStore.resetInstance();
      for (const [key, value] of Object.entries({ HYPERVIBE_DATA_DIR: previous.data, HYPERVIBE_SECRET_KEY: previous.key, HYPERVIBE_DISABLE_REPO_SPEC: previous.repo })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {
    // Provider and git exceptions can contain assertions, credentials or signed URLs.
    return { version: 1, status: attempted ? 'unknown' : 'blocked', message: attempted
      ? 'The release outcome could not be verified. Inspect the managed workloads before retrying.'
      : 'The release prerequisites could not be verified. No build or workload update was started; check the committed contract, applied bindings and cloud access.' };
  }
}
