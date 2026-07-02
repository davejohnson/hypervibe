import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  buildBranchDeployWorkflow,
  getGitHubAdapter,
  resolveBranchDeployTargets,
  type BranchDeployProvider,
  type BranchDeployWorkflow,
} from './github-ops.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const OPERATION = 'githubActionsDeployBranch';
const SUPPORTED_PROVIDERS = new Set(['railway', 'cloudrun']);
const PROVIDERS_REQUIRING_GITHUB_PACKAGE_PULL = new Set(['railway']);
const GITHUB_CI_REQUIRED_CLASSIC_SCOPES = ['repo', 'workflow'];

export function requiredProviderSecretNamesForGitHubActions(provider: string): string[] {
  const names: string[] = [];
  switch (provider) {
    case 'railway':
      names.push('RAILWAY_API_TOKEN');
      break;
    case 'cloudrun':
      names.push('GCP_SERVICE_ACCOUNT_JSON', 'GCP_PROJECT_ID', 'GCP_REGION');
      break;
    default:
      break;
  }
  if (PROVIDERS_REQUIRING_GITHUB_PACKAGE_PULL.has(provider)) {
    names.push('IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN');
  }
  return names;
}

export function missingProviderSecretsMessage(provider: string, missingProviderSecrets: string[]): string {
  const parts = [`Missing provider secrets: ${missingProviderSecrets.join(', ')}.`];
  const missingImageRegistrySecrets = missingProviderSecrets.some((name) => name.startsWith('IMAGE_REGISTRY_'));
  const missingProviderApiSecrets = missingProviderSecrets.some((name) => !name.startsWith('IMAGE_REGISTRY_'));
  if (missingProviderApiSecrets) {
    parts.push(`Connect and verify ${provider} so Hypervibe can sync its API credentials into GitHub Actions. ${formatConnectionGuidance(provider)}`);
  }
  if (missingImageRegistrySecrets) {
    parts.push(`For Railway GHCR image pulls, reconnect GitHub with both GitHub API and package-read credentials. The GitHub apiToken needs repo + workflow for workflow/secrets management; packageReadToken needs read:packages for durable GHCR image pulls. ${formatConnectionGuidance('github', { intro: 'Confirm the GitHub token type and CI deploy permissions.' })}`);
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
const secretStore = getSecretStore();

type ProviderSecret = { name: string; value: string };
type WorkflowCiBinding = {
  contentHash?: string;
  syncedSecrets?: string[];
  syncedSecretHashes?: Record<string, string>;
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

export function providerSecretsForGitHubActions(
  provider: string,
  options: { githubLogin?: string; githubRepo?: string } = {}
): ProviderSecret[] {
  const secrets: ProviderSecret[] = [];
  const connection = connectionRepo.findBestVerifiedMatch(provider);

  if (connection) {
    const credentials = secretStore.decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
    switch (provider) {
      case 'railway':
        if (typeof credentials.apiToken === 'string' && credentials.apiToken.length > 0) {
          secrets.push({ name: 'RAILWAY_API_TOKEN', value: credentials.apiToken });
        }
        break;
      case 'cloudrun':
        if (typeof credentials.credentials === 'string' && credentials.credentials.length > 0) {
          secrets.push({ name: 'GCP_SERVICE_ACCOUNT_JSON', value: credentials.credentials });
        }
        if (typeof credentials.projectId === 'string' && credentials.projectId.length > 0) {
          secrets.push({ name: 'GCP_PROJECT_ID', value: credentials.projectId });
        }
        if (typeof credentials.region === 'string' && credentials.region.length > 0) {
          secrets.push({ name: 'GCP_REGION', value: credentials.region });
        }
        break;
      default:
        break;
    }
  }

  if (PROVIDERS_REQUIRING_GITHUB_PACKAGE_PULL.has(provider)) {
    const githubConnections = connectionRepo.findAllByProvider('github')
      .filter((connection) => connection.status === 'verified')
      .flatMap((connection) => {
        const rank = githubConnectionRank(connection.scope, options.githubRepo);
        return rank === null ? [] : [{ connection, rank }];
      })
      .sort((a, b) => a.rank - b.rank);

    for (const { connection: githubConnection } of githubConnections) {
      const credentials = secretStore.decryptObject<Record<string, unknown>>(githubConnection.credentialsEncrypted);
      const username =
        options.githubLogin
        ?? (typeof credentials.login === 'string' ? credentials.login : undefined)
        ?? (typeof credentials.username === 'string' ? credentials.username : undefined);
      const token =
        typeof credentials.packageReadToken === 'string' && credentials.packageReadToken.length > 0
          ? credentials.packageReadToken
          : undefined;

      if (username && token) {
        secrets.push(
          { name: 'IMAGE_REGISTRY_USERNAME', value: username },
          { name: 'IMAGE_REGISTRY_TOKEN', value: token }
        );
        break;
      }
    }
  }

  return secrets;
}

function githubConnectionRank(scope: string | null, repo?: string): number | null {
  if (!repo) {
    return scope === null ? 0 : 1;
  }
  if (scope === repo) {
    return 0;
  }
  if (scope?.endsWith('/*') && repo.startsWith(scope.slice(0, -1))) {
    return 1;
  }
  if (scope === null) {
    return 2;
  }
  return null;
}

function ciBindings(environment: Environment | null): Record<string, WorkflowCiBinding> {
  const ci = asRecord(environment?.platformBindings?.ci);
  return asRecord(ci?.deployBranch) as Record<string, WorkflowCiBinding> | null ?? {};
}

function secretHashes(secrets: ProviderSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.map((secret) => [secret.name, sha256(secret.value)]));
}

function buildAction(params: {
  type: 'create' | 'update' | 'noop';
  provider: string;
  repo: string;
  workflow: BranchDeployWorkflow;
  reason: string;
  verified: boolean;
  availableSecretNames: string[];
  missingProviderSecrets?: string[];
  staleProviderSecrets?: string[];
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
      repository: params.repo,
      provider: params.provider,
      workflow: {
        path: params.workflow.path,
        branch: params.workflow.branch,
        requiredSecrets: params.workflow.requiredSecrets,
        requiredVariables: params.workflow.requiredVariables,
        contentHash: sha256(params.workflow.content),
      },
      availableProviderSecrets: params.availableSecretNames,
      ...(params.missingProviderSecrets?.length ? { missingProviderSecrets: params.missingProviderSecrets } : {}),
      ...(params.staleProviderSecrets?.length ? { staleProviderSecrets: params.staleProviderSecrets } : {}),
    },
  };
}

export async function planGitHubActionsDeploy(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { project, environmentName, environmentSpec, environment } = params;
  const warnings: string[] = [];
  if (!environmentUsesGitHubActionsDeploy(environmentSpec)) {
    return { warnings };
  }
  if (!SUPPORTED_PROVIDERS.has(environmentSpec.hosting.provider)) {
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

  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === environmentName);
  if (!target) {
    warnings.push(`No GitHub Actions deploy target found for environment "${environmentName}".`);
    return { warnings };
  }

  const workflow = buildBranchDeployWorkflow(environmentSpec.hosting.provider as BranchDeployProvider, target, migration);
  const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(environmentSpec.hosting.provider)
    .filter((name) => workflow.requiredSecrets.includes(name));
  const availableSecrets = providerSecretsForGitHubActions(environmentSpec.hosting.provider, { githubRepo: repo })
    .filter((secret) => workflow.requiredSecrets.includes(secret.name));
  const availableSecretNames = availableSecrets.map((secret) => secret.name);
  const availableSecretHashes = secretHashes(availableSecrets);
  const missingProviderSecrets = requiredProviderSecrets.filter((name) => !availableSecretNames.includes(name));
  if (missingProviderSecrets.length > 0) {
    warnings.push(
      `GitHub Actions deploy workflow ${workflow.path} requires provider secrets that Hypervibe cannot sync: ${missingProviderSecrets.join(', ')}. `
      + missingProviderSecretsMessage(environmentSpec.hosting.provider, missingProviderSecrets)
    );
  }
  const contentHash = sha256(workflow.content);
  const binding = ciBindings(environment)[workflow.path];

  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe GitHub Actions workflow for ${repo}: ${adapterResult.error}`);
    return {
      action: buildAction({
        type: binding?.contentHash === contentHash ? 'noop' : 'update',
        provider: environmentSpec.hosting.provider,
        repo,
        workflow,
        reason: binding?.contentHash === contentHash
          ? 'GitHub Actions deploy workflow was previously synced by Hypervibe'
          : `GitHub Actions deploy workflow ${workflow.path} needs to be synced`,
        verified: false,
        availableSecretNames,
        missingProviderSecrets,
        dependsOn: params.dependsOn,
      }),
      warnings,
    };
  }

  let currentContent: string | null = null;
  let workflowReadVerified = false;
  try {
    currentContent = await adapterResult.adapter.getFileContent(owner, repoName, workflow.path);
    workflowReadVerified = true;
  } catch (error) {
    warnings.push(`Cannot read GitHub Actions workflow ${workflow.path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const syncedSecrets = new Set(binding?.syncedSecrets ?? []);
  const syncedSecretHashes = asRecord(binding?.syncedSecretHashes) ?? {};
  const staleProviderSecrets = requiredProviderSecrets.filter((name) =>
    syncedSecrets.has(name)
    && availableSecretHashes[name] !== undefined
    && syncedSecretHashes[name] !== availableSecretHashes[name]
  );
  const missingSecretSync =
    missingProviderSecrets.length > 0
    || requiredProviderSecrets.some((name) => !syncedSecrets.has(name))
    || staleProviderSecrets.length > 0;
  const type = currentContent === workflow.content && !missingSecretSync
    ? 'noop'
    : currentContent === null
      ? 'create'
      : 'update';
  const reason = type === 'noop'
    ? 'GitHub Actions deploy workflow is in sync'
    : currentContent === null
      ? `GitHub Actions deploy workflow ${workflow.path} is missing`
      : missingSecretSync
        ? `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`
        : `GitHub Actions deploy workflow ${workflow.path} differs from desired content`;

  return {
    action: buildAction({
      type,
      provider: environmentSpec.hosting.provider,
      repo,
      workflow,
      reason,
      verified: workflowReadVerified,
      availableSecretNames,
      missingProviderSecrets,
      staleProviderSecrets,
      dependsOn: type === 'noop' ? undefined : params.dependsOn,
    }),
    warnings,
  };
}

export async function applyGitHubActionsDeploy(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, environmentName, environmentSpec } = params;
  const repo = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repo) {
    return { success: false, message: 'GitHub repository is missing', error: 'Set project gitRemoteUrl to a GitHub remote.' };
  }
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    return { success: false, message: 'GitHub repository is invalid', error: `Could not parse ${repo}.` };
  }
  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    return { success: false, message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const adapter: GitHubAdapter = adapterResult.adapter;
  const verification = await adapter.verify();
  if (!verification.success) {
    return {
      success: false,
      message: 'GitHub connection verification failed',
      error: verification.error ?? 'GitHub connection verification failed',
    };
  }
  const permissionProblem = githubCiDeployPermissionProblem(verification, { repo });
  if (permissionProblem) {
    return {
      success: false,
      message: 'GitHub connection is missing CI deploy permissions',
      error: permissionProblem.hint,
      data: {
        repository: repo,
        missingScopes: permissionProblem.missingScopes,
        currentScopes: verification.scopes,
      },
    };
  }

  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === environmentName);
  if (!target) {
    return { success: false, message: 'No GitHub Actions deploy target', error: `No deploy target found for ${environmentName}.` };
  }
  const workflow = buildBranchDeployWorkflow(environmentSpec.hosting.provider as BranchDeployProvider, target, migration);
  const requiredProviderSecrets = requiredProviderSecretNamesForGitHubActions(environmentSpec.hosting.provider)
    .filter((name) => workflow.requiredSecrets.includes(name));
  const availableSecrets = providerSecretsForGitHubActions(environmentSpec.hosting.provider, { githubRepo: repo })
    .filter((secret) => workflow.requiredSecrets.includes(secret.name));
  const availableSecretNames = availableSecrets.map((secret) => secret.name);
  const missingProviderSecrets = requiredProviderSecrets.filter((name) => !availableSecretNames.includes(name));

  const fileResult = await adapter.createOrUpdateFile(
    owner,
    repoName,
    workflow.path,
    workflow.content,
    `Add ${workflow.templateName} workflow`
  );

  const syncedSecrets: ProviderSecret[] = [];
  const secretErrors: Array<{ name: string; error: string }> = [];
  for (const secret of availableSecrets) {
    try {
      await adapter.setRepositorySecret(owner, repoName, secret.name, secret.value);
      syncedSecrets.push(secret);
    } catch (error) {
      secretErrors.push({ name: secret.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  persistWorkflowBinding(project, environmentName, workflow, syncedSecrets);
  const syncedSecretNames = syncedSecrets.map((secret) => secret.name);
  if (missingProviderSecrets.length > 0) {
    return {
      success: false,
      message: `Synced ${workflow.path}, but required provider secrets are missing`,
      error: missingProviderSecretsMessage(environmentSpec.hosting.provider, missingProviderSecrets),
      data: { workflow: workflow.path, file: fileResult, syncedSecrets: syncedSecretNames, missingProviderSecrets },
    };
  }
  if (secretErrors.length > 0) {
    return {
      success: false,
      message: `Synced ${workflow.path}, but some GitHub secrets failed`,
      error: secretErrors.map((entry) => `${entry.name}: ${entry.error}`).join('; '),
      data: { workflow: workflow.path, file: fileResult, syncedSecrets: syncedSecretNames, secretErrors },
    };
  }
  return {
    success: true,
    message: `Synced GitHub Actions deploy workflow ${workflow.path}`,
    data: { workflow: workflow.path, file: fileResult, syncedSecrets: syncedSecretNames },
  };
}

function persistWorkflowBinding(
  project: Project,
  environmentName: string,
  workflow: BranchDeployWorkflow,
  syncedSecrets: ProviderSecret[]
): void {
  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, environmentName)
    ?? envRepo.create({ projectId: project.id, name: environmentName });
  const ci = asRecord(environment.platformBindings.ci) ?? {};
  const deployBranch = asRecord(ci.deployBranch) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    ci: {
      ...ci,
      deployBranch: {
        ...deployBranch,
        [workflow.path]: {
          contentHash: sha256(workflow.content),
          syncedSecrets: syncedSecrets.map((secret) => secret.name),
          syncedSecretHashes: secretHashes(syncedSecrets),
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });
}
