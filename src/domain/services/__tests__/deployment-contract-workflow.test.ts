import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployProvider,
  BranchDeployTarget,
} from '../../ports/ci-deploy.port.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';

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
  kind: BranchDeployEnvironmentKind
): BranchDeployTarget {
  return {
    environmentName,
    kind,
    branch: 'main',
    autoDeployOnPush: kind === 'staging',
    serviceNames: ['web'],
    providerProjectId: 'provider-project',
    providerEnvironmentId: 'provider-environment',
    providerServiceIds: ['provider-service'],
    providerJobNames: [],
  };
}

function workflow(
  provider: BranchDeployProvider = 'railway',
  environmentName: 'staging' | 'production' = 'staging'
) {
  return buildBranchDeployWorkflow(
    provider,
    target(environmentName, environmentName),
    { includeStep: false }
  );
}

function extractGateScript(content: string): string {
  const stepStart = content.indexOf(`      - name: ${JSON.stringify(GATE_STEP_NAME)}\n`);
  expect(stepStart).toBeGreaterThan(-1);
  const marker = '          script: |\n';
  const scriptStart = content.indexOf(marker, stepStart) + marker.length;
  const nextStep = content.indexOf('\n      - ', scriptStart);
  const scriptEnd = nextStep === -1 ? content.length : nextStep;
  return content
    .slice(scriptStart, scriptEnd)
    .split('\n')
    .map((line) => line.startsWith('            ') ? line.slice(12) : line)
    .join('\n')
    .trimEnd();
}

type GateResult = {
  core: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    setFailed: ReturnType<typeof vi.fn>;
  };
  summaryText: string;
  summaryWrite: ReturnType<typeof vi.fn>;
};

async function runGate(
  environmentName: 'staging' | 'production',
  appliedHash?: string
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
    summary,
  };
  const requireModule = (moduleName: string) => {
    if (moduleName === 'crypto') return { createHash };
    if (moduleName === 'fs') {
      return { readFileSync: () => JSON.stringify(SPEC) };
    }
    throw new Error(`Unexpected module request: ${moduleName}`);
  };
  const execute = new AsyncFunction('require', 'core', 'process', extractGateScript(workflow('railway', environmentName).content));
  await execute(requireModule, core, {
    env: {
      HYPERVIBE_ENVIRONMENT: environmentName,
      HYPERVIBE_APPLIED_SPEC_HASH: appliedHash,
      HYPERVIBE_DEPLOY_SHA: DEPLOY_SHA,
    },
  });

  return {
    core,
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
    expect(result.summaryWrite).not.toHaveBeenCalled();
  });

  it('places the same parseable gate before builds and deploys for every supported provider and environment', () => {
    for (const provider of ['railway', 'cloudrun'] as const) {
      for (const environmentName of ['staging', 'production'] as const) {
        const generated = workflow(provider, environmentName);
        const gateIndex = generated.content.indexOf(GATE_STEP_NAME);
        const imageBuildIndex = generated.content.indexOf('docker/build-push-action@v6');

        expect(generated.content).toContain(`environment: ${environmentName}`);
        expect(generated.content).toContain(`name: ${JSON.stringify(GATE_STEP_NAME)}`);
        expect(generated.content).toContain('HYPERVIBE_DEPLOY_SHA: ${{ steps.deploy.outputs.sha }}');
        expect(gateIndex).toBeGreaterThan(-1);
        expect(gateIndex).toBeLessThan(imageBuildIndex);
        expect(generated.content).not.toContain('continue-on-error');
        expect(() => new AsyncFunction(extractGateScript(generated.content))).not.toThrow();
      }
    }
  });
});
