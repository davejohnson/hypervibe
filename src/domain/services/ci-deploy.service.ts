import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { githubPackagePullCredentials } from '../../adapters/providers/github/package-pull.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  buildBranchDeployWorkflow,
  getGitHubAdapter,
  githubActionsWorkflowInputHash,
  resolveBranchDeployTargets,
  type BranchDeployWorkflow,
} from './github-ops.service.js';
export { githubActionsWorkflowInputHash };
import { missingManagedCiReleaseBindings } from './managed-ci-targets.js';
import {
  IOS_RELEASE_REQUIRED_SECRETS,
  MATCH_SIGNING_REQUIRED_SECRETS,
  iosReleaseWorkflowPath,
} from './ios-release-workflow.service.js';
import { getVerifiedAppStoreConnectCredentials } from './appstore-ops.service.js';
import { proposeGitHubInfrastructureFiles } from './github-infrastructure.service.js';
import { formatConnectionGuidance, GITHUB_TOKEN_URLS } from './connection-guidance.js';
import { resolveExternalDatabaseUrl } from './database-ops.service.js';
import {
  APPLIED_SPEC_HASH_OPERATION,
  APPLIED_SPEC_HASH_VARIABLE,
  environmentDeploymentContractHashForApply,
} from './deployment-contract.service.js';
import { managedCiReleaseArtifactName } from './managed-ci-evidence.js';

const OPERATION = 'githubActionsDeployBranch';
export const GITHUB_ACTIONS_RELEASE_OPERATION = 'githubActionsRelease';
const GITHUB_CI_REQUIRED_CLASSIC_SCOPES = ['repo', 'workflow'];
const RELEASE_WAIT_TIMEOUT_MS = 30 * 60_000;
const RELEASE_POLL_INTERVAL_MS = 3_000;

export function managedWorkflowPublicationBranch(environmentName: string): string {
  const slug = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'environment';
  return `hypervibe/managed-ci-${slug}-${sha256(environmentName).slice(0, 8)}`;
}

export function requiredProviderSecretNamesForGitHubActions(provider: string): string[] {
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;
  const names = [...(ci?.requiredSecrets ?? [])];
  if (ci?.requiresGitHubPackagePull) {
    names.push('IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN');
  }
  return Array.from(new Set(names));
}

export function missingProviderSecretsMessage(provider: string, missingProviderSecrets: string[]): string {
  const missingDatabaseUrl = missingProviderSecrets.includes('DATABASE_URL');
  const providerSecrets = missingProviderSecrets.filter((name) => name !== 'DATABASE_URL');
  const parts = providerSecrets.length > 0
    ? [`Missing provider secrets: ${providerSecrets.join(', ')}.`]
    : [];
  const missingImageRegistrySecrets = missingProviderSecrets.some((name) => name.startsWith('IMAGE_REGISTRY_'));
  const missingProviderApiSecrets = providerSecrets.some((name) => !name.startsWith('IMAGE_REGISTRY_'));
  if (missingDatabaseUrl) {
    parts.push('Missing managed database secret: DATABASE_URL. Hypervibe could not resolve an externally reachable database URL for the GitHub Actions migration step; reconcile the database and re-run hv_plan.');
  }
  if (missingProviderApiSecrets) {
    parts.push(`Connect and verify ${provider} so Hypervibe can sync its API credentials into GitHub Actions. ${formatConnectionGuidance(provider)}`);
  }
  if (missingImageRegistrySecrets) {
    const displayName = providerRegistry.getMetadata(provider)?.displayName ?? provider;
    parts.push(`For ${displayName} GHCR image pulls, reconnect GitHub with both GitHub API and package-read credentials (create the read:packages PAT here: ${GITHUB_TOKEN_URLS.packageRead}). The GitHub apiToken needs repo + workflow for workflow/secrets management; packageReadToken needs read:packages for durable package/image pulls. ${formatConnectionGuidance('github', { intro: 'Confirm the GitHub token type and CI deploy permissions.' })}`);
  }
  return parts.join(' ');
}

export function githubCiDeployPermissionProblem(
  verification: { scopes?: string[] },
  options: { repo?: string } = {}
): { missingScopes: string[]; hint: string } | null {
  // GitHub exposes x-oauth-scopes for classic PATs. Fine-grained PATs may not
  // report classic scopes here, so only enforce when the scope header exists.
  if (!verification.scopes?.length) {
    return null;
  }
  const scopes = new Set(verification.scopes);
  const missingScopes = GITHUB_CI_REQUIRED_CLASSIC_SCOPES.filter((scope) => !scopes.has(scope));
  if (missingScopes.length === 0) {
    return null;
  }
  return {
    missingScopes,
    hint: [
      `The GitHub apiToken is verified but missing classic PAT scope(s): ${missingScopes.join(', ')}.`,
      'A read:packages-only token is only enough for GHCR image pulls; it cannot create/update deploy workflows or repository secrets.',
      formatConnectionGuidance('github', {
        scope: options.repo,
        intro: 'Reconnect GitHub with CI deploy permissions.',
      }),
    ].join(' '),
  };
}

const connectionRepo = new ConnectionRepository();

type ProviderSecret = { name: string; value: string };
type ManagedWorkflowBinding = {
  contentHash?: string;
  inputHash?: string;
  managedPaths?: string[];
  syncedEnvironmentSecrets?: string[];
  syncedEnvironmentSecretHashes?: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function environmentUsesGitHubActionsDeploy(environmentSpec: EnvironmentSpec): boolean {
  return environmentSpec.deploy?.strategy === 'branch' && (environmentSpec.deploy.trigger ?? 'ci') === 'ci';
}

export function isGitHubActionsDeployAction(action: PlanAction): boolean {
  return action.metadata?.operation === OPERATION;
}

export function isGitHubActionsAppliedSpecHashAction(action: PlanAction): boolean {
  return action.metadata?.operation === APPLIED_SPEC_HASH_OPERATION;
}

export function providerSecretsForGitHubActions(
  provider: string,
  options: { githubLogin?: string; githubRepo?: string } = {}
): ProviderSecret[] {
  const secrets: ProviderSecret[] = [];
  const connection = connectionRepo.findBestVerifiedMatch(provider, options.githubRepo);
  const ci = providerRegistry.getMetadata(provider)?.orchestration?.ci;

  if (connection) {
    const credentials = getSecretStore().decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
    for (const name of ci?.requiredSecrets ?? []) {
      const credentialKey = ci?.secretCredentialKeys?.[name];
      if (!credentialKey) continue;
      const value = credentials[credentialKey];
      if (typeof value === 'string' && value.length > 0) {
        secrets.push({ name, value });
      }
    }
  }

  if (ci?.requiresGitHubPackagePull) {
    const pull = githubPackagePullCredentials({ githubRepo: options.githubRepo, githubLogin: options.githubLogin });
    if (pull) {
      secrets.push(
        { name: 'IMAGE_REGISTRY_USERNAME', value: pull.username },
        { name: 'IMAGE_REGISTRY_TOKEN', value: pull.token }
      );
    }
  }

  return secrets;
}

/**
 * The managed database's externally reachable URL as a GitHub Actions
 * secret, when the environment has one — lets the generated migration
 * step run without a manually configured DATABASE_URL.
 */
export async function databaseUrlSecretForGitHubActions(
  project: Project,
  environmentName: string
): Promise<ProviderSecret | null> {
  const environment = new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
  if (!environment) return null;
  const url = await resolveExternalDatabaseUrl(project, environment);
  return url ? { name: 'DATABASE_URL', value: url } : null;
}

function ciBindings(environment: Environment | null): Record<string, ManagedWorkflowBinding> {
  const ci = asRecord(environment?.platformBindings?.ci);
  return asRecord(ci?.deployBranch) as Record<string, ManagedWorkflowBinding> | null ?? {};
}

function boundManagedWorkflowPaths(environment: Environment | null): string[] {
  const paths = new Set<string>();
  for (const [workflowPath, binding] of Object.entries(ciBindings(environment))) {
    paths.add(workflowPath);
    for (const path of binding.managedPaths ?? []) {
      if (typeof path === 'string' && path.length > 0) paths.add(path);
    }
    if (binding.managedPaths === undefined && environment) {
      const syncedEnvironmentSecrets = new Set([
        ...(binding.syncedEnvironmentSecrets ?? []),
        ...Object.keys(binding.syncedEnvironmentSecretHashes ?? {}),
      ]);
      // Older bindings did not record companion paths. A complete managed iOS
      // credential set proves Hypervibe owned the deterministic companion file.
      if (IOS_RELEASE_REQUIRED_SECRETS.every((name) => syncedEnvironmentSecrets.has(name))) {
        paths.add(iosReleaseWorkflowPath(environment.name));
      }
    }
  }
  return [...paths].sort();
}

function retiredManagedWorkflowPaths(
  environment: Environment | null,
  workflow: BranchDeployWorkflow
): string[] {
  const desiredPaths = new Set(workflowFiles(workflow).map((file) => file.path));
  return boundManagedWorkflowPaths(environment).filter((path) => !desiredPaths.has(path));
}

function secretHashes(secrets: ProviderSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.map((secret) => [secret.name, sha256(secret.value)]));
}

function sameSecretHashes(
  reviewed: Record<string, unknown> | null,
  current: Record<string, string>
): boolean {
  if (!reviewed) return false;
  const entries = Object.entries(reviewed);
  return entries.length === Object.keys(current).length
    && entries.every(([name, hash]) => typeof hash === 'string' && current[name] === hash);
}

function reviewedSecretNames(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.some((name) => typeof name !== 'string' || !name)
    || new Set(value).size !== value.length
  ) return null;
  return [...value].sort();
}

function presentManagedSecretNames(required: readonly string[], observed: readonly string[]): string[] {
  const observedNames = new Set(observed);
  return [...new Set(required)].filter((name) => observedNames.has(name)).sort();
}

function sameStringLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type ManagedWorkflowDispatchFailure = [
  reason: 'observation-failed' | 'default-branch' | 'branch',
  error: string,
];

export async function managedWorkflowDispatchTargetFailure(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  branch: string;
  expectedSha: string;
  expectedShaLabel?: string;
}): Promise<ManagedWorkflowDispatchFailure | null> {
  try {
    const [ref, repository] = await Promise.all([
      params.adapter.getRef(params.owner, params.repo, `heads/${params.branch}`),
      params.adapter.getRepository(params.owner, params.repo),
    ]);
    if (repository.default_branch !== params.branch) {
      return ['default-branch', `GitHub default branch is now ${repository.default_branch}, so reviewed workflow ref ${params.branch} cannot be dispatched.`];
    }
    if (ref?.object.sha !== params.expectedSha) {
      return ['branch', `GitHub branch ${params.branch} no longer points to reviewed ${params.expectedShaLabel ?? 'commit'} ${params.expectedSha}.`];
    }
    return null;
  } catch (error) {
    return ['observation-failed', error instanceof Error ? error.message : String(error)];
  }
}

export function workflowFiles(workflow: BranchDeployWorkflow): Array<{ path: string; content: string }> {
  return [
    { path: workflow.path, content: workflow.content },
    ...(workflow.companionFiles ?? []),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

export function workflowFilesContentHash(files: Array<{ path: string; content: string }>): string {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (ordered.length === 1) return sha256(ordered[0]!.content);
  return sha256(JSON.stringify(
    ordered.map((file) => ({ path: file.path, hash: sha256(file.content) }))
  ));
}

type ManagedWorkflowContract = {
  target: ReturnType<typeof resolveBranchDeployTargets>['targets'][number];
  workflow: BranchDeployWorkflow;
  inputHash: string;
  renderedContentHash: string;
  environment: Environment | null;
  binding: ManagedWorkflowBinding | undefined;
};

export async function observeManagedWorkflowFiles(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  contract: ManagedWorkflowContract;
}): Promise<{
  desiredFiles: Array<{ path: string; content: string }>;
  liveContentHash: string | null;
  retiredPaths: string[];
  retiredFilePresent: boolean;
  acceptance: 'rendered' | 'pinned' | 'drift';
}> {
  const repository = await params.adapter.getRepository(params.owner, params.repo);
  if (repository.default_branch !== params.contract.workflow.branch) {
    throw new Error(
      `Managed GitHub Actions deploy branch "${params.contract.workflow.branch}" must match repository default branch "${repository.default_branch}" because workflow_dispatch only runs workflows registered on the default branch.`
    );
  }
  const desiredFiles = workflowFiles(params.contract.workflow);
  const retiredPaths = retiredManagedWorkflowPaths(params.contract.environment, params.contract.workflow);
  const observed = await Promise.all([
    ...desiredFiles.map(async (file) => ({
      path: file.path,
      content: await params.adapter.getFileContent(
        params.owner,
        params.repo,
        file.path,
        params.contract.workflow.branch
      ),
      retired: false,
    })),
    ...retiredPaths.map(async (path) => ({
      path,
      content: await params.adapter.getFileContent(
        params.owner,
        params.repo,
        path,
        params.contract.workflow.branch
      ),
      retired: true,
    })),
  ]);
  const desiredObserved = observed.filter((file) => !file.retired);
  const anyDesiredFileMissing = desiredObserved.some((file) => file.content === null);
  const liveContentHash = anyDesiredFileMissing
    ? null
    : workflowFilesContentHash(desiredObserved.map((file) => ({
        path: file.path,
        content: file.content!,
      })));
  const retiredFilePresent = observed.some((file) => file.retired && file.content !== null);
  const acceptance = !liveContentHash || retiredFilePresent
    ? 'drift'
    : liveContentHash === params.contract.renderedContentHash
      ? 'rendered'
      : params.contract.binding?.contentHash === liveContentHash
          && params.contract.binding.inputHash === params.contract.inputHash
        ? 'pinned'
        : 'drift';
  return {
    desiredFiles,
    liveContentHash,
    retiredPaths,
    retiredFilePresent,
    acceptance,
  };
}

export function resolveManagedWorkflowContract(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment?: Environment | null;
}):
  | { ok: false; reason: 'target-missing' | 'bindings-incomplete'; error: string }
  | ({ ok: true } & ManagedWorkflowContract) {
  const { targets, migration } = resolveBranchDeployTargets(params.project);
  const target = targets.find((candidate) => candidate.environmentName === params.environmentName);
  if (!target) {
    return {
      ok: false,
      reason: 'target-missing',
      error: `No GitHub Actions deploy target found for environment "${params.environmentName}".`,
    };
  }
  const missingBindings = missingManagedCiReleaseBindings(target);
  if (missingBindings.length > 0) {
    return {
      ok: false,
      reason: 'bindings-incomplete',
      error: `Managed CI workflow for ${params.environmentName} cannot be compiled because its current provider bindings are incomplete, malformed, duplicated, or outside the exact desired service set (${missingBindings.join(', ')}). Reconcile hosting identities, then re-run hv_plan.`,
    };
  }
  const workflow = buildBranchDeployWorkflow(
    params.environmentSpec.hosting.provider,
    target,
    migration,
    params.environmentSpec.ios
  );
  const inputHash = githubActionsWorkflowInputHash({
    provider: params.environmentSpec.hosting.provider,
    target,
    migration,
    ios: params.environmentSpec.ios,
  });
  const environment = params.environment === undefined
    ? new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName)
    : params.environment;
  return {
    ok: true,
    target,
    workflow,
    inputHash,
    renderedContentHash: workflowFilesContentHash(workflowFiles(workflow)),
    environment,
    binding: ciBindings(environment)[workflow.path],
  };
}

function appStoreSecretsForGitHubActions(environmentSpec: EnvironmentSpec): {
  secrets: ProviderSecret[];
  error?: string;
} {
  if (!environmentSpec.ios?.release) return { secrets: [] };
  const resolved = getVerifiedAppStoreConnectCredentials(environmentSpec.ios.bundleId);
  if ('error' in resolved) return { secrets: [], error: resolved.error };
  return {
    secrets: [
      { name: 'APP_STORE_CONNECT_KEY_ID', value: resolved.credentials.keyId },
      { name: 'APP_STORE_CONNECT_ISSUER_ID', value: resolved.credentials.issuerId },
      { name: 'APP_STORE_CONNECT_PRIVATE_KEY', value: resolved.credentials.privateKey },
    ],
  };
}

function requiredIosBuildSecrets(environmentSpec: EnvironmentSpec): string[] {
  const release = environmentSpec.ios?.release;
  if (!release) return [];
  return [
    ...release.build.requiredSecrets,
    ...(release.signing.provider === 'match' ? MATCH_SIGNING_REQUIRED_SECRETS : []),
  ];
}

async function resolveManagedWorkflowSecrets(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  workflow: BranchDeployWorkflow;
  repository: string;
}): Promise<{
  requiredProviderSecrets: string[];
  requiredDatabaseSecrets: string[];
  availableSecrets: ProviderSecret[];
  availableSecretHashes: Record<string, string>;
  missingProviderSecrets: string[];
  missingDatabaseSecrets: string[];
  appStoreError?: string;
}> {
  const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(
    params.environmentSpec.hosting.provider
  ).filter((name) => params.workflow.requiredSecrets.includes(name));
  const requiredDatabaseSecrets = params.workflow.requiredSecrets.includes('DATABASE_URL')
    ? ['DATABASE_URL']
    : [];
  const availableSecrets = providerSecretsForGitHubActions(
    params.environmentSpec.hosting.provider,
    { githubRepo: params.repository }
  ).filter((secret) => params.workflow.requiredSecrets.includes(secret.name));
  if (requiredDatabaseSecrets.length > 0 && !availableSecrets.some((secret) => secret.name === 'DATABASE_URL')) {
    const databaseUrlSecret = await databaseUrlSecretForGitHubActions(
      params.project,
      params.environmentName
    );
    if (databaseUrlSecret) availableSecrets.push(databaseUrlSecret);
  }
  const availableSecretNames = availableSecrets.map((secret) => secret.name);
  const appStore = appStoreSecretsForGitHubActions(params.environmentSpec);
  availableSecrets.push(...appStore.secrets);
  return {
    requiredProviderSecrets,
    requiredDatabaseSecrets,
    availableSecrets,
    availableSecretHashes: secretHashes(availableSecrets),
    missingProviderSecrets: requiredProviderSecrets.filter((name) => !availableSecretNames.includes(name)),
    missingDatabaseSecrets: requiredDatabaseSecrets.filter((name) => !availableSecretNames.includes(name)),
    ...(appStore.error ? { appStoreError: appStore.error } : {}),
  };
}

function buildAction(params: {
  type: 'create' | 'update' | 'noop';
  provider: string;
  repo: string;
  workflow: BranchDeployWorkflow;
  inputHash: string;
  reason: string;
  verified: boolean;
  missingProviderSecrets?: string[];
  staleProviderSecrets?: string[];
  missingDatabaseSecrets?: string[];
  staleDatabaseSecrets?: string[];
  desiredEnvironmentSecretHashes?: Record<string, string>;
  reviewedEnvironmentSecrets?: string[];
  missingEnvironmentSecrets?: string[];
  staleEnvironmentSecrets?: string[];
  retiredPaths?: string[];
  workflowPublicationRequired?: boolean;
  dependsOn?: string[];
}): PlanAction {
  return {
    id: `ci:github-actions:${params.workflow.environment}:deploy-branch`,
    type: params.type,
    resource: { kind: 'ci', name: `deploy-branch:${params.workflow.environment}`, provider: 'github' },
    verified: params.verified,
    reason: params.reason,
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: OPERATION,
      ...(params.workflowPublicationRequired ? { workflowPublicationRequired: true } : {}),
      repository: params.repo,
      provider: params.provider,
      workflow: {
        path: params.workflow.path,
        branch: params.workflow.branch,
        autoDeployOnPush: params.workflow.autoDeployOnPush,
        ...(params.workflow.promoteFromEnvironment
          ? { promoteFromEnvironment: params.workflow.promoteFromEnvironment }
          : {}),
        requiredSecrets: params.workflow.requiredSecrets,
        requiredVariables: params.workflow.requiredVariables,
        aggregateContentHash: workflowFilesContentHash(workflowFiles(params.workflow)),
        inputHash: params.inputHash,
        companionPaths: (params.workflow.companionFiles ?? []).map((file) => file.path),
        ...(params.retiredPaths?.length ? { retiredPaths: params.retiredPaths } : {}),
      },
      ...(params.missingProviderSecrets?.length ? { missingProviderSecrets: params.missingProviderSecrets } : {}),
      ...(params.staleProviderSecrets?.length ? { staleProviderSecrets: params.staleProviderSecrets } : {}),
      ...(params.missingDatabaseSecrets?.length ? { missingDatabaseSecrets: params.missingDatabaseSecrets } : {}),
      ...(params.staleDatabaseSecrets?.length ? { staleDatabaseSecrets: params.staleDatabaseSecrets } : {}),
      ...(params.desiredEnvironmentSecretHashes
        ? { desiredEnvironmentSecretHashes: params.desiredEnvironmentSecretHashes }
        : {}),
      ...(params.reviewedEnvironmentSecrets
        ? { reviewedEnvironmentSecrets: params.reviewedEnvironmentSecrets }
        : {}),
      ...(params.missingEnvironmentSecrets?.length
        ? { missingEnvironmentSecrets: params.missingEnvironmentSecrets }
        : {}),
      ...(params.staleEnvironmentSecrets?.length
        ? { staleEnvironmentSecrets: params.staleEnvironmentSecrets }
        : {}),
    },
  };
}

type GitHubCiMutationResult = {
  success: false;
  message: string;
  error: string;
  data?: Record<string, unknown>;
};

async function verifiedGitHubCiWriter(project: Project): Promise<
  | { adapter: GitHubAdapter; repository: string; owner: string; repo: string }
  | { result: GitHubCiMutationResult }
> {
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repository) {
    return {
      result: {
        success: false,
        message: 'GitHub repository is missing',
        error: 'Set project gitRemoteUrl to a GitHub remote.',
      },
    };
  }
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return {
      result: {
        success: false,
        message: 'GitHub repository is invalid',
        error: `Could not parse ${repository}.`,
      },
    };
  }
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    return {
      result: {
        success: false,
        message: 'GitHub adapter unavailable',
        error: adapterResult.error,
      },
    };
  }
  const verification = await adapterResult.adapter.verify();
  if (!verification.success) {
    return {
      result: {
        success: false,
        message: 'GitHub connection verification failed',
        error: verification.error ?? 'GitHub connection verification failed',
      },
    };
  }
  const permissionProblem = githubCiDeployPermissionProblem(verification, { repo: repository });
  if (permissionProblem) {
    return {
      result: {
        success: false,
        message: 'GitHub connection is missing CI deploy permissions',
        error: permissionProblem.hint,
        data: {
          repository,
          missingScopes: permissionProblem.missingScopes,
          currentScopes: verification.scopes,
        },
      },
    };
  }
  return { adapter: adapterResult.adapter, repository, owner, repo };
}

export async function planGitHubActionsDeploy(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[]; error?: string }> {
  const { project, environmentName, environmentSpec } = params;
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(environmentSpec)) {
    return { warnings };
  }
  if (!providerRegistry.getMetadata(environmentSpec.hosting.provider)?.orchestration?.ci) {
    warnings.push(`GitHub Actions branch deploys are not supported for provider "${environmentSpec.hosting.provider}".`);
    return { warnings };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    warnings.push('deploy.strategy is "branch" with trigger "ci", but the project has no GitHub remote (gitRemoteUrl), so the GitHub Actions deploy workflow cannot be configured.');
    return { warnings };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    warnings.push(`Could not parse GitHub repository from ${repo}.`);
    return { warnings };
  }

  const contract = resolveManagedWorkflowContract(params);
  if (!contract.ok) {
    if (contract.reason === 'target-missing') {
      warnings.push(contract.error);
      return { warnings };
    }
    return { warnings, error: contract.error };
  }
  const { workflow, inputHash, binding } = contract;
  const bindingHasInputContract = Boolean(binding?.inputHash);
  const inputContractNeedsAdoption = !bindingHasInputContract;
  const inputContractChanged = bindingHasInputContract && binding?.inputHash !== inputHash;
  const unverifiedPublication = (warning: string) => {
    warnings.push(warning);
    return {
      action: buildAction({
        type: 'update',
        provider: environmentSpec.hosting.provider,
        repo,
        workflow,
        inputHash,
        reason: `Cannot verify the live GitHub Actions deploy workflow ${workflow.path}`,
        verified: false,
        workflowPublicationRequired: true,
        retiredPaths: retiredManagedWorkflowPaths(contract.environment, workflow),
        dependsOn: params.dependsOn,
      }),
      warnings,
    };
  };

  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    return unverifiedPublication(
      `Cannot observe GitHub Actions workflow for ${repo}: ${adapterResult.error}`
    );
  }

  let observation: Awaited<ReturnType<typeof observeManagedWorkflowFiles>>;
  try {
    observation = await observeManagedWorkflowFiles({
      adapter: adapterResult.adapter,
      owner,
      repo: repoName,
      contract,
    });
  } catch (error) {
    return unverifiedPublication(
      `Cannot read GitHub Actions workflow ${workflow.path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const { acceptance } = observation;
  if (acceptance === 'drift') {
    const reason = observation.liveContentHash === null
      ? workflow.companionFiles?.length
        ? `One or more managed GitHub Actions release files are missing for ${environmentName}`
        : `GitHub Actions deploy workflow ${workflow.path} is missing`
      : observation.retiredFilePresent
        ? `Retired managed GitHub Actions workflow files must be removed for ${environmentName}`
        : inputContractChanged
          ? `GitHub Actions deploy workflow inputs changed for ${workflow.path}`
          : `GitHub Actions deploy workflow ${workflow.path} differs from desired content`;
    return {
      action: buildAction({
        type: observation.liveContentHash === null ? 'create' : 'update',
        provider: environmentSpec.hosting.provider,
        repo,
        workflow,
        inputHash,
        reason,
        verified: true,
        workflowPublicationRequired: true,
        retiredPaths: observation.retiredPaths,
        dependsOn: params.dependsOn,
      }),
      warnings,
    };
  }

  // Secret state matters only after the reviewed workflow files are accepted.
  const {
    requiredProviderSecrets,
    requiredDatabaseSecrets,
    availableSecretHashes,
    missingProviderSecrets,
    missingDatabaseSecrets,
    appStoreError,
  } = await resolveManagedWorkflowSecrets({
    project,
    environmentName,
    environmentSpec,
    workflow,
    repository: repo,
  });
  if (missingProviderSecrets.length > 0) {
    warnings.push(
      `GitHub Actions deploy workflow ${workflow.path} requires provider secrets that Hypervibe cannot sync: ${missingProviderSecrets.join(', ')}. `
      + missingProviderSecretsMessage(environmentSpec.hosting.provider, missingProviderSecrets)
    );
  }
  if (missingDatabaseSecrets.length > 0) {
    warnings.push(
      `GitHub Actions deploy workflow ${workflow.path} cannot sync its managed database secret. `
      + missingProviderSecretsMessage(environmentSpec.hosting.provider, missingDatabaseSecrets)
    );
  }
  if (appStoreError) warnings.push(appStoreError);
  const requiredBuildSecrets = requiredIosBuildSecrets(environmentSpec);

  let environmentSecretNames: string[] = [];
  let environmentSecretsObserved = true;
  try {
    environmentSecretNames = await adapterResult.adapter.listEnvironmentSecrets(owner, repoName, environmentName);
  } catch (error) {
    environmentSecretsObserved = false;
    warnings.push(`Cannot observe GitHub environment secret names for ${environmentName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const syncedHashes = binding?.syncedEnvironmentSecretHashes ?? {};
  const needsSync = (name: string) => !environmentSecretNames.includes(name)
    || syncedHashes[name] !== availableSecretHashes[name];
  const staleProviderSecrets = requiredProviderSecrets.filter(needsSync);
  const staleDatabaseSecrets = requiredDatabaseSecrets.filter(needsSync);
  const staleEnvironmentSecrets = Object.keys(availableSecretHashes).filter(needsSync);
  const missingEnvironmentSecrets = requiredBuildSecrets.filter((name) => !environmentSecretNames.includes(name));
  const missingSecretSync = missingProviderSecrets.length > 0
    || missingDatabaseSecrets.length > 0
    || Boolean(appStoreError)
    || staleEnvironmentSecrets.length > 0
    || missingEnvironmentSecrets.length > 0
    || !environmentSecretsObserved;
  const databaseSecretSyncRequired = missingDatabaseSecrets.length > 0 || staleDatabaseSecrets.length > 0;
  const contentContractNeedsAdoption = acceptance === 'rendered'
    && binding?.contentHash !== observation.liveContentHash;
  const type = inputContractNeedsAdoption || inputContractChanged || contentContractNeedsAdoption
    ? 'update'
    : !missingSecretSync
      ? 'noop'
      : 'update';
  const reason = inputContractNeedsAdoption && acceptance === 'rendered'
      ? 'Record the reviewed GitHub Actions workflow input contract without replacing its accepted files'
      : type === 'noop'
        ? acceptance === 'pinned'
          ? 'GitHub Actions deploy workflow is in sync with its reviewed inputs'
          : 'GitHub Actions deploy workflow is in sync'
        : missingSecretSync
          ? databaseSecretSyncRequired
            ? `GitHub Actions deploy workflow ${workflow.path} exists but managed database secrets need syncing`
            : `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`
          : contentContractNeedsAdoption
            ? 'Record the accepted GitHub Actions workflow content contract'
            : `Record the reviewed GitHub Actions workflow input contract for ${workflow.path}`;

  return {
    action: buildAction({
      type,
      provider: environmentSpec.hosting.provider,
      repo,
      workflow,
      inputHash,
      reason,
      verified: environmentSecretsObserved,
      missingProviderSecrets,
      staleProviderSecrets,
      missingDatabaseSecrets,
      staleDatabaseSecrets,
      desiredEnvironmentSecretHashes: availableSecretHashes,
      reviewedEnvironmentSecrets: environmentSecretsObserved
        ? presentManagedSecretNames(
            [...Object.keys(availableSecretHashes), ...requiredProviderSecrets, ...requiredDatabaseSecrets, ...requiredBuildSecrets],
            environmentSecretNames
          )
        : undefined,
      missingEnvironmentSecrets,
      staleEnvironmentSecrets,
      dependsOn: type === 'noop' ? undefined : params.dependsOn,
    }),
    warnings,
  };
}

export async function applyGitHubActionsDeploy(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
  authority?: 'publication-only' | 'secret-sync';
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, environmentName, environmentSpec } = params;
  const authority = params.authority ?? (
    params.action.metadata?.workflowPublicationRequired === true
      ? 'publication-only'
      : 'secret-sync'
  );
  const writer = await verifiedGitHubCiWriter(project);
  if ('result' in writer) return writer.result;
  const { adapter, repository: repo, owner, repo: repoName } = writer;

  const contract = resolveManagedWorkflowContract({
    project,
    environmentName,
    environmentSpec,
  });
  if (!contract.ok) {
    return { success: false, status: 'blocked', message: 'No valid GitHub Actions deploy target', error: contract.error };
  }
  const { workflow, inputHash, renderedContentHash } = contract;
  const reviewedWorkflow = asRecord(params.action.metadata?.workflow);
  const publicationWasReviewed = params.action.metadata?.workflowPublicationRequired === true;
  if (
    params.action.metadata?.operation !== OPERATION
    || reviewedWorkflow?.path !== workflow.path
    || reviewedWorkflow.inputHash !== inputHash
    || reviewedWorkflow.aggregateContentHash !== renderedContentHash
    || publicationWasReviewed !== (authority === 'publication-only')
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitHub Actions deploy action is stale',
      error: 'The reviewed workflow path, rendered content, input contract, or publication authority changed. Re-run hv_plan.',
    };
  }
  let observation: Awaited<ReturnType<typeof observeManagedWorkflowFiles>>;
  try {
    observation = await observeManagedWorkflowFiles({
      adapter,
      owner,
      repo: repoName,
      contract,
    });
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot verify GitHub Actions deploy workflow ${workflow.path}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const { acceptance } = observation;
  if (authority === 'publication-only') {
    if (acceptance !== 'drift') {
      return {
        success: false,
        status: 'blocked',
        message: 'GitHub Actions workflow publication is no longer pending',
        error: 'The reviewed publication action no longer matches live repository state. Re-run hv_plan before syncing secrets.',
      };
    }
    const reviewedRetiredPaths = Array.isArray(reviewedWorkflow.retiredPaths)
      ? reviewedWorkflow.retiredPaths.filter((path): path is string => typeof path === 'string')
      : [];
    if (
      reviewedRetiredPaths.length !== observation.retiredPaths.length
      || reviewedRetiredPaths.some((path, index) => path !== observation.retiredPaths[index])
    ) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed workflow paths changed',
        error: 'The reviewed retired workflow paths no longer match the managed binding. Re-run hv_plan.',
      };
    }
    const desiredFiles = observation.desiredFiles.map((file) => {
      const isPrimaryDeployWorkflow = file.path === workflow.path;
      return {
        path: file.path,
        content: file.content,
        hash: sha256(file.content),
        review: isPrimaryDeployWorkflow
          ? workflow.review
          : {
              title: `${environmentName} iOS release`,
              summary: `Updates the GitHub workflow that releases the iOS app after the ${environmentName} server deployment succeeds.`,
              details: [
                'Uses the exact server commit that was successfully deployed.',
                'Keeps the project build and Hypervibe-managed Apple release in isolated jobs.',
                'Installs existing Match assets read-only when managed signing is selected.',
                'Revalidates the IPA before sending it to the declared TestFlight groups.',
                'Does not submit the app to the App Store automatically.',
              ],
              mergeEffect: workflow.autoDeployOnPush
                ? `This release workflow waits for a successful ${environmentName} server deployment; merging it does not bypass that check.`
                : `Merging this PR only updates the release workflow; the ${environmentName} server deployment still has to be started manually.`,
            },
      };
    });
    const proposal = await proposeGitHubInfrastructureFiles({
      repository: repo,
      desiredFiles,
      targetBranch: workflow.branch,
      retiredManagedPaths: reviewedRetiredPaths,
      proposalBranch: managedWorkflowPublicationBranch(environmentName),
      requireDefaultTarget: true,
    });
    return {
      ...proposal,
      data: {
        workflow: workflow.path,
        companionFiles: (workflow.companionFiles ?? []).map((file) => file.path),
        ...(proposal.data ?? {}),
      },
    };
  }
  if (acceptance === 'drift') {
    return {
      success: false,
      status: 'blocked',
      message: 'GitHub Actions secret sync action is stale',
      error: 'The managed workflow now requires publication. Re-run hv_plan and apply the isolated publication stage.',
    };
  }

  const {
    requiredProviderSecrets,
    requiredDatabaseSecrets,
    availableSecrets,
    missingProviderSecrets,
    missingDatabaseSecrets,
    availableSecretHashes,
    appStoreError,
  } = await resolveManagedWorkflowSecrets({
    project,
    environmentName,
    environmentSpec,
    workflow,
    repository: repo,
  });

  const reviewedEnvironmentSecrets = reviewedSecretNames(params.action.metadata?.reviewedEnvironmentSecrets);
  if (!reviewedEnvironmentSecrets || !sameSecretHashes(
    asRecord(params.action.metadata?.desiredEnvironmentSecretHashes), availableSecretHashes
  )) {
    return {
      success: false, status: 'blocked', message: 'GitHub Actions managed secret action is stale',
      error: 'The reviewed environment secret inventory or values changed. Re-run hv_plan before writing GitHub secrets.',
    };
  }
  let environmentSecretNames: string[];
  try {
    environmentSecretNames = await adapter.listEnvironmentSecrets(owner, repoName, environmentName);
  } catch (error) {
    return {
      success: false, status: 'blocked', message: `Cannot observe GitHub environment secrets for ${environmentName}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const currentEnvironmentSecrets = presentManagedSecretNames(
    [...Object.keys(availableSecretHashes), ...requiredProviderSecrets, ...requiredDatabaseSecrets, ...requiredIosBuildSecrets(environmentSpec)],
    environmentSecretNames
  );
  if (!sameStringLists(currentEnvironmentSecrets, reviewedEnvironmentSecrets)) {
    return {
      success: false, status: 'blocked', message: 'GitHub Actions managed secret action is stale',
      error: 'The managed environment secret inventory changed after planning. Re-run hv_plan before writing GitHub secrets.',
    };
  }

  const missingManagedSecrets = [...missingProviderSecrets, ...missingDatabaseSecrets];
  if (missingManagedSecrets.length > 0) {
    return {
      success: false,
      status: 'blocked',
      message: `Cannot sync ${workflow.path} because required managed secrets are missing`,
      error: missingProviderSecretsMessage(environmentSpec.hosting.provider, missingManagedSecrets),
      data: {
        workflow: workflow.path,
        syncedEnvironmentSecrets: [],
        ...(missingProviderSecrets.length > 0 ? { missingProviderSecrets } : {}),
        ...(missingDatabaseSecrets.length > 0 ? { missingDatabaseSecrets } : {}),
      },
    };
  }

  if (environmentSpec.ios?.release) {
    const requiredBuildSecrets = requiredIosBuildSecrets(environmentSpec);
    const missingBuildSecrets = requiredBuildSecrets
      .filter((name) => !environmentSecretNames.includes(name));
    if (missingBuildSecrets.length > 0) {
      return {
        success: false,
        status: 'blocked',
        message: `The iOS release workflow is missing signing/build secrets for ${environmentName}`,
        error: `Create these GitHub environment secrets, then re-run hv_plan: ${missingBuildSecrets.join(', ')}.`,
        data: { workflow: workflow.path, environmentName, missingEnvironmentSecrets: missingBuildSecrets },
      };
    }
    if (appStoreError) {
      return {
        success: false,
        status: 'blocked',
        message: `Cannot sync App Store Connect credentials to ${environmentName}`,
        error: appStoreError,
      };
    }
  }

  const syncedSecrets: ProviderSecret[] = [];
  const secretErrors: Array<{ name: string; error: string }> = [];
  for (const secret of availableSecrets) {
    try {
      await adapter.setEnvironmentSecret(owner, repoName, environmentName, secret.name, secret.value);
      syncedSecrets.push(secret);
    } catch (error) {
      secretErrors.push({ name: secret.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const syncedSecretNames = syncedSecrets.map((secret) => secret.name);
  persistCiBindingPatch(project, environmentName, {
    deployBranch: {
      [workflow.path]: {
        contentHash: observation.liveContentHash!,
        inputHash,
        managedPaths: workflowFiles(workflow).map((file) => file.path),
        syncedEnvironmentSecrets: syncedSecretNames,
        syncedEnvironmentSecretHashes: secretHashes(syncedSecrets),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  return {
    success: secretErrors.length === 0,
    message: `Synced ${syncedSecrets.length} managed GitHub Actions secrets for ${environmentName}`,
    ...(secretErrors.length ? { error: secretErrors.map((entry) => `${entry.name}: ${entry.error}`).join('; ') } : {}),
    data: {
      workflow: workflow.path,
      companionFiles: (workflow.companionFiles ?? []).map((file) => file.path),
      syncedEnvironmentSecrets: syncedSecretNames,
      ...(secretErrors.length ? { secretErrors } : {}),
    },
  };
}

export async function planGitHubActionsAppliedSpecHash(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { project, spec, environmentName, environmentSpec } = params;
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(environmentSpec)) {
    return { warnings };
  }

  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    warnings.push('Cannot record the applied deployment contract because the project has no GitHub remote.');
    return { warnings };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    warnings.push(`Cannot record the applied deployment contract because ${repo} is not a valid GitHub repository.`);
    return { warnings };
  }

  const desiredHash = environmentDeploymentContractHashForApply(spec, environmentName);
  const action = (type: 'update' | 'noop', verified: boolean, reason: string): PlanAction => ({
    id: `ci:github-actions:${environmentName}:applied-spec-hash`,
    type,
    resource: { kind: 'ci', name: `applied-spec-hash:${environmentName}`, provider: 'github' },
    verified,
    reason,
    ...(type === 'update' && params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: APPLIED_SPEC_HASH_OPERATION,
      repository: repo,
      environmentName,
      variableName: APPLIED_SPEC_HASH_VARIABLE,
      desiredHash,
    },
  });

  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe the applied deployment contract for ${repo}: ${adapterResult.error}`);
    return {
      action: action(
        'update',
        false,
        `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  }

  try {
    const current = await adapterResult.adapter.getEnvironmentVariable(
      owner,
      repoName,
      environmentName,
      APPLIED_SPEC_HASH_VARIABLE
    );
    const matches = current?.value === desiredHash;
    return {
      action: action(
        matches ? 'noop' : 'update',
        true,
        matches
          ? 'GitHub Actions deployment contract is reconciled'
          : `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  } catch (error) {
    warnings.push(
      `Cannot observe GitHub Actions environment variable ${APPLIED_SPEC_HASH_VARIABLE} for ${repo}/${environmentName}: `
      + (error instanceof Error ? error.message : String(error))
    );
    return {
      action: action(
        'update',
        false,
        `Record the reconciled ${environmentName} deployment contract in GitHub Actions`
      ),
      warnings,
    };
  }
}

export async function applyGitHubActionsAppliedSpecHash(params: {
  project: Project;
  environmentName: string;
  desiredHash: string;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, environmentName, desiredHash } = params;
  const writer = await verifiedGitHubCiWriter(project);
  if ('result' in writer) return writer.result;
  const { adapter, repository: repo, owner, repo: repoName } = writer;

  try {
    await adapter.setEnvironmentVariable(
      owner,
      repoName,
      environmentName,
      APPLIED_SPEC_HASH_VARIABLE,
      desiredHash
    );
  } catch (error) {
    return {
      success: false,
      message: 'Failed to record the applied deployment contract',
      error: error instanceof Error ? error.message : String(error),
      data: { repository: repo, environmentName, variableName: APPLIED_SPEC_HASH_VARIABLE },
    };
  }

  persistCiBindingPatch(project, environmentName, {
    appliedSpecHash: {
      hash: desiredHash,
      variableName: APPLIED_SPEC_HASH_VARIABLE,
      updatedAt: new Date().toISOString(),
    },
  });
  return {
    success: true,
    message: `Recorded the reconciled ${environmentName} deployment contract in GitHub Actions`,
    data: {
      repository: repo,
      environmentName,
      variableName: APPLIED_SPEC_HASH_VARIABLE,
      desiredHash,
    },
  };
}

async function findVerifiedRelease(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  workflow: string;
  environmentName: string;
  targetSha: string;
}): Promise<{ runId: number; url: string } | null> {
  const runs = await params.adapter.listWorkflowRuns(params.owner, params.repo, params.workflow, { per_page: 50 });
  const expectedArtifact = managedCiReleaseArtifactName(params.environmentName, params.targetSha);
  const candidates = runs.workflow_runs.filter((run) =>
    run.status === 'completed'
    && run.conclusion === 'success'
    && (run.head_sha === params.targetSha || run.display_title?.includes(params.targetSha))
  );
  for (const run of candidates) {
    const artifacts = await params.adapter.listWorkflowRunArtifacts(params.owner, params.repo, run.id);
    if (artifacts.artifacts.some((artifact) =>
      artifact.name === expectedArtifact
      && artifact.expired === false
      && artifact.workflow_run?.id === run.id
    )) {
      return { runId: run.id, url: run.html_url };
    }
  }
  return null;
}

export async function planGitHubActionsRelease(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(params.environmentSpec)) return { warnings };
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  const [owner, repo] = repository?.split('/') ?? [];
  if (!repository || !owner || !repo) {
    warnings.push(`Cannot plan the ${params.environmentName} release required by database.seedCommand.`);
    return { warnings };
  }
  const contract = resolveManagedWorkflowContract({
    project: params.project,
    environmentName: params.environmentName,
    environmentSpec: params.environmentSpec,
  });
  if (!contract.ok) {
    warnings.push(contract.error);
    return { warnings };
  }
  const {
    workflow,
    inputHash: workflowInputHash,
  } = contract;
  const action = (
    verified: boolean,
    reason: string,
    metadata: Record<string, unknown>,
    type: 'update' | 'noop' = 'update'
  ): PlanAction => ({
    id: `ci:github-actions:${params.environmentName}:release`,
    type,
    resource: { kind: 'ci', name: `release:${params.environmentName}`, provider: 'github' },
    verified,
    reason,
    ...(type === 'update' && params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    metadata: {
      operation: GITHUB_ACTIONS_RELEASE_OPERATION,
      repository,
      environmentName: params.environmentName,
      workflow: workflow.path,
      ref: workflow.branch,
      ...metadata,
    },
  });
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe the exact release required before database seeding: ${adapterResult.error}`);
    return {
      action: action(false, `Cannot verify the ${params.environmentName} release required before database seeding`, {
        blockedReason: 'github_release_observation_unknown',
      }),
      warnings,
    };
  }
  try {
    const workflowObservation = await observeManagedWorkflowFiles({
      adapter: adapterResult.adapter,
      owner,
      repo,
      contract,
    });
    if (workflowObservation.acceptance === 'drift') {
      return {
        action: action(true, `Cannot release through unaccepted workflow ${workflow.path}`, {
          blockedReason: 'github_release_workflow_drift',
        }),
        warnings,
      };
    }
    const ref = await adapterResult.adapter.getRef(owner, repo, `heads/${workflow.branch}`);
    const targetSha = ref?.object.sha;
    if (!targetSha || !/^[0-9a-f]{40}$/i.test(targetSha)) {
      return {
        action: action(true, `GitHub branch ${workflow.branch} has no exact commit to release`, {
          blockedReason: 'github_release_ref_absent',
        }),
        warnings,
      };
    }
    const existing = await findVerifiedRelease({
      adapter: adapterResult.adapter,
      owner,
      repo,
      workflow: workflow.path,
      environmentName: params.environmentName,
      targetSha,
    });
    const mustReleaseAfterPrerequisites = Boolean(params.dependsOn?.length);
    return {
      action: action(
        true,
        existing && !mustReleaseAfterPrerequisites
          ? `Exact commit ${targetSha} is already verified as deployed`
          : `Deploy and verify exact commit ${targetSha} before database seeding`,
        {
          targetSha,
          workflowInputHash,
          workflowContentHash: workflowObservation.liveContentHash,
          forceRelease: mustReleaseAfterPrerequisites,
        },
        existing && !mustReleaseAfterPrerequisites ? 'noop' : 'update'
      ),
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Cannot observe the exact release required before database seeding: ${message}`);
    return {
      action: action(false, `Cannot verify the ${params.environmentName} release required before database seeding`, {
        blockedReason: 'github_release_observation_unknown',
      }),
      warnings,
    };
  }
}

export function isGitHubActionsReleaseAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_ACTIONS_RELEASE_OPERATION;
}

export async function applyGitHubActionsRelease(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  workflow: string;
  ref: string;
  targetSha: string;
  workflowInputHash: string;
  workflowContentHash: string;
  forceRelease?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const repository = parseGitHubRepoFromRemote(params.project.gitRemoteUrl);
  const [owner, repo] = repository?.split('/') ?? [];
  if (!repository || !owner || !repo) {
    return { success: false, status: 'blocked', message: 'GitHub repository is missing', error: 'Set project gitRemoteUrl to a GitHub remote.' };
  }
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    return { success: false, status: 'blocked', message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  const contract = resolveManagedWorkflowContract({
    project: params.project,
    environmentName: params.environmentName,
    environmentSpec: params.environmentSpec,
  });
  if (!contract.ok) {
    return {
      success: false,
      status: 'blocked',
      message: 'Managed release target is missing',
      error: contract.error,
    };
  }
  const { workflow, inputHash: workflowInputHash } = contract;
  if (
    workflow.path !== params.workflow
    || workflow.branch !== params.ref
    || workflowInputHash !== params.workflowInputHash
  ) {
    return {
      success: false,
      status: 'blocked',
      message: 'Managed release workflow contract changed',
      error: 'The reviewed workflow path, ref, or input contract changed. Re-run hv_plan.',
    };
  }
  try {
    const observation = await observeManagedWorkflowFiles({
      adapter,
      owner,
      repo,
      contract,
    });
    if (observation.acceptance === 'drift' || observation.liveContentHash !== params.workflowContentHash) {
      return {
        success: false,
        status: 'blocked',
        message: 'Managed release workflow changed after planning',
        error: 'The live reviewed workflow content changed or now requires publication. Re-run hv_plan.',
      };
    }
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'Managed release workflow could not be verified',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const alreadyReleased = params.forceRelease
    ? null
    : await findVerifiedRelease({
      adapter,
      owner,
      repo,
      workflow: params.workflow,
      environmentName: params.environmentName,
      targetSha: params.targetSha,
    });
  if (alreadyReleased) {
    return {
      success: true,
      message: `Verified deployed commit ${params.targetSha}`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: alreadyReleased.runId, url: alreadyReleased.url },
    };
  }

  const before = await adapter.listWorkflowRuns(owner, repo, params.workflow, { per_page: 50 });
  const existingRunIds = new Set(before.workflow_runs.map((run) => run.id));
  const dispatchFailure = await managedWorkflowDispatchTargetFailure({
    adapter,
    owner,
    repo,
    branch: params.ref,
    expectedSha: params.targetSha,
  });
  if (dispatchFailure) {
    const [reason, error] = dispatchFailure;
    return {
      success: false,
      status: 'blocked',
      message: reason === 'default-branch'
        ? 'Managed release default branch changed after planning'
        : reason === 'branch'
          ? 'Managed release branch changed after planning'
          : 'Managed release branch could not be verified',
      error: `${error}${reason === 'observation-failed' ? '' : ' Re-run hv_plan.'}`,
    };
  }
  await adapter.triggerWorkflow(owner, repo, params.workflow, params.ref, { commit_sha: params.targetSha });
  const deadline = Date.now() + (params.timeoutMs ?? RELEASE_WAIT_TIMEOUT_MS);
  let selectedRun: Awaited<ReturnType<GitHubAdapter['listWorkflowRuns']>>['workflow_runs'][number] | undefined;
  while (Date.now() < deadline) {
    const observed = await adapter.listWorkflowRuns(owner, repo, params.workflow, { per_page: 50 });
    selectedRun = selectedRun
      ? observed.workflow_runs.find((run) => run.id === selectedRun?.id)
      : observed.workflow_runs.find((run) =>
        !existingRunIds.has(run.id)
        && run.event === 'workflow_dispatch'
        && (run.head_sha === params.targetSha || run.display_title?.includes(params.targetSha))
      );
    if (selectedRun?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs ?? RELEASE_POLL_INTERVAL_MS));
  }
  if (!selectedRun || selectedRun.status !== 'completed') {
    return {
      success: true,
      status: 'pending',
      message: `The exact-SHA ${params.environmentName} release is still running`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, ...(selectedRun ? { runId: selectedRun.id, url: selectedRun.html_url } : {}) },
    };
  }
  if (selectedRun.conclusion !== 'success') {
    return {
      success: false,
      message: `The exact-SHA ${params.environmentName} release failed`,
      error: `GitHub Actions run ${selectedRun.id} concluded ${selectedRun.conclusion ?? 'without a conclusion'}.`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url },
    };
  }
  const artifacts = await adapter.listWorkflowRunArtifacts(owner, repo, selectedRun.id);
  const expectedArtifact = managedCiReleaseArtifactName(params.environmentName, params.targetSha);
  const releaseEvidence = artifacts.artifacts.find((artifact) =>
    artifact.name === expectedArtifact
    && artifact.expired === false
    && artifact.workflow_run?.id === selectedRun?.id
  );
  if (!releaseEvidence) {
    return {
      success: false,
      message: `The exact-SHA ${params.environmentName} release lacked verified release evidence`,
      error: `Successful run ${selectedRun.id} did not emit ${expectedArtifact}.`,
      data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url },
    };
  }
  return {
    success: true,
    message: `Deployed and verified exact commit ${params.targetSha}`,
    data: { repository, workflow: params.workflow, targetSha: params.targetSha, runId: selectedRun.id, url: selectedRun.html_url, artifactId: releaseEvidence.id },
  };
}

function persistCiBindingPatch(
  project: Project,
  environmentName: string,
  patch: Record<string, unknown>
): void {
  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, environmentName)
    ?? envRepo.create({ projectId: project.id, name: environmentName });
  const ci = asRecord(environment.platformBindings.ci) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    ci: {
      ...ci,
      ...patch,
    },
  });
}
