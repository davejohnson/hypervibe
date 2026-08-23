import { createHash } from 'crypto';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import { gitLabShellLiteral } from '../railway/railway-ci.recipe.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Project } from '../../../domain/entities/project.entity.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';
import type { CiVariableObservation, CodeChangeRequest, CodeRepositoryIdentity } from '../../../domain/ports/devops.port.js';
import type { CiApplyResult, CiLifecyclePort, CiLifecycleResult } from '../../../domain/registry/devops.registry.js';
import type { EnvironmentSpec, ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { environmentDeploymentContractHashForApply } from '../../../domain/services/deployment-contract.service.js';
import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../domain/ports/ci-deploy.port.js';
import { resolveReviewedBranchDeployTargets } from '../../../domain/services/managed-ci-targets.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { buildPortableContainerArchiveRuntime } from '../../../domain/services/portable-container-build.js';
import { HYPERVIBE_MANAGED_NODE_SLIM_IMAGE } from '../../../domain/services/managed-runtime.js';
import { normalizeGitRemoteIdentity } from '../../../lib/git-remote.js';
import {
  CI_BINDING_REMOVE_OPERATION,
  CI_APPLIED_SPEC_SYNC_OPERATION,
  CI_CONFIGURATION_SYNC_OPERATION,
  CI_VARIABLE_DELETE_OPERATION,
  CI_VARIABLE_SYNC_OPERATION,
} from '../../../domain/services/managed-ci.contract.js';
import {
  GitLabAdapter,
  type GitLabCredentials,
  type GitLabProject,
} from './gitlab.adapter.js';

const ROOT_MARKER = '# hypervibe-managed: gitlab-ci/v1';
const MANIFEST_PATH = '.gitlab/hypervibe/manifest.yml';
export const GITLAB_DEPLOYMENT_GATE_PATH = '.gitlab/hypervibe/verify-deployment-order.mjs';
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

type GitLabVariableKeys = { appliedSpecHash: string; values: Record<string, string> };

type GitLabContext = {
  adapter: GitLabAdapter;
  credentials: GitLabCredentials;
  actorId: string;
  repository: CodeRepositoryIdentity;
  project: GitLabProject;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gitLabVariableKeys(
  spec: ProjectSpec,
  environmentName: string,
  valueNames: string[] = []
): GitLabVariableKeys {
  const namespace = sha256(`${spec.devops?.code.scope ?? ''}\0${environmentName}`)
    .slice(0, 16)
    .toUpperCase();
  const key = (suffix: string) => `HYPERVIBE_${namespace}_${suffix}`;
  const normalized = valueNames.map((name) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new Error(`Portable CI value name ${name} is not a safe environment variable name`);
    }
    return [name, key(name)] as const;
  });
  if (new Set(normalized.map(([, physical]) => physical)).size !== normalized.length) {
    throw new Error('Portable CI value names collide after GitLab variable normalization');
  }
  return {
    appliedSpecHash: key('APPLIED_SPEC_HASH'),
    values: Object.fromEntries(normalized),
  };
}

function recipeFor(providerName: string, target: BranchDeployTarget): PortableCiDeployRecipe {
  const provider = providerRegistry.get(providerName);
  const builder = provider?.metadata.orchestration?.ci?.buildPortableRecipe;
  if (!builder) {
    throw new Error(`Hosting provider ${providerName} does not declare a provider-neutral CI deploy recipe`);
  }
  const recipe = builder(target);
  if (recipe.provider !== providerName || recipe.version !== 1) {
    throw new Error(`Hosting provider ${providerName} returned a mismatched portable CI recipe`);
  }
  const declaredCapabilities = [...(provider.metadata.orchestration?.ci?.portableRunnerCapabilities ?? [])].sort();
  const recipeCapabilities = [...recipe.runnerCapabilities].sort();
  if (JSON.stringify(declaredCapabilities) !== JSON.stringify(recipeCapabilities)) {
    throw new Error(`Hosting provider ${providerName} returned runner capabilities that differ from its registered CI contract`);
  }
  const names = recipe.values.map((value) => value.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Hosting provider ${providerName} returned duplicate portable CI values`);
  }
  if (
    recipe.runtime.path.startsWith('/')
    || recipe.runtime.path.includes('\\')
    || recipe.runtime.path.split('/').some((part) => part === '..' || part === '.')
    || !recipe.runtime.path.startsWith('.gitlab/hypervibe/')
  ) {
    throw new Error(`Hosting provider ${providerName} returned an unsafe portable CI runtime path`);
  }
  for (const dependency of recipe.runtime.npmPackages ?? []) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+(?:-[A-Za-z0-9_.-]+)?$/.test(dependency)) {
      throw new Error(`Hosting provider ${providerName} returned an unpinned portable CI runtime dependency`);
    }
  }
  return recipe;
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

function runnerTag(spec: ProjectSpec): string {
  const runner = spec.devops?.ci?.runner;
  return runner?.mode === 'self-managed' ? runner.tag : GITLAB_SAAS_RUNNER_TAG;
}

function requiredRunnerCapabilities(spec: ProjectSpec): string[] {
  const capabilities = new Set<string>(['linux-amd64']);
  for (const environment of Object.values(spec.environments)) {
    if (environment.deploy?.strategy !== 'branch' || environment.deploy.trigger === 'native') continue;
    const required = providerRegistry.get(environment.hosting.provider)
      ?.metadata.orchestration?.ci?.portableRunnerCapabilities ?? [];
    for (const capability of required) capabilities.add(capability);
  }
  return [...capabilities].sort();
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
  const canonicalBinding = canonical ? gitLabCiBinding(project.id, canonical) : null;
  if (canonicalBinding) return canonicalBinding;
  for (const environment of new EnvironmentRepository().findByProjectId(project.id)) {
    const binding = gitLabCiBinding(project.id, environment.name);
    if (binding && (asRecord(binding.configurationActive) || asRecord(binding.configurationProposal))) {
      return binding;
    }
  }
  return null;
}

function configurationOwnerEnvironment(project: Project, spec: ProjectSpec): string | null {
  const canonical = canonicalEnvironment(spec, managedTargets(project, spec));
  if (canonical && gitLabCiBinding(project.id, canonical)) return canonical;
  for (const environment of new EnvironmentRepository().findByProjectId(project.id)) {
    const binding = gitLabCiBinding(project.id, environment.name);
    if (binding && (asRecord(binding.configurationActive) || asRecord(binding.configurationProposal))) {
      return environment.name;
    }
  }
  return canonical;
}

function managedTargets(project: Project, spec: ProjectSpec): BranchDeployTarget[] {
  const targets = resolveReviewedBranchDeployTargets(project, spec).targets;
  return targets.filter((target) => {
    const environment = spec.environments[target.environmentName];
    return environment?.deploy?.strategy === 'branch'
      && environment.deploy.trigger !== 'native';
  });
}

function renderRules(target: BranchDeployTarget): string {
  const rules: string[] = [];
  const rollbackTagPrefix = `hypervibe-rollback-${safeSlug(target.environmentName)}-`;
  if (target.autoDeployOnPush) {
    rules.push(`    - if: ${yamlString(`$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${gitLabExpressionString(target.branch)}`)}`);
  }
  rules.push(`    - if: ${yamlString(`($CI_PIPELINE_SOURCE == "api" || $CI_PIPELINE_SOURCE == "web") && $CI_COMMIT_BRANCH == ${gitLabExpressionString(target.branch)} && "$[[ inputs.environment ]]" == ${gitLabExpressionString(target.environmentName)} && "$[[ inputs.rollback ]]" == "false"`)}`);
  rules.push(`    - if: ${yamlString(`$CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_TAG =~ /^${rollbackTagPrefix}[a-z0-9-]+$/ && "$[[ inputs.environment ]]" == ${gitLabExpressionString(target.environmentName)} && "$[[ inputs.rollback ]]" == "true"`)}`);
  rules.push('    - when: never');
  return rules.join('\n');
}

export function buildGitLabDeploymentGateRuntime(): string {
  return `const required = ['CI_API_V4_URL', 'CI_PROJECT_ID', 'CI_JOB_ID', 'CI_PIPELINE_ID', 'CI_JOB_TOKEN', 'CI_COMMIT_SHA', 'CI_COMMIT_REF_NAME', 'HYPERVIBE_ENVIRONMENT', 'HYPERVIBE_ROLLBACK', 'HYPERVIBE_EXPECTED_LATEST_RUN_ID', 'HYPERVIBE_SOURCE_ARTIFACT_ID', 'HYPERVIBE_SOURCE_PIPELINE_ID'];
for (const key of required) if (process.env[key] === undefined) throw new Error(key + ' is required for the deployment-order gate');
const numeric = (value, label) => {
  if (!/^[1-9]\\d*$/.test(value)) throw new Error(label + ' must be a positive GitLab id');
  return BigInt(value);
};
const projectId = process.env.CI_PROJECT_ID;
const jobId = process.env.CI_JOB_ID;
const pipelineId = process.env.CI_PIPELINE_ID;
numeric(projectId, 'CI_PROJECT_ID'); numeric(jobId, 'CI_JOB_ID'); numeric(pipelineId, 'CI_PIPELINE_ID');
if (!/^[0-9a-f]{40}$/i.test(process.env.CI_COMMIT_SHA)) throw new Error('CI_COMMIT_SHA must be a full Git SHA');
if (!['false', 'true'].includes(process.env.HYPERVIBE_ROLLBACK)) throw new Error('HYPERVIBE_ROLLBACK is invalid');
const endpoint = new URL(process.env.CI_API_V4_URL.replace(/\\/+$/, '') + '/projects/' + encodeURIComponent(projectId) + '/deployments');
endpoint.searchParams.set('environment', process.env.HYPERVIBE_ENVIRONMENT);
endpoint.searchParams.set('order_by', 'id'); endpoint.searchParams.set('sort', 'desc'); endpoint.searchParams.set('per_page', '100');
let deployments;
for (let attempt = 0; attempt < 6; attempt++) {
  const response = await fetch(endpoint, { headers: { Accept: 'application/json', 'JOB-TOKEN': process.env.CI_JOB_TOKEN } });
  if (!response.ok) throw new Error('GitLab deployment-order observation failed with HTTP ' + response.status);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error('GitLab deployment-order observation was not a list');
  deployments = value.filter((entry) => entry?.environment?.name === process.env.HYPERVIBE_ENVIRONMENT);
  const matches = deployments.filter((entry) => String(entry?.deployable?.id) === jobId && String(entry?.deployable?.pipeline?.id) === pipelineId);
  if (matches.length === 1) break;
  if (matches.length > 1) throw new Error('GitLab exposed duplicate deployment identities for this job');
  if (attempt === 5) throw new Error('GitLab did not expose the current deployment identity before provider mutation');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const current = deployments.filter((entry) => String(entry?.deployable?.id) === jobId && String(entry?.deployable?.pipeline?.id) === pipelineId)[0];
if (!current || String(current.sha).toLowerCase() !== process.env.CI_COMMIT_SHA.toLowerCase() || current.ref !== process.env.CI_COMMIT_REF_NAME) throw new Error('GitLab current deployment provenance is inconsistent');
const currentId = numeric(String(current.id), 'current deployment id');
const newer = deployments.filter((entry) => numeric(String(entry.id), 'deployment id') > currentId);
if (newer.length > 0) throw new Error('A newer GitLab deployment exists for this environment; refusing stale provider mutation');
const prior = deployments.filter((entry) => numeric(String(entry.id), 'deployment id') < currentId);
if (process.env.HYPERVIBE_ROLLBACK === 'true') {
  const expected = numeric(process.env.HYPERVIBE_EXPECTED_LATEST_RUN_ID, 'expected latest pipeline id');
  const sourcePipeline = numeric(process.env.HYPERVIBE_SOURCE_PIPELINE_ID, 'source pipeline id');
  if (!/^[1-9]\\d*:\\.hypervibe-release\\.json$/.test(process.env.HYPERVIBE_SOURCE_ARTIFACT_ID)) throw new Error('Rollback source artifact identity is invalid');
  if (expected >= numeric(pipelineId, 'CI_PIPELINE_ID') || sourcePipeline > expected) throw new Error('Rollback pipeline evidence ordering is invalid');
  const intervening = prior.filter((entry) => {
    const value = String(entry?.deployable?.pipeline?.id ?? '');
    return /^[1-9]\\d*$/.test(value) && BigInt(value) > expected;
  });
  if (intervening.length > 0) throw new Error('A deployment newer than the reviewed rollback observation exists');
  const tagPrefix = 'hypervibe-rollback-' + process.env.HYPERVIBE_ENVIRONMENT.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-';
  if (!process.env.CI_COMMIT_REF_NAME.startsWith(tagPrefix)) throw new Error('Rollback deployment is not running from the protected environment tag');
} else if (process.env.HYPERVIBE_EXPECTED_LATEST_RUN_ID || process.env.HYPERVIBE_SOURCE_ARTIFACT_ID || process.env.HYPERVIBE_SOURCE_PIPELINE_ID) {
  throw new Error('Non-rollback deployment received rollback-only evidence');
}
`;
}

function renderEnvironmentJobs(
  spec: ProjectSpec,
  target: BranchDeployTarget,
  hostingProvider: string,
  recipe: PortableCiDeployRecipe,
  buildRuntimePath: string,
  programFingerprint: string
): string {
  const slug = safeSlug(target.environmentName);
  const appliedHash = environmentDeploymentContractHashForApply(spec, target.environmentName);
  const keys = gitLabVariableKeys(spec, target.environmentName, recipe.values.map((value) => value.name));
  const rules = renderRules(target);
  const selectedRunnerTag = runnerTag(spec);
  const buildJob = `hypervibe:build:${hostingProvider}:${slug}`;
  const deployJob = `hypervibe:deploy:${hostingProvider}:${slug}`;
  const container = recipe.kind === 'container';
  const valueExports = recipe.values
    .map((value) => `      export ${value.name}="$${keys.values[value.name]}"`)
    .join('\n');
  const dependencyInstall = recipe.runtime.npmPackages?.length
    ? `      npm install --prefix .hypervibe-runtime --ignore-scripts --no-save ${recipe.runtime.npmPackages.map(gitLabShellLiteral).join(' ')}\n      export NODE_PATH="$PWD/.hypervibe-runtime/node_modules"\n`
    : '';
  return `spec:
  inputs:
    environment:
      type: string
    commit_sha:
      type: string
    rollback:
      type: string
      options: ['false', 'true']
      default: 'false'
    expected_latest_run_id:
      type: string
      default: ''
    source_artifact_id:
      type: string
      default: ''
    source_pipeline_id:
      type: string
      default: ''
---
${buildJob}:
  stage: build
  image: docker:27.5.1-git
${container ? `  services:
    - name: docker:27.5.1-dind
` : ''}  tags:
    - ${selectedRunnerTag}
  inherit:
    default: false
    variables: false
  interruptible: true
  timeout: 30m
${container ? `  variables:
    DOCKER_TLS_CERTDIR: "/certs"
` : ''}  rules:
${rules}
  before_script: []
  script:
    - |
      set -eu
      test "$${keys.appliedSpecHash}" = ${gitLabShellLiteral(appliedHash)}
${container
    ? `      sh ${buildRuntimePath} "$[[ inputs.commit_sha ]]"`
    : `      deploy_sha="$(git rev-parse HEAD)"
      case "$deploy_sha" in *[!0-9a-fA-F]*|'') exit 1 ;; esac
      test "\${#deploy_sha}" -eq 40
      test "$deploy_sha" = "$[[ inputs.commit_sha ]]"
      printf '%s\\n' "$deploy_sha" > .hypervibe-deploy-sha`}
  after_script: []
  artifacts:
    expire_in: 30 days
    paths:
${container ? '      - .hypervibe-image-uri\n      - .hypervibe-docker\n' : ''}      - .hypervibe-deploy-sha

${deployJob}:
  stage: deploy
  image: ${HYPERVIBE_MANAGED_NODE_SLIM_IMAGE}
${container ? `  services:
    - name: docker:27.5.1-dind
` : ''}  tags:
    - ${selectedRunnerTag}
  inherit:
    default: false
    variables: false
  interruptible: false
  resource_group: ${yamlString(`hypervibe-${target.environmentName}`)}
  timeout: 20m
  environment:
    name: ${yamlString(target.environmentName)}
  needs:
    - job: ${buildJob}
      artifacts: true
${container ? `  variables:
    DOCKER_TLS_CERTDIR: "/certs"
` : ''}  rules:
${rules}
  before_script: []
  script:
    - |
      set -eu
      test "$${keys.appliedSpecHash}" = ${gitLabShellLiteral(appliedHash)}
      export HYPERVIBE_REPOSITORY=${gitLabShellLiteral(spec.devops!.code.scope)}
      export HYPERVIBE_ENVIRONMENT=${gitLabShellLiteral(target.environmentName)}
      export HYPERVIBE_PROGRAM_FINGERPRINT=${gitLabShellLiteral(programFingerprint)}
      export HYPERVIBE_ROLLBACK="$[[ inputs.rollback ]]"
      export HYPERVIBE_SOURCE_ARTIFACT_ID="$[[ inputs.source_artifact_id ]]"
      export HYPERVIBE_SOURCE_PIPELINE_ID="$[[ inputs.source_pipeline_id ]]"
      export HYPERVIBE_EXPECTED_LATEST_RUN_ID="$[[ inputs.expected_latest_run_id ]]"
      node ${GITLAB_DEPLOYMENT_GATE_PATH}
${valueExports}
${dependencyInstall}      node ${recipe.runtime.path}
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
  if (targets.length === 0) {
    return {
      files: [],
      programHash: sha256(JSON.stringify({ version: PROGRAM_VERSION, provider: 'gitlab-ci', targets: [] })),
      jobNames: [],
    };
  }
  const unsupported = Object.entries(spec.environments).filter(([, environment]) => (
    environment.deploy?.strategy === 'branch'
    && environment.deploy.trigger !== 'native'
    && !providerRegistry.get(environment.hosting.provider)?.metadata.orchestration?.ci?.buildPortableRecipe
  ));
  if (unsupported.length > 0) {
    throw new Error(`GitLab CI has no provider-neutral deploy recipe for environments: ${unsupported.map(([name]) => name).join(', ')}`);
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
    throw new Error('GitLab CI does not yet deploy declared cron jobs');
  }
  const slugs = targets.map((target) => safeSlug(target.environmentName));
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('GitLab CI environment names collide after safe job-id normalization');
  }

  const runtime = spec.runtime;
  const descriptors = targets.map((target) => {
    const provider = spec.environments[target.environmentName]!.hosting.provider;
    return {
      target,
      provider,
      recipe: recipeFor(provider, target),
      buildRuntimePath: `.gitlab/hypervibe/build-${safeSlug(provider)}-${safeSlug(target.environmentName)}.sh`,
      startCommand: target.containerStartCommand,
    };
  });
  const semanticProgram = JSON.stringify({
    version: PROGRAM_VERSION,
    provider: 'gitlab-ci',
    repository: spec.devops?.code,
    runtime,
    deploymentGateHash: sha256(buildGitLabDeploymentGateRuntime()),
    targets: descriptors.map(({ target, provider, recipe, startCommand }) => ({
      environment: target.environmentName,
      provider,
      branch: target.branch,
      autoDeployOnPush: target.autoDeployOnPush,
      promoteFromEnvironment: target.promoteFromEnvironment,
      appliedSpecHash: environmentDeploymentContractHashForApply(spec, target.environmentName),
      startCommand,
      recipe: {
        version: recipe.version,
        kind: recipe.kind,
        runnerCapabilities: [...recipe.runnerCapabilities].sort(),
        values: recipe.values,
        runtimePath: recipe.runtime.path,
        runtimeHash: sha256(recipe.runtime.content),
      },
    })),
  });
  const programHash = sha256(semanticProgram);
  const jobNames = descriptors.flatMap(({ target, provider }) => {
    const slug = safeSlug(target.environmentName);
    return [`hypervibe:build:${provider}:${slug}`, `hypervibe:deploy:${provider}:${slug}`];
  });
  const deployFiles = descriptors.map(({ target, provider, recipe, buildRuntimePath }) => ({
    path: `.gitlab/hypervibe/deploy-${safeSlug(provider)}-${safeSlug(target.environmentName)}.yml`,
    content: renderEnvironmentJobs(spec, target, provider, recipe, buildRuntimePath, programHash),
  }));
  const manifest = `# hypervibe-managed: gitlab-ci-manifest/v1
spec:
  inputs:
    environment:
      type: string
    commit_sha:
      type: string
    rollback:
      type: string
      options: ['false', 'true']
      default: 'false'
    expected_latest_run_id:
      type: string
      default: ''
    source_artifact_id:
      type: string
      default: ''
    source_pipeline_id:
      type: string
      default: ''
---
include:
${deployFiles.map((file) => `  - local: '/${file.path}'
    inputs:
      environment: "$[[ inputs.environment ]]"
      commit_sha: "$[[ inputs.commit_sha ]]"
      rollback: "$[[ inputs.rollback ]]"
      expected_latest_run_id: "$[[ inputs.expected_latest_run_id ]]"
      source_artifact_id: "$[[ inputs.source_artifact_id ]]"
      source_pipeline_id: "$[[ inputs.source_pipeline_id ]]"`).join('\n')}
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
    rollback:
      type: string
      options: ['false', 'true']
      default: 'false'
    expected_latest_run_id:
      type: string
      default: ''
    source_artifact_id:
      type: string
      default: ''
    source_pipeline_id:
      type: string
      default: ''
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
      rollback: "$[[ inputs.rollback ]]"
      expected_latest_run_id: "$[[ inputs.expected_latest_run_id ]]"
      source_artifact_id: "$[[ inputs.source_artifact_id ]]"
      source_pipeline_id: "$[[ inputs.source_pipeline_id ]]"
`;
  const runtimeFiles = new Map<string, string>([
    [GITLAB_DEPLOYMENT_GATE_PATH, buildGitLabDeploymentGateRuntime()],
  ]);
  for (const { target, recipe, buildRuntimePath, startCommand } of descriptors) {
    if (recipe.kind === 'container') {
      runtimeFiles.set(buildRuntimePath, buildPortableContainerArchiveRuntime(runtime, startCommand));
    }
    const current = runtimeFiles.get(recipe.runtime.path);
    if (current !== undefined && current !== recipe.runtime.content) {
      throw new Error(`Portable CI runtimes for ${target.environmentName} collide at ${recipe.runtime.path}`);
    }
    runtimeFiles.set(recipe.runtime.path, recipe.runtime.content);
  }
  const rawFiles = [
    { path: rootPath, content: root },
    { path: MANIFEST_PATH, content: manifest },
    ...deployFiles,
    ...[...runtimeFiles].map(([path, content]) => ({ path, content })),
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
        ? `GitLab project ${selection.code.scope} does not exist; converge its explicit managed repository lifecycle in the canonical environment before planning CI`
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
  let actor: { id: string; username: string };
  try {
    actor = await adapter.getCurrentUser();
  } catch (error) {
    return { error: `GitLab authenticated user identity is unknown: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { adapter, credentials, actorId: actor.id, repository: observation.value, project };
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

async function observeAbsentPaths(
  context: GitLabContext,
  paths: string[],
  ref: string
): Promise<{ absent: boolean } | { error: string }> {
  for (const path of paths) {
    const observed = await context.adapter.observeFile(context.repository, path, ref);
    if (observed.state === 'unknown') return { error: observed.reason };
    if (observed.state === 'present') return { absent: false };
  }
  return { absent: true };
}

function branchPatternMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(branch);
}

async function verifyRunnerPolicy(context: GitLabContext, spec: ProjectSpec): Promise<string | null> {
  const selection = spec.devops?.ci?.runner ?? { mode: 'provider-hosted' as const };
  const tag = runnerTag(spec);
  try {
    const runners = await context.adapter.listProjectRunners(
      context.repository.nativeId,
      tag
    );
    if (selection.mode === 'self-managed') {
      const required = requiredRunnerCapabilities(spec);
      const missing = required.filter((capability) => !selection.capabilities.includes(capability as 'linux-amd64' | 'docker-privileged'));
      if (missing.length > 0) {
        return `The self-managed runner binding is missing required capabilities: ${missing.join(', ')}`;
      }
      const selected = runners.filter((runner) => runner.id === selection.runnerId);
      if (selected.length !== 1) {
        return `GitLab did not resolve exact self-managed runner ${selection.runnerId} with dedicated tag ${tag}`;
      }
      const conflicts = runners.filter((runner) => runner.id !== selection.runnerId);
      if (conflicts.length > 0) {
        return `Other runners can claim dedicated self-managed tag ${tag}: ${conflicts.map((runner) => runner.id).join(', ')}`;
      }
      const details = await context.adapter.getRunner(selection.runnerId);
      if (
        details.runnerType !== 'project_type'
        || details.status !== 'online'
        || details.paused
        || !details.locked
        || details.runUntagged
        || details.accessLevel !== 'ref_protected'
        || !details.tags.includes(tag)
      ) {
        return `Self-managed runner ${selection.runnerId} must be an online, unpaused, locked project runner restricted to protected refs, with untagged jobs disabled`;
      }
      const expectedAttestation = `hypervibe-capabilities:${[...selection.capabilities].sort().join(',')}`;
      if (details.maintenanceNote !== expectedAttestation) {
        return `Self-managed runner ${selection.runnerId} must expose the exact provider-observed maintenance-note attestation ${expectedAttestation}`;
      }
      const managers = await context.adapter.listRunnerManagers(selection.runnerId);
      const online = managers.filter((manager) => manager.status === 'online');
      if (managers.length !== 1 || online.length !== 1 || online[0]?.systemId !== selection.managerSystemId) {
        return `Self-managed runner ${selection.runnerId} must have exactly one registered manager, online with system id ${selection.managerSystemId}`;
      }
      if (online[0].platform !== 'linux' || online[0].architecture !== 'amd64') {
        return `Self-managed runner manager ${selection.managerSystemId} must report linux/amd64`;
      }
      return null;
    }
    if (context.repository.instanceScope !== 'https://gitlab.com') {
      return 'Provider-hosted GitLab runners are supported only on GitLab.com; declare one exact self-managed runner binding for this instance';
    }
    if (runners.length === 0) {
      return `No GitLab.com hosted runner with tag ${tag} is available to the project`;
    }
    if (runners.some((runner) => runner.runnerType !== 'instance_type')) {
      return `A project or group runner can claim the trusted ${tag} tag; remove that conflicting runner before managed secret sync`;
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
  spec: ProjectSpec,
  target: BranchDeployTarget
): Promise<string | null> {
  try {
  const runnerProblem = await verifyRunnerPolicy(context, spec);
  if (runnerProblem) return runnerProblem;
  const access = Math.max(
    context.project.permissions?.project_access?.access_level ?? 0,
    context.project.permissions?.group_access?.access_level ?? 0
  );
  if (access < 40) return 'GitLab Maintainer-or-higher project access was not proven';
  if (context.project.ci_pipeline_variables_minimum_override_role !== 'no_one_allowed') {
    return 'GitLab pipeline-variable override policy must be no_one_allowed before managed deploy variables can be synced';
  }
  const hostingProvider = spec.environments[target.environmentName]?.hosting.provider;
  if (!hostingProvider) return `Hosting provider is missing for ${target.environmentName}`;
  const recipe = recipeFor(hostingProvider, target);
  const registryEnabled = context.project.container_registry_access_level === 'enabled'
    || context.project.container_registry_access_level === 'private'
    || (
      context.project.container_registry_access_level === undefined
      && context.project.container_registry_enabled === true
    );
  if (recipe.kind === 'container' && !registryEnabled) {
    return 'The GitLab project container registry is disabled or could not be proven enabled';
  }
  if (recipe.kind === 'container') {
    const registryPull = await context.adapter.verifyRegistryPull(context.project);
    if (!registryPull.success) {
      return `The project-scoped GitLab registry pull credential was not verified: ${registryPull.error}`;
    }
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
  const rollbackTagPattern = `hypervibe-rollback-${safeSlug(target.environmentName)}-*`;
  const protectedTags = await context.adapter.listProtectedTags(context.repository.nativeId);
  const matchingTags = protectedTags.filter((rule) => branchPatternMatches(rule.name, rollbackTagPattern.replace('*', 'probe')));
  if (matchingTags.length !== 1) {
    return `GitLab must expose exactly one protected-tag rule for ${rollbackTagPattern}`;
  }
  if (
    matchingTags[0]!.name !== rollbackTagPattern
    || matchingTags[0]!.createAccessLevels.length !== 1
    || matchingTags[0]!.createAccessLevels[0]?.userId !== Number(context.actorId)
    || matchingTags[0]!.createAccessLevels[0]?.accessLevel !== undefined
    || matchingTags[0]!.createAccessLevels[0]?.groupId !== undefined
    || matchingTags[0]!.createAccessLevels[0]?.deployKeyId !== undefined
  ) {
    return `GitLab protected rollback tags for ${target.environmentName} must use the exact ${rollbackTagPattern} wildcard and allow only authenticated GitLab user ${context.actorId}`;
  }
  if (context.project.ci_forward_deployment_enabled !== true) {
    return 'GitLab forward deployment protection must be enabled for every managed environment';
  }
  if (context.project.ci_forward_deployment_rollback_allowed !== false) {
    return 'GitLab rollback job retries must be disabled so an old deployment job cannot be replayed outside the reviewed rollback pipeline';
  }
  if (target.kind === 'production') {
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
  commitSha: string,
  removedPaths: string[] = []
): Promise<{ commitSha: string } | { error: string }> {
  const observed = await observeFiles(context, files, ref);
  if ('error' in observed) return observed;
  if (!observed.exact) return { error: `The Hypervibe GitLab CI configuration is not exact at ${ref}` };
  const removed = await observeAbsentPaths(context, removedPaths, ref);
  if ('error' in removed) return removed;
  if (!removed.absent) return { error: `Obsolete Hypervibe GitLab CI files remain at ${ref}` };
  if (files.length === 0) return { commitSha };
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
  jobNames: string[],
  removedPaths: string[] = []
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
    branch.value.sha,
    removedPaths
  );
}

function configAction(
  context: GitLabContext,
  files: ManagedFile[],
  programHash: string,
  baseSha: string,
  removedPaths: string[],
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
      removedPaths,
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

function variableDeleteAction(
  context: GitLabContext,
  environmentName: string,
  variable: CiVariableObservation,
  ownedHash: string,
  programHash: string
): PlanAction {
  return {
    id: `ci:gitlab-ci:${environmentName}:variable:${variable.key}:destroy`,
    type: 'destroy',
    resource: { kind: 'secret', name: `${environmentName}:${variable.key}`, provider: 'gitlab-ci' },
    verified: true,
    dataBearing: true,
    requiresConfirm: true,
    reason: `Delete the exact owned GitLab CI variable ${variable.key} after managed jobs are absent`,
    metadata: {
      operation: CI_VARIABLE_DELETE_OPERATION,
      codeProvider: 'gitlab',
      ciProvider: 'gitlab-ci',
      repositoryId: context.repository.nativeId,
      instanceScope: context.repository.instanceScope,
      repositoryScope: context.repository.canonicalScope,
      environmentName,
      variableKey: variable.key,
      environmentScope: variable.scope,
      valueHash: ownedHash,
      programHash,
    },
  };
}

function bindingRemoveAction(
  context: GitLabContext,
  environmentName: string,
  programHash: string,
  dependsOn: string[]
): PlanAction {
  return {
    id: `ci:gitlab-ci:${environmentName}:binding:remove`,
    type: 'update',
    resource: { kind: 'ci', name: `binding:${environmentName}`, provider: 'gitlab-ci' },
    verified: true,
    reason: `Remove the converged local GitLab CI binding for ${environmentName}`,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    metadata: {
      operation: CI_BINDING_REMOVE_OPERATION,
      codeProvider: 'gitlab',
      ciProvider: 'gitlab-ci',
      repositoryId: context.repository.nativeId,
      instanceScope: context.repository.instanceScope,
      repositoryScope: context.repository.canonicalScope,
      environmentName,
      programHash,
    },
  };
}

function managedJobMatchesEnvironment(name: string, environmentName: string): boolean {
  return name.startsWith('hypervibe:') && name.endsWith(`:${safeSlug(environmentName)}`);
}

async function activeManagedJobProblem(
  context: GitLabContext,
  environmentName: string
): Promise<string | null> {
  try {
    const runs = await context.adapter.listRuns(context.repository, 'pipeline', 30);
    for (const run of runs.filter((candidate) => candidate.phase === 'queued' || candidate.phase === 'running')) {
      const jobs = await context.adapter.listJobs(context.repository, run.id, 100);
      const active = jobs.find((job) => (
        managedJobMatchesEnvironment(job.name, environmentName)
        && (job.phase === 'queued' || job.phase === 'running')
      ));
      if (active) return `Managed GitLab job ${active.name} in pipeline ${run.id} is ${active.phase}`;
    }
    return null;
  } catch (error) {
    return `Managed GitLab run observation is unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function portableVariables(
  _context: GitLabContext,
  spec: ProjectSpec,
  target: BranchDeployTarget
): DesiredVariable[] | { error: string } {
  const provider = spec.environments[target.environmentName]?.hosting.provider;
  if (!provider) return { error: `Hosting provider is missing for ${target.environmentName}` };
  let recipe: PortableCiDeployRecipe;
  try {
    recipe = recipeFor(provider, target);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const keys = gitLabVariableKeys(spec, target.environmentName, recipe.values.map((value) => value.name));
  const credentialCache = new Map<string, Record<string, unknown>>();
  const desired: DesiredVariable[] = [];
  for (const definition of recipe.values) {
    let value: string;
    let source: string;
    if (definition.source.kind === 'literal') {
      value = definition.source.value;
      source = `recipe:${provider}.${definition.name}`;
    } else {
      const connectionProvider = definition.source.provider;
      let credentials = credentialCache.get(connectionProvider);
      if (!credentials) {
        const connection = new ConnectionRepository().findBestVerifiedMatch(
          connectionProvider,
          connectionProvider === 'gitlab' ? spec.devops?.code.scope : undefined
        );
        if (!connection) {
          return { error: `No verified ${connectionProvider} connection is available for GitLab CI variable sync` };
        }
        credentials = getSecretStore().decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);
        credentialCache.set(connectionProvider, credentials);
      }
      const candidate = credentials[definition.source.credentialKey];
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return { error: `The verified ${connectionProvider} connection has no ${definition.source.credentialKey} credential required by ${provider}` };
      }
      value = candidate;
      source = `connection:${connectionProvider}.${definition.source.credentialKey}${definition.transform ? `:${definition.transform}` : ''}`;
    }
    if (definition.transform === 'base64') value = Buffer.from(value, 'utf8').toString('base64');
    desired.push({
      key: keys.values[definition.name]!,
      value,
      source,
      environmentScope: target.environmentName,
      protected: true,
      masked: definition.secret,
      hidden: definition.secret,
      raw: true,
    });
  }
  return desired;
}

function allGitLabVariableKeys(spec: ProjectSpec, target: BranchDeployTarget): string[] {
  const provider = spec.environments[target.environmentName]?.hosting.provider;
  const names = provider ? recipeFor(provider, target).values.map((value) => value.name) : [];
  const keys = gitLabVariableKeys(spec, target.environmentName, names);
  return [keys.appliedSpecHash, ...Object.values(keys.values)];
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
  const policyProblem = await verifyDeployPolicy(context, params.spec, target);
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
    desired = portableVariables(context, params.spec, target);
  }
  if ('error' in desired) return { warnings: [], error: desired.error };

  const environmentBinding = gitLabCiBinding(params.project.id, params.environmentName);

  let observed;
  try {
    observed = await context.adapter.listVariables(context.repository.nativeId);
  } catch (error) {
    return { warnings: [], error: error instanceof Error ? error.message : String(error) };
  }
  const desiredKeys = new Set(allGitLabVariableKeys(params.spec, target));
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

async function planTeardown(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  context: GitLabContext;
  rendered: ReturnType<typeof renderManagedFiles>;
  removedPaths: string[];
}): Promise<CiLifecycleResult> {
  const binding = gitLabCiBinding(params.project.id, params.environmentName);
  if (!binding) return { warnings: [] };
  const active = await proveActiveConfiguration(
    params.context,
    params.rendered.files,
    params.rendered.jobNames,
    params.removedPaths
  );
  if ('error' in active) return { warnings: [], error: active.error };
  const configurationBinding = configurationBindingForSpec(params.project, params.spec);
  const ownershipProblem = await proveMergedConfigurationOwnership(
    configurationBinding,
    params.context,
    params.rendered.programHash
  );
  if (ownershipProblem) return { warnings: [], error: ownershipProblem };
  const activeJob = await activeManagedJobProblem(params.context, params.environmentName);
  if (activeJob) return { warnings: [], error: `${activeJob}; teardown stops before deleting variables.` };

  const ownedHashes = asRecord(binding.variableHashes) ?? {};
  let observed: CiVariableObservation[];
  try {
    observed = await params.context.adapter.listVariables(params.context.repository.nativeId);
  } catch (error) {
    return { warnings: [], error: error instanceof Error ? error.message : String(error) };
  }
  const actions: PlanAction[] = [];
  for (const [key, rawHash] of Object.entries(ownedHashes).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof rawHash !== 'string' || !rawHash) {
      return { warnings: [], error: `Owned GitLab variable ${key} has an invalid local fingerprint; refusing deletion.` };
    }
    const matches = observed.filter((candidate) => candidate.key === key);
    if (matches.length > 1) {
      return { warnings: [], error: `Owned GitLab variable ${key} resolves to multiple provider scopes; refusing teardown.` };
    }
    const variable = matches[0] ?? {
      key,
      scope: key.includes('_APPLIED_SPEC_HASH') ? '*' : params.environmentName,
      precedence: 'project',
      protected: true,
      masked: false,
      raw: true,
      valueVisibility: 'omitted' as const,
    };
    if (matches[0] && matches[0].valueHash && matches[0].valueHash !== rawHash) {
      return { warnings: [], error: `Owned GitLab variable ${key} changed outside Hypervibe; refusing to delete the new value.` };
    }
    actions.push(variableDeleteAction(
      params.context,
      params.environmentName,
      variable,
      rawHash,
      params.rendered.programHash
    ));
  }
  actions.push(bindingRemoveAction(
    params.context,
    params.environmentName,
    params.rendered.programHash,
    actions.map((action) => action.id)
  ));
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
  const existingEnvironmentBinding = gitLabCiBinding(params.project.id, params.environmentName);
  const wantsManagedDeploy = params.environmentSpec.deploy?.strategy === 'branch'
    && params.environmentSpec.deploy.trigger !== 'native';
  if (!wantsManagedDeploy && !existingEnvironmentBinding) {
    return { warnings: [] };
  }
  const context = await loadContext(params.spec);
  if ('error' in context) return { warnings: [], error: context.error };
  const rootPath = activeRootPath(context.project);
  const rendered = renderManagedFilesSafely(params.project, params.spec, rootPath);
  if ('error' in rendered) return { warnings: [], error: rendered.error };
  const targets = managedTargets(params.project, params.spec);
  if (targets.length > 0) {
    const runnerProblem = await verifyRunnerPolicy(context, params.spec);
    if (runnerProblem) return { warnings: [], error: runnerProblem };
  }
  const canonical = configurationOwnerEnvironment(params.project, params.spec) ?? params.environmentName;
  const binding = configurationBindingForSpec(params.project, params.spec);
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
  const desiredPaths = new Set(rendered.files.map((file) => file.path));
  const removedOwnedPaths = boundConfigurationPaths(binding)
    .filter((path) => !desiredPaths.has(path));
  const removedObservation = await observeAbsentPaths(
    context,
    removedOwnedPaths,
    context.repository.defaultBranch
  );
  if ('error' in removedObservation) return { warnings: [], error: removedObservation.error };
  const configurationExact = observedFiles.exact && removedObservation.absent;
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
  if (!configurationExact) {
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
      actions: [configAction(context, rendered.files, rendered.programHash, base.value.sha, removedOwnedPaths)],
      warnings: [],
    };
  }
  if (!configurationOwnershipMatches(binding, context, rendered.programHash)) {
    return {
      warnings: [],
      error: 'The exact GitLab CI configuration is present but its reviewed Hypervibe proposal/active binding is missing or stale; Hypervibe will not silently adopt it.',
    };
  }
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames, removedOwnedPaths);
  if ('error' in active) return { warnings: [], error: active.error };
  if (params.bindingsWillChange) {
    return {
      warnings: [`Hosting bindings will change for ${params.environmentName}; re-plan after hosting converges before syncing exact GitLab variables.`],
    };
  }
  if (!wantsManagedDeploy) {
    return planTeardown({
      project: params.project,
      spec: params.spec,
      environmentName: params.environmentName,
      context,
      rendered,
      removedPaths: removedOwnedPaths,
    });
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
  const desired = portableVariables(context, spec, target);
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
  const policyProblem = await verifyDeployPolicy(context, params.spec, target);
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
  const desiredKeys = new Set(allGitLabVariableKeys(params.spec, target));
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

async function applyVariableDelete(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  action: PlanAction;
}): Promise<CiApplyResult> {
  const context = await loadContext(params.spec);
  if ('error' in context) return { success: false, status: 'blocked', message: 'GitLab CI connection is unavailable', error: context.error };
  const binding = gitLabCiBinding(params.project.id, params.environmentName);
  if (!bindingMatchesRepository(binding, context)) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable teardown binding is stale', error: 'The durable repository ownership binding is missing.' };
  }
  const rendered = renderManagedFilesSafely(params.project, params.spec, activeRootPath(context.project));
  if ('error' in rendered) return { success: false, status: 'blocked', message: 'GitLab CI teardown program is unsupported', error: rendered.error };
  const configurationBinding = configurationBindingForSpec(params.project, params.spec);
  const desiredPaths = new Set(rendered.files.map((file) => file.path));
  const removedPaths = boundConfigurationPaths(configurationBinding).filter((path) => !desiredPaths.has(path));
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames, removedPaths);
  if ('error' in active) return { success: false, status: 'blocked', message: 'GitLab CI teardown configuration is not proven active', error: active.error };
  const ownershipProblem = await proveMergedConfigurationOwnership(configurationBinding, context, rendered.programHash);
  if (ownershipProblem) return { success: false, status: 'blocked', message: 'GitLab CI teardown ownership is not proven', error: ownershipProblem };
  const activeJob = await activeManagedJobProblem(context, params.environmentName);
  if (activeJob) return { success: false, status: 'blocked', message: 'GitLab CI teardown has active work', error: activeJob };

  const key = metadataString(params.action, 'variableKey');
  const scope = metadataString(params.action, 'environmentScope');
  const ownedHash = metadataString(params.action, 'valueHash');
  if (
    !key
    || !scope
    || !ownedHash
    || metadataString(params.action, 'repositoryId') !== context.repository.nativeId
    || metadataString(params.action, 'instanceScope') !== context.repository.instanceScope
    || metadataString(params.action, 'repositoryScope') !== context.repository.canonicalScope
    || metadataString(params.action, 'environmentName') !== params.environmentName
    || metadataString(params.action, 'programHash') !== rendered.programHash
    || params.action.resource.name !== `${params.environmentName}:${key}`
  ) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable teardown action is stale', error: 'The reviewed variable identity or program changed; re-run hv_plan.' };
  }
  const hashes = asRecord(binding?.variableHashes) ?? {};
  if (hashes[key] !== ownedHash) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable teardown ownership is stale', error: `${key} no longer has the reviewed local ownership fingerprint.` };
  }
  let variables: CiVariableObservation[];
  try {
    variables = await context.adapter.listVariables(context.repository.nativeId);
  } catch (error) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable teardown observation is unknown', error: error instanceof Error ? error.message : String(error) };
  }
  const matches = variables.filter((candidate) => candidate.key === key && candidate.scope === scope);
  if (matches.length > 1) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable teardown identity is ambiguous', error: `Multiple variables match ${key} at ${scope}.` };
  }
  const current = matches[0];
  if (current && current.valueHash !== ownedHash) {
    return { success: false, status: 'blocked', message: 'GitLab CI variable changed after planning', error: `${key} no longer matches the exact owned value fingerprint.` };
  }
  try {
    if (current) await context.adapter.deleteVariable(context.repository.nativeId, key, scope);
    const after = await context.adapter.listVariables(context.repository.nativeId);
    if (after.some((candidate) => candidate.key === key && candidate.scope === scope)) {
      return { success: false, status: 'blocked', message: 'GitLab CI variable deletion did not converge', error: `${key} remains observable at ${scope}.` };
    }
  } catch (error) {
    return { success: false, status: 'blocked', message: `GitLab CI variable ${key} was not deleted`, error: error instanceof Error ? error.message : String(error) };
  }
  const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
  if (environment) {
    const ci = asRecord(environment.platformBindings.ci) ?? {};
    const gitlab = asRecord(ci.gitlabCi) ?? {};
    const nextHashes = Object.fromEntries(Object.entries(hashes).filter(([candidate]) => candidate !== key));
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: { ...ci, gitlabCi: { ...gitlab, variableHashes: nextHashes } },
    });
  }
  return { success: true, message: `Deleted exact owned GitLab CI variable ${key}`, data: { variable: key, environmentScope: scope } };
}

async function applyBindingRemove(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  action: PlanAction;
}): Promise<CiApplyResult> {
  const context = await loadContext(params.spec);
  if ('error' in context) return { success: false, status: 'blocked', message: 'GitLab CI connection is unavailable', error: context.error };
  const binding = gitLabCiBinding(params.project.id, params.environmentName);
  if (!bindingMatchesRepository(binding, context)) {
    return { success: false, status: 'blocked', message: 'GitLab CI binding removal is stale', error: 'The exact owned binding is missing.' };
  }
  const hashes = asRecord(binding?.variableHashes) ?? {};
  if (Object.keys(hashes).length > 0) {
    return { success: false, status: 'blocked', message: 'GitLab CI binding removal dependency is incomplete', error: `Owned variables remain: ${Object.keys(hashes).join(', ')}.` };
  }
  const rendered = renderManagedFilesSafely(params.project, params.spec, activeRootPath(context.project));
  if ('error' in rendered) return { success: false, status: 'blocked', message: 'GitLab CI teardown program is unsupported', error: rendered.error };
  if (
    metadataString(params.action, 'repositoryId') !== context.repository.nativeId
    || metadataString(params.action, 'instanceScope') !== context.repository.instanceScope
    || metadataString(params.action, 'repositoryScope') !== context.repository.canonicalScope
    || metadataString(params.action, 'environmentName') !== params.environmentName
    || metadataString(params.action, 'programHash') !== rendered.programHash
  ) {
    return { success: false, status: 'blocked', message: 'GitLab CI binding removal is stale', error: 'The reviewed repository or program changed; re-run hv_plan.' };
  }
  const configurationBinding = configurationBindingForSpec(params.project, params.spec);
  const desiredPaths = new Set(rendered.files.map((file) => file.path));
  const removedPaths = boundConfigurationPaths(configurationBinding).filter((path) => !desiredPaths.has(path));
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames, removedPaths);
  if ('error' in active) return { success: false, status: 'blocked', message: 'GitLab CI teardown is not converged', error: active.error };
  const activeJob = await activeManagedJobProblem(context, params.environmentName);
  if (activeJob) return { success: false, status: 'blocked', message: 'GitLab CI teardown has active work', error: activeJob };

  const remainingTargets = managedTargets(params.project, params.spec);
  if (remainingTargets.length > 0) {
    const replacementOwner = remainingTargets.some((target) => {
      if (target.environmentName === params.environmentName) return false;
      const candidate = gitLabCiBinding(params.project.id, target.environmentName);
      return bindingMatchesRepository(candidate, context)
        && (
          asRecord(candidate?.configurationProposal)?.programHash === rendered.programHash
          || asRecord(candidate?.configurationActive)?.programHash === rendered.programHash
        );
    });
    if (!replacementOwner) {
      return { success: false, status: 'blocked', message: 'GitLab CI configuration ownership cannot move safely', error: 'No remaining environment has the exact reviewed configuration proposal binding.' };
    }
  }
  const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
  if (environment) {
    const ci = asRecord(environment.platformBindings.ci) ?? {};
    new EnvironmentRepository().updatePlatformBindings(environment.id, {
      ci: { ...ci, gitlabCi: null },
    });
  }
  return { success: true, message: `Removed the converged GitLab CI binding for ${params.environmentName}`, data: { environmentName: params.environmentName } };
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
  const plannedRemovedPaths = Array.isArray(params.action.metadata?.removedPaths)
    && params.action.metadata.removedPaths.every((value) => typeof value === 'string')
    ? [...params.action.metadata.removedPaths as string[]].sort()
    : [];
  const ownershipBinding = configurationBindingForSpec(params.project, params.spec);
  const desiredPaths = new Set(rendered.files.map((file) => file.path));
  const currentRemovedPaths = boundConfigurationPaths(ownershipBinding)
    .filter((path) => !desiredPaths.has(path))
    .sort();
  if (
    JSON.stringify(plannedFiles) !== JSON.stringify(currentFileContract)
    || JSON.stringify(plannedRemovedPaths) !== JSON.stringify(currentRemovedPaths)
  ) {
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
  const removedAtBase = await observeAbsentPaths(context, plannedRemovedPaths, context.repository.defaultBranch);
  if ('error' in removedAtBase) return { success: false, status: 'blocked', message: 'Cannot observe obsolete GitLab CI files', error: removedAtBase.error };
  if (active.exact && removedAtBase.absent) {
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

  const repositoryOwned = bindingMatchesRepository(ownershipBinding, context);
  const ownedPaths = new Set(boundConfigurationPaths(ownershipBinding));

  const proposalBranch = await context.adapter.observeBranch(context.repository, branchName);
  let proposalSha: string;
  if (proposalBranch.state === 'unknown') {
    return { success: false, status: 'blocked', message: 'Cannot observe GitLab proposal branch', error: proposalBranch.reason };
  }
  if (proposalBranch.state === 'present') {
    const proposed = await observeFiles(context, rendered.files, branchName);
    const removedFromProposal = await observeAbsentPaths(context, plannedRemovedPaths, branchName);
    if ('error' in proposed || !proposed.exact || 'error' in removedFromProposal || !removedFromProposal.absent) {
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
    const managedPaths = new Set([...rendered.files.map((file) => file.path), ...plannedRemovedPaths]);
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
    const actions: Array<{
      action: 'create' | 'update' | 'delete';
      path: string;
      content?: string;
      lastCommitId?: string;
    }> = [];
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
    for (const path of plannedRemovedPaths) {
      if (!repositoryOwned || !ownedPaths.has(path)) {
        return {
          success: false,
          status: 'blocked',
          message: 'GitLab CI teardown path is unowned',
          error: `${path} is not present in the reviewed ownership binding.`,
        };
      }
      const current = await context.adapter.observeFile(
        context.repository,
        path,
        context.repository.defaultBranch
      );
      if (current.state === 'unknown') {
        return { success: false, status: 'blocked', message: 'Cannot observe GitLab CI teardown file', error: current.reason };
      }
      if (current.state === 'present') {
        if (!current.value.lastCommitId) {
          return {
            success: false,
            status: 'blocked',
            message: 'GitLab CI teardown concurrency is unknown',
            error: `${path} has no provider-observed last commit id.`,
          };
        }
        actions.push({ action: 'delete', path, lastCommitId: current.value.lastCommitId });
      }
    }
    if (actions.length === 0) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitLab CI configuration action is stale',
        error: 'No reviewed file mutation remains; re-run hv_plan.',
      };
    }
    const commit = await context.adapter.createCommit(context.repository, {
      branch: branchName,
      startSha: baseSha,
      commitMessage: rendered.files.length > 0
        ? 'Configure Hypervibe GitLab CI deploys'
        : 'Remove Hypervibe GitLab CI deploys',
      actions,
    });
    proposalSha = commit.id;
  }
  const proposalProof = await proveConfigurationAtRef(
    context,
    rendered.files,
    rendered.jobNames,
    branchName,
    proposalSha,
    plannedRemovedPaths
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
    title: rendered.files.length > 0
      ? 'Configure Hypervibe GitLab CI deploys'
      : 'Remove Hypervibe GitLab CI deploys',
    description: [
      rendered.files.length > 0
        ? 'Hypervibe-generated, provider-reviewed CI configuration.'
        : 'Hypervibe-generated, provider-reviewed CI teardown.',
      '',
      `Program fingerprint: ${rendered.programHash}`,
      rendered.files.length > 0
        ? 'Merging enables exact-SHA image builds and deploy jobs. CI variables are synced only after Hypervibe observes this merged configuration and its deployment protections.'
        : 'Merging removes the managed jobs before Hypervibe deletes their exact owned CI variables.',
    ].join('\n'),
  });
  persistConfigurationProposal({
    project: params.project,
    environmentName: rendered.files.length > 0
      ? canonicalEnvironment(params.spec, managedTargets(params.project, params.spec)) ?? params.environmentName
      : params.environmentName,
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

export async function observeGitLabManagedProgram(params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
}): Promise<{
  adapter: GitLabAdapter;
  repository: CodeRepositoryIdentity;
  project: GitLabProject;
  rootPath: string;
  ref: string;
  programHash: string;
  deployJobName: string;
  hostingProvider: string;
} | { error: string }> {
  const context = await loadContext(params.spec);
  if ('error' in context) return context;
  const target = managedTargets(params.project, params.spec)
    .find((candidate) => candidate.environmentName === params.environmentName);
  if (!target) return { error: `${params.environmentName} is not a managed GitLab CI deploy target` };
  const rendered = renderManagedFilesSafely(params.project, params.spec, activeRootPath(context.project));
  if ('error' in rendered) return rendered;
  const binding = configurationBindingForSpec(params.project, params.spec);
  const ownershipProblem = await proveMergedConfigurationOwnership(binding, context, rendered.programHash);
  if (ownershipProblem) return { error: ownershipProblem };
  const active = await proveActiveConfiguration(context, rendered.files, rendered.jobNames);
  if ('error' in active) return active;
  const policyProblem = await verifyDeployPolicy(context, params.spec, target);
  if (policyProblem) return { error: policyProblem };
  const hostingProvider = params.spec.environments[params.environmentName]!.hosting.provider;
  return {
    adapter: context.adapter,
    repository: context.repository,
    project: context.project,
    rootPath: activeRootPath(context.project),
    ref: target.branch,
    programHash: rendered.programHash,
    deployJobName: `hypervibe:deploy:${hostingProvider}:${safeSlug(params.environmentName)}`,
    hostingProvider,
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
    if (params.action.metadata?.operation === CI_VARIABLE_DELETE_OPERATION) {
      return applyVariableDelete(params);
    }
    if (params.action.metadata?.operation === CI_BINDING_REMOVE_OPERATION) {
      return applyBindingRemove(params);
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
