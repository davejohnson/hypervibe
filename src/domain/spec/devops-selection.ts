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
    || Object.values(spec.secrets).some((secret) => (
      secret.ownership === 'delegated'
      && Boolean(secret.githubActions?.repository || secret.githubActions?.environments.length)
    ))
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

/**
 * Resolve GitHub Actions as the explicit code-host/CI authority for repository
 * secret destinations. Canonical DevOps state must select both halves; legacy
 * state remains opt-in through its enabled top-level GitHub block.
 */
export function resolveGitHubActionsSelection(spec: ProjectSpec): DevOpsSelection | null {
  const selection = resolveDevOpsSelection(spec);
  if (
    !selection
    || selection.code.provider !== 'github'
    || selection.ci?.provider !== 'github-actions'
    || (selection.source === 'legacy-github' && (!spec.github || spec.github.enabled === false))
  ) {
    return null;
  }
  return selection;
}

export function githubActionsCanonicalEnvironment(spec: ProjectSpec): string | undefined {
  const selection = spec.devops
    ? resolveGitHubActionsSelection(spec)
    : null;
  if (spec.devops && !selection) return undefined;
  if (!spec.devops && (!spec.github || spec.github.enabled === false)) return undefined;
  return (selection?.canonicalEnvironment ?? spec.github?.canonicalEnvironment)
    ?? (spec.environments.production ? 'production' : Object.keys(spec.environments).sort()[0])
    ?? 'repository';
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
