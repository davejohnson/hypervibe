import { createHash } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/digitalocean/digitalocean.adapter.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
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
    conclusion: 'success',
    path: SOURCE_WORKFLOW,
  };
}

function sourceArtifact() {
  return {
    id: 71,
    name: EXPECTED_ARTIFACT,
    expired: false,
    workflow_run: { id: 41, head_sha: SHA },
  };
}

async function runPromotionGate(options: {
  runs: unknown[];
  artifacts?: unknown[];
}) {
  const listWorkflowRuns = vi.fn(async () => ({
    data: { workflow_runs: options.runs },
  }));
  const listWorkflowRunArtifacts = vi.fn(async () => ({
    data: { artifacts: options.artifacts ?? [] },
  }));
  const github = {
    rest: {
      actions: { listWorkflowRuns, listWorkflowRunArtifacts },
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
        HYPERVIBE_PROMOTION_SHA: SHA,
      },
    },
    core
  );
  return { result, github, core, listWorkflowRuns, listWorkflowRunArtifacts };
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

async function produceProductionReleaseEvidence() {
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
      HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: target.deploymentContractFingerprint,
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

async function runRollbackContentValidation(evidence: unknown) {
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
        HYPERVIBE_ROLLBACK_DEPLOYMENT_CONTRACT_FINGERPRINT: target.deploymentContractFingerprint,
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
    const consumed = await runPromotionContentValidation(producedEvidence);
    await expect(consumed.result).resolves.toBeUndefined();
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
    expect(gate.listWorkflowRuns).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'promoted-app',
      workflow_id: SOURCE_WORKFLOW,
      head_sha: SHA,
      status: 'success',
      per_page: 20,
    });
    expect(gate.listWorkflowRunArtifacts).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'promoted-app',
      run_id: 41,
      per_page: 100,
    });
    expect(gate.core.info).toHaveBeenCalledWith(
      `Verified staging release evidence for ${SHA} from ${SOURCE_WORKFLOW} run 41 artifact 71`
    );
    expect(gate.core.setOutput).toHaveBeenCalledWith('artifact_id', '71');
    expect(gate.core.setOutput).toHaveBeenCalledWith('run_id', '41');
  });

  it.each([
    {
      label: 'missing artifact',
      runs: [sourceRun()],
      artifacts: [],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: true,
    },
    {
      label: 'run SHA',
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [sourceArtifact()],
      expectedError: `No successful staging deployment of ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: false,
    },
    {
      label: 'workflow path',
      runs: [{ ...sourceRun(), path: '.github/workflows/unreviewed.yml' }],
      artifacts: [sourceArtifact()],
      expectedError: `No successful staging deployment of ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: false,
    },
    {
      label: 'run conclusion',
      runs: [{ ...sourceRun(), conclusion: 'failure' }],
      artifacts: [sourceArtifact()],
      expectedError: `No successful staging deployment of ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: false,
    },
    {
      label: 'artifact expiry',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), expired: true }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: true,
    },
    {
      label: 'artifact workflow run',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), workflow_run: { id: 42, head_sha: SHA } }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: true,
    },
    {
      label: 'artifact workflow SHA',
      runs: [sourceRun()],
      artifacts: [{ ...sourceArtifact(), workflow_run: { id: 41, head_sha: WRONG_SHA } }],
      expectedError: `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`,
      observesArtifacts: true,
    },
  ])('rejects promotion with mismatched $label provenance', async ({
    runs,
    artifacts,
    expectedError,
    observesArtifacts,
  }) => {
    const gate = await runPromotionGate({ runs, artifacts });

    await expect(gate.result).rejects.toThrow(expectedError);
    if (observesArtifacts) {
      expect(gate.listWorkflowRunArtifacts).toHaveBeenCalledOnce();
    } else {
      expect(gate.listWorkflowRunArtifacts).not.toHaveBeenCalled();
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
});
