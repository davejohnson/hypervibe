import type { ProjectSpec } from './spec.schema.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';

export interface EngineCiIntent { repository: string; branch: string; environmentName: string }

export function assertEngineCiIntent(intent: EngineCiIntent): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(intent.repository)
    || !/^[A-Za-z0-9_/-][A-Za-z0-9._/-]*$/.test(intent.branch) || intent.branch.includes('..') || intent.branch.endsWith('/')
    || !/^[A-Za-z0-9_-]+$/.test(intent.environmentName)) throw new Error('CI releases need one GitHub repository, an exact branch and an environment name.');
}

/** CI is desired infrastructure: trust and permissions join the reviewed engine plan. */
export function engineCiIntent(spec: ProjectSpec, environmentName: string): EngineCiIntent | undefined {
  const env = spec.environments[environmentName];
  if (env?.deploy?.strategy !== 'branch') return undefined;
  if (['aws', 'azure'].includes(env.hosting.provider)) {
    const web = Object.values(env.services).filter(service => (service.workloadKind ?? 'web') === 'web');
    if (env.migrations?.mode === 'releaseCommand' || Object.values(env.services).some(service => service.releaseCommand)) {
      throw new Error('Release-command migrations are not implemented for this cloud’s branch releases.');
    }
    if (web.some(service => service.public === false)) throw new Error('Branch releases need public web health access. Private web CI health verification is not implemented on this cloud.');
  }
  const repository = parseGitHubRepoFromRemote(spec.gitRemoteUrl);
  if (!repository) throw new Error('CI releases need this project’s GitHub repository in gitRemoteUrl.');
  const intent = { repository, branch: env.deploy.branch ?? 'main', environmentName };
  assertEngineCiIntent(intent);
  return intent;
}
