import { createHash } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/digitalocean/digitalocean.adapter.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import {
  buildBranchDeployWorkflow,
  githubActionsWorkflowInputHash,
} from '../github-ops.service.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import {
  MANAGED_CI_RELEASE_EVIDENCE_VERSION,
  managedCiReleaseArtifactName,
} from '../managed-ci-evidence.js';
import {
  extractGitHubScript,
  installReleaseEvidenceValidator,
  releaseEvidenceValidatorRequire,
} from './managed-ci-workflow.test-utils.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WRONG_SHA = 'f'.repeat(40);
const TRUSTED_HEAD_SHA = 'c'.repeat(40);
const REPOSITORY = { id: 101, full_name: 'acme/promoted-app' };
const SOURCE_WORKFLOW = '.github/workflows/deploy-railway-staging.yml';
const EXPECTED_ARTIFACT = managedCiReleaseArtifactName('staging', SHA);
const STEP_NAME = 'Verify promotion release evidence';
const VALIDATE_STEP_NAME = 'Validate promotion release evidence';
const PROGRAM_FINGERPRINT = 'a'.repeat(64);
const DEPLOYMENT_CONTRACT_FINGERPRINT = 'e'.repeat(64);
const EVIDENCE_MISMATCH = 'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, deployment contract provenance, and immutable image';
const SOURCE_SCOPE = {
  providerProjectId: 'rail-project',
  providerEnvironmentId: 'rail-staging',
};
const SOURCE_RESOURCES = [
  {
    logicalName: 'nightly',
    workloadKind: 'cron',
    providerResourceType: 'job',
    providerResourceId: 'rail-staging-nightly',
  },
  {
    logicalName: 'web',
    workloadKind: 'web',
    providerResourceType: 'service',
    providerResourceId: 'rail-staging-web',
  },
];
let tempDir: string;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function bindingsFingerprint(
  provider: string,
  environment: string,
  scope: Record<string, unknown>,
  resources: unknown[]
): string {
  return createHash('sha256').update(JSON.stringify(canonicalize({
    version: 1,
    provider,
    environment,
    scope,
    resources,
  })), 'utf8').digest('hex');
}

const SOURCE_BINDINGS_FINGERPRINT = bindingsFingerprint(
  'railway',
  'staging',
  SOURCE_SCOPE,
  SOURCE_RESOURCES
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function productionTarget(): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    promoteFromEnvironment: 'staging',
    promoteFromBranch: 'main',
    promoteFromProvider: 'railway',
    promoteFromServiceNames: ['web', 'nightly'],
    promoteFromProgramFingerprint: PROGRAM_FINGERPRINT,
    promoteFromDeploymentContractFingerprint: DEPLOYMENT_CONTRACT_FINGERPRINT,
    promoteFromReleaseTarget: {
      scope: SOURCE_SCOPE,
      bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
      resources: SOURCE_RESOURCES,
    },
    programFingerprint: 'd'.repeat(64),
    deploymentContractFingerprint: 'f'.repeat(64),
    serviceNames: ['web', 'nightly'],
    providerProjectId: 'rail-project',
    providerEnvironmentId: 'rail-production',
    providerServiceIds: ['rail-production-web', 'rail-production-nightly'],
    releaseTarget: {
      scope: {
        providerProjectId: 'rail-project',
        providerEnvironmentId: 'rail-production',
      },
      bindingsFingerprint: bindingsFingerprint(
        'railway',
        'production',
        {
          providerProjectId: 'rail-project',
          providerEnvironmentId: 'rail-production',
        },
        [
          {
            logicalName: 'nightly',
            workloadKind: 'cron',
            providerResourceType: 'job',
            providerResourceId: 'rail-production-nightly',
          },
          {
            logicalName: 'web',
            workloadKind: 'web',
            providerResourceType: 'service',
            providerResourceId: 'rail-production-web',
          },
        ]
      ),
      resources: [
        {
          logicalName: 'nightly',
          workloadKind: 'cron',
          providerResourceType: 'job',
          providerResourceId: 'rail-production-nightly',
        },
        {
          logicalName: 'web',
          workloadKind: 'web',
          providerResourceType: 'service',
          providerResourceId: 'rail-production-web',
        },
      ],
    },
  } as BranchDeployTarget;
}

function generatedWorkflow(): string {
  return buildBranchDeployWorkflow(
    'railway',
    productionTarget(),
    { includeStep: false }
  ).content;
}

function sourceRun(headSha = SHA) {
  return {
    id: 41,
    head_sha: headSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    repository: REPOSITORY,
    head_repository: REPOSITORY,
    conclusion: 'success',
    path: SOURCE_WORKFLOW,
  };
}

function sourceArtifact() {
  return {
    id: 71,
    name: EXPECTED_ARTIFACT,
    expired: false,
    workflow_run: { id: 41, head_sha: SHA, head_branch: 'main', repository_id: 101, head_repository_id: 101 },
  };
}

async function runPromotionGate(options: {
  runs: unknown[];
  artifacts?: unknown[];
  branchRef?: unknown;
  comparison?: unknown;
}) {
  // Documented name filter and paging, not a recorded live response:
  // https://docs.github.com/en/rest/actions/artifacts#list-artifacts-for-a-repository
  const listArtifactsForRepo = vi.fn(async (request: { name: string; page: number; per_page: number }) => ({
    data: { artifacts: (options.artifacts ?? [])
      .filter((artifact) => (artifact as ReturnType<typeof sourceArtifact>).name === request.name)
      .slice((request.page - 1) * request.per_page, request.page * request.per_page) },
  }));
  const getWorkflowRun = vi.fn(async (request: { run_id: number }) => ({
    data: options.runs.find((run) => (run as ReturnType<typeof sourceRun>).id === request.run_id) ?? {},
  }));
  // Reconstructed documented GitHub metadata, not captured provider responses.
  // https://docs.github.com/en/rest/git/refs#get-a-reference
  // https://docs.github.com/en/rest/commits/commits#compare-two-commits
  const getRef = vi.fn(async () => ({ data: options.branchRef ?? {
    ref: 'refs/heads/main', object: { type: 'commit', sha: TRUSTED_HEAD_SHA },
  } }));
  const comparisons: Record<string, unknown> = {
    [SHA + '...' + TRUSTED_HEAD_SHA]: { status: 'ahead', base_commit: { sha: SHA }, merge_base_commit: { sha: SHA } },
    [WRONG_SHA + '...' + TRUSTED_HEAD_SHA]: { status: 'ahead', base_commit: { sha: WRONG_SHA }, merge_base_commit: { sha: WRONG_SHA } },
  };
  const compareCommitsWithBasehead = vi.fn(async (request: { basehead: string }) => ({
    data: options.comparison ?? comparisons[request.basehead] ?? {},
  }));
  const github = {
    rest: {
      actions: { listArtifactsForRepo, getWorkflowRun },
      git: { getRef },
      repos: { compareCommitsWithBasehead },
    },
  };
  const core = { info: vi.fn(), setOutput: vi.fn() };
  const execute = new AsyncFunction(
    'github',
    'context',
    'process',
    'core',
    extractGitHubScript(generatedWorkflow(), STEP_NAME)
  );
  const result = execute(
    github,
    { repo: { owner: 'acme', repo: 'promoted-app' } },
    {
      env: {
        HYPERVIBE_PROMOTE_FROM_ENVIRONMENT: 'staging',
        HYPERVIBE_PROMOTE_FROM_WORKFLOW: SOURCE_WORKFLOW,
        HYPERVIBE_PROMOTE_FROM_BRANCH: 'main',
        HYPERVIBE_PROMOTION_SHA: SHA,
      },
    },
    core
  );
  return { result, github, core, listArtifactsForRepo, getWorkflowRun, getRef, compareCommitsWithBasehead };
}

async function runPromotionContentValidation(evidence: unknown) {
  const workflow = generatedWorkflow();
  const validator = installReleaseEvidenceValidator(workflow, tempDir);
  const readFileSync = vi.fn(() => JSON.stringify(evidence));
  const require = releaseEvidenceValidatorRequire(validator, {
    readFileSync,
  });
  const core = { info: vi.fn(), setOutput: vi.fn() };
  const execute = new AsyncFunction(
    'require',
    'process',
    'core',
    extractGitHubScript(workflow, VALIDATE_STEP_NAME)
  );
  const result = execute(
    require,
    {
      env: {
        HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
        HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
        GITHUB_REPOSITORY: 'acme/promoted-app',
        HYPERVIBE_PROMOTE_FROM_ENVIRONMENT: 'staging',
        HYPERVIBE_PROMOTE_FROM_PROVIDER: 'railway',
        HYPERVIBE_PROMOTION_SHA: SHA,
        HYPERVIBE_PROMOTION_SERVICES: JSON.stringify(['web', 'nightly']),
        HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT: PROGRAM_FINGERPRINT,
        HYPERVIBE_PROMOTION_DEPLOYMENT_CONTRACT_FINGERPRINT: DEPLOYMENT_CONTRACT_FINGERPRINT,
        HYPERVIBE_PROMOTION_TARGET_SCOPE: JSON.stringify(SOURCE_SCOPE),
        HYPERVIBE_PROMOTION_BINDINGS_FINGERPRINT: SOURCE_BINDINGS_FINGERPRINT,
        HYPERVIBE_PROMOTION_RESOURCES: JSON.stringify(SOURCE_RESOURCES),
        HYPERVIBE_RELEASE_EVIDENCE_PATH: '/tmp/hypervibe-promotion-evidence/hypervibe-server-release.json',
      },
    },
    core
  );
  return { result, core, readFileSync };
}

async function produceProductionReleaseEvidence(contractHash?: string) {
  const target = productionTarget();
  const releaseTarget = target.releaseTarget!;
  const workflow = generatedWorkflow();
  const validator = installReleaseEvidenceValidator(workflow, tempDir);
  const writeFileSync = vi.fn();
  const require = releaseEvidenceValidatorRequire(validator, { writeFileSync });
  const execute = new AsyncFunction(
    'require',
    'process',
    extractGitHubScript(workflow, 'Write server release evidence')
  );
  const imageUri = `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`;

  await execute(require, {
    env: {
      HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
      HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
      GITHUB_REPOSITORY: 'acme/promoted-app',
      HYPERVIBE_RELEASE_SHA: SHA,
      HYPERVIBE_RELEASE_PROVIDER: 'railway',
      HYPERVIBE_RELEASE_ENVIRONMENT: 'production',
      HYPERVIBE_RELEASE_SERVICES: JSON.stringify(target.serviceNames),
      HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(releaseTarget.scope),
      HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(releaseTarget.resources),
      HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: releaseTarget.bindingsFingerprint,
      HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: target.programFingerprint,
      HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: contractHash ?? target.deploymentContractFingerprint,
      HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'true',
      HYPERVIBE_RELEASE_IMAGE_URI: imageUri,
    },
  });

  expect(writeFileSync).toHaveBeenCalledOnce();
  return {
    evidence: JSON.parse(String(writeFileSync.mock.calls[0]?.[1])),
    imageUri,
  };
}

async function runRollbackContentValidation(evidence: unknown, appliedHash?: string) {
  const target = productionTarget();
  const releaseTarget = target.releaseTarget!;
  const workflow = generatedWorkflow();
  const validator = installReleaseEvidenceValidator(workflow, tempDir);
  const readFileSync = vi.fn(() => JSON.stringify(evidence));
  const require = releaseEvidenceValidatorRequire(validator, { readFileSync });
  const core = { info: vi.fn(), setOutput: vi.fn() };
  const execute = new AsyncFunction(
    'require',
    'process',
    'core',
    extractGitHubScript(workflow, 'Resolve immutable rollback image')
  );
  const result = execute(
    require,
    {
      env: {
        HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
        HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
        HYPERVIBE_RELEASE_EVIDENCE_PATH: '/tmp/hypervibe-rollback-evidence/hypervibe-server-release.json',
        GITHUB_REPOSITORY: 'acme/promoted-app',
        HYPERVIBE_ROLLBACK_PROVIDER: 'railway',
        HYPERVIBE_ROLLBACK_ENVIRONMENT: 'production',
        HYPERVIBE_ROLLBACK_SHA: SHA,
        HYPERVIBE_ROLLBACK_SERVICES: JSON.stringify(target.serviceNames),
        HYPERVIBE_ROLLBACK_TARGET_SCOPE: JSON.stringify(releaseTarget.scope),
        HYPERVIBE_ROLLBACK_RESOURCES: JSON.stringify(releaseTarget.resources),
        HYPERVIBE_ROLLBACK_BINDINGS_FINGERPRINT: releaseTarget.bindingsFingerprint,
        HYPERVIBE_ROLLBACK_PROGRAM_FINGERPRINT: target.programFingerprint,
        HYPERVIBE_ROLLBACK_DEPLOYMENT_CONTRACT_FINGERPRINT: appliedHash ?? target.deploymentContractFingerprint,
      },
    },
    core
  );
  return { result, core, readFileSync };
}

function validReleaseEvidence(overrides: Record<string, unknown> = {}) {
  const imageUri = `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`;
  return {
    version: MANAGED_CI_RELEASE_EVIDENCE_VERSION,
    provider: 'railway',
    environment: 'staging',
    deploymentContractFingerprint: DEPLOYMENT_CONTRACT_FINGERPRINT,
    source: {
      repository: 'acme/promoted-app',
      sha: SHA,
    },
    target: {
      scope: SOURCE_SCOPE,
      bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
      resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri })),
    },
    programFingerprint: PROGRAM_FINGERPRINT,
    verifiedAt: '2026-09-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('generated managed-CI promotion evidence gate', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-promotion-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects promotion through a provider without verifiable immutable artifacts', () => {
    const target = productionTarget();
    target.providerProjectId = 'do-app';
    target.providerEnvironmentId = undefined;
    target.providerServiceIds = ['do-app:services:web', 'do-app:jobs:nightly'];

    expect(() => buildBranchDeployWorkflow(
      'digitalocean',
      target,
      { includeStep: false }
    )).toThrow(
      'Promotion to production is unavailable because provider "digitalocean" does not expose a verifiable immutable artifact.'
    );
  });

  it('requires a reviewed source branch before rendering promotion', () => {
    const target = productionTarget();
    delete target.promoteFromBranch;
    expect(() => buildBranchDeployWorkflow('railway', target, { includeStep: false }))
      .toThrow('has no reviewed source branch');
  });

  it('writes exact source release evidence that the promotion consumer accepts', async () => {
    const sourceTarget: BranchDeployTarget = {
      environmentName: 'staging',
      kind: 'staging',
      branch: 'main',
      autoDeployOnPush: true,
      serviceNames: ['web', 'nightly'],
      providerProjectId: 'rail-project',
      providerEnvironmentId: 'rail-staging',
      providerServiceIds: ['rail-staging-web', 'rail-staging-nightly'],
      programFingerprint: PROGRAM_FINGERPRINT,
      releaseTarget: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES,
      },
    } as BranchDeployTarget;
    const workflow = buildBranchDeployWorkflow(
      'railway',
      sourceTarget,
      { includeStep: false }
    ).content;
    const validator = installReleaseEvidenceValidator(workflow, tempDir);
    const writeFileSync = vi.fn((_path: string, _content: string) => undefined);
    const require = releaseEvidenceValidatorRequire(validator, {
      writeFileSync,
    });
    const execute = new AsyncFunction(
      'require',
      'process',
      extractGitHubScript(workflow, 'Write server release evidence')
    );

    await execute(require, {
      env: {
        HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
        HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
        GITHUB_REPOSITORY: 'acme/promoted-app',
        HYPERVIBE_RELEASE_SHA: SHA,
        HYPERVIBE_RELEASE_PROVIDER: 'railway',
        HYPERVIBE_RELEASE_ENVIRONMENT: 'staging',
        HYPERVIBE_RELEASE_SERVICES: JSON.stringify(['web', 'nightly']),
        HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(SOURCE_SCOPE),
        HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(SOURCE_RESOURCES),
        HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: SOURCE_BINDINGS_FINGERPRINT,
        HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: PROGRAM_FINGERPRINT,
        HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: DEPLOYMENT_CONTRACT_FINGERPRINT,
        HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'true',
        HYPERVIBE_RELEASE_IMAGE_URI: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`,
      },
    });

    const producedEvidence = JSON.parse(String(writeFileSync.mock.calls[0]?.[1]));
    expect(producedEvidence).toEqual({
      version: MANAGED_CI_RELEASE_EVIDENCE_VERSION,
      provider: 'railway',
      environment: 'staging',
      deploymentContractFingerprint: DEPLOYMENT_CONTRACT_FINGERPRINT,
      source: { repository: 'acme/promoted-app', sha: SHA },
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES.map((resource) => ({
          ...resource,
          imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`,
        })),
      },
      programFingerprint: PROGRAM_FINGERPRINT,
      verifiedAt: expect.any(String),
    });
    const discovered = await runPromotionGate({
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [{ ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, head_sha: WRONG_SHA } }],
    });
    await expect(discovered.result).resolves.toBeUndefined();
    const consumed = await runPromotionContentValidation(producedEvidence);
    await expect(consumed.result).resolves.toBeUndefined();
    const wrongSource = await runPromotionContentValidation({
      ...producedEvidence, source: { ...producedEvidence.source, sha: WRONG_SHA },
    });
    await expect(wrongSource.result).rejects.toThrow(EVIDENCE_MISMATCH);
  });

  it('feeds v4 producer evidence to rollback and rejects exact contract or resource drift', async () => {
    const produced = await produceProductionReleaseEvidence();
    const accepted = await runRollbackContentValidation(produced.evidence);

    await expect(accepted.result).resolves.toBeUndefined();
    expect(accepted.core.setOutput).toHaveBeenCalledWith('image_uri', produced.imageUri);
    expect(accepted.core.info).toHaveBeenCalledWith(
      `Resolved immutable rollback image ${produced.imageUri}`
    );

    const wrongContract = {
      ...produced.evidence,
      deploymentContractFingerprint: '0'.repeat(64),
    };
    const wrongResource = JSON.parse(JSON.stringify(produced.evidence));
    wrongResource.target.resources[0].providerResourceId = 'unreviewed-resource';
    for (const evidence of [wrongContract, wrongResource]) {
      const rejected = await runRollbackContentValidation(evidence);
      await expect(rejected.result).rejects.toThrow(
        `Rollback release evidence does not match the ${EVIDENCE_MISMATCH}`
      );
      expect(rejected.core.setOutput).not.toHaveBeenCalled();
    }
  });

  it('fails every evidence consumer if the shared validator is modified', async () => {
    const workflow = generatedWorkflow();
    const validator = installReleaseEvidenceValidator(workflow, tempDir);
    fs.writeFileSync(validator.validatorPath, 'module.exports = {};\n');
    const writeFileSync = vi.fn();
    const require = releaseEvidenceValidatorRequire(validator, {
      readFileSync: () => '{}',
      writeFileSync,
    });
    const process = {
      env: {
        HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
        HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
      },
    };

    for (const stepName of [
      'Deployment safety gate: verify Hypervibe reconciliation',
      'Verify reviewed release target',
      'Resolve immutable rollback image',
      'Resolve promotion deployment contract',
      'Validate promotion release evidence',
      'Write server release evidence',
    ]) {
      const execute = new AsyncFunction(
        'require',
        'process',
        'core',
        'github',
        'context',
        extractGitHubScript(workflow, stepName)
      );
      await expect(execute(require, process, {}, {}, {})).rejects.toThrow(
        'Release evidence validator failed its integrity check'
      );
    }
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('resolves source contract provenance after checkout and validates promotion before build', () => {
    const content = generatedWorkflow();
    const gateIndex = content.indexOf(`name: ${STEP_NAME}`);
    const checkoutIndex = content.indexOf('uses: actions/checkout@v7');
    const contractIndex = content.indexOf('name: Resolve promotion deployment contract');
    const validationIndex = content.indexOf(`name: ${VALIDATE_STEP_NAME}`);
    const buildIndex = content.indexOf('docker/build-push-action@v6');

    expect(content).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(content).toContain(`HYPERVIBE_PROMOTE_FROM_WORKFLOW: ${JSON.stringify(SOURCE_WORKFLOW)}`);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeLessThan(gateIndex);
    expect(gateIndex).toBeLessThan(contractIndex);
    expect(contractIndex).toBeLessThan(validationIndex);
    expect(validationIndex).toBeLessThan(buildIndex);
    expect(() => new AsyncFunction(extractGitHubScript(content, STEP_NAME))).not.toThrow();
    expect(content).toContain('id: promotion_evidence');
    expect(content).toContain('name: Download promotion release evidence');
    expect(content).toContain('artifact-ids: ${{ steps.promotion_evidence.outputs.artifact_id }}');
    expect(content).toContain('run-id: ${{ steps.promotion_evidence.outputs.run_id }}');
    expect(content).toContain(`HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT: ${PROGRAM_FINGERPRINT}`);
    expect(content).toContain(`HYPERVIBE_PROMOTION_BINDINGS_FINGERPRINT: ${SOURCE_BINDINGS_FINGERPRINT}`);
    expect(content).toContain(
      'HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: ${{ steps.deployment_contract.outputs.fingerprint }}'
    );
    expect(content).toContain(
      'HYPERVIBE_PROMOTION_DEPLOYMENT_CONTRACT_FINGERPRINT: ${{ steps.promotion_contract.outputs.fingerprint }}'
    );
  });

  it('accepts only exact successful source-workflow and release-artifact evidence', async () => {
    const gate = await runPromotionGate({ runs: [sourceRun()], artifacts: [sourceArtifact()] });

    await expect(gate.result).resolves.toBeUndefined();
    expect(gate.listArtifactsForRepo).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'promoted-app',
      name: EXPECTED_ARTIFACT,
      per_page: 100,
      page: 1,
    });
    expect(gate.getWorkflowRun).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'promoted-app',
      run_id: 41,
    });
    expect(gate.core.info).toHaveBeenCalledWith(
      `Verified staging release evidence for ${SHA} from ${SOURCE_WORKFLOW} run 41 artifact 71`
    );
    expect(gate.core.setOutput).toHaveBeenCalledWith('artifact_id', '71');
    expect(gate.core.setOutput).toHaveBeenCalledWith('run_id', '41');
  });

  it('accepts an exact deployed commit when dispatch used a different workflow ref commit', async () => {
    // Reconstructed GitHub responses: workflow_dispatch uses the selected ref's
    // last commit, independently of custom inputs.commit_sha; head_sha filters
    // the workflow run, not the deployed source recorded in our release artifact.
    // https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch
    // https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
    const gate = await runPromotionGate({
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [{ ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, head_sha: WRONG_SHA } }],
    });

    await expect(gate.result).resolves.toBeUndefined();
    expect(gate.core.setOutput).toHaveBeenCalledWith('artifact_id', '71');
    expect(gate.core.setOutput).toHaveBeenCalledWith('run_id', '41');
    const validation = await runPromotionContentValidation(validReleaseEvidence());
    await expect(validation.result).resolves.toBeUndefined();
  });

  it('rejects an unreviewed feature workflow even when forged evidence copies public fingerprints', async () => {
    // The evidence format is a content contract, not producer authentication.
    const forged = validReleaseEvidence();
    for (const resource of forged.target.resources) {
      resource.imageUri = `ghcr.io/acme/promoted-app@sha256:${'9'.repeat(64)}`;
    }
    await expect((await runPromotionContentValidation(forged)).result).resolves.toBeUndefined();
    const gate = await runPromotionGate({
      runs: [{ ...sourceRun(WRONG_SHA), head_branch: 'feature/unreviewed-workflow' }],
      artifacts: [{ ...sourceArtifact(), workflow_run: {
        ...sourceArtifact().workflow_run, head_sha: WRONG_SHA, head_branch: 'feature/unreviewed-workflow',
      } }],
    });
    await expect(gate.result).rejects.toThrow('No unexpired Hypervibe');
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it.each([
    ['missing branch', { head_branch: undefined }],
    ['unfinished run', { status: 'in_progress' }],
    ['pull request', { event: 'pull_request' }],
    ['pull request target', { event: 'pull_request_target' }],
    ['another repository', { repository: { id: 202, full_name: 'other/promoted-app' } }],
    ['fork with same branch name', { head_repository: { id: 202, full_name: 'fork/promoted-app' } }],
    ['missing repository identity', { repository: undefined }],
    ['mismatched repository ID', { head_repository: { ...REPOSITORY, id: 202 } }],
  ])('rejects producer provenance: %s', async (_label, runChanges) => {
    const gate = await runPromotionGate({ runs: [{ ...sourceRun(), ...runChanges }], artifacts: [sourceArtifact()] });
    await expect(gate.result).rejects.toThrow('No unexpired Hypervibe');
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it.each([
    ['branch mismatch', { head_branch: 'feature/unreviewed-workflow' }],
    ['repository mismatch', { repository_id: 202 }],
    ['head repository mismatch', { head_repository_id: 202 }],
    ['missing repository identity', { repository_id: undefined }],
  ])('rejects artifact producer metadata: %s', async (_label, metadata) => {
    const gate = await runPromotionGate({ runs: [sourceRun()], artifacts: [{ ...sourceArtifact(),
      workflow_run: { ...sourceArtifact().workflow_run, ...metadata },
    }] });
    await expect(gate.result).rejects.toThrow('No unexpired Hypervibe');
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it.each([
    ['unmerged SHA behind a same-named tag', { status: 'diverged', base_commit: { sha: SHA }, merge_base_commit: { sha: WRONG_SHA } }],
    ['producer ahead of trusted branch', { status: 'behind', base_commit: { sha: SHA }, merge_base_commit: { sha: TRUSTED_HEAD_SHA } }],
    ['missing comparison', {}],
    ['wrong comparison base', { status: 'ahead', base_commit: { sha: WRONG_SHA }, merge_base_commit: { sha: SHA } }],
    ['wrong merge base', { status: 'ahead', base_commit: { sha: SHA }, merge_base_commit: { sha: WRONG_SHA } }],
  ])('requires producer membership in the exact source branch: %s', async (_label, comparison) => {
    const gate = await runPromotionGate({ runs: [sourceRun()], artifacts: [sourceArtifact()], comparison });
    await expect(gate.result).rejects.toThrow('No unexpired Hypervibe');
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it.each([
    { ref: 'refs/tags/main', object: { type: 'commit', sha: TRUSTED_HEAD_SHA } },
    { ref: 'refs/heads/main', object: { type: 'tag', sha: TRUSTED_HEAD_SHA } },
    { ref: 'refs/heads/main', object: { type: 'commit', sha: 'short' } },
    {},
  ])('fails closed on an unverified source branch reference %#', async (branchRef) => {
    const gate = await runPromotionGate({ runs: [sourceRun()], artifacts: [sourceArtifact()], branchRef });
    await expect(gate.result).rejects.toThrow('Promotion source branch');
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it('accepts the exact trusted branch head from a push as well as older dispatched workflow commits', async () => {
    const gate = await runPromotionGate({
      runs: [{ ...sourceRun(TRUSTED_HEAD_SHA), event: 'push' }],
      artifacts: [{ ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, head_sha: TRUSTED_HEAD_SHA } }],
      comparison: { status: 'identical', base_commit: { sha: TRUSTED_HEAD_SHA }, merge_base_commit: { sha: TRUSTED_HEAD_SHA } },
    });
    await expect(gate.result).resolves.toBeUndefined();
    expect(gate.getRef).toHaveBeenCalledWith({ owner: 'acme', repo: 'promoted-app', ref: 'heads/main' });
    expect(gate.compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: 'acme', repo: 'promoted-app', basehead: TRUSTED_HEAD_SHA + '...' + TRUSTED_HEAD_SHA, per_page: 1,
    });
  });

  it('skips an untrusted newer artifact and selects the trusted release for the same deployed SHA', async () => {
    const gate = await runPromotionGate({
      runs: [{ ...sourceRun(), id: 40, head_branch: 'feature/unreviewed-workflow' }, sourceRun()],
      artifacts: [{ ...sourceArtifact(), id: 70, workflow_run: {
        ...sourceArtifact().workflow_run, id: 40, head_branch: 'feature/unreviewed-workflow',
      } }, sourceArtifact()],
    });
    await expect(gate.result).resolves.toBeUndefined();
    expect(gate.core.setOutput).toHaveBeenCalledWith('artifact_id', '71');
    expect(gate.getWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it('discovers an unexpired exact release after a full artifact page', async () => {
    const gate = await runPromotionGate({
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [
        ...Array.from({ length: 100 }, (_, index) => ({ ...sourceArtifact(), id: index + 100, expired: true })),
        { ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, head_sha: WRONG_SHA } },
      ],
    });

    await expect(gate.result).resolves.toBeUndefined();
    expect(gate.listArtifactsForRepo).toHaveBeenCalledTimes(2);
    expect(gate.listArtifactsForRepo).toHaveBeenLastCalledWith({
      owner: 'acme', repo: 'promoted-app', name: EXPECTED_ARTIFACT, per_page: 100, page: 2,
    });
    expect(gate.getWorkflowRun).toHaveBeenCalledOnce();
  });

  it('fails closed when artifact discovery exceeds its bounded search', async () => {
    const gate = await runPromotionGate({
      runs: [sourceRun()],
      artifacts: Array.from({ length: 1000 }, (_, index) => ({ ...sourceArtifact(), id: index + 100, expired: true })),
    });

    await expect(gate.result).rejects.toThrow('Promotion artifact search exceeded its 1000-artifact limit');
    expect(gate.listArtifactsForRepo).toHaveBeenCalledTimes(10);
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it('requires reviewed publication for promotion workflows while preserving other workflow locks', () => {
    const target = productionTarget();
    delete target.programFingerprint;
    delete target.deploymentContractFingerprint;
    const migration = { includeStep: false };
    // Accepted input hash after the first discovery fix; keep its literal
    // promotion revision independent of runtime constants.
    const previousHash = (inputTarget: BranchDeployTarget) => canonicalJsonSha256({
      version: 1, rendererRevision: 7,
      ...(inputTarget.promoteFromEnvironment ? { promotionRendererRevision: 1 } : {}),
      provider: 'railway', target: inputTarget, migration,
    });
    expect(githubActionsWorkflowInputHash({ provider: 'railway', target, migration })).not.toBe(previousHash(target));
    delete target.promoteFromEnvironment;
    expect(githubActionsWorkflowInputHash({ provider: 'railway', target, migration })).toBe(previousHash(target));
  });

  it.each([
    {
      label: 'missing artifact',
      runs: [sourceRun()],
      artifacts: [],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: false,
    },
    {
      label: 'run SHA differing from artifact workflow SHA',
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [sourceArtifact()],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: true,
    },
    {
      label: 'workflow path',
      runs: [{ ...sourceRun(), path: '.github/workflows/unreviewed.yml' }],
      artifacts: [sourceArtifact()],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: true,
    },
    {
      label: 'run conclusion',
      runs: [{ ...sourceRun(), conclusion: 'failure' }],
      artifacts: [sourceArtifact()],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: true,
    },
    {
      label: 'artifact expiry',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), expired: true }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: false,
    },
    {
      label: 'artifact workflow run',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, id: 42 } }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: true,
    },
    {
      label: 'artifact workflow SHA',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), workflow_run: { ...sourceArtifact().workflow_run, head_sha: WRONG_SHA } }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesRun: true,
    },
  ])('rejects promotion with mismatched $label provenance', async ({
    runs,
    artifacts,
    expectedError,
    observesRun,
  }) => {
    const gate = await runPromotionGate({ runs, artifacts });

    await expect(gate.result).rejects.toThrow(expectedError);
    if (observesRun) {
      expect(gate.getWorkflowRun).toHaveBeenCalledOnce();
    } else {
      expect(gate.getWorkflowRun).not.toHaveBeenCalled();
    }
    expect(gate.core.setOutput).not.toHaveBeenCalled();
  });

  it('accepts exact downloaded release evidence content', async () => {
    const validation = await runPromotionContentValidation(validReleaseEvidence());

    await expect(validation.result).resolves.toBeUndefined();
    expect(validation.readFileSync).toHaveBeenCalledWith(
      '/tmp/hypervibe-promotion-evidence/hypervibe-server-release.json',
      'utf8'
    );
    expect(validation.core.info).toHaveBeenCalledWith(
      `Validated staging release evidence content for ${SHA}`
    );
  });

  it.each([
    ['evidence from the wrong provider', { provider: 'cloudrun' }, EVIDENCE_MISMATCH],
    ['evidence without a verified immutable image', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: null })),
      },
    }, EVIDENCE_MISMATCH],
    ['evidence with the wrong program fingerprint', {
      programFingerprint: 'c'.repeat(64),
    }, EVIDENCE_MISMATCH],
    ['evidence from the wrong repository', {
      source: { repository: 'acme/other-app', sha: SHA },
    }, EVIDENCE_MISMATCH],
    ['evidence with the wrong services', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: [SOURCE_RESOURCES[1]],
      },
    }, EVIDENCE_MISMATCH],
    ['legacy evidence', { version: 2 }, /release evidence/i],
    ['v3 evidence without deployment contract provenance', {
      version: MANAGED_CI_RELEASE_EVIDENCE_VERSION - 1,
      deploymentContractFingerprint: undefined,
    }, /release evidence/i],
    ['malformed deployment contract fingerprint', {
      deploymentContractFingerprint: 'not-a-sha256-fingerprint',
    }, /release evidence/i],
    ['evidence with a different valid deployment contract fingerprint', {
      deploymentContractFingerprint: 'd'.repeat(64),
    }, EVIDENCE_MISMATCH],
    ['empty resources', {
      target: { scope: SOURCE_SCOPE, bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT, resources: [] },
    }, /release evidence/i],
    ['duplicate logical resources', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: [
          { ...SOURCE_RESOURCES[0], imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` },
          { ...SOURCE_RESOURCES[0], providerResourceId: 'other-job', imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` },
        ],
      },
    }, /release evidence/i],
    ['unknown resources', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: [
          ...SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` })),
          {
            logicalName: 'unknown',
            workloadKind: 'web',
            providerResourceType: 'service',
            providerResourceId: 'unknown-service',
            imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`,
          },
        ],
      },
    }, /release evidence/i],
    ['wrong provider scope', {
      target: {
        scope: { ...SOURCE_SCOPE, providerEnvironmentId: 'rail-other' },
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` })),
      },
    }, /release evidence/i],
    ['stale bindings fingerprint', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: 'f'.repeat(64),
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` })),
      },
    }, /release evidence/i],
  ])('rejects %s before a production provider mutation', async (_label, override, expectedError) => {
    const validation = await runPromotionContentValidation(validReleaseEvidence(override));
    await expect(validation.result).rejects.toThrow(expectedError);
  });
  it('restores the prior image after an env-only reconciliation', async () => {
    const spec = { version: 1, project: 'promoted-app', environments: { production: { hosting: { provider: 'railway' }, envVars: {} } } };
    const oldHash = environmentDeploymentContractHash(spec, 'production');
    const newHash = environmentDeploymentContractHash({ ...spec, environments: { production: { ...spec.environments.production, envVars: { SEED_CLIENT_TEST_DATA: 'true', CARE_PLAN_AI_REQUEST_TIMEOUT_MS: '30000' } } } }, 'production');
    expect(oldHash).not.toBe(newHash);
    const produced = await produceProductionReleaseEvidence(oldHash);
    const before = await runRollbackContentValidation(produced.evidence, oldHash);
    await expect(before.result).resolves.toBeUndefined();
    const generated = generatedWorkflow();
    const validator = installReleaseEvidenceValidator(generated, tempDir);
    const core = { setOutput: vi.fn() };
    const getContent = vi.fn(async () => ({ data: {
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(spec)).toString('base64'),
    }}));
    await new AsyncFunction('require', 'process', 'core', 'github', 'context', 'Buffer',
      extractGitHubScript(generated, 'Deployment safety gate: verify Hypervibe reconciliation'))(
        releaseEvidenceValidatorRequire(validator), { env: {
          HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
          HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
          HYPERVIBE_ENVIRONMENT: 'production', HYPERVIBE_APPLIED_SPEC_HASH: newHash,
          HYPERVIBE_DEPLOY_SHA: SHA, HYPERVIBE_DEPLOY_OPERATION: 'rollback',
        }}, core, { rest: { repos: { getContent } } }, { repo: { owner: 'acme', repo: 'promoted-app' } }, Buffer
    );
    const historicalHash = core.setOutput.mock.calls.find(([key]) => key === 'fingerprint')?.[1];
    expect(getContent).toHaveBeenCalledWith({owner: 'acme', repo: 'promoted-app', path: '.hypervibe/spec.json', ref: SHA});
    const after = await runRollbackContentValidation(produced.evidence, historicalHash);
    await expect(after.result).resolves.toBeUndefined();
    expect(after.core.setOutput).toHaveBeenCalledWith('image_uri', produced.imageUri);
  });

});
