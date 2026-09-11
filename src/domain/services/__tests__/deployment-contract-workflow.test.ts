import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import { buildGitLabDeploymentContractRuntime } from '../../../adapters/providers/gitlab/gitlab-ci.lifecycle.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
} from '../../ports/ci-deploy.port.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';
import {
  extractGitHubScript,
  installReleaseEvidenceValidator,
  releaseEvidenceValidatorRequire,
  workflowStepIdentifiers,
} from './managed-ci-workflow.test-utils.js';

const GATE_STEP_NAME = 'Deployment safety gate: verify Hypervibe reconciliation';
const ANNOTATION_TITLE = 'Deployment blocked — Hypervibe reconciliation required';
const DEPLOY_SHA = '0123456789abcdef0123456789abcdef01234567';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
const SPEC = {
  version: 1,
  project: 'contract-app',
  gitRemoteUrl: 'git@github.com:dave/contract-app.git',
  runtime: { kind: 'node', version: '24' },
  secrets: {
    SHARED_KEY: {
      ownership: 'delegated',
      principal: 'owner',
      environments: ['staging', 'production'],
      required: true,
      driftPolicy: 'preserve',
    },
  },
  environments: {
    staging: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    },
    production: {
      hosting: { provider: 'railway' },
      services: { web: { workloadKind: 'web' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    },
  },
};

function target(
  environmentName: 'staging' | 'production',
  kind: BranchDeployEnvironmentKind,
  provider: BranchDeployProvider
): BranchDeployTarget {
  const branchTarget: BranchDeployTarget = {
    environmentName,
    kind,
    branch: 'main',
    autoDeployOnPush: kind === 'staging',
    serviceNames: ['web'],
    providerProjectId: 'provider-project',
    providerEnvironmentId: 'provider-environment',
    providerRegion: 'us-central1',
    providerScope: { projectId: 'provider-project', region: 'us-central1' },
    providerServiceIds: ['provider-service'],
    providerJobNames: [],
    programFingerprint: 'a'.repeat(64),
    deploymentContractFingerprint: environmentDeploymentContractHash(SPEC, environmentName),
  };
  branchTarget.releaseTarget = managedCiReleaseTarget({
    provider,
    environmentName,
    scope: {
      providerProjectId: branchTarget.providerProjectId,
      providerEnvironmentId: branchTarget.providerEnvironmentId,
      providerRegion: branchTarget.providerRegion,
      providerScope: branchTarget.providerScope,
    },
    resources: [{
      logicalName: 'web',
      workloadKind: 'web',
      providerResourceType: 'service',
      providerResourceId: 'provider-service',
    }],
  });
  return branchTarget;
}

function workflow(
  provider: BranchDeployProvider = 'railway',
  environmentName: 'staging' | 'production' = 'staging'
) {
  return buildBranchDeployWorkflow(
    provider,
    target(environmentName, environmentName, provider),
    { includeStep: false }
  );
}

type GateResult = {
  core: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    setFailed: ReturnType<typeof vi.fn>;
    setOutput: ReturnType<typeof vi.fn>;
  };
  readFileSync: ReturnType<typeof vi.fn>;
  summaryText: string;
  summaryWrite: ReturnType<typeof vi.fn>;
};

async function runGate(
  environmentName: 'staging' | 'production',
  appliedHash?: string,
  operation = 'deploy'
): Promise<GateResult> {
  const summaryParts: string[] = [];
  const summary = {
    addHeading: vi.fn((text: string) => {
      summaryParts.push(text);
      return summary;
    }),
    addRaw: vi.fn((text: string) => {
      summaryParts.push(text);
      return summary;
    }),
    addBreak: vi.fn(() => {
      summaryParts.push('');
      return summary;
    }),
    addTable: vi.fn((rows: unknown[][]) => {
      summaryParts.push(JSON.stringify(rows));
      return summary;
    }),
    addList: vi.fn((items: string[]) => {
      summaryParts.push(items.join('\n'));
      return summary;
    }),
    write: vi.fn(async () => summary),
  };
  const core = {
    error: vi.fn(),
    info: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    summary,
  };
  const generated = workflow('railway', environmentName).content;
  const readFileSync = vi.fn(() => JSON.stringify(SPEC));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-contract-gate-'));
  try {
    const validator = installReleaseEvidenceValidator(generated, tempDir);
    const execute = new AsyncFunction(
      'require',
      'core',
      'process',
      extractGitHubScript(generated, GATE_STEP_NAME)
    );
    await execute(
      releaseEvidenceValidatorRequire(validator, {
        readFileSync,
      }),
      core,
      {
        env: {
          HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
          HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
          HYPERVIBE_ENVIRONMENT: environmentName,
          HYPERVIBE_APPLIED_SPEC_HASH: appliedHash,
          HYPERVIBE_DEPLOY_SHA: DEPLOY_SHA,
          HYPERVIBE_DEPLOY_OPERATION: operation,
        },
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    core,
    readFileSync,
    summaryText: summaryParts.join('\n'),
    summaryWrite: summary.write,
  };
}

describe('generated deployment-contract safety gate', () => {
  it('reports a missing applied hash as a deployment safety block', async () => {
    const result = await runGate('staging');
    const desiredHash = environmentDeploymentContractHash(SPEC, 'staging');

    expect(result.core.error).toHaveBeenCalledWith(
      'Deployment blocked for staging: applied contract hash is missing.',
      { title: ANNOTATION_TITLE }
    );
    expect(result.core.setFailed).toHaveBeenCalledWith(
      'Deployment blocked for staging: applied contract hash is missing.'
    );
    expect(result.core.setOutput).not.toHaveBeenCalled();
    expect(result.summaryWrite).toHaveBeenCalledOnce();
    expect(result.summaryText).toContain(ANNOTATION_TITLE);
    expect(result.summaryText).toContain('This is not an application build or test failure. No image was built and nothing was deployed.');
    expect(result.summaryText).toContain(`The desired staging infrastructure contract for commit \`${DEPLOY_SHA}\``);
    expect(result.summaryText).toContain('**Cause:** applied hash missing');
    expect(result.summaryText).toContain(desiredHash);
    expect(result.summaryText).toContain('missing');
    expect(result.summaryText).toContain(DEPLOY_SHA);
    expect(result.summaryText).toContain(`Check out commit \`${DEPLOY_SHA}\`.`);
    expect(result.summaryText).toContain('Run `hv_status` for `staging`.');
    expect(result.summaryText).toContain('Run `hv_plan` for `staging`.');
    expect(result.summaryText).toContain('Review and apply that exact plan with `hv_apply`.');
    expect(result.summaryText).toContain('Retrigger this workflow with `hv_ci_trigger`.');
  });

  it('reports a mismatched applied hash with both hashes and the prevented commit', async () => {
    const appliedHash = 'f'.repeat(64);
    const result = await runGate('production', appliedHash);
    const desiredHash = environmentDeploymentContractHash(SPEC, 'production');

    expect(result.core.error).toHaveBeenCalledWith(
      'Deployment blocked for production: desired and applied contract hashes differ.',
      { title: ANNOTATION_TITLE }
    );
    expect(result.core.setFailed).toHaveBeenCalledWith(
      'Deployment blocked for production: desired and applied contract hashes differ.'
    );
    expect(result.core.setOutput).not.toHaveBeenCalled();
    expect(result.summaryText).toContain('**Cause:** desired and applied hashes differ');
    expect(result.summaryText).toContain(desiredHash);
    expect(result.summaryText).toContain(appliedHash);
    expect(result.summaryText).toContain(DEPLOY_SHA);
  });

  it('keeps the successful path quiet when the hashes match', async () => {
    const appliedHash = environmentDeploymentContractHash(SPEC, 'staging');
    const result = await runGate('staging', appliedHash);

    expect(result.core.error).not.toHaveBeenCalled();
    expect(result.core.setFailed).not.toHaveBeenCalled();
    expect(result.core.setOutput).toHaveBeenCalledOnce();
    expect(result.core.setOutput).toHaveBeenCalledWith('fingerprint', appliedHash);
    expect(result.summaryWrite).not.toHaveBeenCalled();
  });

  it('uses the current applied contract for rollback before provider mutation', async () => {
    const appliedHash = 'e'.repeat(64);
    const accepted = await runGate('production', appliedHash, 'rollback');
    expect(accepted.core.setOutput).toHaveBeenCalledWith('fingerprint', appliedHash);
    expect(accepted.readFileSync).not.toHaveBeenCalled();

    await expect(runGate('production', undefined, 'rollback')).rejects.toThrow(
      'Rollback blocked for production: applied contract hash is missing or malformed.'
    );
  });

  it('places the parsed contract and evidence steps around every build and provider mutation', () => {
    for (const provider of ['railway', 'cloudrun'] as const) {
      for (const environmentName of ['staging', 'production'] as const) {
        const generated = workflow(provider, environmentName);
        const steps = workflowStepIdentifiers(generated.content);
        const providerMutation = provider === 'railway'
          ? 'Deploy image to Railway'
          : 'Deploy image to Cloud Run';
        const gateIndex = steps.indexOf(GATE_STEP_NAME);
        const imageBuildIndex = steps.indexOf('docker/build-push-action@v6');
        const rollbackEvidenceIndex = steps.indexOf('Resolve immutable rollback image');
        const providerMutationIndex = steps.indexOf(providerMutation);
        const releaseEvidenceIndex = steps.indexOf('Write server release evidence');

        expect(generated.content).toContain(`environment: ${environmentName}`);
        expect(generated.content).toContain(`name: ${JSON.stringify(GATE_STEP_NAME)}`);
        expect(generated.content).toContain('HYPERVIBE_DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
        expect(gateIndex).toBeGreaterThan(-1);
        expect(gateIndex).toBeLessThan(imageBuildIndex);
        expect(imageBuildIndex).toBeLessThan(providerMutationIndex);
        expect(providerMutationIndex).toBeLessThan(releaseEvidenceIndex);
        expect(gateIndex).toBeLessThan(rollbackEvidenceIndex);
        expect(rollbackEvidenceIndex).toBeLessThan(providerMutationIndex);
        expect(generated.content).not.toContain('continue-on-error');
        expect(() => new AsyncFunction(
          extractGitHubScript(generated.content, GATE_STEP_NAME)
        )).not.toThrow();
      }
    }
  });
});

describe('generated GitLab deployment-contract safety gate', () => {
  it('executes the emitted runtime against the raw spec before build or provider mutation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-gitlab-contract-gate-'));
    const runtimePath = path.join(directory, 'verify-deployment-contract.cjs');
    fs.mkdirSync(path.join(directory, '.hypervibe'));
    fs.writeFileSync(path.join(directory, '.hypervibe/spec.json'), JSON.stringify(SPEC));
    fs.writeFileSync(runtimePath, buildGitLabDeploymentContractRuntime());
    const baseEnv = {
      ...process.env,
      HYPERVIBE_ENVIRONMENT: 'staging',
      HYPERVIBE_ROLLBACK: 'false',
    };
    try {
      const appliedHash = environmentDeploymentContractHash(SPEC, 'staging');
      const accepted = spawnSync(process.execPath, [runtimePath], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...baseEnv, HYPERVIBE_APPLIED_SPEC_HASH: appliedHash },
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(
        path.join(directory, '.hypervibe-deployment-contract-fingerprint'),
        'utf8'
      )).toBe(`${appliedHash}\n`);

      const rejected = spawnSync(process.execPath, [runtimePath], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...baseEnv, HYPERVIBE_APPLIED_SPEC_HASH: 'f'.repeat(64) },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('desired and applied contract hashes differ');

      fs.rmSync(path.join(directory, '.hypervibe/spec.json'));
      const rollbackHash = 'e'.repeat(64);
      const rollback = spawnSync(process.execPath, [runtimePath], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          HYPERVIBE_APPLIED_SPEC_HASH: rollbackHash,
          HYPERVIBE_ROLLBACK: 'true',
        },
      });
      expect(rollback.status, rollback.stderr).toBe(0);
      expect(fs.readFileSync(
        path.join(directory, '.hypervibe-deployment-contract-fingerprint'),
        'utf8'
      )).toBe(`${rollbackHash}\n`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('generated deployment failure evidence', () => {
  it('adds a bounded sanitized failure artifact job for every provider and environment', () => {
    for (const provider of ['railway', 'cloudrun'] as const) {
      for (const environmentName of ['staging', 'production'] as const) {
        const generated = workflow(provider, environmentName);

        expect(generated.content).toContain('  failure_evidence:\n    needs: deploy');
        expect(generated.content).toContain("    if: ${{ always() && needs.deploy.result == 'failure' }}");
        expect(generated.content).toContain('      actions: read');
        expect(generated.content).toContain('      - name: Capture sanitized deployment failure evidence');
        expect(generated.content).toContain('      - name: Upload deployment failure evidence');
        expect(generated.content).toContain('          path: hypervibe-deploy-failure.log');
        expect(generated.content).toContain(`          name: deploy-${environmentName}-failure-evidence`);
        expect(() => new AsyncFunction(
          extractGitHubScript(generated.content, 'Capture sanitized deployment failure evidence')
        )).not.toThrow();
      }
    }
  });

  it('keeps the failed deploy diagnosis while redacting credential-shaped log values', async () => {
    const generated = workflow('railway', 'staging');
    const script = extractGitHubScript(
      generated.content,
      'Capture sanitized deployment failure evidence'
    );
    const writeFileSync = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const github = {
      paginate: vi.fn(async () => [
        { id: 41, name: 'unrelated', conclusion: 'success' },
        { id: 42, name: 'deploy', conclusion: 'failure' },
      ]),
      request: vi.fn(async () => ({
        data: Buffer.from([
          'ordinary build output',
          'Authorization: Bearer extremely-sensitive-token',
          'RAILWAY_API_TOKEN=railway-sensitive-token',
          'DATABASE_URL=postgresql://postgres:database-password@example.test/app',
          'request=https://example.test/deploy?token=query-sensitive-token',
          'Railway deployment dep-123 failed with status CRASHED',
        ].join('\n')),
      })),
      rest: { actions: { listJobsForWorkflowRun } },
    };
    const requireModule = (moduleName: string) => {
      if (moduleName === 'fs') return { writeFileSync };
      throw new Error(`Unexpected module request: ${moduleName}`);
    };
    const execute = new AsyncFunction('require', 'github', 'context', 'process', 'core', script);

    await execute(
      requireModule,
      github,
      { repo: { owner: 'dave', repo: 'contract-app' } },
      { env: { HYPERVIBE_RUN_ID: '1234' } },
      { info: vi.fn() }
    );

    expect(github.paginate).toHaveBeenCalledWith(listJobsForWorkflowRun, {
      owner: 'dave',
      repo: 'contract-app',
      run_id: 1234,
      filter: 'latest',
      per_page: 100,
    });
    expect(github.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { owner: 'dave', repo: 'contract-app', job_id: 42 }
    );
    expect(writeFileSync).toHaveBeenCalledOnce();
    const evidence = String(writeFileSync.mock.calls[0]?.[1]);
    expect(evidence).toContain('Railway deployment dep-123 failed with status CRASHED');
    expect(evidence).toContain('RAILWAY_API_TOKEN=***');
    expect(evidence).not.toContain('extremely-sensitive-token');
    expect(evidence).not.toContain('railway-sensitive-token');
    expect(evidence).not.toContain('database-password');
    expect(evidence).not.toContain('query-sensitive-token');
  });
});
