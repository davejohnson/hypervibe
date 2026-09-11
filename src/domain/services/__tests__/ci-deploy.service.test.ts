import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/digitalocean/digitalocean.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { SpecStore } from '../../spec/spec.store.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../github-ops.service.js';
import type { Project } from '../../entities/project.entity.js';
import {
  applyGitHubActionsAppliedSpecHash,
  applyGitHubActionsDeploy,
  applyGitHubActionsRelease,
  environmentUsesGitHubActionsDeploy,
  githubActionsWorkflowInputHash,
  githubCiDeployPermissionProblem,
  managedWorkflowPublicationBranch,
  missingProviderSecretsMessage,
  planGitHubActionsAppliedSpecHash,
  planGitHubActionsDeploy,
  planGitHubActionsRelease,
  providerSecretsForGitHubActions,
  requiredProviderSecretNamesForGitHubActions,
  workflowFiles,
  workflowFilesContentHash,
} from '../ci-deploy.service.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import {
  IOS_RELEASE_REQUIRED_SECRETS,
  MATCH_SIGNING_REQUIRED_SECRETS,
} from '../ios-release-workflow.service.js';
import type { PlanAction } from '../../plan/plan.types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const CI_ENVIRONMENT_SPEC = {
  hosting: { provider: 'railway' },
  services: { web: {} },
  deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
};
const MANAGED_WORKFLOW_BRANCH = managedWorkflowPublicationBranch('production');
const IOS_ENVIRONMENT_SPEC = environmentSpecSchema.parse({
  ...CI_ENVIRONMENT_SPEC,
  ios: {
    bundleId: 'com.example.billforge',
    testflight: { groups: { beta: {} } },
    release: {
      services: ['web'],
      build: {
        workingDirectory: 'apps/ios',
        command: 'make ipa',
        ipaPath: 'build/Billforge.ipa',
      },
      signing: { provider: 'match' },
      testflight: { groups: ['beta'] },
    },
  },
});
const APP_STORE_CREDENTIALS = {
  keyId: 'KEY1',
  issuerId: 'ISSUER1',
  privateKey: 'private-material-super-secret',
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

function expectedWorkflowInputHash(project: Project): string {
  const { targets, migration } = resolveBranchDeployTargets(project);
  return githubActionsWorkflowInputHash({
    provider: 'railway',
    target: targets[0],
    migration,
  });
}

function reviewedDeployAction(
  project: Project,
  environmentSpec: ReturnType<typeof environmentSpecSchema.parse>,
  publicationOnly: boolean,
  additionalSecretValues: Record<string, string> = {}
): PlanAction {
  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === 'production')!;
  const workflow = buildBranchDeployWorkflow(
    environmentSpec.hosting.provider,
    target,
    migration,
    environmentSpec.ios
  );
  const secretValues = {
    RAILWAY_API_TOKEN: 'railway-token',
    IMAGE_REGISTRY_USERNAME: 'davejohnson',
    IMAGE_REGISTRY_TOKEN: 'pkg-token',
    ...additionalSecretValues,
  };
  return {
    id: 'ci:github-actions:production:deploy-branch',
    type: 'update',
    resource: { kind: 'ci', name: 'deploy-branch:production', provider: 'github' },
    verified: true,
    reason: 'test reviewed action',
    metadata: {
      operation: 'githubActionsDeployBranch',
      ...(publicationOnly ? { workflowPublicationRequired: true } : {}),
      ...(!publicationOnly
        ? {
            desiredSecretHashes: Object.fromEntries(
              Object.entries(secretValues).map(([name, value]) => [name, sha256(value)])
            ),
            desiredEnvironmentSecretHashes: {},
            reviewedRepositorySecrets: [...new Set([
              ...Object.keys(secretValues),
              ...(workflow.requiredSecrets.includes('DATABASE_URL') ? ['DATABASE_URL'] : []),
            ])].sort(),
          }
        : {}),
      workflow: {
        path: workflow.path,
        inputHash: githubActionsWorkflowInputHash({
          provider: environmentSpec.hosting.provider,
          target,
          migration,
          ios: environmentSpec.ios,
        }),
        aggregateContentHash: workflowFilesContentHash(workflowFiles(workflow)),
        retiredPaths: [],
      },
    },
  };
}

function syncedBinding(
  project: Project,
  workflowContent: string,
  additionalSecrets: Record<string, string> = {}
) {
  const secretValues = {
    RAILWAY_API_TOKEN: 'railway-token',
    IMAGE_REGISTRY_USERNAME: 'davejohnson',
    IMAGE_REGISTRY_TOKEN: 'pkg-token',
    ...additionalSecrets,
  };
  return {
    contentHash: sha256(workflowContent),
    inputHash: expectedWorkflowInputHash(project),
    managedPaths: [expectedWorkflow(project).path],
    syncedSecrets: Object.keys(secretValues),
    syncedSecretHashes: Object.fromEntries(
      Object.entries(secretValues).map(([name, value]) => [name, sha256(value)])
    ),
  };
}

function configureIosRelease(project: Project) {
  const environmentSpec = IOS_ENVIRONMENT_SPEC;
  const ios = environmentSpec.ios!;
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: { production: environmentSpec },
  });
  const connections = new ConnectionRepository();
  const appStore = connections.create({
    provider: 'appstoreconnect',
    scope: ios.bundleId,
    credentialsEncrypted: getSecretStore().encryptObject(APP_STORE_CREDENTIALS),
  });
  connections.updateStatus(appStore.id, 'verified');

  const { targets, migration } = resolveBranchDeployTargets(project);
  const target = targets.find((candidate) => candidate.environmentName === 'production')!;
  const workflow = buildBranchDeployWorkflow('railway', target, migration, ios);
  const files = workflowFiles(workflow);
  return {
    appStoreConnectionId: appStore.id,
    environmentSpec,
    workflow,
    binding: {
      ...syncedBinding(project, workflow.content),
      contentHash: workflowFilesContentHash(files),
      inputHash: githubActionsWorkflowInputHash({
        provider: 'railway',
        target,
        migration,
        ios,
      }),
      managedPaths: files.map((file) => file.path),
    },
  };
}

function mockLiveWorkflowFiles(workflow: ReturnType<typeof expectedWorkflow>) {
  const files = new Map<string, string | null>(
    workflowFiles(workflow).map((file) => [file.path, file.content])
  );
  const read = vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
    .mockImplementation(async (_owner, _repo, filePath) => files.get(filePath) ?? null);
  return { files, read };
}

function acceptWorkflow(
  project: Project,
  envRepo: EnvironmentRepository,
  environmentId: string,
  workflow: ReturnType<typeof expectedWorkflow>,
  options: {
    acceptedContent?: string;
    liveContent?: string;
    binding?: Partial<ReturnType<typeof syncedBinding>>;
  } = {}
): void {
  const acceptedContent = options.acceptedContent ?? workflow.content;
  envRepo.updatePlatformBindings(environmentId, {
    ci: {
      deployBranch: {
        [workflow.path]: options.binding ?? syncedBinding(project, acceptedContent),
      },
    },
  });
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
    .mockResolvedValue(options.liveContent ?? acceptedContent);
}

function seedAcceptedRelease(options: {
  environmentSpec?: ReturnType<typeof environmentSpecSchema.parse>;
  liveContent?: (workflow: ReturnType<typeof expectedWorkflow>) => string;
} = {}) {
  const seeded = seedProjectWithSpec();
  seedVerifiedConnections();
  if (options.environmentSpec) {
    new SpecStore().replace(seeded.project, {
      version: 1,
      project: seeded.project.name,
      environments: { production: options.environmentSpec },
    });
  }
  const spec = new SpecStore().get(seeded.project)!.spec;
  const workflow = expectedWorkflow(seeded.project);
  acceptWorkflow(seeded.project, seeded.envRepo, seeded.environmentId, workflow, {
    liveContent: options.liveContent?.(workflow),
  });
  return {
    ...seeded,
    spec,
    workflow,
    workflowInputHash: expectedWorkflowInputHash(seeded.project),
    workflowContentHash: workflowFilesContentHash(workflowFiles(workflow)),
  };
}

function reviewedReleaseParams(
  release: ReturnType<typeof seedAcceptedRelease>,
  overrides: Partial<Parameters<typeof applyGitHubActionsRelease>[0]> = {}
): Parameters<typeof applyGitHubActionsRelease>[0] {
  return {
    project: release.project,
    environmentName: 'production',
    environmentSpec: release.spec.environments.production,
    workflow: release.workflow.path,
    ref: release.workflow.branch,
    targetSha: 'b'.repeat(40),
    workflowInputHash: release.workflowInputHash,
    workflowContentHash: release.workflowContentHash,
    ...overrides,
  };
}

function mockVerifiedGitHub(): void {
  vi.spyOn(GitHubAdapter.prototype, 'verify').mockResolvedValue({
    success: true,
    login: 'davejohnson',
    scopes: ['repo', 'workflow'],
  });
}

function mockFreshManagedWorkflowPullRequest(number: number): void {
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  let branchCreated = false;
  vi.spyOn(GitHubAdapter.prototype, 'getRef').mockImplementation(async (_owner, _repo, ref) => {
    if (ref === 'heads/main') return { ref: 'refs/heads/main', object: { sha: 'base-sha' } };
    if (ref === `heads/${MANAGED_WORKFLOW_BRANCH}` && branchCreated) {
      return { ref: `refs/heads/${MANAGED_WORKFLOW_BRANCH}`, object: { sha: 'base-sha' } };
    }
    return null;
  });
  vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockResolvedValue([]);
  vi.spyOn(GitHubAdapter.prototype, 'createRef').mockImplementation(async () => {
    branchCreated = true;
  });
  vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
    number,
    html_url: `https://github.com/davejohnson/billforge/pull/${number}`,
  });
}

function configureToolMigrations(project: Project) {
  const environmentSpec = environmentSpecSchema.parse({
    ...CI_ENVIRONMENT_SPEC,
    database: { provider: 'railway', engine: 'postgres' },
    migrations: { mode: 'tool', runInDeploy: true, command: 'npm run migrate' },
  });
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    environments: { production: environmentSpec },
  });
  return environmentSpec;
}

describe('ci-deploy.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-ci-deploy-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'listRepositorySecrets').mockResolvedValue([
      'RAILWAY_API_TOKEN',
      'IMAGE_REGISTRY_USERNAME',
      'IMAGE_REGISTRY_TOKEN',
      'DATABASE_URL',
    ]);
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
      ]);
    });

    it('returns only the DigitalOcean API token', () => {
      expect(
        requiredProviderSecretNamesForGitHubActions('digitalocean')
      ).toEqual([
        'DIGITALOCEAN_TOKEN',
      ]);
    });

    it('returns no secrets for unknown providers', () => {
      expect(requiredProviderSecretNamesForGitHubActions('vercel')).toEqual([]);
    });
  });

  describe('providerSecretsForGitHubActions', () => {
    it('uses only the exact repository-scoped cloud connection ahead of global fallback', () => {
      const connectionRepo = new ConnectionRepository();
      const secretStore = getSecretStore();
      const add = (scope: string | undefined, projectId: string) => {
        const connection = connectionRepo.create({
          provider: 'cloudrun',
          scope,
          credentialsEncrypted: secretStore.encryptObject({
            credentials: `credentials-for-${projectId}`,
            projectId,
          }),
        });
        connectionRepo.updateStatus(connection.id, 'verified');
      };
      add(undefined, 'global-project');
      add('davejohnson/other-app', 'other-project');
      add('davejohnson/billforge', 'billforge-project');

      expect(providerSecretsForGitHubActions('cloudrun', {
        githubRepo: 'davejohnson/billforge',
      })).toEqual([
        { name: 'GCP_SERVICE_ACCOUNT_JSON', value: 'credentials-for-billforge-project' },
        { name: 'GCP_PROJECT_ID', value: 'billforge-project' },
      ]);
    });

    it('does not use credentials scoped to a different repository', () => {
      const connectionRepo = new ConnectionRepository();
      const secretStore = getSecretStore();
      const connection = connectionRepo.create({
        provider: 'cloudrun',
        scope: 'davejohnson/other-app',
        credentialsEncrypted: secretStore.encryptObject({
          credentials: 'other-credentials',
          projectId: 'other-project',
        }),
      });
      connectionRepo.updateStatus(connection.id, 'verified');

      expect(providerSecretsForGitHubActions('cloudrun', {
        githubRepo: 'davejohnson/billforge',
      })).toEqual([]);
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
      });
      expect(result.action?.metadata?.missingProviderSecrets).toBeUndefined();
      expect((result.action?.metadata?.workflow as { aggregateContentHash: string }).aggregateContentHash)
        .toBe(workflowFilesContentHash(workflowFiles(workflow)));
    });

    it('blocks planning before workflow or secret observation when the deploy branch is not the repository default', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const nonDefaultSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        deploy: { ...CI_ENVIRONMENT_SPEC.deploy, branch: 'release' },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: nonDefaultSpec },
      });
      const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent');

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: nonDefaultSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        verified: false,
        metadata: { workflowPublicationRequired: true },
      });
      expect(result.warnings.join('\n')).toContain(
        'deploy branch "release" must match repository default branch "main"'
      );
      expect(getFileContent).not.toHaveBeenCalled();
      expect(GitHubAdapter.prototype.listRepositorySecrets).not.toHaveBeenCalled();
    });

    it('plans managed iOS companion files before resolving environment secrets', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const { environmentSpec } = configureIosRelease(project);
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
      const listEnvironmentSecrets = vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets')
        .mockResolvedValue([]);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'create',
        metadata: {
          workflow: {
            companionPaths: [
              '.github/workflows/hypervibe-ios-release-production.yml',
            ],
          },
        },
      });
      expect(result.action?.reason).toContain('managed GitHub Actions release files');
      expect(listEnvironmentSecrets).not.toHaveBeenCalled();
      expect(JSON.stringify(result.action)).not.toContain('private-material-super-secret');
    });

    it.each([
      ['modified', '# modified iOS companion\n', 'update', 'differs from desired content'],
      ['missing', null, 'create', 'managed GitHub Actions release files are missing'],
    ] as const)('publishes when the primary workflow is unchanged but the iOS companion is %s', async (
      _case,
      companionContent,
      expectedType,
      expectedReason
    ) => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const { environmentSpec, workflow, binding } = configureIosRelease(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      const companion = workflow.companionFiles![0]!;
      const live = mockLiveWorkflowFiles(workflow);
      live.files.set(companion.path, companionContent);
      const listEnvironmentSecrets = vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets');

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: expectedType,
        verified: true,
        metadata: { workflowPublicationRequired: true },
      });
      expect(result.action?.reason).toContain(expectedReason);
      expect(live.read).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        workflow.path,
        'main'
      );
      expect(listEnvironmentSecrets).not.toHaveBeenCalled();
    });

    it.each([
      ['accepts current rendered bytes', 'rendered', 'noop', 'GitHub Actions deploy workflow is in sync'],
      ['keeps reviewed bytes pinned across renderer changes', 'pinned', 'noop', 'GitHub Actions deploy workflow is in sync with its reviewed inputs'],
      ['repairs a stale accepted-content binding', 'stale-binding', 'update', 'Record the accepted GitHub Actions workflow content contract'],
      ['replaces legacy bindings missing inputHash', 'legacy', 'update', null],
      ['replaces live byte drift', 'live-drift', 'update', null],
    ] as const)('%s', async (_name, scenario, expectedType, fixedReason) => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      const acceptedContent = scenario === 'pinned' || scenario === 'legacy'
        ? workflow.content.replace('actions/checkout@v7', 'actions/checkout@v6')
        : workflow.content;
      const binding: Partial<ReturnType<typeof syncedBinding>> = syncedBinding(project, acceptedContent);
      if (scenario === 'stale-binding') binding.contentHash = sha256('# stale accepted content');
      if (scenario === 'legacy') delete binding.inputHash;
      const liveContent = scenario === 'live-drift' ? '# stale workflow' : acceptedContent;
      acceptWorkflow(project, envRepo, environmentId, workflow, { acceptedContent, liveContent, binding });

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
        ...(scenario === 'rendered' ? { dependsOn: ['service:web'] } : {}),
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        type: expectedType,
        verified: true,
        reason: fixedReason ?? `GitHub Actions deploy workflow ${workflow.path} differs from desired content`,
      });
      if (scenario === 'rendered') {
        expect(result.action?.dependsOn).toBeUndefined();
        expect(result.action?.metadata?.staleProviderSecrets).toBeUndefined();
      }
      if (scenario === 'pinned') {
        expect(acceptedContent).not.toBe(workflow.content);
        expect(result.action?.metadata?.workflow).toMatchObject({ inputHash: expectedWorkflowInputHash(project) });
      }
      if (scenario === 'stale-binding') expect(binding.contentHash).not.toBe(sha256(acceptedContent));
      if (scenario === 'legacy') expect(result.action?.metadata?.workflowPublicationRequired).toBe(true);
      if (scenario === 'live-drift') expect(liveContent).not.toBe(acceptedContent);
    });

    it('keeps managed workflow bytes stable when only deploy-time environment values change', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const acceptedTarget = resolveBranchDeployTargets(project).targets[0]!;
      const acceptedWorkflow = expectedWorkflow(project);
      const acceptedInputHash = expectedWorkflowInputHash(project);
      acceptWorkflow(project, envRepo, environmentId, acceptedWorkflow);
      const changedEnvironmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        envVars: {
          SEED_CLIENT_TEST_DATA: 'true',
          CARE_PLAN_AI_REQUEST_TIMEOUT_MS: '30000',
        },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: changedEnvironmentSpec },
      });
      const changedTarget = resolveBranchDeployTargets(project).targets[0]!;
      expect(changedTarget.deploymentContractFingerprint)
        .not.toBe(acceptedTarget.deploymentContractFingerprint);
      expect(changedTarget.programFingerprint).toBe(acceptedTarget.programFingerprint);
      expect(expectedWorkflow(project).content).toBe(acceptedWorkflow.content);
      expect(expectedWorkflowInputHash(project)).toBe(acceptedInputHash);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: changedEnvironmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'noop',
        verified: true,
        reason: 'GitHub Actions deploy workflow is in sync',
      });
      expect(result.action?.metadata?.workflowPublicationRequired).toBeUndefined();
    });

    it('publishes a workflow update when a service start command changes', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const oldProgramFingerprint = resolveBranchDeployTargets(project).targets[0]!.programFingerprint;
      const oldWorkflow = expectedWorkflow(project);
      const oldInputHash = expectedWorkflowInputHash(project);
      acceptWorkflow(project, envRepo, environmentId, oldWorkflow);
      const changedEnvironmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        services: { web: { startCommand: 'npm run serve' } },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: changedEnvironmentSpec },
      });
      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: changedEnvironmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        verified: true,
        reason: `GitHub Actions deploy workflow inputs changed for ${oldWorkflow.path}`,
        metadata: { workflowPublicationRequired: true },
      });
      expect(resolveBranchDeployTargets(project).targets[0]!.programFingerprint)
        .not.toBe(oldProgramFingerprint);
      expect((result.action?.metadata?.workflow as { inputHash: string }).inputHash).not.toBe(oldInputHash);
    });

    it('ignores observed image URI churn in the workflow input contract', () => {
      const { project } = seedProjectWithSpec();
      const { targets, migration } = resolveBranchDeployTargets(project);
      const target = targets[0];
      const hash = (imageUri: string) => githubActionsWorkflowInputHash({
        provider: 'railway',
        target: { ...target, providerImageUris: [imageUri] },
        migration,
      });
      const firstTag = 'registry.digitalocean.com/acme-reg/davejohnson/billforge:sha-one';
      const nextTag = 'registry.digitalocean.com/acme-reg/davejohnson/billforge:sha-two';
      expect(hash(nextTag)).toBe(hash(firstTag));
    });

    it('compiles a Cloud Run workflow from converged hosting bindings', async () => {
      const projectRepo = new ProjectRepository();
      const envRepo = new EnvironmentRepository();
      const project = projectRepo.create({
        name: 'cloud-app',
        defaultPlatform: 'cloudrun',
        gitRemoteUrl: 'https://github.com/davejohnson/cloud-app',
      });
      const environmentSpec = environmentSpecSchema.parse({
        hosting: { provider: 'cloudrun', region: 'us-west1' },
        services: { web: { workloadKind: 'web' } },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
      });
      const environment = envRepo.create({
        projectId: project.id,
        name: 'staging',
        platformBindings: {
          provider: 'cloudrun',
          projectId: 'cloud-app-staging',
          providerScope: { projectId: 'gcp-project', region: 'us-west1' },
          services: {
            web: {
              serviceId: 'cloud-app-staging-web',
              workloadKind: 'web',
              resourceType: 'service',
            },
          },
        },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { staging: environmentSpec },
      });

      const converged = await planGitHubActionsDeploy({
        project: projectRepo.findById(project.id)!,
        environmentName: 'staging',
        environmentSpec,
        environment: envRepo.findById(environment.id),
      });

      expect(converged.error).toBeUndefined();
      expect(converged.action?.metadata?.workflow).toMatchObject({
        aggregateContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        requiredVariables: [],
      });
    });

    it('refuses to compile a workflow with a missing desired service binding', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      const environmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        services: {
          web: { startCommand: 'npm start' },
          worker: { workloadKind: 'worker', startCommand: 'npm run worker' },
        },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: environmentSpec },
      });

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toBeUndefined();
      expect(result.error).toContain('worker');
      expect(result.error).toContain('Reconcile hosting identities');
    });

    it('plans an update when the workflow matches but provider secrets were never synced', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: {
          deployBranch: {
            [workflow.path]: {
              contentHash: sha256(workflow.content),
              inputHash: expectedWorkflowInputHash(project),
            },
          },
        },
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
    });

    it('plans an update and reports stale secrets when a synced secret hash no longer matches', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      const binding = syncedBinding(project, workflow.content);
      binding.syncedSecretHashes.RAILWAY_API_TOKEN = sha256('rotated-old-token');
      acceptWorkflow(project, envRepo, environmentId, workflow, { binding });

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

    it('plans secret resync when a bound GitHub repository secret was deleted', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow);
      vi.mocked(GitHubAdapter.prototype.listRepositorySecrets).mockResolvedValue([
        'IMAGE_REGISTRY_USERNAME',
        'IMAGE_REGISTRY_TOKEN',
      ]);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(GitHubAdapter.prototype.listRepositorySecrets).toHaveBeenCalledWith(
        'davejohnson',
        'billforge'
      );
      expect(result.action).toMatchObject({
        type: 'update',
        verified: true,
        reason: `GitHub Actions deploy workflow ${workflow.path} exists but provider secrets need syncing`,
      });
    });

    it('fails closed when GitHub repository secret names cannot be observed', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow);
      vi.mocked(GitHubAdapter.prototype.listRepositorySecrets)
        .mockRejectedValue(new Error('secret inventory unavailable'));

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        verified: false,
      });
      expect(result.action?.metadata?.workflowPublicationRequired).toBeUndefined();
      expect(result.warnings).toEqual([
        'Cannot observe GitHub repository secret names for davejohnson/billforge: secret inventory unavailable',
      ]);

      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: result.action!,
        authority: 'secret-sync',
      });
      expect(applied).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed secret action is stale',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
    });

    it('blocks every secret write when a required repository secret appears after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow);
      vi.mocked(GitHubAdapter.prototype.listRepositorySecrets)
        .mockResolvedValueOnce(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'])
        .mockResolvedValue([
          'RAILWAY_API_TOKEN',
          'IMAGE_REGISTRY_USERNAME',
          'IMAGE_REGISTRY_TOKEN',
        ]);
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });

      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(applied).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed secret action is stale',
        error: expect.stringContaining('repository secret inventory changed'),
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
    });

    it('blocks every secret write when repository secret inventory becomes unavailable after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow);
      vi.mocked(GitHubAdapter.prototype.listRepositorySecrets)
        .mockResolvedValueOnce(['IMAGE_REGISTRY_USERNAME', 'IMAGE_REGISTRY_TOKEN'])
        .mockRejectedValueOnce(new Error('repository inventory unavailable'));
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });

      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret');
      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(applied).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Cannot observe GitHub repository secrets before sync',
        error: 'repository inventory unavailable',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(setEnvironmentSecret).not.toHaveBeenCalled();
    });

    it('plans managed database secret sync when tool migrations have no external database URL', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const migrationEnvironmentSpec = configureToolMigrations(project);
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow);

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: migrationEnvironmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.action).toMatchObject({
        type: 'update',
        reason: `GitHub Actions deploy workflow ${workflow.path} exists but managed database secrets need syncing`,
        metadata: { missingDatabaseSecrets: ['DATABASE_URL'] },
      });
      expect(result.action?.metadata?.missingProviderSecrets).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('cannot sync its managed database secret');
      expect(result.warnings[0]).not.toContain('Connect and verify railway');
    });

    it('detects a rotated managed database URL by its stored secret hash', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const migrationEnvironmentSpec = configureToolMigrations(project);
      const oldUrl = 'postgresql://app:old@db.example.test:5432/app';
      const newUrl = 'postgresql://app:new@db.example.test:5432/app';
      new ComponentRepository().create({
        environmentId,
        type: 'postgres',
        bindings: { provider: 'railway', connectionUrl: newUrl },
      });
      const workflow = expectedWorkflow(project);
      acceptWorkflow(project, envRepo, environmentId, workflow, {
        binding: syncedBinding(project, workflow.content, { DATABASE_URL: oldUrl }),
      });

      const result = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: migrationEnvironmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        type: 'update',
        reason: `GitHub Actions deploy workflow ${workflow.path} exists but managed database secrets need syncing`,
        metadata: { staleDatabaseSecrets: ['DATABASE_URL'] },
      });
      expect(result.action?.metadata?.staleProviderSecrets).toBeUndefined();
    });

    it('falls back to the stored ci binding when no GitHub connection is available', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections({ github: false });
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(project, workflow.content) } },
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
        type: 'update',
        verified: false,
        reason: `Cannot verify the live GitHub Actions deploy workflow ${workflow.path}`,
        metadata: { workflowPublicationRequired: true },
      });
      expect(result.action?.metadata?.missingProviderSecrets).toBeUndefined();
      expect(result.warnings).toEqual([
        expect.stringContaining('Cannot observe GitHub Actions workflow for davejohnson/billforge'),
      ]);
    });

  });

  describe('applyGitHubActionsDeploy', () => {
    it.each(['inputHash', 'aggregateContentHash'] as const)(
      'rejects a stale reviewed workflow %s before repository mutation',
      async (field) => {
        const { project } = seedProjectWithSpec();
        seedVerifiedConnections();
        const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
        const action = reviewedDeployAction(project, environmentSpec, false);
        (action.metadata!.workflow as Record<string, unknown>)[field] = 'stale-reviewed-hash';
        mockVerifiedGitHub();
        const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent');
        const updateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
        const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');

        const result = await applyGitHubActionsDeploy({
          project,
          environmentName: 'production',
          environmentSpec,
          action,
          authority: 'secret-sync',
        });

        expect(result).toMatchObject({
          success: false,
          status: 'blocked',
          message: 'GitHub Actions deploy action is stale',
        });
        expect(getFileContent).not.toHaveBeenCalled();
        expect(updateFile).not.toHaveBeenCalled();
        expect(setRepositorySecret).not.toHaveBeenCalled();
      }
    );

    it('blocks a non-default deploy branch before repository mutation', async () => {
      const { project } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        deploy: { ...CI_ENVIRONMENT_SPEC.deploy, branch: 'release' },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: environmentSpec },
      });
      mockVerifiedGitHub();
      const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent');
      const updateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const createPullRequest = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest');

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: reviewedDeployAction(project, environmentSpec, true),
        authority: 'publication-only',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: expect.stringContaining('Cannot verify GitHub Actions deploy workflow'),
        error: expect.stringContaining('deploy branch "release" must match repository default branch "main"'),
      });
      expect(getFileContent).not.toHaveBeenCalled();
      expect(updateFile).not.toHaveBeenCalled();
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('publishes through an isolated workflow PR before doing secret or database work', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = configureToolMigrations(project);
      new ComponentRepository().create({
        environmentId,
        type: 'postgres',
        externalId: 'rail-database',
        bindings: { provider: 'railway', projectId: 'rail-project' },
      });
      const getDatabaseVariables = vi.spyOn(RailwayAdapter.prototype, 'getServiceVariables')
        .mockResolvedValue({ DATABASE_PUBLIC_URL: 'postgresql://app:pw@db.example.test:5432/app' });
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
      vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
      vi.spyOn(GitHubAdapter.prototype, 'getRef')
        .mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'base-sha' } })
        .mockResolvedValueOnce({ ref: `refs/heads/${MANAGED_WORKFLOW_BRANCH}`, object: { sha: 'base-sha' } });
      vi.spyOn(GitHubAdapter.prototype, 'listPullRequests').mockImplementation(
        async (_owner, _repo, options) => options?.head === 'davejohnson:hypervibe/github-infrastructure'
          ? [{
              number: 99,
              html_url: 'https://github.com/davejohnson/billforge/pull/99',
              title: '[Hypervibe] Sync GitHub infrastructure',
              body: 'Hypervibe generated this pull request from unrelated desired state.',
              state: 'open',
              merged_at: null,
              head: { ref: 'hypervibe/github-infrastructure', sha: 'base-sha' },
              base: { ref: 'main', sha: 'base-sha' },
            }]
          : []
      );
      vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
        .mockResolvedValue({ created: false, updated: true });
      vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
      const createPullRequest = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest').mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/davejohnson/billforge/pull/42',
      });

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: reviewedDeployAction(project, environmentSpec, true),
        authority: 'publication-only',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'pending',
        data: { pullRequestNumber: 42 },
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(getDatabaseVariables).not.toHaveBeenCalled();
      expect(envRepo.findById(environmentId)?.platformBindings.ci).toBeUndefined();
      expect(createPullRequest).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        expect.objectContaining({ head: MANAGED_WORKFLOW_BRANCH })
      );
    });

    it('blocks workflow publication when the repository default branch changes after planning', async () => {
      const { project } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(null);
      vi.mocked(GitHubAdapter.prototype.getRepository)
        .mockResolvedValueOnce({ default_branch: 'main' })
        .mockResolvedValueOnce({ default_branch: 'trunk' });
      const getRef = vi.spyOn(GitHubAdapter.prototype, 'getRef');
      const createRef = vi.spyOn(GitHubAdapter.prototype, 'createRef');
      const updateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
      const createPullRequest = vi.spyOn(GitHubAdapter.prototype, 'createPullRequest');
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: reviewedDeployAction(project, environmentSpec, true),
        authority: 'publication-only',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub default branch changed before workflow publication',
        error: expect.stringContaining('Reviewed target branch main is no longer the repository default branch trunk'),
      });
      expect(getRef).not.toHaveBeenCalled();
      expect(createRef).not.toHaveBeenCalled();
      expect(updateFile).not.toHaveBeenCalled();
      expect(createPullRequest).not.toHaveBeenCalled();
      expect(setRepositorySecret).not.toHaveBeenCalled();
    });

    it('syncs secrets only after the reviewed workflow is present on the default branch', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      const workflow = expectedWorkflow(project);
      const acceptedContent = workflow.content.replace('actions/checkout@v7', 'actions/checkout@v6');
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(project, acceptedContent) } },
      });
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(acceptedContent);
      const createOrUpdateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile');
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: reviewedDeployAction(project, environmentSpec, false),
        authority: 'secret-sync',
      });

      expect(result.success).toBe(true);
      expect(createOrUpdateFile).not.toHaveBeenCalled();
      expect(setRepositorySecret).toHaveBeenCalledTimes(3);
      const binding = (
        envRepo.findById(environmentId)?.platformBindings.ci as {
          deployBranch: Record<string, { contentHash: string; inputHash: string }>;
        }
      ).deployBranch[workflow.path];
      expect(binding).toMatchObject({
        contentHash: sha256(acceptedContent),
        inputHash: expectedWorkflowInputHash(project),
      });
    });

    it('blocks a reviewed secret sync when the iOS companion drifts before apply', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const { environmentSpec, workflow, binding } = configureIosRelease(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      const live = mockLiveWorkflowFiles(workflow);
      vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue([
        ...MATCH_SIGNING_REQUIRED_SECRETS,
        ...IOS_RELEASE_REQUIRED_SECRETS,
      ]);
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });
      expect(plan.action?.metadata?.workflowPublicationRequired).toBeUndefined();

      live.files.set(workflow.companionFiles![0]!.path, '# changed after hv_plan\n');
      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret')
        .mockResolvedValue();
      const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret')
        .mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions secret sync action is stale',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(setEnvironmentSecret).not.toHaveBeenCalled();
    });

    it('blocks every secret write when App Store credentials rotate after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const {
        appStoreConnectionId,
        environmentSpec,
        workflow,
        binding,
      } = configureIosRelease(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      mockLiveWorkflowFiles(workflow);
      vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue([
        ...MATCH_SIGNING_REQUIRED_SECRETS,
        ...IOS_RELEASE_REQUIRED_SECRETS,
      ]);
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });
      expect(plan.action?.metadata?.workflowPublicationRequired).toBeUndefined();

      const connections = new ConnectionRepository();
      connections.updateCredentials(
        appStoreConnectionId,
        getSecretStore().encryptObject({
          ...APP_STORE_CREDENTIALS,
          keyId: 'KEY2',
          privateKey: 'rotated-private-material',
        })
      );
      connections.updateStatus(appStoreConnectionId, 'verified');
      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret')
        .mockResolvedValue();
      const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret')
        .mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed secret action is stale',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(setEnvironmentSecret).not.toHaveBeenCalled();
    });

    it('blocks every secret write when a managed environment secret appears after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const { environmentSpec, workflow, binding } = configureIosRelease(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      mockLiveWorkflowFiles(workflow);
      vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets')
        .mockResolvedValueOnce([
          ...MATCH_SIGNING_REQUIRED_SECRETS,
          'APP_STORE_CONNECT_ISSUER_ID',
          'APP_STORE_CONNECT_PRIVATE_KEY',
        ])
        .mockResolvedValue([
          ...MATCH_SIGNING_REQUIRED_SECRETS,
          ...IOS_RELEASE_REQUIRED_SECRETS,
        ]);
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });

      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret');
      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(applied).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed secret action is stale',
        error: expect.stringContaining('environment secret inventory changed'),
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(setEnvironmentSecret).not.toHaveBeenCalled();
    });

    it('blocks every secret write when environment secret inventory becomes unavailable after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const { environmentSpec, workflow, binding } = configureIosRelease(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      mockLiveWorkflowFiles(workflow);
      vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets')
        .mockResolvedValueOnce([
          ...MATCH_SIGNING_REQUIRED_SECRETS,
          'APP_STORE_CONNECT_ISSUER_ID',
          'APP_STORE_CONNECT_PRIVATE_KEY',
        ])
        .mockRejectedValueOnce(new Error('environment inventory unavailable'));
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update', verified: true });

      mockVerifiedGitHub();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret');
      const setEnvironmentSecret = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentSecret');
      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(applied).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Cannot observe GitHub environment secrets for production',
        error: 'environment inventory unavailable',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(setEnvironmentSecret).not.toHaveBeenCalled();
    });

    it('drops deletion authority after a retired managed workflow is confirmed absent', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      const workflow = expectedWorkflow(project);
      const retiredPath = '.github/workflows/deploy-railway-production-v1.yml';
      const legacyBinding: Partial<ReturnType<typeof syncedBinding>> = syncedBinding(
        project,
        workflow.content
      );
      delete legacyBinding.inputHash;
      legacyBinding.managedPaths = [workflow.path, retiredPath];
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: legacyBinding } },
      });
      mockVerifiedGitHub();
      const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
        .mockImplementation(async (_owner, _repo, path) => (
          path === workflow.path ? workflow.content : null
        ));

      const adoptionPlan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(adoptionPlan.action).toMatchObject({
        type: 'update',
        verified: true,
        reason: 'Record the reviewed GitHub Actions workflow input contract without replacing its accepted files',
      });
      expect(adoptionPlan.action?.metadata?.workflowPublicationRequired).toBeUndefined();
      expect(getFileContent).toHaveBeenCalledWith('davejohnson', 'billforge', retiredPath, 'main');
      vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const applied = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: adoptionPlan.action!,
        authority: 'secret-sync',
      });

      expect(applied.success).toBe(true);
      const deployBindings = (
        envRepo.findById(environmentId)?.platformBindings.ci as {
          deployBranch: Record<string, { managedPaths: string[] }>;
        }
      ).deployBranch;
      expect(Object.keys(deployBindings)).toEqual([workflow.path]);
      expect(deployBindings[workflow.path]?.managedPaths).toEqual([workflow.path]);

      getFileContent.mockClear();
      getFileContent.mockImplementation(async (_owner, _repo, path) => (
        path === workflow.path
          ? workflow.content
          : path === retiredPath
            ? '# user recreated this workflow'
            : null
      ));
      const nextPlan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(nextPlan.action).toMatchObject({ type: 'noop' });
      expect(getFileContent).not.toHaveBeenCalledWith('davejohnson', 'billforge', retiredPath, 'main');
      expect(nextPlan.action?.metadata?.workflow).not.toHaveProperty('retiredPaths');
    });

    it('blocks every secret write when a reviewed provider credential rotates after planning', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      const workflow = expectedWorkflow(project);
      const binding = syncedBinding(project, workflow.content);
      binding.syncedSecretHashes.RAILWAY_API_TOKEN = sha256('previous-railway-token');
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({ type: 'update' });

      const railway = new ConnectionRepository().findByProvider('railway')!;
      new ConnectionRepository().updateCredentials(
        railway.id,
        getSecretStore().encryptObject({ apiToken: 'rotated-railway-token' })
      );
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'secret-sync',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'GitHub Actions managed secret action is stale',
      });
      expect(setRepositorySecret).not.toHaveBeenCalled();
    });

    it('blocks before any secret write when a reviewed migration workflow has no database URL', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const migrationEnvironmentSpec = configureToolMigrations(project);
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(project, workflow.content) } },
      });
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: migrationEnvironmentSpec,
        action: reviewedDeployAction(project, migrationEnvironmentSpec, false),
        authority: 'secret-sync',
      });

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        data: { syncedSecrets: [], missingDatabaseSecrets: ['DATABASE_URL'] },
      });
      expect(result.error).toContain('Missing managed database secret: DATABASE_URL.');
      expect(result.error).not.toContain('Connect and verify railway');
      expect(setRepositorySecret).not.toHaveBeenCalled();
      expect(
        (envRepo.findById(environmentId)?.platformBindings.ci as {
          deployBranch: Record<string, { syncedSecrets: string[] }>;
        }).deployBranch[workflow.path].syncedSecrets
      ).not.toContain('DATABASE_URL');
    });

    it('syncs and records the exact hash after a managed database URL rotates', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const migrationEnvironmentSpec = configureToolMigrations(project);
      const oldUrl = 'postgresql://app:old@db.example.test:5432/app';
      const newUrl = 'postgresql://app:new@db.example.test:5432/app';
      new ComponentRepository().create({
        environmentId,
        type: 'postgres',
        bindings: { provider: 'railway', connectionUrl: newUrl },
      });
      const workflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: syncedBinding(project, workflow.content, { DATABASE_URL: oldUrl }) } },
      });
      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(workflow.content);
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: migrationEnvironmentSpec,
        action: reviewedDeployAction(project, migrationEnvironmentSpec, false, { DATABASE_URL: newUrl }),
        authority: 'secret-sync',
      });

      expect(result.success).toBe(true);
      expect(setRepositorySecret).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        'DATABASE_URL',
        newUrl
      );
      const binding = (
        envRepo.findById(environmentId)?.platformBindings.ci as {
          deployBranch: Record<string, { syncedSecrets: string[]; syncedSecretHashes: Record<string, string> }>;
        }
      ).deployBranch[workflow.path];
      expect(binding.syncedSecrets).toContain('DATABASE_URL');
      expect(binding.syncedSecretHashes.DATABASE_URL).toBe(sha256(newUrl));
      expect(binding.syncedSecretHashes.DATABASE_URL).not.toBe(sha256(oldUrl));
    });

    it('proposes the latest renderer output when a reviewed workflow input changes', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const oldWorkflow = expectedWorkflow(project);
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [oldWorkflow.path]: syncedBinding(project, oldWorkflow.content) } },
      });
      const changedEnvironmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        services: { web: { startCommand: 'npm run serve' } },
      });
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: changedEnvironmentSpec },
      });
      const latestWorkflow = expectedWorkflow(project);
      expect(latestWorkflow.content).not.toBe(oldWorkflow.content);

      mockVerifiedGitHub();
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(oldWorkflow.content);
      mockFreshManagedWorkflowPullRequest(42);
      vi.spyOn(GitHubAdapter.prototype, 'getFile').mockResolvedValue(null);
      const createOrUpdateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
        .mockResolvedValue({ created: true, updated: false });

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec: changedEnvironmentSpec,
        action: reviewedDeployAction(project, changedEnvironmentSpec, true),
        authority: 'publication-only',
      });

      expect(result).toMatchObject({ success: false, status: 'pending' });
      expect(createOrUpdateFile).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        latestWorkflow.path,
        latestWorkflow.content,
        expect.any(String),
        MANAGED_WORKFLOW_BRANCH
      );
    });

    it.each([
      ['recorded path', 'recorded'],
      ['legacy iOS credentials', 'legacy'],
    ] as const)('deletes a previously bound iOS companion workflow with %s when iOS release is disabled', async (
      _case,
      bindingKind
    ) => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const iosEnvironmentSpec = IOS_ENVIRONMENT_SPEC;
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: iosEnvironmentSpec },
      });
      const oldTargets = resolveBranchDeployTargets(project);
      const oldTarget = oldTargets.targets[0]!;
      const oldWorkflow = buildBranchDeployWorkflow(
        'railway',
        oldTarget,
        oldTargets.migration,
        iosEnvironmentSpec.ios
      );
      const oldFiles = workflowFiles(oldWorkflow);
      const retiredPath = oldWorkflow.companionFiles![0]!.path;
      envRepo.updatePlatformBindings(environmentId, {
        ci: {
          deployBranch: {
            [oldWorkflow.path]: {
              contentHash: workflowFilesContentHash(oldFiles),
              inputHash: githubActionsWorkflowInputHash({
                provider: 'railway',
                target: oldTarget,
                migration: oldTargets.migration,
                ios: iosEnvironmentSpec.ios,
              }),
              ...(bindingKind === 'recorded'
                ? { managedPaths: oldFiles.map((file) => file.path) }
                : { syncedEnvironmentSecrets: [...IOS_RELEASE_REQUIRED_SECRETS] }),
            },
          },
        },
      });

      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      new SpecStore().replace(project, {
        version: 1,
        project: project.name,
        environments: { production: environmentSpec },
      });
      const currentWorkflow = expectedWorkflow(project);
      const currentFiles = new Map(workflowFiles(currentWorkflow).map((file) => [file.path, file.content]));
      const retiredContent = oldWorkflow.companionFiles![0]!.content;
      vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(
        async (_owner, _repo, path) => path === retiredPath ? retiredContent : currentFiles.get(path) ?? null
      );
      mockVerifiedGitHub();

      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });
      expect(plan.action).toMatchObject({
        type: 'update',
        reason: 'Retired managed GitHub Actions workflow files must be removed for production',
        metadata: {
          workflowPublicationRequired: true,
          workflow: { retiredPaths: [retiredPath] },
        },
      });

      mockFreshManagedWorkflowPullRequest(43);
      vi.spyOn(GitHubAdapter.prototype, 'getFile').mockImplementation(
        async (_owner, _repo, path) => path === retiredPath
          ? { content: retiredContent, sha: 'retired-ios-sha' }
          : currentFiles.has(path)
            ? { content: currentFiles.get(path)!, sha: 'current-workflow-sha' }
            : null
      );
      const updateFile = vi.spyOn(GitHubAdapter.prototype, 'createOrUpdateFile')
        .mockResolvedValue({ created: false, updated: false });
      const deleteFile = vi.spyOn(GitHubAdapter.prototype, 'deleteFile').mockResolvedValue();
      const setRepositorySecret = vi.spyOn(GitHubAdapter.prototype, 'setRepositorySecret').mockResolvedValue();

      const result = await applyGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        action: plan.action!,
        authority: 'publication-only',
      });

      expect(result).toMatchObject({ success: false, status: 'pending' });
      expect(updateFile).not.toHaveBeenCalled();
      expect(deleteFile).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        retiredPath,
        'retired-ios-sha',
        expect.any(String),
        MANAGED_WORKFLOW_BRANCH
      );
      expect(setRepositorySecret).not.toHaveBeenCalled();
    });

    it('leaves a same-named iOS workflow alone when a legacy binding has no ownership evidence', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const environmentSpec = environmentSpecSchema.parse(CI_ENVIRONMENT_SPEC);
      const workflow = expectedWorkflow(project);
      const binding: Partial<ReturnType<typeof syncedBinding>> = syncedBinding(project, workflow.content);
      delete binding.managedPaths;
      envRepo.updatePlatformBindings(environmentId, {
        ci: { deployBranch: { [workflow.path]: binding } },
      });
      mockVerifiedGitHub();
      const userWorkflowPath = '.github/workflows/hypervibe-ios-release-production.yml';
      const getFileContent = vi.spyOn(GitHubAdapter.prototype, 'getFileContent')
        .mockImplementation(async (_owner, _repo, path) => (
          path === userWorkflowPath ? '# user-owned workflow' : workflow.content
        ));

      const plan = await planGitHubActionsDeploy({
        project,
        environmentName: 'production',
        environmentSpec,
        environment: envRepo.findById(environmentId),
      });

      expect(plan.action).toMatchObject({
        type: 'noop',
        reason: 'GitHub Actions deploy workflow is in sync',
      });
      expect(getFileContent).not.toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        userWorkflowPath,
        'main'
      );
    });
  });

  describe('applied deployment contract hash', () => {
    it('plans the final hash update when GitHub has not recorded the desired state', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
      const spec = new SpecStore().get(project)!.spec;
      const desiredHash = environmentDeploymentContractHash(spec, 'production');

      const result = await planGitHubActionsAppliedSpecHash({
        project,
        spec,
        environmentName: 'production',
        environmentSpec: spec.environments.production,
        environment: envRepo.findById(environmentId),
        dependsOn: ['service:web', 'ci:github-actions:production:deploy-branch'],
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        id: 'ci:github-actions:production:applied-spec-hash',
        type: 'update',
        resource: { kind: 'ci', name: 'applied-spec-hash:production', provider: 'github' },
        dependsOn: ['service:web', 'ci:github-actions:production:deploy-branch'],
        metadata: {
          operation: 'githubActionsAppliedSpecHash',
          repository: 'davejohnson/billforge',
          environmentName: 'production',
          variableName: 'HYPERVIBE_APPLIED_SPEC_HASH',
          desiredHash,
        },
      });
    });

    it('plans a noop when the environment-scoped variable matches', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const spec = new SpecStore().get(project)!.spec;
      const desiredHash = environmentDeploymentContractHash(spec, 'production');
      vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue({
        name: 'HYPERVIBE_APPLIED_SPEC_HASH',
        value: desiredHash,
      });

      const result = await planGitHubActionsAppliedSpecHash({
        project,
        spec,
        environmentName: 'production',
        environmentSpec: spec.environments.production,
        environment: envRepo.findById(environmentId),
        dependsOn: ['service:web'],
      });

      expect(result.action).toMatchObject({
        type: 'noop',
        verified: true,
        reason: 'GitHub Actions deployment contract is reconciled',
      });
      expect(result.action?.dependsOn).toBeUndefined();
    });

    it('sets the environment variable and records only non-secret hash metadata', async () => {
      const { project, envRepo, environmentId } = seedProjectWithSpec();
      seedVerifiedConnections();
      const spec = new SpecStore().get(project)!.spec;
      const desiredHash = environmentDeploymentContractHash(spec, 'production');
      mockVerifiedGitHub();
      const setVariable = vi.spyOn(GitHubAdapter.prototype, 'setEnvironmentVariable').mockResolvedValue();

      const result = await applyGitHubActionsAppliedSpecHash({
        project,
        environmentName: 'production',
        desiredHash,
      });

      expect(result.success).toBe(true);
      expect(setVariable).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        'production',
        'HYPERVIBE_APPLIED_SPEC_HASH',
        desiredHash
      );
      expect(envRepo.findById(environmentId)?.platformBindings).toMatchObject({
        ci: {
          appliedSpecHash: {
            hash: desiredHash,
            variableName: 'HYPERVIBE_APPLIED_SPEC_HASH',
          },
        },
      });
    });
  });

  describe('database seed release barrier', () => {
    it('plans an exact-SHA release after its reviewed prerequisites', async () => {
      const release = seedAcceptedRelease();
      vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
        ref: 'refs/heads/main',
        object: { sha: 'a'.repeat(40) },
      });
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
        total_count: 0,
        workflow_runs: [],
      });

      const result = await planGitHubActionsRelease({
        project: release.project,
        environmentName: 'production',
        environmentSpec: release.spec.environments.production,
        dependsOn: ['ci:github-actions:production:applied-spec-hash'],
      });

      expect(result.warnings).toEqual([]);
      expect(result.action).toMatchObject({
        id: 'ci:github-actions:production:release',
        type: 'update',
        verified: true,
        dependsOn: ['ci:github-actions:production:applied-spec-hash'],
        metadata: {
          operation: 'githubActionsRelease',
          repository: 'davejohnson/billforge',
          ref: 'main',
          targetSha: 'a'.repeat(40),
          workflowInputHash: release.workflowInputHash,
          workflowContentHash: release.workflowContentHash,
          forceRelease: true,
        },
      });
    });

    it('blocks release planning when the deploy branch is not the repository default', async () => {
      const release = seedAcceptedRelease({
        environmentSpec: environmentSpecSchema.parse({
          ...CI_ENVIRONMENT_SPEC,
          deploy: { ...CI_ENVIRONMENT_SPEC.deploy, branch: 'release' },
        }),
      });
      const getRef = vi.spyOn(GitHubAdapter.prototype, 'getRef');
      vi.mocked(GitHubAdapter.prototype.getRepository).mockResolvedValue({ default_branch: 'main' });

      const result = await planGitHubActionsRelease({
        project: release.project,
        environmentName: 'production',
        environmentSpec: release.spec.environments.production,
      });

      expect(result.action).toMatchObject({
        type: 'update',
        verified: false,
        metadata: {
          ref: 'release',
          blockedReason: 'github_release_observation_unknown',
        },
      });
      expect(result.warnings.join('\n')).toContain(
        'deploy branch "release" must match repository default branch "main"'
      );
      expect(GitHubAdapter.prototype.getFileContent).not.toHaveBeenCalled();
      expect(getRef).not.toHaveBeenCalled();
    });

    it('ignores release evidence from the pre-v4 artifact namespace', async () => {
      const release = seedAcceptedRelease();
      const sha = 'a'.repeat(40);
      vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
        ref: 'refs/heads/main',
        object: { sha },
      });
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
        total_count: 1,
        workflow_runs: [{
          id: 41,
          name: 'Deploy Railway (production)',
          display_title: `Deploy production ${sha}`,
          status: 'completed',
          conclusion: 'success',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          head_sha: sha,
          head_branch: 'main',
          event: 'workflow_dispatch',
          html_url: 'https://github.com/davejohnson/billforge/actions/runs/41',
        }],
      });
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({
        total_count: 1,
        artifacts: [{
          id: 98,
          name: `hypervibe-server-release-production-${sha}`,
          expired: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          workflow_run: { id: 41 } as never,
        }],
      });

      const result = await planGitHubActionsRelease({
        project: release.project,
        environmentName: 'production',
        environmentSpec: release.spec.environments.production,
      });

      expect(result.action).toMatchObject({
        type: 'update',
        reason: `Deploy and verify exact commit ${sha} before database seeding`,
      });
    });

    it('dispatches the exact commit and waits for verified release evidence', async () => {
      const release = seedAcceptedRelease();
      const sha = 'b'.repeat(40);
      const run = {
        id: 42,
        name: 'Deploy Railway (production)',
        display_title: `Deploy production ${sha}`,
        status: 'completed',
        conclusion: 'success',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        head_sha: sha,
        head_branch: 'main',
        event: 'workflow_dispatch',
        html_url: 'https://github.com/davejohnson/billforge/actions/runs/42',
      };
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns')
        .mockResolvedValueOnce({ total_count: 0, workflow_runs: [] })
        .mockResolvedValueOnce({ total_count: 1, workflow_runs: [run] });
      vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
        ref: 'refs/heads/main',
        object: { sha },
      });
      const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({
        total_count: 1,
        artifacts: [{
          id: 99,
          name: `hypervibe-server-release-v4-production-${sha}`,
          expired: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          workflow_run: {
            id: 42,
            repository_id: 1,
            head_repository_id: 1,
            head_branch: 'main',
            head_sha: sha,
          },
        }],
      });

      const result = await applyGitHubActionsRelease(reviewedReleaseParams(release, {
        forceRelease: true,
        pollIntervalMs: 0,
      }));

      expect(result).toMatchObject({
        success: true,
        data: { targetSha: sha, runId: 42, artifactId: 99 },
      });
      expect(trigger).toHaveBeenCalledWith(
        'davejohnson',
        'billforge',
        '.github/workflows/deploy-railway-production.yml',
        'main',
        { commit_sha: sha }
      );
    });

    it('blocks direct release apply when the deploy branch is not the repository default', async () => {
      const environmentSpec = environmentSpecSchema.parse({
        ...CI_ENVIRONMENT_SPEC,
        deploy: { ...CI_ENVIRONMENT_SPEC.deploy, branch: 'release' },
      });
      const release = seedAcceptedRelease({ environmentSpec });
      const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow');
      const listRuns = vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns');

      const result = await applyGitHubActionsRelease(reviewedReleaseParams(release));

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Managed release workflow could not be verified',
        error: expect.stringContaining('deploy branch "release" must match repository default branch "main"'),
      });
      expect(GitHubAdapter.prototype.getFileContent).not.toHaveBeenCalled();
      expect(listRuns).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    it('blocks release dispatch when the reviewed branch advances immediately before dispatch', async () => {
      const release = seedAcceptedRelease();
      const reviewedSha = 'b'.repeat(40);
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
        total_count: 0,
        workflow_runs: [],
      });
      vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
        ref: 'refs/heads/main',
        object: { sha: 'c'.repeat(40) },
      });
      const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

      const result = await applyGitHubActionsRelease(reviewedReleaseParams(release, {
        targetSha: reviewedSha,
        forceRelease: true,
      }));

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Managed release branch changed after planning',
      });
      expect(trigger).not.toHaveBeenCalled();
    });

    it('blocks release dispatch when the repository default branch changes immediately before dispatch', async () => {
      const release = seedAcceptedRelease();
      const reviewedSha = 'b'.repeat(40);
      vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({
        total_count: 0,
        workflow_runs: [],
      });
      vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({
        ref: 'refs/heads/main',
        object: { sha: reviewedSha },
      });
      vi.mocked(GitHubAdapter.prototype.getRepository)
        .mockResolvedValueOnce({ default_branch: 'main' })
        .mockResolvedValueOnce({ default_branch: 'trunk' });
      const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

      const result = await applyGitHubActionsRelease(reviewedReleaseParams(release, {
        targetSha: reviewedSha,
        forceRelease: true,
      }));

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Managed release default branch changed after planning',
      });
      expect(trigger).not.toHaveBeenCalled();
    });

    it('blocks release dispatch when accepted workflow bytes change after planning', async () => {
      const release = seedAcceptedRelease({
        liveContent: (workflow) => `${workflow.content}\n# changed after hv_plan\n`,
      });
      const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();

      const result = await applyGitHubActionsRelease(reviewedReleaseParams(release));

      expect(result).toMatchObject({
        success: false,
        status: 'blocked',
        message: 'Managed release workflow changed after planning',
      });
      expect(trigger).not.toHaveBeenCalled();
    });
  });
});
