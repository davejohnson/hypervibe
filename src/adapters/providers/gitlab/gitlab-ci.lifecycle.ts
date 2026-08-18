import { createHash } from 'crypto';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import {
  buildRailwayDeployRuntime,
  buildRailwayGitLabImageRuntime,
  gitLabShellLiteral,
  RAILWAY_BUILD_RUNTIME_PATH,
  RAILWAY_DEPLOY_RUNTIME_PATH,
} from '../railway/railway-ci.recipe.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';
import type { CodeChangeRequest, CodeRepositoryIdentity } from '../../../domain/ports/devops.port.js';
import type { CiApplyResult, CiLifecyclePort, CiLifecycleResult } from '../../../domain/registry/devops.registry.js';
import type { EnvironmentSpec, ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { environmentDeploymentContractHashForApply } from '../../../domain/services/deployment-contract.service.js';
import type { BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import { resolveReviewedBranchDeployTargets } from '../../../domain/services/managed-ci-targets.js';
import { effectiveProjectRuntime } from '../../../domain/spec/project-runtime.js';
import { normalizeGitRemoteIdentity } from '../../../lib/git-remote.js';
import {
  CI_APPLIED_SPEC_SYNC_OPERATION,
  CI_CONFIGURATION_SYNC_OPERATION,
  CI_VARIABLE_SYNC_OPERATION,
} from '../../../domain/services/managed-ci.contract.js';
import {
  GitLabAdapter,
  type GitLabCredentials,
  type GitLabProject,
} from './gitlab.adapter.js';

const ROOT_MARKER = '# hypervibe-managed: gitlab-ci/v1';
const MANIFEST_PATH = '.gitlab/hypervibe/manifest.yml';
const PROGRAM_VERSION = 1;
const GITLAB_SAAS_RUNNER_TAG = 'saas-linux-small-amd64';

type ManagedFile = { path: string; content: string; hash: string };
type DesiredVariable = {
  key: string;
  value: string;
  environmentScope: string;
  protected: boolean;
  masked: boolean;
  hidden: boolean;
  raw: boolean;
  source: string;
};

type GitLabVariableKeys = {
  appliedSpecHash: string;
  railwayApiToken: string;
  imageRegistryToken: string;
  imageRegistryUsername: string;
  railwayEnvironmentId: string;
  railwayServiceIds: string;
};

type GitLabContext = {
  adapter: GitLabAdapter;
  credentials: GitLabCredentials;
  repository: CodeRepositoryIdentity;
  project: GitLabProject;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gitLabVariableKeys(spec: ProjectSpec, environmentName: string): GitLabVariableKeys {
  const namespace = sha256(`${spec.devops?.code.scope ?? ''}\0${environmentName}`)
    .slice(0, 16)
    .toUpperCase();
  const key = (suffix: string) => `HYPERVIBE_${namespace}_${suffix}`;
  return {
    appliedSpecHash: key('APPLIED_SPEC_HASH'),
    railwayApiToken: key('RAILWAY_API_TOKEN'),
    imageRegistryToken: key('IMAGE_REGISTRY_TOKEN'),
    imageRegistryUsername: key('IMAGE_REGISTRY_USERNAME'),
    railwayEnvironmentId: key('RAILWAY_ENVIRONMENT_ID'),
    railwayServiceIds: key('RAILWAY_SERVICE_IDS'),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function gitLabCiBinding(projectId: string, environmentName: string): Record<string, unknown> | null {
  const environment = new EnvironmentRepository().findByProjectAndName(projectId, environmentName);
  const ci = asRecord(environment?.platformBindings.ci);
  return asRecord(ci?.gitlabCi);
}

function bindingMatchesRepository(binding: Record<string, unknown> | null, context: GitLabContext): boolean {
  return binding?.repositoryId === context.repository.nativeId
    && binding.instanceScope === context.repository.instanceScope
    && binding.repositoryScope === context.repository.canonicalScope;
}

function configurationOwnershipMatches(
  binding: Record<string, unknown> | null,
  context: GitLabContext,
  programHash: string
): boolean {
  if (!bindingMatchesRepository(binding, context)) return false;
  const active = asRecord(binding?.configurationActive);
  const proposal = asRecord(binding?.configurationProposal);
  return active?.programHash === programHash || proposal?.programHash === programHash;
}

async function proveMergedConfigurationOwnership(
  binding: Record<string, unknown> | null,
  context: GitLabContext,
  programHash: string
): Promise<string | null> {
  if (!bindingMatchesRepository(binding, context)) {
    return 'The GitLab CI repository ownership binding is missing or stale';
  }
  const active = asRecord(binding?.configurationActive);
  if (active?.programHash === programHash) return null;
  const proposal = asRecord(binding?.configurationProposal);
  const sourceBranch = typeof proposal?.proposalBranch === 'string' ? proposal.proposalBranch : '';
  const sourceSha = typeof proposal?.proposalSha === 'string' ? proposal.proposalSha : '';
  const targetBranch = typeof proposal?.targetBranch === 'string' ? proposal.targetBranch : '';
  if (proposal?.programHash !== programHash || !sourceBranch || !sourceSha || !targetBranch) {
    return 'The reviewed GitLab CI proposal binding is missing or stale';
  }
  let merged: CodeChangeRequest[];
  try {
    merged = await context.adapter.listChangeRequests(context.repository, {
      sourceBranch,
      targetBranch,
      state: 'merged',
    });
  } catch (error) {
    return `GitLab merge-request provenance is unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (merged.length !== 1 || merged[0]?.sourceSha !== sourceSha) {
    return 'GitLab did not prove one merged configuration request at the exact reviewed proposal head';
  }
  return null;
}

function boundConfigurationPaths(binding: Record<string, unknown> | null): string[] {
  const active = asRecord(binding?.configurationActive);
  const proposal = asRecord(binding?.configurationProposal);
  const files = Array.isArray(active?.files)
    ? active.files
    : Array.isArray(proposal?.files)
      ? proposal.files
      : [];
  return files.flatMap((entry) => {
    const record = asRecord(entry);
    return typeof record?.path === 'string' ? [record.path] : [];
  });
}

function persistConfigurationProposal(params: {
  project: Project;
  environmentName: string;
  context: GitLabContext;
  files: ManagedFile[];
  programHash: string;
  proposalBranch: string;
  proposalSha: string;
  targetBranch: string;
}): void {
  const environments = new EnvironmentRepository();
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName)
    ?? environments.create({ projectId: params.project.id, name: params.environmentName });
  const ci = asRecord(environment.platformBindings.ci) ?? {};
  const gitlab = asRecord(ci.gitlabCi) ?? {};
  environments.updatePlatformBindings(environment.id, {
    ci: {
      ...ci,
      gitlabCi: {
        ...gitlab,
        provider: 'gitlab-ci',
        repositoryId: params.context.repository.nativeId,
        instanceScope: params.context.repository.instanceScope,
        repositoryScope: params.context.repository.canonicalScope,
        configurationProposal: {
          programHash: params.programHash,
          proposalBranch: params.proposalBranch,
          proposalSha: params.proposalSha,
          targetBranch: params.targetBranch,
          files: params.files.map((file) => ({ path: file.path, hash: file.hash })),
          proposedAt: new Date().toISOString(),
        },
      },
    },
  });
}

function metadataString(action: PlanAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function gitLabExpressionString(value: string): string {
  return JSON.stringify(value);
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error(`Cannot render GitLab CI job id for environment "${value}"`);
  return slug;
}

function activeRootPath(project: GitLabProject): string {
  const value = project.ci_config_path?.trim() || '.gitlab-ci.yml';
  if (
    value.startsWith('/')
    || value.includes('@')
    || value.split('/').some((part) => part === '..' || part === '.')
    || value.includes('\\')
    || value.length > 255
  ) {
    throw new Error(`GitLab active CI config path "${value}" is external or unsafe; the MVP supports only a root file in the bound repository`);
  }
  return value;
}

function canonicalEnvironment(spec: ProjectSpec, targets: BranchDeployTarget[]): string | null {
  const requested = spec.devops?.canonicalEnvironment;
  if (requested && requested !== 'repository') return requested;
  return targets.find((target) => target.kind === 'production')?.environmentName
    ?? targets[0]?.environmentName
    ?? null;
}

function configurationBindingForSpec(project: Project, spec: ProjectSpec): Record<string, unknown> | null {
  const canonical = canonicalEnvironment(spec, managedTargets(project, spec));
  return canonical ? gitLabCiBinding(project.id, canonical) : null;
}

function managedTargets(project: Project, spec: ProjectSpec): BranchDeployTarget[] {
  const targets = resolveReviewedBranchDeployTargets(project, spec).targets;
  return targets.filter((target) => {
    const environment = spec.environments[target.environmentName];
    return environment?.hosting.provider === 'railway'
      && environment.deploy?.strategy === 'branch'
      && environment.deploy.trigger !== 'native';
  });
}

function renderRules(target: BranchDeployTarget): string {
  const rules: string[] = [];
  if (target.autoDeployOnPush) {
    rules.push(`    - if: ${yamlString(`$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${gitLabExpressionString(target.branch)}`)}`);
  }
  rules.push(`    - if: ${yamlString(`($CI_PIPELINE_SOURCE == "api" || $CI_PIPELINE_SOURCE == "web") && $CI_COMMIT_BRANCH == ${gitLabExpressionString(target.branch)} && "$[[ inputs.environment ]]" == ${gitLabExpressionString(target.environmentName)}`)}`);
  rules.push('    - when: never');
  return rules.join('\n');
}

function renderEnvironmentJobs(
  spec: ProjectSpec,
  target: BranchDeployTarget,
  programFingerprint: string
): string {
  const slug = safeSlug(target.environmentName);
  const appliedHash = environmentDeploymentContractHashForApply(spec, target.environmentName);
  const keys = gitLabVariableKeys(spec, target.environmentName);
  const rules = renderRules(target);
  return `spec:
  inputs:
    environment:
      type: string
    commit_sha:
      type: string
---
hypervibe:build:railway:${slug}:
  stage: build
  image: docker:27.5.1-git
  services:
    - name: docker:27.5.1-dind
  tags:
    - ${GITLAB_SAAS_RUNNER_TAG}
  inherit:
    default: false
    variables: false
  interruptible: true
  timeout: 30m
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  rules:
${rules}
  before_script: []
  script:
    - |
      set -eu
      test "$${keys.appliedSpecHash}" = ${gitLabShellLiteral(appliedHash)}
      sh ${RAILWAY_BUILD_RUNTIME_PATH} "$[[ inputs.commit_sha ]]"
  after_script: []
  artifacts:
    expire_in: 30 days
    paths:
      - ${RAILWAY_DEPLOY_RUNTIME_PATH}
      - .hypervibe-image-uri
      - .hypervibe-deploy-sha

hypervibe:deploy:railway:${slug}:
  stage: deploy
  image: node:22-slim
  tags:
    - ${GITLAB_SAAS_RUNNER_TAG}
  inherit:
    default: false
    variables: false
  interruptible: false
  resource_group: ${yamlString(`hypervibe-${target.environmentName}`)}
  timeout: 20m
  environment:
    name: ${yamlString(target.environmentName)}
  needs:
    - job: hypervibe:build:railway:${slug}
      artifacts: true
  rules:
${rules}
  before_script: []
  script:
    - |
      set -eu
      test "$${keys.appliedSpecHash}" = ${gitLabShellLiteral(appliedHash)}
      export HYPERVIBE_REPOSITORY=${gitLabShellLiteral(spec.devops!.code.scope)}
      export HYPERVIBE_ENVIRONMENT=${gitLabShellLiteral(target.environmentName)}
      export HYPERVIBE_PROGRAM_FINGERPRINT=${gitLabShellLiteral(programFingerprint)}
      RAILWAY_API_TOKEN="$${keys.railwayApiToken}" RAILWAY_ENVIRONMENT_ID="$${keys.railwayEnvironmentId}" RAILWAY_SERVICE_IDS="$${keys.railwayServiceIds}" IMAGE_REGISTRY_USERNAME="$${keys.imageRegistryUsername}" IMAGE_REGISTRY_TOKEN="$${keys.imageRegistryToken}" node ${RAILWAY_DEPLOY_RUNTIME_PATH}
  after_script: []
  artifacts:
    when: always
    expire_in: 30 days
    paths:
      - .hypervibe-release.json
`;
}

function renderManagedFiles(project: Project, spec: ProjectSpec, rootPath: string): {
  files: ManagedFile[];
  programHash: string;
  jobNames: string[];
} {
  const targets = managedTargets(project, spec);
  if (targets.length === 0) throw new Error('No GitLab CI Railway deploy environments are declared');
  const unsupported = Object.entries(spec.environments).filter(([, environment]) => (
    environment.deploy?.strategy === 'branch'
    && environment.deploy.trigger !== 'native'
    && environment.hosting.provider !== 'railway'
  ));
  if (unsupported.length > 0) {
    throw new Error(`GitLab CI MVP supports Railway deploys only; unsupported environments: ${unsupported.map(([name]) => name).join(', ')}`);
  }
  if (Object.values(spec.environments).some((environment) => environment.ios?.release)) {
    throw new Error('GitLab CI MVP does not yet render iOS release jobs');
  }
  if (Object.values(spec.environments).some((environment) => environment.migrations?.mode === 'tool')) {
    throw new Error('GitLab CI MVP does not yet render tool-mode database migrations');
  }
  if (Object.values(spec.environments).some((environment) => environment.database?.seedCommand)) {
    throw new Error('GitLab CI MVP does not yet render declarative database seed releases');
  }
  if (Object.values(spec.environments).some((environment) => (
    Object.values(environment.services).some((service) => service.workloadKind === 'cron')
  ))) {
    throw new Error('GitLab CI MVP does not yet deploy Railway cron jobs');
  }
  const slugs = targets.map((target) => safeSlug(target.environmentName));
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('GitLab CI environment names collide after safe job-id normalization');
  }

  const runtime = effectiveProjectRuntime(spec.runtime);
  const defaultStartCommand = runtime.kind === 'node' ? 'npm start' : 'python -m app';
  const startCommands = new Set(targets.map((target) => target.webStartCommand ?? defaultStartCommand));
  if (startCommands.size !== 1) {
    throw new Error('GitLab CI MVP requires one identical web start command across every managed environment');
  }
  const startCommand = [...startCommands][0]!;
  const semanticProgram = JSON.stringify({
    version: PROGRAM_VERSION,
    provider: 'railway',
    repository: spec.devops?.code,
    runtime,
    targets: targets.map((target) => ({
      environment: target.environmentName,
      branch: target.branch,
      autoDeployOnPush: target.autoDeployOnPush,
      promoteFromEnvironment: target.promoteFromEnvironment,
      appliedSpecHash: environmentDeploymentContractHashForApply(spec, target.environmentName),
    })),
  });
  const programHash = sha256(semanticProgram);
  const jobNames = targets.flatMap((target) => {
    const slug = safeSlug(target.environmentName);
    return [`hypervibe:build:railway:${slug}`, `hypervibe:deploy:railway:${slug}`];
  });
  const deployFiles = targets.map((target) => ({
    path: `.gitlab/hypervibe/deploy-railway-${safeSlug(target.environmentName)}.yml`,
    content: renderEnvironmentJobs(spec, target, programHash),
  }));
  const manifest = `# hypervibe-managed: gitlab-ci-manifest/v1
spec:
  inputs:
    environment:
      type: string
    commit_sha:
      type: string
---
include:
${deployFiles.map((file) => `  - local: '/${file.path}'
    inputs:
      environment: "$[[ inputs.environment ]]"
      commit_sha: "$[[ inputs.commit_sha ]]"`).join('\n')}
`;
  const environments = targets.map((target) => target.environmentName);
  const defaultEnvironment = canonicalEnvironment(spec, targets) ?? environments[0];
  const root = `${ROOT_MARKER}
spec:
  inputs:
    environment:
      type: string
      options:
${environments.map((environment) => `        - ${yamlString(environment)}`).join('\n')}
      default: ${yamlString(defaultEnvironment)}
    commit_sha:
      type: string
      default: '$CI_COMMIT_SHA'
---
workflow:
  rules:
${targets.filter((target) => target.autoDeployOnPush).map((target) => `    - if: ${yamlString(`$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${gitLabExpressionString(target.branch)}`)}`).join('\n')}
    - if: '$CI_PIPELINE_SOURCE == "api" || $CI_PIPELINE_SOURCE == "web"'
    - when: never
stages:
  - build
  - deploy
include:
  - local: '/${MANIFEST_PATH}'
    inputs:
      environment: "$[[ inputs.environment ]]"
      commit_sha: "$[[ inputs.commit_sha ]]"
`;
  const rawFiles = [
    { path: rootPath, content: root },
    { path: MANIFEST_PATH, content: manifest },
    ...deployFiles,
    { path: RAILWAY_BUILD_RUNTIME_PATH, content: buildRailwayGitLabImageRuntime(runtime, startCommand) },
    { path: RAILWAY_DEPLOY_RUNTIME_PATH, content: buildRailwayDeployRuntime() },
  ];
  return {
    files: rawFiles
      .map((file) => ({ ...file, hash: sha256(file.content) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    programHash,
    jobNames,
  };
}

function renderManagedFilesSafely(
  project: Project,
  spec: ProjectSpec,
  rootPath: string
): ReturnType<typeof renderManagedFiles> | { error: string } {
  try {
    return renderManagedFiles(project, spec, rootPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadContext(spec: ProjectSpec): Promise<GitLabContext | { error: string }> {
  const selection = spec.devops;
  if (!selection || selection.code.provider !== 'gitlab' || selection.ci?.provider !== 'gitlab-ci') {
    return { error: 'The current desired state does not select GitLab plus GitLab CI' };
  }
  const connection = new ConnectionRepository().findBestVerifiedMatch('gitlab', selection.code.scope);
  if (!connection) {
    return { error: `No verified GitLab connection for ${selection.code.scope}` };
  }
  const credentials = getSecretStore().decryptObject<GitLabCredentials>(connection.credentialsEncrypted);
  const adapter = new GitLabAdapter();
  adapter.connect(credentials);
  const observation = await adapter.observeRepository(selection.code.scope);
  if (observation.state !== 'present') {
    return {
      error: observation.state === 'absent'
        ? `GitLab project ${selection.code.scope} does not exist; project bootstrap is outside the MVP`
        : observation.reason,
    };
  }
  const remote = normalizeGitRemoteIdentity(spec.gitRemoteUrl);
  const cloneIdentities = observation.value.cloneUrls
    .map((url) => normalizeGitRemoteIdentity(url))
    .filter((value): value is string => Boolean(value));
  if (!remote || !cloneIdentities.includes(remote)) {
    return { error: 'gitRemoteUrl does not match the provider-observed GitLab project clone identity' };
  }
  const project = await adapter.getProject(observation.value.nativeId);
  if (project.repository_object_format === 'sha256') {
    return { error: 'GitLab SHA-256 repositories are not supported by the current exact-SHA deploy contract' };
  }
  try {
    activeRootPath(project);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { adapter, credentials, repository: observation.value, project };
}

async function observeFiles(
  context: GitLabContext,
  files: ManagedFile[],
  ref: string
): Promise<{ exact: boolean; observations: Map<string, 'present' | 'absent'> } | { error: string }> {
  const observations = new Map<string, 'present' | 'absent'>();
  let exact = true;
  for (const file of files) {
    const observed = await context.adapter.observeFile(context.repository, file.path, ref);
    if (observed.state === 'unknown') return { error: observed.reason };
    observations.set(file.path, observed.state);
    if (observed.state === 'present' && observed.value.contentHash !== file.hash) {
      exact = false;
    }
    if (observed.state === 'absent') exact = false;
  }
  return { exact, observations };
}

function branchPatternMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(branch);
}

async function verifyRunnerPolicy(context: GitLabContext): Promise<string | null> {
  if (context.repository.instanceScope !== 'https://gitlab.com') {
    return 'GitLab CI managed deploys currently require GitLab.com hosted runners; self-managed runner trust needs an explicit future binding';
  }
  try {
    const runners = await context.adapter.listProjectRunners(
      context.repository.nativeId,
      GITLAB_SAAS_RUNNER_TAG
    );
    if (runners.length === 0) {
      return `No GitLab.com hosted runner with tag ${GITLAB_SAAS_RUNNER_TAG} is available to the project`;
    }
    if (runners.some((runner) => runner.runnerType !== 'instance_type')) {
      return `A project or group runner can claim the trusted ${GITLAB_SAAS_RUNNER_TAG} tag; remove that conflicting runner before managed secret sync`;
    }
    if (!runners.some((runner) => runner.status === 'online' && !runner.paused)) {
      return `No online, unpaused GitLab.com hosted runner with tag ${GITLAB_SAAS_RUNNER_TAG} is available`;
    }
    return null;
  } catch (error) {
    return `GitLab runner trust observation is unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function verifyDeployPolicy(
  context: GitLabContext,
  target: BranchDeployTarget
): Promise<string | null> {
  try {
  const runnerProblem = await verifyRunnerPolicy(context);
  if (runnerProblem) return runnerProblem;
  const access = Math.max(
    context.project.permissions?.project_access?.access_level ?? 0,
    context.project.permissions?.group_access?.access_level ?? 0
  );
  if (access < 40) return 'GitLab Maintainer-or-higher project access was not proven';
  if (context.project.ci_pipeline_variables_minimum_override_role !== 'no_one_allowed') {
    return 'GitLab pipeline-variable override policy must be no_one_allowed before managed deploy variables can be synced';
  }
  const registryEnabled = context.project.container_registry_access_level === 'enabled'
    || context.project.container_registry_access_level === 'private'
    || (
      context.project.container_registry_access_level === undefined
      && context.project.container_registry_enabled === true
    );
  if (!registryEnabled) {
    return 'The GitLab project container registry is disabled or could not be proven enabled';
  }
  const registryPull = await context.adapter.verifyRegistryPull(context.project);
  if (!registryPull.success) {
    return `The project-scoped GitLab registry pull credential was not verified: ${registryPull.error}`;
  }
  const protectedBranches = await context.adapter.listProtectedBranches(context.repository.nativeId);
  const matching = protectedBranches.filter((rule) => branchPatternMatches(rule.name, target.branch));
  if (matching.length === 0) return `GitLab branch ${target.branch} is not protected`;
  if (matching.some((rule) => (
    rule.allowForcePush
    || rule.pushAccessLevels.some((level) => (
      level.userId !== undefined
      || level.groupId !== undefined
      || level.deployKeyId !== undefined
      || (level.accessLevel ?? -1) !== 0
    ))
  ))) {
    return `Every effective protected-branch rule for ${target.branch} must disable force push and direct push`;
  }
  if (target.kind === 'production') {
    if (context.project.ci_forward_deployment_enabled !== true) {
      return 'GitLab forward deployment protection must be enabled for production';
    }
    const environment = await context.adapter.getProtectedEnvironment(
      context.repository.nativeId,
      target.environmentName
    );
    if (environment.state !== 'present') {
      return environment.state === 'absent'
        ? `GitLab environment ${target.environmentName} is not protected`
        : environment.reason;
    }
    if (
      environment.value.deployAccessLevels.length === 0
      || environment.value.deployAccessLevels.some((level) => (
        level.userId !== undefined || level.groupId !== undefined || level.accessLevel !== 40
      ))
    ) {
      return `GitLab environment ${target.environmentName} must allow deployment only to the Maintainer role`;
    }
  }
  return null;
  } catch (error) {
    return `GitLab deploy-policy observation is unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function proveConfigurationAtRef(
  context: GitLabContext,
  files: ManagedFile[],
  jobNames: string[],
  ref: string,
  commitSha: string
): Promise<{ commitSha: string } | { error: string }> {
  const observed = await observeFiles(context, files, ref);
  if ('error' in observed) return observed;
  if (!observed.exact) return { error: `The Hypervibe GitLab CI configuration is not exact at ${ref}` };
  const lint = await context.adapter.observeActiveConfiguration(
    context.repository.nativeId,
    commitSha,
    ref
  );
  if (lint.state !== 'present') {
    return { error: lint.state === 'absent' ? 'GitLab active CI configuration is absent' : lint.reason };
  }
  const activeJobs = new Set(lint.value.jobs.map((job) => job.name));
  const missing = jobNames.filter((job) => !activeJobs.has(job));
  if (missing.length > 0) return { error: `GitLab CI Lint did not resolve managed jobs: ${missing.join(', ')}` };
  const unexpected = [...activeJobs].filter((job) => !jobNames.includes(job));
  if (unexpected.length > 0) {
    return { error: `GitLab CI Lint resolved jobs outside the Hypervibe-owned authority: ${unexpected.join(', ')}` };
  }
  const expectedIncludes = new Set(
    files
      .map((file) => file.path)
      .filter((path) => path === MANIFEST_PATH || path.startsWith('.gitlab/hypervibe/deploy-'))
  );
  const actualIncludes = new Set<string>();
  for (const include of lint.value.includes) {
    if (include.type !== 'local' || !include.location) {
      return { error: 'GitLab CI Lint reported an unexpected or unresolved include authority' };
    }
    if (!include.context_sha || include.context_sha !== commitSha) {
      return { error: 'GitLab CI Lint did not bind every local include to the exact reviewed commit' };
    }
    actualIncludes.add(include.location.replace(/^\/+/, ''));
  }
  if (
    actualIncludes.size !== expectedIncludes.size
    || [...expectedIncludes].some((path) => !actualIncludes.has(path))
  ) {
    return { error: 'GitLab CI Lint include graph does not match the Hypervibe-owned configuration graph' };
  }
  return { commitSha };
}

async function proveActiveConfiguration(
  context: GitLabContext,
  files: ManagedFile[],
  jobNames: string[]
): Promise<{ commitSha: string } | { error: string }> {
  const branch = await context.adapter.observeBranch(context.repository, context.repository.defaultBranch);
  if (branch.state !== 'present') {
    return { error: branch.state === 'absent' ? 'GitLab default branch disappeared' : branch.reason };
  }
  return proveConfigurationAtRef(
    context,
    files,
    jobNames,
    context.repository.defaultBranch,
    branch.value.sha
  );
}

function configAction(
  context: GitLabContext,
  files: ManagedFile[],
  programHash: string,
  baseSha: string,
  dependsOn?: string[]
): PlanAction {
  const proposalBranch = `hypervibe/gitlab-ci-${programHash.slice(0, 12)}`;
  return {
    id: 'ci:gitlab-ci:configuration',
    type: 'update',
    resource: { kind: 'ci', name: 'configuration', provider: 'gitlab-ci' },
    verified: true,
    reason: 'Publish the reviewed GitLab CI configuration through a merge request',
    ...(dependsOn?.length ? { dependsOn } : {}),
    metadata: {
      operation: CI_CONFIGURATION_SYNC_OPERATION,
      codeProvider: 'gitlab',
      ciProvider: 'gitlab-ci',
      repositoryId: context.repository.nativeId,
      instanceScope: context.repository.instanceScope,
      repositoryScope: context.repository.canonicalScope,
      targetBranch: context.repository.defaultBranch,
      baseSha,
      proposalBranch,
      programHash,
      files: files.map((file) => ({ path: file.path, hash: file.hash })),
    },
  };
}

function variableAction(
  context: GitLabContext,
  environmentName: string,
  desired: DesiredVariable,
  type: 'create' | 'update',
  programHash: string,
  dependsOn?: string[],
  operation = CI_VARIABLE_SYNC_OPERATION
): PlanAction {
  return {
    id: `ci:gitlab-ci:${environmentName}:variable:${desired.key}`,
    type,
    resource: { kind: 'secret', name: `${environmentName}:${desired.key}`, provider: 'gitlab-ci' },
    verified: true,
    reason: `${type === 'create' ? 'Create' : 'Update'} the exact environment-scoped GitLab CI variable ${desired.key}`,
    ...(dependsOn?.length ? { dependsOn } : {}),
    metadata: {
      operation,
      codeProvider: 'gitlab',
      ciProvider: 'gitlab-ci',
      repositoryId: context.repository.nativeId,
      instanceScope: context.repository.instanceScope,
      repositoryScope: context.repository.canonicalScope,
      environmentName,
      variableKey: desired.key,
      environmentScope: desired.environmentScope,
      valueHash: sha256(desired.value),
      protected: desired.protected,
      masked: desired.masked,
      hidden: desired.hidden,
      raw: desired.raw,
      valueSource: desired.source,
      programHash,
    },
  };
}

function railwayVariables(
  context: GitLabContext,
  spec: ProjectSpec,
  target: BranchDeployTarget
): DesiredVariable[] | { error: string } {
  const railwayConnection = new ConnectionRepository().findBestVerifiedMatch('railway');
  if (!railwayConnection) return { error: 'No verified Railway connection is available for GitLab CI secret sync' };
  const railway = getSecretStore().decryptObject<Record<string, unknown>>(railwayConnection.credentialsEncrypted);
  const railwayToken = typeof railway.apiToken === 'string' ? railway.apiToken : '';
  if (!railwayToken) return { error: 'The verified Railway connection has no API token' };
  if (!context.credentials.registryUsername || !context.credentials.registryReadToken) {
    return {
      error: 'The GitLab connection needs registryUsername and a project-scoped read_registry token so Railway can pull the private image',
    };
  }
  if (!target.providerEnvironmentId || target.providerServiceIds.length === 0) {
    return { error: `Railway bindings for ${target.environmentName} are incomplete; apply hosting first, then re-plan CI variables` };
  }
  if (target.providerServiceIds.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) {
    return { error: `Railway service bindings for ${target.environmentName} contain an unsafe or ambiguous provider id` };
  }
  const secret = (key: string, value: string, source: string): DesiredVariable => ({
    key,
    value,
    source,
    environmentScope: target.environmentName,
    protected: true,
    masked: true,
    hidden: true,
    raw: true,
  });
  const plain = (key: string, value: string, source: string): DesiredVariable => ({
    key,
    value,
    source,
    environmentScope: target.environmentName,
    protected: true,
    masked: false,
    hidden: false,
    raw: true,
  });
  const keys = gitLabVariableKeys(spec, target.environmentName);
  return [
    secret(keys.railwayApiToken, railwayToken, 'connection:railway.apiToken'),
    secret(keys.imageRegistryToken, context.credentials.registryReadToken, 'connection:gitlab.registryReadToken'),
    plain(keys.imageRegistryUsername, context.credentials.registryUsername, 'connection:gitlab.registryUsername'),
    plain(keys.railwayEnvironmentId, target.providerEnvironmentId, 'binding:hosting.environmentId'),
    plain(keys.railwayServiceIds, [...target.providerServiceIds].sort().join(','), 'binding:hosting.serviceIds'),
  ];
}

function gitLabEnvironmentScopeMatches(scope: string, environmentName: string): boolean {
  const escaped = scope.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(environmentName);
}

function isReservedGitLabVariable(key: string, desiredKeys: Set<string>): boolean {
  if (desiredKeys.has(key)) return false;
  const upper = key.toUpperCase();
  return upper.startsWith('CI_')
    || upper.startsWith('GITLAB_')
    || upper.startsWith('HYPERVIBE_')
    || upper.startsWith('RAILWAY_')
    || upper.startsWith('IMAGE_REGISTRY_')
    || upper === 'IMAGE_URI'
    || upper === 'DOCKER_HOST'
    || upper === 'DOCKER_CERT_PATH'
    || upper === 'DOCKER_TLS_CERTDIR';
}

async function planVariables(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  dependsOn?: string[];
  appliedSpecOnly: boolean;
}): Promise<CiLifecycleResult> {
  const context = await loadContext(params.spec);
  if ('error' in context) return { warnings: [], error: context.error };
  const rootPath = activeRootPath(context.project);
  const rendered = renderManagedFilesSafely(params.project, params.spec, rootPath);
  if ('error' in rendered) return { warnings: [], error: rendered.error };
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames);
  if ('error' in active) return { warnings: [], error: active.error };
  const configurationBinding = configurationBindingForSpec(params.project, params.spec);
  const ownershipProblem = await proveMergedConfigurationOwnership(
    configurationBinding,
    context,
    rendered.programHash
  );
  if (ownershipProblem) {
    return {
      warnings: [],
      error: `${ownershipProblem}; variable reconciliation is blocked.`,
    };
  }
  const target = managedTargets(params.project, params.spec)
    .find((candidate) => candidate.environmentName === params.environmentName);
  if (!target) return { warnings: [] };
  const policyProblem = await verifyDeployPolicy(context, target);
  if (policyProblem) return { warnings: [], error: policyProblem };

  let desired: DesiredVariable[] | { error: string };
  if (params.appliedSpecOnly) {
    const keys = gitLabVariableKeys(params.spec, params.environmentName);
    desired = [{
      key: keys.appliedSpecHash,
      value: environmentDeploymentContractHashForApply(params.spec, params.environmentName),
      environmentScope: '*',
      protected: true,
      masked: false,
      hidden: false,
      raw: true,
      source: 'desired:deployment-contract',
    }];
  } else {
    desired = railwayVariables(context, params.spec, target);
  }
  if ('error' in desired) return { warnings: [], error: desired.error };

  const environmentBinding = gitLabCiBinding(params.project.id, params.environmentName);

  let observed;
  try {
    observed = await context.adapter.listVariables(context.repository.nativeId);
  } catch (error) {
    return { warnings: [], error: error instanceof Error ? error.message : String(error) };
  }
  const desiredKeys = new Set(Object.values(gitLabVariableKeys(params.spec, params.environmentName)));
  const reservedCollision = observed.find((candidate) => (
    gitLabEnvironmentScopeMatches(candidate.scope, params.environmentName)
    && isReservedGitLabVariable(candidate.key, desiredKeys)
  ));
  if (reservedCollision) {
    return {
      warnings: [],
      error: `GitLab project variable ${reservedCollision.key} at scope ${reservedCollision.scope} can shadow a managed or provider-defined deploy value. Remove or rename it before planning.`,
    };
  }
  const ownedHashes = asRecord(environmentBinding?.variableHashes) ?? {};
  const actions: PlanAction[] = [];
  for (const variable of desired) {
    const overlapping = observed.find((candidate) => (
      candidate.key === variable.key
      && candidate.scope !== variable.environmentScope
      && gitLabEnvironmentScopeMatches(candidate.scope, params.environmentName)
    ));
    if (overlapping) {
      return {
        warnings: [],
        error: `GitLab variable ${variable.key} has overlapping unowned scope ${overlapping.scope}; Hypervibe will not guess the effective value.`,
      };
    }
    const matches = observed.filter((candidate) => (
      candidate.key === variable.key && candidate.scope === variable.environmentScope
    ));
    if (matches.length > 1) {
      return { warnings: [], error: `Multiple GitLab variables match ${variable.key} at ${variable.environmentScope}` };
    }
    const current = matches[0];
    if (current && typeof ownedHashes[variable.key] !== 'string') {
      return {
        warnings: [],
        error: `GitLab variable ${variable.key} at ${variable.environmentScope} exists without a matching Hypervibe ownership binding; it will not be adopted or overwritten.`,
      };
    }
    if (current && (current.valueVisibility !== 'plaintext' || !current.valueHash)) {
      return {
        warnings: [],
        error: `GitLab did not return an observable value fingerprint for owned variable ${variable.key}; reconciliation is blocked.`,
      };
    }
    if (current && Boolean(current.hidden) !== variable.hidden) {
      return {
        warnings: [],
        error: `Owned GitLab variable ${variable.key} has incompatible hidden visibility. GitLab cannot safely change that flag in place, so replacement requires an explicit future lifecycle action.`,
      };
    }
    const exact = current
      && current.valueHash === sha256(variable.value)
      && current.protected === variable.protected
      && current.masked === variable.masked
      && Boolean(current.hidden) === variable.hidden
      && current.raw === variable.raw;
    if (!exact) {
      actions.push(variableAction(
        context,
        params.environmentName,
        variable,
        current ? 'update' : 'create',
        rendered.programHash,
        params.dependsOn,
        params.appliedSpecOnly ? CI_APPLIED_SPEC_SYNC_OPERATION : CI_VARIABLE_SYNC_OPERATION
      ));
    }
  }
  return { actions, warnings: [] };
}

async function planDeploy(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  dependsOn?: string[];
  bindingsWillChange?: boolean;
}): Promise<CiLifecycleResult> {
  if (params.environmentSpec.deploy?.strategy !== 'branch' || params.environmentSpec.deploy.trigger === 'native') {
    return { warnings: [] };
  }
  const context = await loadContext(params.spec);
  if ('error' in context) return { warnings: [], error: context.error };
  const runnerProblem = await verifyRunnerPolicy(context);
  if (runnerProblem) return { warnings: [], error: runnerProblem };
  const rootPath = activeRootPath(context.project);
  const rendered = renderManagedFilesSafely(params.project, params.spec, rootPath);
  if ('error' in rendered) return { warnings: [], error: rendered.error };
  const targets = managedTargets(params.project, params.spec);
  const canonical = canonicalEnvironment(params.spec, targets);
  const binding = canonical ? gitLabCiBinding(params.project.id, canonical) : null;
  const repositoryOwned = bindingMatchesRepository(binding, context);
  const root = await context.adapter.observeFile(context.repository, rootPath, context.repository.defaultBranch);
  if (root.state === 'unknown') return { warnings: [], error: root.reason };
  if (root.state === 'present' && !root.value.content.startsWith(`${ROOT_MARKER}\n`)) {
    return {
      warnings: [],
      error: `GitLab active root ${rootPath} is unmanaged. Hypervibe will not rewrite it; add include: - local: '/${MANIFEST_PATH}' through your own reviewed change first.`,
    };
  }
  if (root.state === 'present' && !repositoryOwned) {
    return {
      warnings: [],
      error: `GitLab active root ${rootPath} has a Hypervibe marker but no matching local ownership binding. Restore the original Hypervibe bindings or remove the unowned files before planning.`,
    };
  }
  const observedFiles = await observeFiles(context, rendered.files, context.repository.defaultBranch);
  if ('error' in observedFiles) return { warnings: [], error: observedFiles.error };
  if (!repositoryOwned && [...observedFiles.observations.entries()].some(([path, state]) => (
    path !== rootPath && state === 'present'
  ))) {
    return {
      warnings: [],
      error: 'GitLab managed-path files already exist without a matching local ownership binding; Hypervibe will not overwrite or adopt them.',
    };
  }
  const previouslyOwnedPaths = new Set(boundConfigurationPaths(binding));
  const unownedCollision = repositoryOwned
    ? [...observedFiles.observations.entries()].find(([path, state]) => (
        state === 'present' && !previouslyOwnedPaths.has(path)
      ))
    : undefined;
  if (unownedCollision) {
    return {
      warnings: [],
      error: `GitLab managed path ${unownedCollision[0]} exists but is not in the last reviewed ownership binding; Hypervibe will not overwrite it.`,
    };
  }
  if (!observedFiles.exact) {
    const desiredPaths = new Set(rendered.files.map((file) => file.path));
    const removedOwnedPaths = boundConfigurationPaths(binding)
      .filter((path) => !desiredPaths.has(path));
    if (removedOwnedPaths.length > 0) {
      return {
        warnings: [],
        error: `GitLab CI MVP will not leave or implicitly delete obsolete managed files: ${removedOwnedPaths.join(', ')}. File teardown needs an explicit lifecycle action.`,
      };
    }
    if (canonical !== params.environmentName) {
      return {
        warnings: [],
        error: `GitLab CI configuration is not active. Plan environment ${canonical ?? 'repository'} to publish the one project-level merge request first.`,
      };
    }
    const base = await context.adapter.observeBranch(context.repository, context.repository.defaultBranch);
    if (base.state !== 'present') {
      return { warnings: [], error: base.state === 'absent' ? 'GitLab default branch is absent' : base.reason };
    }
    return {
      actions: [configAction(context, rendered.files, rendered.programHash, base.value.sha)],
      warnings: [],
    };
  }
  if (!configurationOwnershipMatches(binding, context, rendered.programHash)) {
    return {
      warnings: [],
      error: 'The exact GitLab CI configuration is present but its reviewed Hypervibe proposal/active binding is missing or stale; Hypervibe will not silently adopt it.',
    };
  }
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames);
  if ('error' in active) return { warnings: [], error: active.error };
  if (params.bindingsWillChange) {
    return {
      warnings: [`Railway bindings will change for ${params.environmentName}; re-plan after hosting converges before syncing exact GitLab variables.`],
    };
  }
  return planVariables({
    project: params.project,
    spec: params.spec,
    environmentName: params.environmentName,
    dependsOn: params.dependsOn,
    appliedSpecOnly: false,
  });
}

function resolveDesiredVariable(
  action: PlanAction,
  context: GitLabContext,
  project: Project,
  spec: ProjectSpec,
  environmentName: string
): DesiredVariable | { error: string } {
  const key = metadataString(action, 'variableKey');
  const scope = metadataString(action, 'environmentScope');
  const source = metadataString(action, 'valueSource');
  if (!key || !scope || !source) return { error: 'Variable action identity is incomplete' };
  if (action.metadata?.operation === CI_APPLIED_SPEC_SYNC_OPERATION) {
    const keys = gitLabVariableKeys(spec, environmentName);
    if (key !== keys.appliedSpecHash || scope !== '*' || source !== 'desired:deployment-contract') {
      return { error: 'Applied-spec variable action identity is invalid' };
    }
    return {
      key,
      value: environmentDeploymentContractHashForApply(spec, environmentName),
      environmentScope: '*',
      protected: true,
      masked: false,
      hidden: false,
      raw: true,
      source,
    };
  }
  if (scope !== environmentName) return { error: 'Variable action scope is invalid for the selected environment' };
  const target = managedTargets(project, spec).find((candidate) => candidate.environmentName === environmentName);
  if (!target) return { error: `No GitLab CI target exists for ${environmentName}` };
  const desired = railwayVariables(context, spec, target);
  if ('error' in desired) return desired;
  return desired.find((variable) => variable.key === key && variable.source === source)
    ?? { error: `Variable ${key} is not part of the current GitLab CI program` };
}

async function applyVariable(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  action: PlanAction;
}): Promise<CiApplyResult> {
  const context = await loadContext(params.spec);
  if ('error' in context) return { success: false, status: 'blocked', message: 'GitLab CI connection is unavailable', error: context.error };
  if (
    metadataString(params.action, 'repositoryId') !== context.repository.nativeId
    || metadataString(params.action, 'instanceScope') !== context.repository.instanceScope
    || metadataString(params.action, 'repositoryScope') !== context.repository.canonicalScope
  ) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: 'The reviewed repository identity changed; re-run hv_plan.' };
  }
  const rootPath = activeRootPath(context.project);
  const rendered = renderManagedFilesSafely(params.project, params.spec, rootPath);
  if ('error' in rendered) return { success: false, status: 'blocked', message: 'GitLab CI program is unsupported', error: rendered.error };
  if (metadataString(params.action, 'programHash') !== rendered.programHash) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: 'The reviewed CI program changed; re-run hv_plan.' };
  }
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames);
  if ('error' in active) return { success: false, status: 'blocked', message: 'GitLab CI configuration is not proven active', error: active.error };
  const configurationBinding = configurationBindingForSpec(params.project, params.spec);
  const ownershipProblem = await proveMergedConfigurationOwnership(
    configurationBinding,
    context,
    rendered.programHash
  );
  if (ownershipProblem) {
    return { success: false, status: 'blocked', message: 'GitLab CI ownership is not proven', error: ownershipProblem };
  }
  const target = managedTargets(params.project, params.spec).find((candidate) => candidate.environmentName === params.environmentName);
  if (!target) return { success: false, status: 'blocked', message: 'GitLab CI target is stale', error: `No target exists for ${params.environmentName}` };
  const policyProblem = await verifyDeployPolicy(context, target);
  if (policyProblem) return { success: false, status: 'blocked', message: 'GitLab deploy policy is not safe', error: policyProblem };
  const desired = resolveDesiredVariable(params.action, context, params.project, params.spec, params.environmentName);
  if ('error' in desired) return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: desired.error };
  if (
    metadataString(params.action, 'valueHash') !== sha256(desired.value)
    || params.action.metadata?.protected !== desired.protected
    || params.action.metadata?.masked !== desired.masked
    || params.action.metadata?.hidden !== desired.hidden
    || params.action.metadata?.raw !== desired.raw
  ) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: 'The reviewed value fingerprint or flags changed; re-run hv_plan.' };
  }
  let observed;
  try {
    observed = await context.adapter.listVariables(context.repository.nativeId);
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitLab CI variable observation is unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const desiredKeys = new Set(
    Object.values(gitLabVariableKeys(params.spec, params.environmentName))
  );
  const reservedCollision = observed.find((candidate) => (
    gitLabEnvironmentScopeMatches(candidate.scope, params.environmentName)
    && isReservedGitLabVariable(candidate.key, desiredKeys)
  ));
  if (reservedCollision) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitLab CI variable action is stale',
      error: `GitLab project variable ${reservedCollision.key} at scope ${reservedCollision.scope} can shadow the managed deploy.`,
    };
  }
  const overlapping = observed.find((candidate) => (
    candidate.key === desired.key
    && candidate.scope !== desired.environmentScope
    && gitLabEnvironmentScopeMatches(candidate.scope, params.environmentName)
  ));
  if (overlapping) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitLab CI variable action is stale',
      error: `GitLab variable ${desired.key} has overlapping scope ${overlapping.scope}.`,
    };
  }
  const matches = observed.filter((candidate) => (
    candidate.key === desired.key && candidate.scope === desired.environmentScope
  ));
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable identity is ambiguous', error: `Multiple variables match ${desired.key} at ${desired.environmentScope}.` };
  }
  const environmentBinding = gitLabCiBinding(params.project.id, params.environmentName);
  const ownedHashes = asRecord(environmentBinding?.variableHashes) ?? {};
  const current = matches[0];
  if (params.action.type === 'create' && current) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: `${desired.key} appeared after planning; re-run hv_plan rather than overwriting it.` };
  }
  if (params.action.type === 'update' && !current) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable action is stale', error: `${desired.key} disappeared after planning; re-run hv_plan.` };
  }
  if (current && typeof ownedHashes[desired.key] !== 'string') {
    return { success: false, status: 'blocked', message: 'GitLab CI variable is unowned', error: `${desired.key} has no matching Hypervibe ownership binding and will not be overwritten.` };
  }
  if (current && (current.valueVisibility !== 'plaintext' || !current.valueHash)) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable observation is incomplete', error: `${desired.key} did not expose a safe value fingerprint.` };
  }
  if (current && Boolean(current.hidden) !== desired.hidden) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable visibility is incompatible', error: `${desired.key} cannot change its hidden flag safely in place.` };
  }
  try {
    await context.adapter.upsertVariable(context.repository.nativeId, {
      key: desired.key,
      value: desired.value,
      environmentScope: desired.environmentScope,
      protected: desired.protected,
      masked: desired.masked,
      hidden: desired.hidden,
      raw: desired.raw,
    });
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      message: `GitLab CI variable ${desired.key} was not synchronized`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
  if (environment) {
    const ci = asRecord(environment.platformBindings.ci) ?? {};
    const gitlab = asRecord(ci.gitlabCi) ?? {};
    const hashes = asRecord(gitlab.variableHashes) ?? {};
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: {
        ...ci,
        gitlabCi: {
          ...gitlab,
          provider: 'gitlab-ci',
          repositoryId: context.repository.nativeId,
          instanceScope: context.repository.instanceScope,
          repositoryScope: context.repository.canonicalScope,
          programHash: rendered.programHash,
          activeCommit: active.commitSha,
          configurationActive: {
            programHash: rendered.programHash,
            commitSha: active.commitSha,
            files: rendered.files.map((file) => ({ path: file.path, hash: file.hash })),
            observedAt: new Date().toISOString(),
          },
          configurationProposal: null,
          variableHashes: { ...hashes, [desired.key]: sha256(desired.value) },
        },
      },
    });
  }
  return {
    success: true,
    message: `Synced GitLab CI variable ${desired.key} for ${params.environmentName}`,
    data: { variable: desired.key, environmentScope: desired.environmentScope, valueHash: sha256(desired.value) },
  };
}

async function applyConfiguration(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  action: PlanAction;
}): Promise<CiApplyResult> {
  const context = await loadContext(params.spec);
  if ('error' in context) return { success: false, status: 'blocked', message: 'GitLab CI connection is unavailable', error: context.error };
  const rootPath = activeRootPath(context.project);
  const rendered = renderManagedFilesSafely(params.project, params.spec, rootPath);
  if ('error' in rendered) return { success: false, status: 'blocked', message: 'GitLab CI program is unsupported', error: rendered.error };
  const baseSha = metadataString(params.action, 'baseSha');
  const branchName = metadataString(params.action, 'proposalBranch');
  const targetBranch = metadataString(params.action, 'targetBranch');
  if (
    metadataString(params.action, 'repositoryId') !== context.repository.nativeId
    || metadataString(params.action, 'instanceScope') !== context.repository.instanceScope
    || metadataString(params.action, 'repositoryScope') !== context.repository.canonicalScope
    || metadataString(params.action, 'programHash') !== rendered.programHash
    || targetBranch !== context.repository.defaultBranch
    || !baseSha
    || !branchName
  ) {
    return { success: false, status: 'blocked', message: 'GitLab CI configuration action is stale', error: 'The reviewed repository, branch, or program identity changed; re-run hv_plan.' };
  }
  const plannedFiles = Array.isArray(params.action.metadata?.files) ? params.action.metadata.files : [];
  const currentFileContract = rendered.files.map((file) => ({ path: file.path, hash: file.hash }));
  if (JSON.stringify(plannedFiles) !== JSON.stringify(currentFileContract)) {
    return { success: false, status: 'blocked', message: 'GitLab CI configuration action is stale', error: 'The reviewed file set changed; re-run hv_plan.' };
  }
  const root = await context.adapter.observeFile(context.repository, rootPath, context.repository.defaultBranch);
  if (root.state === 'unknown') return { success: false, status: 'blocked', message: 'Cannot observe GitLab CI root', error: root.reason };
  if (root.state === 'present' && !root.value.content.startsWith(`${ROOT_MARKER}\n`)) {
    return { success: false, status: 'blocked', message: 'GitLab CI root is unmanaged', error: `Hypervibe will not rewrite ${rootPath}.` };
  }
  const base = await context.adapter.observeBranch(context.repository, context.repository.defaultBranch);
  if (base.state !== 'present' || base.value.sha !== baseSha) {
    return { success: false, status: 'blocked', message: 'GitLab CI configuration action is stale', error: 'The default branch advanced or became unknown; re-run hv_plan.' };
  }
  const active = await observeFiles(context, rendered.files, context.repository.defaultBranch);
  if ('error' in active) return { success: false, status: 'blocked', message: 'Cannot observe GitLab CI files', error: active.error };
  if (active.exact) {
    const binding = configurationBindingForSpec(params.project, params.spec);
    if (!configurationOwnershipMatches(binding, context, rendered.programHash)) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab CI configuration is exact but unowned',
        error: 'The active files appeared without the reviewed Hypervibe proposal binding; re-plan instead of adopting them implicitly.',
      };
    }
    return { success: true, message: 'GitLab CI configuration is already merged', data: { programHash: rendered.programHash } };
  }

  const ownershipBinding = configurationBindingForSpec(params.project, params.spec);
  const repositoryOwned = bindingMatchesRepository(ownershipBinding, context);
  const ownedPaths = new Set(boundConfigurationPaths(ownershipBinding));

  const proposalBranch = await context.adapter.observeBranch(context.repository, branchName);
  let proposalSha: string;
  if (proposalBranch.state === 'unknown') {
    return { success: false, status: 'blocked', message: 'Cannot observe GitLab proposal branch', error: proposalBranch.reason };
  }
  if (proposalBranch.state === 'present') {
    const proposed = await observeFiles(context, rendered.files, branchName);
    if ('error' in proposed || !proposed.exact) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab proposal branch cannot be reused safely',
        error: 'The deterministic branch contains unexpected or partial content; inspect it and re-plan after resolving it.',
      };
    }
    let comparison;
    try {
      comparison = await context.adapter.compareRepository(context.repository, baseSha, proposalBranch.value.sha);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab proposal branch provenance is unknown',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const managedPaths = new Set(rendered.files.map((file) => file.path));
    if (
      comparison.commits.length !== 1
      || comparison.commits[0]?.id !== proposalBranch.value.sha
      || comparison.paths.some((path) => !managedPaths.has(path))
    ) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab proposal branch cannot be reused safely',
        error: 'The branch has extra commits, unrelated file changes, or does not descend from the reviewed base SHA.',
      };
    }
    proposalSha = proposalBranch.value.sha;
  } else {
    const actions = [];
    for (const file of rendered.files) {
      const current = await context.adapter.observeFile(context.repository, file.path, context.repository.defaultBranch);
      if (current.state === 'unknown') return { success: false, status: 'blocked', message: 'Cannot observe GitLab CI file', error: current.reason };
      if (current.state === 'present' && (!repositoryOwned || !ownedPaths.has(file.path))) {
        return {
          success: false,
          status: 'blocked',
          message: 'GitLab CI managed path is unowned',
          error: `${file.path} appeared outside the reviewed ownership binding; re-run hv_plan instead of overwriting it.`,
        };
      }
      if (current.state === 'present' && !current.value.lastCommitId) {
        return {
          success: false,
          status: 'blocked',
          message: 'GitLab CI file concurrency is unknown',
          error: `${file.path} has no provider-observed last commit id.`,
        };
      }
      actions.push(current.state === 'present'
        ? {
            action: 'update' as const,
            path: file.path,
            content: file.content,
            lastCommitId: current.value.lastCommitId,
          }
        : { action: 'create' as const, path: file.path, content: file.content });
    }
    const commit = await context.adapter.createCommit(context.repository, {
      branch: branchName,
      startSha: baseSha,
      commitMessage: 'Configure Hypervibe GitLab CI deploys',
      actions,
    });
    proposalSha = commit.id;
  }
  const proposalProof = await proveConfigurationAtRef(
    context,
    rendered.files,
    rendered.jobNames,
    branchName,
    proposalSha
  );
  if ('error' in proposalProof) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitLab rejected or could not prove the proposed CI configuration',
      error: proposalProof.error,
    };
  }
  const open = await context.adapter.listChangeRequests(context.repository, {
    sourceBranch: branchName,
    targetBranch,
    state: 'opened',
  });
  if (open.length > 1) {
    return { success: false, status: 'blocked', message: 'Multiple GitLab merge requests match the managed branch', error: 'Close the duplicate merge requests, then re-run hv_plan.' };
  }
  if (open.length === 0) {
    const [closed, merged] = await Promise.all([
      context.adapter.listChangeRequests(context.repository, {
        sourceBranch: branchName,
        targetBranch,
        state: 'closed',
      }),
      context.adapter.listChangeRequests(context.repository, {
        sourceBranch: branchName,
        targetBranch,
        state: 'merged',
      }),
    ]);
    if (closed.length > 0 || merged.length > 0) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab proposal branch has prior merge-request history',
        error: 'Hypervibe will not reopen or replace a closed/merged proposal under the same reviewed action; re-run hv_plan after resolving the branch.',
      };
    }
  }
  if (open[0]?.sourceSha && open[0].sourceSha !== proposalSha) {
    return {
      success: false,
      status: 'blocked',
      message: 'GitLab merge request head changed',
      error: 'The open merge request no longer points at the exact reviewed proposal commit.',
    };
  }
  const mergeRequest = open[0] ?? await context.adapter.createChangeRequest(context.repository, {
    sourceBranch: branchName,
    targetBranch,
    title: 'Configure Hypervibe GitLab CI deploys',
    description: [
      'Hypervibe-generated, provider-reviewed CI configuration.',
      '',
      `Program fingerprint: ${rendered.programHash}`,
      'Merging enables exact-SHA image builds and Railway deploy jobs. CI variables are synced only after Hypervibe observes this merged configuration and its deployment protections.',
    ].join('\n'),
  });
  persistConfigurationProposal({
    project: params.project,
    environmentName: params.environmentName,
    context,
    files: rendered.files,
    programHash: rendered.programHash,
    proposalBranch: branchName,
    proposalSha,
    targetBranch,
  });
  return {
    success: false,
    status: 'pending',
    message: 'GitLab CI configuration merge request is waiting for human review',
    data: {
      mergeRequest: mergeRequest.webUrl,
      mergeRequestNumber: mergeRequest.number,
      proposalBranch: branchName,
      proposalSha,
      targetBranch,
      programHash: rendered.programHash,
    },
  };
}

export const gitLabCiLifecycle: CiLifecyclePort = {
  planDeploy,
  async applyDeploy(params) {
    if (params.action.metadata?.operation === CI_CONFIGURATION_SYNC_OPERATION) {
      return applyConfiguration(params);
    }
    if (params.action.metadata?.operation === CI_VARIABLE_SYNC_OPERATION) {
      return applyVariable(params);
    }
    return { success: false, status: 'blocked', message: 'Unsupported GitLab CI deploy action', error: 'Re-run hv_plan with the current Hypervibe version.' };
  },
  async planAppliedSpecHash(params) {
    if (params.environmentSpec.deploy?.strategy !== 'branch' || params.environmentSpec.deploy.trigger === 'native') {
      return { warnings: [] };
    }
    return planVariables({
      project: params.project,
      spec: params.spec,
      environmentName: params.environmentName,
      dependsOn: params.dependsOn,
      appliedSpecOnly: true,
    });
  },
  async applyAppliedSpecHash(params) {
    return applyVariable(params);
  },
};
