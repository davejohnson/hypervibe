import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import type { GitHubAdapter, GitHubLabel } from '../../adapters/providers/github/github.adapter.js';
import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { CollaborationSpec, ProjectSpec } from '../spec/spec.schema.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import {
  canonicalPullRequestTemplateContent,
  GITHUB_PULL_REQUEST_TEMPLATE,
} from './github-infrastructure.service.js';
import { getGitHubAdapter } from './github-ops.service.js';

const OPERATION = 'githubCollaboration';
const ISSUE_TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/task.yml';

export type CollaborationConnectionBlock = {
  provider: string;
  reason: string;
  scope?: string;
  policy?: 'hard' | 'action-scoped-if-independent-actions';
};

type DesiredLabel = { name: string; color: string; description: string };
type BranchProtection = Awaited<ReturnType<GitHubAdapter['getBranchProtection']>>;

const DEFAULT_LABELS: DesiredLabel[] = [
  { name: 'agent-ready', color: '0e8a16', description: 'Scoped work ready for a coding agent' },
  { name: 'blocked', color: 'b60205', description: 'Blocked on a decision, credential, or external dependency' },
  { name: 'type:bug', color: 'd73a4a', description: 'Something is broken' },
  { name: 'type:feature', color: 'a2eeef', description: 'New or changed product behavior' },
  { name: 'type:chore', color: 'cfd3d7', description: 'Maintenance or cleanup work' },
  { name: 'type:infra', color: '5319e7', description: 'Infrastructure or deployment work' },
  { name: 'area:ui', color: '1d76db', description: 'User interface work' },
  { name: 'area:deploy', color: '006b75', description: 'Deployment pipeline or hosting work' },
  { name: 'area:db', color: 'fbca04', description: 'Database schema or data work' },
  { name: 'risk:prod', color: 'e99695', description: 'Needs production-risk review before promotion' },
  { name: 'risk:data', color: 'f9d0c4', description: 'Touches data migration, deletion, or backfill paths' },
];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function repoParts(repo: string): { owner: string; repoName: string } | null {
  const [owner, repoName] = repo.split('/');
  return owner && repoName ? { owner, repoName } : null;
}

function normalizeColor(color: string): string {
  return color.replace(/^#/, '').toLowerCase();
}

function normalizeLabelName(name: string): string {
  return name.toLowerCase();
}

function desiredLabels(collaboration: CollaborationSpec): DesiredLabel[] {
  if (!collaboration.issues.enabled) return [];
  const byName = new Map(DEFAULT_LABELS.map((label) => [normalizeLabelName(label.name), label]));
  for (const label of collaboration.issues.labels) {
    byName.set(normalizeLabelName(label.name), {
      name: label.name,
      color: normalizeColor(label.color ?? 'ededed'),
      description: label.description ?? '',
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function issueTemplateContent(): string {
  return [
    'name: Task',
    'description: Small scoped task for a human or AI coding agent',
    'title: "[Task] "',
    'labels: ["agent-ready"]',
    'body:',
    '  - type: textarea',
    '    id: goal',
    '    attributes:',
    '      label: Goal',
    '      description: What should change?',
    '    validations:',
    '      required: true',
    '  - type: textarea',
    '    id: context',
    '    attributes:',
    '      label: Context',
    '      description: Relevant files, screenshots, links, or product notes.',
    '    validations:',
    '      required: false',
    '  - type: textarea',
    '    id: acceptance',
    '    attributes:',
    '      label: Acceptance criteria',
    '      description: What must be true before this is ready for review?',
    '      placeholder: |',
    '        - The visible table column is wider on desktop and mobile.',
    '        - Existing tests still pass.',
    '    validations:',
    '      required: true',
    '',
  ].join('\n');
}

function desiredFiles(collaboration: CollaborationSpec): Array<{ path: string; content: string; hash: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (collaboration.issues.enabled && collaboration.issues.templates) {
    files.push({ path: ISSUE_TEMPLATE_PATH, content: issueTemplateContent() });
  }
  if (collaboration.pullRequests.requirePr) {
    files.push({
      path: GITHUB_PULL_REQUEST_TEMPLATE,
      content: canonicalPullRequestTemplateContent(),
    });
  }
  return files.map((file) => ({ ...file, hash: sha256(file.content) }));
}

export function resolveCollaborationRepository(project: Project, spec: ProjectSpec): string | undefined {
  return spec.collaboration?.repository ?? parseGitHubRepoFromRemote(project.gitRemoteUrl) ?? undefined;
}

export function collaborationCanonicalEnvironment(spec: ProjectSpec): string | undefined {
  if (!spec.collaboration || spec.collaboration.enabled === false) return undefined;
  if (spec.collaboration.canonicalEnvironment) return spec.collaboration.canonicalEnvironment;
  if (spec.environments.production) return 'production';
  return Object.keys(spec.environments).sort()[0];
}

export function shouldPlanGitHubCollaboration(spec: ProjectSpec, environmentName: string): boolean {
  return Boolean(spec.collaboration && spec.collaboration.enabled !== false && collaborationCanonicalEnvironment(spec) === environmentName);
}

export function githubCollaborationConnectionBlock(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  connectionRepo?: ConnectionRepository;
}): CollaborationConnectionBlock | null {
  if (!shouldPlanGitHubCollaboration(params.spec, params.environmentName)) return null;
  const repo = resolveCollaborationRepository(params.project, params.spec);
  const connectionRepo = params.connectionRepo ?? new ConnectionRepository();
  const verified = connectionRepo.findBestVerifiedMatch('github', repo);
  if (verified) return null;
  return {
    provider: 'github',
    reason: `No verified GitHub connection${repo ? ` for ${repo}` : ''}. ${formatConnectionGuidance('github', {
      scope: repo,
      intro: 'Connect GitHub to manage collaboration infrastructure: issue templates, labels, pull request templates, and branch protection.',
    })}`,
    ...(repo ? { scope: repo } : {}),
  };
}

function fileDrift(current: Map<string, string | null>, collaboration: CollaborationSpec): string[] {
  return desiredFiles(collaboration)
    .filter((file) => current.get(file.path) !== file.content)
    .map((file) => file.path);
}

function labelDrift(current: GitHubLabel[], collaboration: CollaborationSpec): string[] {
  const currentByName = new Map(current.map((label) => [normalizeLabelName(label.name), label]));
  return desiredLabels(collaboration)
    .filter((label) => {
      const existing = currentByName.get(normalizeLabelName(label.name));
      return !existing
        || normalizeColor(existing.color) !== normalizeColor(label.color)
        || (existing.description ?? '') !== label.description;
    })
    .map((label) => label.name);
}

function currentStatusChecks(current: BranchProtection): string[] {
  const checks = current?.required_status_checks;
  if (!checks) return [];
  const contexts = checks.contexts?.length
    ? checks.contexts
    : checks.checks?.map((check) => check.context).filter(Boolean) ?? [];
  return [...contexts].sort();
}

function branchProtectionDrift(current: BranchProtection, collaboration: CollaborationSpec): string[] {
  const desired = collaboration.pullRequests;
  if (!desired.requirePr) return [];
  const drift: string[] = [];
  if (!current) {
    return ['branchProtection'];
  }
  const reviews = current.required_pull_request_reviews;
  if (desired.requireReview) {
    if (!reviews || reviews.required_approving_review_count !== desired.requiredReviewers) {
      drift.push('requiredReviewers');
    }
    if ((reviews?.dismiss_stale_reviews ?? false) !== desired.dismissStaleReviews) {
      drift.push('dismissStaleReviews');
    }
    if ((reviews?.require_code_owner_reviews ?? false) !== desired.requireCodeOwnerReviews) {
      drift.push('requireCodeOwnerReviews');
    }
  }
  if ((current.enforce_admins?.enabled ?? false) !== desired.enforceAdmins) {
    drift.push('enforceAdmins');
  }
  if ((current.allow_force_pushes?.enabled ?? false) !== false) {
    drift.push('allowForcePushes');
  }
  if ((current.allow_deletions?.enabled ?? false) !== false) {
    drift.push('allowDeletions');
  }
  if (desired.requireStatusChecks) {
    const actualChecks = currentStatusChecks(current);
    const expectedChecks = [...desired.statusChecks].sort();
    if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
      drift.push('statusChecks');
    }
    if ((current.required_status_checks?.strict ?? false) !== desired.strictStatusChecks) {
      drift.push('strictStatusChecks');
    }
  }
  return drift;
}

function collaborationWarnings(repo: string, collaboration: CollaborationSpec): string[] {
  if (collaboration.collaborators.length === 0) return [];
  const users = collaboration.collaborators
    .map((entry) => `${entry.username} (${entry.permission})`)
    .join(', ');
  return [
    `GitHub collaborator invitations are manual in Hypervibe v1. Invite or confirm access for ${users} at https://github.com/${repo}/settings/access before assigning tickets to those users.`,
  ];
}

export function isGitHubCollaborationAction(action: PlanAction): boolean {
  return action.metadata?.operation === OPERATION;
}

export function githubCollaborationPermissionProblem(
  verification: { scopes?: string[] },
  options: { repo?: string } = {}
): { missingScopes: string[]; hint: string } | null {
  if (!verification.scopes?.length) return null;
  const scopes = new Set(verification.scopes);
  const missingScopes = scopes.has('repo') ? [] : ['repo'];
  if (missingScopes.length === 0) return null;
  return {
    missingScopes,
    hint: [
      `The GitHub apiToken is verified but missing classic PAT scope(s): ${missingScopes.join(', ')}.`,
      'Repository collaboration setup needs repo access to write issue templates, labels, pull request templates, and branch protection.',
      formatConnectionGuidance('github', {
        scope: options.repo,
        intro: 'Reconnect GitHub with repository collaboration permissions.',
      }),
    ].join(' '),
  };
}

export async function planGitHubCollaboration(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { project, spec, environmentName } = params;
  const collaboration = spec.collaboration;
  if (!collaboration || !shouldPlanGitHubCollaboration(spec, environmentName)) {
    return { warnings: [] };
  }

  const repo = resolveCollaborationRepository(project, spec);
  if (!repo) {
    return {
      warnings: ['collaboration.provider is "github", but the project has no GitHub remote (gitRemoteUrl) and collaboration.repository is unset.'],
    };
  }
  const parts = repoParts(repo);
  if (!parts) {
    return { warnings: [`Could not parse GitHub repository from ${repo}.`] };
  }

  const warnings = collaborationWarnings(repo, collaboration);
  const adapterResult = getGitHubAdapter(repo);
  const metadataBase = {
    operation: OPERATION,
    repository: repo,
    canonicalEnvironment: environmentName,
    issueTemplatePath: ISSUE_TEMPLATE_PATH,
    pullRequestTemplatePath: GITHUB_PULL_REQUEST_TEMPLATE,
    targetBranch: collaboration.pullRequests.targetBranch,
    collaborators: collaboration.collaborators.map((entry) => ({ username: entry.username, permission: entry.permission })),
  };
  if ('error' in adapterResult) {
    warnings.push(`Cannot observe GitHub collaboration state for ${repo}: ${adapterResult.error}`);
    return {
      action: {
        id: 'repo:github-collaboration',
        type: 'update',
        resource: { kind: 'repo', name: repo, provider: 'github' },
        verified: false,
        reason: 'GitHub collaboration setup needs to be synced',
        metadata: metadataBase,
      },
      warnings,
    };
  }

  let verified = true;
  const currentFiles = new Map<string, string | null>();
  for (const file of desiredFiles(collaboration)) {
    try {
      currentFiles.set(file.path, await adapterResult.adapter.getFileContent(parts.owner, parts.repoName, file.path));
    } catch (error) {
      verified = false;
      warnings.push(`Cannot read GitHub file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      currentFiles.set(file.path, null);
    }
  }

  let currentLabels: GitHubLabel[] = [];
  try {
    currentLabels = await adapterResult.adapter.listLabels(parts.owner, parts.repoName);
  } catch (error) {
    verified = false;
    warnings.push(`Cannot read GitHub labels: ${error instanceof Error ? error.message : String(error)}`);
  }

  let branchProtection: BranchProtection = null;
  try {
    branchProtection = await adapterResult.adapter.getBranchProtection(parts.owner, parts.repoName, collaboration.pullRequests.targetBranch);
  } catch (error) {
    verified = false;
    warnings.push(`Cannot read GitHub branch protection for ${collaboration.pullRequests.targetBranch}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files = fileDrift(currentFiles, collaboration);
  const labels = labelDrift(currentLabels, collaboration);
  const branch = branchProtectionDrift(branchProtection, collaboration);
  const drift = [
    ...files.map((path) => `template:${path}`),
    ...labels.map((name) => `label:${name}`),
    ...branch.map((field) => `branch:${field}`),
  ];
  const type = drift.length === 0 ? 'noop' : 'update';
  return {
    action: {
      id: 'repo:github-collaboration',
      type,
      resource: { kind: 'repo', name: repo, provider: 'github' },
      verified,
      reason: type === 'noop'
        ? 'GitHub collaboration setup is in sync'
        : `GitHub collaboration setup needs syncing (${drift.join(', ')})`,
      ...(drift.length > 0
        ? { diff: drift.map((field) => ({ field, from: 'drift', to: 'desired' })) }
        : {}),
      metadata: {
        ...metadataBase,
        desiredLabels: desiredLabels(collaboration).map((label) => label.name),
        desiredFiles: desiredFiles(collaboration).map((file) => ({ path: file.path, contentHash: file.hash })),
        branchProtection: {
          requirePr: collaboration.pullRequests.requirePr,
          requireReview: collaboration.pullRequests.requireReview,
          requiredReviewers: collaboration.pullRequests.requiredReviewers,
          requireStatusChecks: collaboration.pullRequests.requireStatusChecks,
          statusChecks: collaboration.pullRequests.statusChecks,
        },
      },
    },
    warnings,
  };
}

export async function applyGitHubCollaboration(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const collaboration = params.spec.collaboration;
  if (!collaboration || !shouldPlanGitHubCollaboration(params.spec, params.environmentName)) {
    return { success: true, message: 'GitHub collaboration setup is not enabled for this environment' };
  }
  const repo = resolveCollaborationRepository(params.project, params.spec);
  if (!repo) {
    return { success: false, message: 'GitHub repository is missing', error: 'Set project gitRemoteUrl or collaboration.repository.' };
  }
  const parts = repoParts(repo);
  if (!parts) {
    return { success: false, message: 'GitHub repository is invalid', error: `Could not parse ${repo}.` };
  }
  const adapterResult = getGitHubAdapter(repo);
  if ('error' in adapterResult) {
    return { success: false, message: 'GitHub adapter unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  const verification = await adapter.verify();
  if (!verification.success) {
    return {
      success: false,
      message: 'GitHub connection verification failed',
      error: verification.error ?? 'GitHub connection verification failed',
    };
  }
  const permissionProblem = githubCollaborationPermissionProblem(verification, { repo });
  if (permissionProblem) {
    return {
      success: false,
      message: 'GitHub connection is missing repository collaboration permissions',
      error: permissionProblem.hint,
      data: { repository: repo, missingScopes: permissionProblem.missingScopes, currentScopes: verification.scopes },
    };
  }

  const files: Array<{ path: string; created: boolean; updated: boolean }> = [];
  for (const file of desiredFiles(collaboration)) {
    const current = await adapter.getFileContent(parts.owner, parts.repoName, file.path);
    if (current === file.content) continue;
    const result = await adapter.createOrUpdateFile(
      parts.owner,
      parts.repoName,
      file.path,
      file.content,
      `Sync Hypervibe collaboration file ${file.path}`
    );
    files.push({ path: file.path, ...result });
  }

  const labels: Array<{ name: string; created: boolean; updated: boolean }> = [];
  for (const label of desiredLabels(collaboration)) {
    const result = await adapter.createOrUpdateLabel(parts.owner, parts.repoName, label);
    labels.push({ name: label.name, ...result });
  }

  let branchProtectionSynced = false;
  if (collaboration.pullRequests.requirePr) {
    await adapter.updateBranchProtection(parts.owner, parts.repoName, collaboration.pullRequests.targetBranch, {
      requireReviews: collaboration.pullRequests.requireReview,
      requiredReviewers: collaboration.pullRequests.requiredReviewers,
      dismissStaleReviews: collaboration.pullRequests.dismissStaleReviews,
      requireCodeOwnerReviews: collaboration.pullRequests.requireCodeOwnerReviews,
      requireStatusChecks: collaboration.pullRequests.requireStatusChecks,
      statusChecks: collaboration.pullRequests.statusChecks,
      strictStatusChecks: collaboration.pullRequests.strictStatusChecks,
      enforceAdmins: collaboration.pullRequests.enforceAdmins,
      preserveStatusChecks: !collaboration.pullRequests.requireStatusChecks,
      allowForcePushes: false,
      allowDeletions: false,
    });
    branchProtectionSynced = true;
  }

  return {
    success: true,
    message: `Synced GitHub collaboration setup for ${repo}`,
    data: {
      repository: repo,
      files,
      labels: labels.filter((label) => label.created || label.updated),
      branchProtectionSynced,
      manualCollaborators: collaboration.collaborators,
    },
  };
}
