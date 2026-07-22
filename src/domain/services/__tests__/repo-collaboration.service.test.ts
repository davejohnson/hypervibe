import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { projectSpecSchema, type ProjectSpec } from '../../spec/spec.schema.js';
import {
  applyGitHubCollaboration,
  githubCollaborationConnectionBlock,
  githubCollaborationPermissionProblem,
  planGitHubCollaboration,
  shouldPlanGitHubCollaboration,
} from '../repo-collaboration.service.js';

const REPO = 'davejohnson/billforge';

function seedGitHubConnection(): void {
  const connectionRepo = new ConnectionRepository();
  const connection = connectionRepo.create({
    provider: 'github',
    scope: REPO,
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'gh-token' }),
  });
  connectionRepo.updateStatus(connection.id, 'verified');
}

function seedProjectAndSpec(specPatch: Partial<ProjectSpec> = {}) {
  const project = new ProjectRepository().create({
    name: 'billforge',
    defaultPlatform: 'railway',
    gitRemoteUrl: `https://github.com/${REPO}`,
  });
  const spec = projectSpecSchema.parse({
    version: 1,
    project: project.name,
    collaboration: {
      collaborators: [{ username: 'teammate', permission: 'push' }],
    },
    environments: {
      staging: { hosting: { provider: 'railway' }, services: { web: {} } },
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
    },
    ...specPatch,
  });
  return { project, spec };
}

describe('repo-collaboration.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-repo-collab-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses production as the canonical collaboration planning environment by default', () => {
    const { spec } = seedProjectAndSpec();
    expect(shouldPlanGitHubCollaboration(spec, 'production')).toBe(true);
    expect(shouldPlanGitHubCollaboration(spec, 'staging')).toBe(false);
  });

  it('reports a GitHub connection block with token URL and permissions guidance', () => {
    const { project, spec } = seedProjectAndSpec();
    const block = githubCollaborationConnectionBlock({ project, spec, environmentName: 'production' });
    expect(block).toMatchObject({ provider: 'github', scope: REPO });
    expect(block?.reason).toContain('https://github.com/settings/tokens');
    expect(block?.reason).toContain('issue templates, labels, pull request templates, and branch protection');
    expect(block?.reason).toContain('Issues read/write');
    expect(block?.reason).toContain('Administration read/write');
  });

  it('plans templates, labels, and branch protection drift', async () => {
    seedGitHubConnection();
    const { project, spec } = seedProjectAndSpec();
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getBranchProtection').mockResolvedValue(null);

    const result = await planGitHubCollaboration({ project, spec, environmentName: 'production' });

    expect(result.action).toMatchObject({
      id: 'repo:github-collaboration',
      type: 'update',
      resource: { kind: 'repo', name: REPO, provider: 'github' },
      verified: true,
    });
    expect(result.action?.reason).toContain('template:.github/ISSUE_TEMPLATE/task.yml');
    expect(result.action?.reason).toContain('label:agent-ready');
    expect(result.action?.reason).toContain('branch:branchProtection');
    expect(result.warnings[0]).toContain('collaborator invitations are manual');
  });

  it('applies collaboration setup without inviting collaborators', async () => {
    seedGitHubConnection();
    const { project, spec } = seedProjectAndSpec();
    vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({ success: true, login: 'davejohnson', scopes: ['repo'] });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
    const writeFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile').mockResolvedValue({ created: true, updated: false });
    const writeLabel = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateLabel').mockResolvedValue({ created: true, updated: false });
    const protect = vi.spyOn(GitHubAdapter.prototype, 'updateBranchProtection').mockResolvedValue();

    const result = await applyGitHubCollaboration({ project, spec, environmentName: 'production' });

    expect(result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      'davejohnson',
      'billforge',
      '.github/ISSUE_TEMPLATE/task.yml',
      expect.stringContaining('name: Task'),
      'Sync Hypervibe collaboration file .github/ISSUE_TEMPLATE/task.yml'
    );
    expect(writeLabel).toHaveBeenCalledWith('davejohnson', 'billforge', expect.objectContaining({ name: 'agent-ready' }));
    expect(protect).toHaveBeenCalledWith('davejohnson', 'billforge', 'main', expect.objectContaining({
      requireReviews: true,
      requiredReviewers: 1,
      preserveStatusChecks: true,
    }));
    expect(result.data).toMatchObject({
      repository: REPO,
      manualCollaborators: [{ username: 'teammate', permission: 'push' }],
    });
  });

  it('rejects classic PATs that cannot manage repository collaboration', () => {
    const problem = githubCollaborationPermissionProblem({ scopes: ['read:packages'] }, { repo: REPO });
    expect(problem?.missingScopes).toEqual(['repo']);
    expect(problem?.hint).toContain('missing classic PAT scope(s): repo');
    expect(problem?.hint).toContain('https://github.com/settings/tokens');
  });
});
