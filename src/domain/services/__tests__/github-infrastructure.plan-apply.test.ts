import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Project } from '../../entities/project.entity.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  applyGitHubInfrastructure,
  compileManagedGitHubFiles,
  GITHUB_INFRASTRUCTURE_ACTION_ID,
  GITHUB_INFRASTRUCTURE_BRANCH,
  GITHUB_INFRASTRUCTURE_MANIFEST,
  GITHUB_OPENAI_SECRET_ACTION_ID,
  planGitHubInfrastructure,
} from '../github-infrastructure.service.js';

const REPOSITORY = 'owner/example';
const project = {
  id: 'project-1',
  name: 'example',
  defaultPlatform: 'railway',
  gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
} as Project;

function spec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'example',
    github: {
      actions: {
        tests: { kind: 'check', category: 'test', runtime: { kind: 'node' }, commands: ['npm test'] },
        fix: { kind: 'autofix', sources: ['tests'] },
      },
      dependencies: { alerts: true, securityUpdates: true },
      security: { secretScanning: true, pushProtection: true, codeScanning: true },
    },
    environments: { production: { hosting: { provider: 'railway' }, services: {} } },
  });
}

function seedGitHub(): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({
    provider: 'github',
    scope: REPOSITORY,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'github-token' }),
  });
  repo.updateStatus(connection.id, 'verified');
}

describe('GitHub infrastructure plan/apply', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-github-infra-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    seedGitHub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans one file PR first and defers the OpenAI secret stage', async () => {
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    const result = await planGitHubInfrastructure({ project, spec: spec(), environmentName: 'production' });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      metadata: { branch: GITHUB_INFRASTRUCTURE_BRANCH },
    });
    expect(result.actions[0].metadata?.desiredFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.github/workflows/hypervibe-fix.yml' }),
    ]));
    expect(result.blocked.find((block) => block.provider === 'openai')).toBeUndefined();
  });

  it('plans action-scoped OpenAI and native settings only after files are merged', async () => {
    const desired = new Map(compileManagedGitHubFiles(spec().github!).map((file) => [file.path, file.content]));
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, filePath) => desired.get(filePath) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({
      default_branch: 'main', private: true,
      security_and_analysis: {
        dependabot_security_updates: { status: 'disabled' },
        secret_scanning: { status: 'disabled' },
        secret_scanning_push_protection: { status: 'disabled' },
      },
    });
    vi.spyOn(GitHubAdapter.prototype, 'getVulnerabilityAlertsEnabled').mockResolvedValue(false);
    vi.spyOn(GitHubAdapter.prototype, 'getCodeScanningDefaultSetup').mockResolvedValue({ state: 'not-configured' });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowPermissions').mockResolvedValue({
      default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
    });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getBranchProtection').mockResolvedValue(null);

    const result = await planGitHubInfrastructure({ project, spec: spec(), environmentName: 'production' });
    expect(result.actions.find((action) => action.id === GITHUB_OPENAI_SECRET_ACTION_ID)?.type).toBe('update');
    expect(result.blocked.find((block) => block.provider === 'openai')).toMatchObject({
      policy: 'action-scoped-if-independent-actions',
      actionIds: [GITHUB_OPENAI_SECRET_ACTION_ID],
    });
    expect(result.actions.find((action) => action.id === 'repo:github-code-scanning')).toMatchObject({
      type: 'update', billable: true, requiresConfirm: true,
    });
    expect(result.actions.find((action) => action.id === 'repo:github-actions-pr-permission')?.type).toBe('update');
  });

  it('creates a deterministic infrastructure branch and returns a pending PR receipt', async () => {
    const github = spec().github!;
    const files = compileManagedGitHubFiles(github);
    const action: PlanAction = {
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      resource: { kind: 'repo', name: REPOSITORY, provider: 'github' },
      verified: true,
      reason: 'drift',
      metadata: {
        operation: 'githubInfrastructurePullRequest',
        repository: REPOSITORY,
        desiredFiles: files,
      },
    };
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    const createRef = vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
    const write = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false });
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({ number: 42, html_url: 'https://github.com/owner/example/pull/42' });

    const result = await applyGitHubInfrastructure({ action });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      data: { pullRequestNumber: 42, pullRequestUrl: 'https://github.com/owner/example/pull/42' },
    });
    expect(createRef).toHaveBeenCalledWith('owner', 'example', `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, 'base-sha');
    expect(write).toHaveBeenCalledWith(
      'owner', 'example', expect.any(String), expect.any(String), expect.any(String), GITHUB_INFRASTRUCTURE_BRANCH
    );
  });

  it('replaces the canonical pull-request template and removes the retired uppercase path', async () => {
    const github = projectSpecSchema.parse({
      version: 1,
      project: 'example',
      github: {
        collaboration: {
          issues: { enabled: false, templates: false },
          pullRequests: { requirePr: true },
        },
      },
      environments: { production: { hosting: { provider: 'railway' }, services: {} } },
    }).github!;
    const action: PlanAction = {
      id: GITHUB_INFRASTRUCTURE_ACTION_ID,
      type: 'update',
      resource: { kind: 'repo', name: REPOSITORY, provider: 'github' },
      verified: true,
      reason: 'release template ownership',
      metadata: {
        operation: 'githubInfrastructurePullRequest',
        repository: REPOSITORY,
        desiredFiles: compileManagedGitHubFiles(github),
      },
    };
    const oldManifest = JSON.stringify({
      version: 1,
      managedBy: 'hypervibe',
      files: ['.github/PULL_REQUEST_TEMPLATE.md'],
    });
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, scopes: ['repo', 'workflow'] });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef')
      .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ref: `refs/heads/${GITHUB_INFRASTRUCTURE_BRANCH}`, object: { sha: 'base-sha' } });
    vi.spyOn(GitHubAdapter.prototype, 'createRef').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getFile').mockImplementation(async (_owner, _repo, filePath) => {
      if (filePath === GITHUB_INFRASTRUCTURE_MANIFEST) {
        return { sha: 'manifest-sha', content: oldManifest };
      }
      if (filePath === '.github/pull_request_template.md') {
        return { sha: 'lowercase-template-sha', content: 'repository-owned template' };
      }
      if (filePath === '.github/PULL_REQUEST_TEMPLATE.md') {
        return { sha: 'uppercase-template-sha', content: 'old Hypervibe template' };
      }
      return null;
    });
    const createOrUpdateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
      .mockResolvedValue({ created: false, updated: true });
    const deleteFile = vi.spyOn(GitHubAdapter.prototype, 'deleteFile').mockResolvedValue();
    vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
      number: 43,
      html_url: 'https://github.com/owner/example/pull/43',
    });

    const result = await applyGitHubInfrastructure({ action });

    expect(result).toMatchObject({ success: false, status: 'pending' });
    expect(createOrUpdateFile).toHaveBeenCalledWith(
      'owner',
      'example',
      '.github/pull_request_template.md',
      expect.stringContaining('## Summary'),
      expect.any(String),
      GITHUB_INFRASTRUCTURE_BRANCH
    );
    expect(deleteFile).toHaveBeenCalledWith(
      'owner',
      'example',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'uppercase-template-sha',
      expect.any(String),
      GITHUB_INFRASTRUCTURE_BRANCH
    );
  });
});
