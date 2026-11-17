import { execFile } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { ENGINE_PLAN_SCOPE as RELEASE_PLAN_SCOPE, ENGINE_RELEASE_OPERATION as RELEASE_OPERATION, type EngineReleaseResult } from './infrastructure-engine.js';

const execFileAsync = promisify(execFile);

/** One exact commit, packaged for a cloud's managed build service. */
export interface LocalCommitSource { commitSha: string; archive: Buffer; uncommittedChangesExcluded: boolean }

/**
 * Packages a local commit without git credentials or Docker: the tracked files
 * at that commit, plus the Dockerfile Hypervibe builds and any files it adds.
 */
export async function packageLocalCommit(directory: string, options: {
  format: 'zip' | 'tar.gz';
  dockerfileName: string;
  dockerfileFor: (repositoryDockerfile?: string) => string;
  /** Extra generated files to add, by path inside the archive. */
  addFiles?: Record<string, string>;
  /** Defaults to HEAD. */
  commitSha?: string;
}): Promise<LocalCommitSource | { blocked: string }> {
  try {
    const git = async (args: string[]) => String((await execFileAsync('git', ['-C', directory, ...args])).stdout);
    const commitSha = options.commitSha ?? (await git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return { blocked: 'The local repository has no commit to release.' };
    let repositoryDockerfile: string | undefined;
    try { repositoryDockerfile = await git(['show', `${commitSha}:Dockerfile`]); } catch { /* no repository Dockerfile */ }
    const virtualFiles = { [options.dockerfileName]: options.dockerfileFor(repositoryDockerfile), ...(options.addFiles ?? {}) };
    const archive = (await execFileAsync('git', ['-C', directory, 'archive', `--format=${options.format}`,
      ...Object.entries(virtualFiles).map(([name, content]) => `--add-virtual-file=${name}:${content}`), commitSha],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })).stdout as Buffer;
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
    return { commitSha, archive, uncommittedChangesExcluded: dirty };
  } catch (error) {
    return { blocked: `Hypervibe could not package this repository: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
}

/** The services a release targets, and the start command a generated image uses. */
export function selectReleaseWorkloads(environmentSpec: EnvironmentSpec, services: string[] | undefined): { selected: string[]; web?: string; startCommand?: string } | { blocked: string } {
  const selected = services?.length ? services : Object.keys(environmentSpec.services);
  const unknownNames = selected.filter((name) => !environmentSpec.services[name]);
  if (unknownNames.length) return { blocked: `${unknownNames.join(', ')} is not a service in this environment.` };
  const web = selected.find((name) => (environmentSpec.services[name]!.workloadKind ?? 'web') === 'web');
  const startCommand = environmentSpec.services[web ?? selected[0]!]?.startCommand;
  return { selected, ...(web ? { web } : {}), ...(startCommand ? { startCommand } : {}) };
}

/** What one cloud supplies to release an already-packaged commit. */
export interface LocalCommitReleaseTarget {
  /** Name shown to the user, for example "AWS". */
  cloudName: string;
  /** `resource.provider` recorded on the release actions. */
  provider: string;
  environmentId: string;
  /** Completes "Build commit abc123 ...", for example "in CodeBuild". */
  buildPhrase: string;
  /** True when no workloads exist yet: the release only builds, and the next infrastructure plan creates them. */
  firstImage: boolean;
  /** What the first-image message calls the things the next plan creates: "services" or "workloads". */
  createdNoun: string;
  /** Native identity of a service, recorded on its release action. */
  resourceOf(name: string): string;
  build(source: LocalCommitSource): Promise<{ image: string; logsUrl?: string } | { error: string; logsUrl?: string; unknown?: boolean }>;
  /** Records the built image before any workload switches, so new workloads are created from it. */
  recordImage(image: string, source: LocalCommitSource): void;
  releaseWorkload(workload: { name: string; kind: string; resource: string; image: string }): Promise<EngineReleaseResult>;
}

/**
 * The release every engine shares: one reviewed plan with a build action and one
 * action per service, executed through the ordinary executor so each step has a
 * receipt. Only the running image changes; a missing workload stops the release.
 */
export async function runLocalCommitRelease(params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number;
}, source: LocalCommitSource, selected: string[], target: LocalCommitReleaseTarget): Promise<
  { results: EngineReleaseResult[]; applyRunId: string; source: { kind: 'local-commit'; revision: string; commitSha: string; uncommittedChangesExcluded?: boolean } } | { blocked: string }
> {
  const environmentSpec = params.spec.environments[params.environmentName]!;
  const commit = source.commitSha.slice(0, 12);
  const actions: PlanAction[] = [
    { id: 'build:image', type: 'update', verified: true, resource: { kind: 'service', name: 'image', provider: target.provider },
      reason: `Build commit ${commit} ${target.buildPhrase}.`, metadata: { operation: RELEASE_OPERATION, workloadKind: 'build' } },
    ...(target.firstImage ? [] : selected.map((name): PlanAction => ({
      id: `release:${name}`, type: 'update', verified: true, dependsOn: ['build:image'], resource: { kind: 'service', name, provider: target.provider },
      reason: `Release commit ${commit} to ${name}; only the running image changes.`,
      metadata: { operation: RELEASE_OPERATION, resource: target.resourceOf(name), workloadKind: environmentSpec.services[name]!.workloadKind ?? 'web' },
    }))),
  ];
  const runRepo = new RunRepository();
  const planRun = runRepo.create({ projectId: params.project.id, environmentId: target.environmentId, type: 'plan', plan: {
    kind: 'hv_plan', scope: RELEASE_PLAN_SCOPE, environmentName: params.environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings: [], engine: { planId: `release-${crypto.randomUUID()}`, release: true },
  } as unknown as Record<string, unknown> });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const results: EngineReleaseResult[] = [];
  let image: string | undefined;
  const execution = await new ConvergeExecutor().execute({
    planRunId: planRun.id,
    currentSpecRevision: params.specRevision,
    handler: async (action) => {
      try {
        if (action.id === 'build:image') {
          const built = await target.build(source);
          if ('error' in built) {
            results.push({ service: 'image', status: built.unknown ? 'unknown' : 'failed', message: built.error, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}) });
            return { success: false, ...(built.unknown ? { status: 'pending' as const } : {}), message: built.error, error: built.error };
          }
          image = built.image;
          target.recordImage(image, source);
          if (target.firstImage) {
            results.push({ service: 'image', status: 'released', imageUri: image, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}),
              message: `Built the first image. Run hv_plan scope="infrastructure" and hv_apply to create the ${target.createdNoun} from it.` });
          }
          return { success: true, message: `Built ${image}.`, data: { imageUri: image } };
        }
        const result = await target.releaseWorkload({
          name: action.resource.name, kind: String(action.metadata?.workloadKind), resource: String(action.metadata?.resource), image: image!,
        });
        results.push(result);
        const data = { ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.taskDefinitionArn ? { taskDefinitionArn: result.taskDefinitionArn } : {}), ...(result.url ? { url: result.url } : {}) };
        if (result.status === 'released') return { success: true, message: result.message, data };
        return { success: false, ...(result.status === 'unknown' ? { status: 'pending' as const } : {}), message: result.message, error: result.message, data };
      } catch (error) {
        const message = `${target.cloudName} rejected the release step: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error)}`;
        results.push({ service: action.resource.name, status: 'unknown', message });
        return { success: false, status: 'pending', message, error: message };
      }
    },
  });
  if (!execution.applyRunId) return { blocked: execution.error ?? 'The release could not start.' };
  for (const name of target.firstImage ? ['image'] : selected) {
    if (!results.some((result) => result.service === name)) {
      results.push({ service: name, status: 'failed', message: `${name} was not released because an earlier step did not finish. ${execution.error ?? ''}`.trim() });
    }
  }
  return { results, applyRunId: execution.applyRunId,
    source: { kind: 'local-commit', revision: source.commitSha, commitSha: source.commitSha, ...(source.uncommittedChangesExcluded ? { uncommittedChangesExcluded: true } : {}) } };
}
