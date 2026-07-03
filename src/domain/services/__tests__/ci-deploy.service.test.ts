import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { SpecStore } from '../../spec/spec.store.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../github-ops.service.js';
import type { Project } from '../../entities/project.entity.js';
import {
  environmentUsesGitHubActionsDeploy,
  githubCiDeployPermissionProblem,
  missingProviderSecretsMessage,
  planGitHubActionsDeploy,
  requiredProviderSecretNamesForGitHubActions,
} from '../ci-deploy.service.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CI_ENVIRONMENT_SPEC = {
  hosting: { provider: 'railway' },
  services: { web: {} },
  deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
};

function seedProjectWithSpec(): {
  project: Project;
  projectRepo: ProjectRepository;
  envRepo: EnvironmentRepository;
  environmentId: string;
} {
  const projectRepo = new ProjectRepository();
  const envRepo = new EnvironmentRepository();
  const project = projectRepo.create({
    name: 'billforge',
    defaultPlatform: 'railway',
    gitRemoteUrl: 'https://github.com/davejohnson/billforge',
  });
  const environment = envRepo.create({
    projectId: project.id,
    name: 'production',
    platformBindings: {
      provider: 'railway',
      projectId: 'rail-project',
      environmentId: 'rail-env',
      services: { web: { serviceId: 'rail-web' } },
    },
  });
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: { production: CI_ENVIRONMENT_SPEC },
  });
  return { project: projectRepo.findById(project.id)!, projectRepo, envRepo, environmentId: environment.id };
}

function seedVerifiedConnections(options: { github?: boolean } = {}): void {
  const connectionRepo = new ConnectionRepository();
  const secretStore = getSecretStore();
  const railway = connectionRepo.create({
    provider: 'railway',
    credentialsEncrypted: secretStore.encryptObject({ apiToken: 'railway-token' }),
  });
  connectionRepo.updateStatus(railway.id, 'verified');
  if (options.github !== false) {
    const github = connectionRepo.create({
      provider: 'github',
      credentialsEncrypted: secretStore.encryptObject({
        apiToken: 'gh-token',
        login: 'davejohnson',
        packageReadToken: 'pkg-token',
      }),
    });
    connectionRepo.updateStatus(github.id, 'verified');
  }
}

function expectedWorkflow(project: Project) {
  const { targets, migration } = resolveBranchDeployTargets(project);
  return buildBranchDeployWorkflow('railway', targets[0], migration);
}

function syncedBinding(workflowContent: string) {
  return {
    contentHash: sha256(workflowContent),
    syncedSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
    syncedSecretHashes: {
      RAILWAY_API_TOKEN: sha256('railway-token'),
      IMAGE_REGISTRY_USERNAME: sha256('davejohnson'),
      IMAGE_REGISTRY_TOKEN: sha256('pkg-token'),
    },
  };
}

describe('ci-deploy.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-ci-deploy-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('requiredProviderSecretNamesForGitHubActions', () => {
    it('returns Railway API token plus GHCR pull credentials for railway', () => {
      expect(requiredProviderSecretNamesForGitHubActions('railway')).toEqual([
        'RAILWAY_API_TOKEN',
        'IMAGE_REGISTRY_USERNAME',
        'IMAGE_REGISTRY_TOKEN',
      ]);
    });

    it('returns GCP credentials for cloudrun', () => {
      expect(requiredProviderSecretNamesForGitHubActions('cloudrun')).toEqual([
        'GCP_SERVICE_ACCOUNT_JSON',
        'GCP_PROJECT_ID',
        'GCP_REGION',
      ]);
    });

    it('returns no secrets for unknown providers', () => {
      expect(requiredProviderSecretNamesForGitHubActions('vercel')).toEqual([]);
    });
  });

  describe('missingProviderSecretsMessage', () => {
    it('includes connection guidance when provider API secrets are missing', () => {
      const message = missingProviderSecretsMessage('railway', ['RAILWAY_API_TOKEN']);
      expect(message).toContain('Missing provider secrets: RAILWAY_API_TOKEN.');
      expect(message).toContain('Connect and verify railway');
      expect(message).toContain('Railway Account API token');
      expect(message).not.toContain('GHCR');
    });

    it('includes GHCR reconnect guidance when IMAGE_REGISTRY_* secrets are missing', () => {
      const message = missingProviderSecretsMessage('railway', ['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN']);
      expect(message).toContain('Missing provider secrets: IMAGE_REGISTRY_USERNAME, IMAGE_REGISTRY_TOKEN.');
      expect(message).toContain('For Railway GHCR image pulls, reconnect GitHub');
      expect(message).toContain('packageReadToken needs read:packages');
      expect(message).not.toContain('Connect and verify railway');
    });

    it('includes both guidance blocks when API and registry secrets are missing', () => {
      const message = missingProviderSecretsMessage('railway', ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_TOKEN']);
      expect(message).toContain('Connect and verify railway');
      expect(message).toContain('For Railway GHCR image pulls, reconnect GitHub');
    });
  });

  describe('githubCiDeployPermissionProblem', () => {
    it('returns null when no scopes are reported', () => {
      expect(githubCiDeployPermissionProblem({})).toBeNull();
      expect(githubCiDeployPermissionProblem({ scopes: [] })).toBeNull();
    });

    it('reports missing classic scopes with a reconnect hint', () => {
      const problem = githubCiDeployPermissionProblem(
        { scopes: ['read:packages'] },
        { repo: 'davejohnson/billforge' }
      );
      expect(problem).not.toBeNull();
      expect(problem!.missingScopes).toEqual(['repo', 'workflow']);
      expect(problem!.hint).toContain('missing classic PAT scope(s): repo, workflow');
      expect(problem!.hint).toContain('Reconnect GitHub with CI deploy permissions.');
      expect(problem!.hint).toContain('scope="davejohnson/billforge"');
    });

    it('returns null when repo and workflow scopes are both present', () => {
      expect(githubCiDeployPermissionProblem({ scopes: ['repo', 'workflow', 'read:packages'] })).toBeNull();
    });
  });

  describe('environmentUsesGitHubActionsDeploy', () => {
    it('is true for branch strategy with trigger unset (defaults to ci)', () => {
      const spec = environmentSpecSchema.parse({
        hosting: { provider: 'railway' },
        deploy: { strategy: 'branch' },
      });
      expect(environmentUsesGitHubActionsDeploy(spec)).toBe(true);
    });

    it('is true for branch strategy with trigger ci', () => {
      const spec = environmentSpecSchema.parse({
        hosting: { provider: 'railway' },
        deploy: { strategy: 'branch', trigger: 'ci' },
      });
      expect(environmentUsesGitHubActionsDeploy(spec)).toBe(true);
    });

    it('is false for branch strategy with trigger native', () => {
      const spec = environmentSpecSchema.parse({
        hosting: { provider: 'railway' },
        deploy: { strategy: 'branch', trigger: 'native' },
      });
      expect(environmentUsesGitHubActionsDeploy(spec)).toBe(false);
    });

    it('is false for manual strategy and for specs without deploy', () => {
      const manual = environmentSpecSchema.parse({
        hosting: { provider: 'railway' },
        deploy: { strategy: 'manual' },
      });
      expect(environmentUsesGitHubActionsDeploy(manual)).toBe(false);
      const noDeploy = environmentSpecSchema.parse({ hosting: { provider: 'railway' } });
      expect(environmentUsesGitHubActionsDeploy(noDeploy)).toBe(false);
    });
  });

  describe('planGitHubActionsDeploy', () => {
    const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);

    it('returns no action when the environment does not use GitHub Actions deploys', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      const manualSpec = environmentSpecSchema.parse({
        hosting: { provider: 'railway' },
        deploy: { strategy: 'manual' },
      });
      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: manualSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(result.action).toBeUndefined();
      expect(result.warnings).toEqual([]);
    });

    it('warns without an action when the hosting provider is unsupported', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      const unsupportedSpec = environmentSpecSchema.parse({
        hosting: { provider: 'vercel' },
        deploy: { strategy: 'branch', trigger: 'ci' },
      });
      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: unsupportedSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(result.action).toBeUndefined();
      expect(result.warnings).toEqual([
        'GitHub Actions branch deploys are not supported for provider "vercel".',
      ]);
    });

    it('warns without an action when the project has no GitHub remote', async () => {
      const projectRepo = new ProjectRepository();
      const project = projectRepo.create({ name: 'no-remote-project', defaultPlatform: 'railway' });
      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: null,
      });
      expect(result.action).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('no GitHub remote');
    });

    it('plans a create action when the workflow file does not exist on GitHub', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
        dependsOn: ['service:web'],
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        id: 'ci:github-actions:production:deploy-branch',
        type: 'create',
        resource: { kind: 'ci', name: 'deploy-branch:production', provider: 'github' },
        verified: true,
        reason: `GitHub Actions deploy workflow ${workflow.path} is missing`,
        dependsOn: ['service:web'],
      });
      expect(result.action?.metadata).toMatchObject({
        operation: 'githubActionsDeployBranch',
        repository: 'davejohnson/billforge',
        provider: 'railway',
        availableProviderSecrets: ['RAILWAY_API_TOKEN', 'IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'],
      });
      expect(result.action?.metadata?.missingProviderSecrets).toBeUndefined();
      expect((result.action?.metadata?.workflow as { contentHash: string }).contentHash).toBe(sha256(workflow.content));
    });

    it('plans a noop when workflow content and synced secret hashes match the stored ci binding', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(workflow.content) } },
      });
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
        dependsOn: ['service:web'],
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        type: 'noop',
        verified: true,
        reason: 'GitHub Actions deploy workflow is in sync',
      });
      expect(result.action?.dependsOn).toBeUndefined();
      expect(result.action?.metadata?.staleProviderSecrets).toBeUndefined();
    });

    it('plans an update when the live workflow content differs from the desired content', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(workflow.content) } },
      });
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue('# stale workflow');

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        type: 'update',
        verified: true,
        reason: `GitHub Actions deploy workflow ${workflow.path} differs from desired content`,
      });
    });

    it('plans an update when the workflow matches but provider secrets were never synced', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        reason: `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`,
      });
    });

    it('plans an update and reports stale secrets when a synced secret hash no longer matches', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      const binding = syncedBinding(workflow.content);
      binding.syncedSecretHashes.RAILWAY_API_TOKEN = sha256('rotated-old-token');
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        reason: `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`,
      });
      expect(result.action?.metadata?.staleProviderSecrets).toEqual(['RAILWAY_API_TOKEN']);
    });

    it('falls back to the stored ci binding when no GitHub connection is available', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections({ github: false });
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(workflow.content) } },
      });
      const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent');

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(getFileContent).not.toHaveBeenCalled();
      expect(result.action).toMatchObject({
        type: 'noop',
        verified: false,
        reason: 'GitHub Actions deploy workflow was previously synced by Hypervibe',
      });
      // No GitHub connection means the GHCR pull credentials cannot be synced.
      expect(result.action?.metadata?.missingProviderSecrets).toEqual([
        'IMAGE_REGISTRY_USERNAME',
        'IMAGE_REGISTRY_TOKEN',
      ]);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('requires provider secrets that Hypervibe cannot sync: IMAGE_REGISTRY_USERNAME, IMAGE_REGISTRY_TOKEN');
      expect(result.warnings[1]).toContain('Cannot observe GitHub Actions workflow for davejohnson/billforge');
    });
  });
});
