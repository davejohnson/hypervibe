import type { ProjectSpec } from './spec.schema.js';
import { normalizeGitRemoteIdentity, parseGitHubRepoFromRemote } from '../../lib/git-remote.js';

export interface DevOpsSelection {
  code: {
    provider: string;
    scope: string;
  };
  ci?: {
    provider: string;
  };
  canonicalEnvironment?: string;
  source: 'canonical' | 'legacy-github';
}

function usesManagedCi(spec: ProjectSpec): boolean {
  return Object.values(spec.environments).some((environment) => (
    environment.deploy?.strategy === 'branch'
    && environment.deploy.trigger !== 'native'
  ));
}

function legacyGitHubNeedsActions(spec: ProjectSpec): boolean {
  const github = spec.github;
  return usesManagedCi(spec)
    || Boolean(github && (
      Object.keys(github.actions).length > 0
      || Object.keys(github.externalWorkflows).length > 0
    ))
    || Object.values(spec.environments).some((environment) => Boolean(
      environment.database?.resilience?.restoreDrill
      || environment.ios?.release
    ));
}

/**
 * Resolve the one runtime DevOps selection without changing persisted desired
 * state. Legacy GitHub specs keep their pinned provider mapping; provider
 * inference is never used for a new non-GitHub deployment authority.
 */
export function resolveDevOpsSelection(spec: ProjectSpec): DevOpsSelection | null {
  if (spec.devops) {
    return {
      code: { provider: spec.devops.code.provider, scope: spec.devops.code.scope },
      ...(spec.devops.ci ? { ci: { provider: spec.devops.ci.provider } } : {}),
      ...(spec.devops.canonicalEnvironment
        ? { canonicalEnvironment: spec.devops.canonicalEnvironment }
        : {}),
      source: 'canonical',
    };
  }

  const repository = spec.github?.repository ?? parseGitHubRepoFromRemote(spec.gitRemoteUrl);
  if (!repository) return null;
  return {
    code: { provider: 'github', scope: repository },
    ...(legacyGitHubNeedsActions(spec) ? { ci: { provider: 'github-actions' } } : {}),
    ...(spec.github?.canonicalEnvironment
      ? { canonicalEnvironment: spec.github.canonicalEnvironment }
      : {}),
    source: 'legacy-github',
  };
}

export function devOpsScopeMatchesRemote(spec: ProjectSpec): boolean {
  if (!spec.devops || !spec.gitRemoteUrl) return true;
  const remote = normalizeGitRemoteIdentity(spec.gitRemoteUrl);
  if (!remote) return false;
  const rawScope = spec.devops.code.scope.trim();
  const pathOnly = !rawScope.includes('://') && !/^[^@/]+@[^:/]+[:/]/.test(rawScope);
  if (pathOnly) {
    const pathOnlyScope = rawScope.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
    const remotePath = remote.slice(remote.indexOf('/') + 1).toLowerCase();
    return Boolean(pathOnlyScope && pathOnlyScope === remotePath);
  }
  const scope = normalizeGitRemoteIdentity(rawScope);
  if (scope) return remote === scope;
  return false;
}

export function environmentUsesManagedCi(spec: ProjectSpec, environmentName: string): boolean {
  const environment = spec.environments[environmentName];
  return Boolean(
    environment
    && environment.deploy?.strategy === 'branch'
    && environment.deploy.trigger !== 'native'
    && resolveDevOpsSelection(spec)?.ci
  );
}
