import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import '../../../adapters/providers/railway/railway.adapter.js';
import '../../../adapters/providers/digitalocean/digitalocean.adapter.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const WRONG_SHA = 'f'.repeat(40);
const SOURCE_WORKFLOW = '.github/workflows/deploy-railway-staging.yml';
const EXPECTED_ARTIFACT = `hypervibe-server-release-staging-${SHA}`;
const STEP_NAME = 'Verify promotion release evidence';
const VALIDATE_STEP_NAME = 'Validate promotion release evidence';
const PROGRAM_FINGERPRINT = 'a'.repeat(64);
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
    promoteFromReleaseTarget: {
      scope: SOURCE_SCOPE,
      bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
      resources: SOURCE_RESOURCES,
    },
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

function extractGitHubScript(content: string, stepName: string): string {
  const stepStart = content.indexOf(`      - name: ${stepName}\n`);
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
  const readFileSync = vi.fn(() => JSON.stringify(evidence));
  const require = vi.fn((moduleName: string) => {
    if (moduleName === 'fs') return { readFileSync };
    if (moduleName === 'crypto') return { createHash };
    throw new Error(`Unexpected module: ${moduleName}`);
  });
  const core = { info: vi.fn(), setOutput: vi.fn() };
  const execute = new AsyncFunction(
    'require',
    'process',
    'core',
    extractGitHubScript(generatedWorkflow(), VALIDATE_STEP_NAME)
  );
  const result = execute(
    require,
    {
      env: {
        GITHUB_REPOSITORY: 'acme/promoted-app',
        HYPERVIBE_PROMOTE_FROM_ENVIRONMENT: 'staging',
        HYPERVIBE_PROMOTE_FROM_PROVIDER: 'railway',
        HYPERVIBE_PROMOTION_SHA: SHA,
        HYPERVIBE_PROMOTION_SERVICES: JSON.stringify(['web', 'nightly']),
        HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT: PROGRAM_FINGERPRINT,
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

function validReleaseEvidence(overrides: Record<string, unknown> = {}) {
  const imageUri = `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`;
  return {
    version: 3,
    provider: 'railway',
    environment: 'staging',
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

  it('writes provider and program provenance into source release evidence', async () => {
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
    const writeFileSync = vi.fn((_path: string, _content: string) => undefined);
    const require = vi.fn((moduleName: string) => {
      if (moduleName === 'fs') return { writeFileSync };
      if (moduleName === 'crypto') return { createHash };
      throw new Error(`Unexpected module: ${moduleName}`);
    });
    const execute = new AsyncFunction(
      'require',
      'process',
      extractGitHubScript(workflow, 'Write server release evidence')
    );

    await execute(require, {
      env: {
        GITHUB_REPOSITORY: 'acme/promoted-app',
        HYPERVIBE_RELEASE_SHA: SHA,
        HYPERVIBE_RELEASE_PROVIDER: 'railway',
        HYPERVIBE_RELEASE_ENVIRONMENT: 'staging',
        HYPERVIBE_RELEASE_SERVICES: JSON.stringify(['web', 'nightly']),
        HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(SOURCE_SCOPE),
        HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(SOURCE_RESOURCES),
        HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: SOURCE_BINDINGS_FINGERPRINT,
        HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: PROGRAM_FINGERPRINT,
        HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'true',
        HYPERVIBE_RELEASE_IMAGE_URI: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}`,
      },
    });

    expect(JSON.parse(String(writeFileSync.mock.calls[0]?.[1]))).toMatchObject({
      version: 3,
      provider: 'railway',
      environment: 'staging',
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
    });
  });

  it('runs before checkout/build only for a non-rollback promotion', () => {
    const content = generatedWorkflow();
    const gateIndex = content.indexOf(`name: ${STEP_NAME}`);

    expect(content).toContain("if: steps.deploy.outputs.operation != 'rollback'");
    expect(content).toContain(`HYPERVIBE_PROMOTE_FROM_WORKFLOW: ${JSON.stringify(SOURCE_WORKFLOW)}`);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(content.indexOf('uses: actions/checkout@v7'));
    expect(gateIndex).toBeLessThan(content.indexOf('docker/build-push-action@v6'));
    expect(() => new AsyncFunction(extractGitHubScript(content, STEP_NAME))).not.toThrow();
    expect(content).toContain('id: promotion_evidence');
    expect(content).toContain('name: Download promotion release evidence');
    expect(content).toContain('artifact-ids: ${{ steps.promotion_evidence.outputs.artifact_id }}');
    expect(content).toContain('run-id: ${{ steps.promotion_evidence.outputs.run_id }}');
    expect(content).toContain(`HYPERVIBE_PROMOTION_PROGRAM_FINGERPRINT: ${PROGRAM_FINGERPRINT}`);
    expect(content).toContain(`HYPERVIBE_PROMOTION_BINDINGS_FINGERPRINT: ${SOURCE_BINDINGS_FINGERPRINT}`);
    expect(content.indexOf(`name: ${VALIDATE_STEP_NAME}`)).toBeLessThan(content.indexOf('uses: actions/checkout@v7'));
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

  it('rejects a successful source run with no matching unexpired release artifact', async () => {
    const gate = await runPromotionGate({ runs: [sourceRun()], artifacts: [] });

    await expect(gate.result).rejects.toThrow(
      `No unexpired Hypervibe staging release artifact for ${SHA} was found in ${SOURCE_WORKFLOW}`
    );
  });

  it('rejects source workflow evidence for a different SHA', async () => {
    const gate = await runPromotionGate({
      runs: [sourceRun(WRONG_SHA)],
      artifacts: [sourceArtifact()],
    });

    await expect(gate.result).rejects.toThrow(
      `No successful staging deployment of ${SHA} was found in ${SOURCE_WORKFLOW}`
    );
    expect(gate.listWorkflowRunArtifacts).not.toHaveBeenCalled();
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

  it('rejects downloaded evidence from the wrong provider', async () => {
    const validation = await runPromotionContentValidation(validReleaseEvidence({ provider: 'cloudrun' }));

    await expect(validation.result).rejects.toThrow(
      'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image'
    );
  });

  it('rejects release evidence without a verified immutable image', async () => {
    const validation = await runPromotionContentValidation(validReleaseEvidence({
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: null })),
      },
    }));

    await expect(validation.result).rejects.toThrow(
      'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image'
    );
  });

  it('rejects downloaded evidence with the wrong program fingerprint', async () => {
    const validation = await runPromotionContentValidation(validReleaseEvidence({
      programFingerprint: 'c'.repeat(64),
    }));

    await expect(validation.result).rejects.toThrow(
      'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image'
    );
  });

  it('rejects downloaded evidence whose repository or services do not match', async () => {
    const wrongRepository = await runPromotionContentValidation(validReleaseEvidence({
      source: { repository: 'acme/other-app', sha: SHA },
    }));
    const wrongServices = await runPromotionContentValidation(validReleaseEvidence({
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: [SOURCE_RESOURCES[1]],
      },
    }));

    await expect(wrongRepository.result).rejects.toThrow(
      'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image'
    );
    await expect(wrongServices.result).rejects.toThrow(
      'exact reviewed provider, environment, repository, SHA, scope, bindings fingerprint, resources, program, and immutable image'
    );
  });

  it.each([
    ['legacy evidence', { version: 2 }],
    ['empty resources', { target: { scope: SOURCE_SCOPE, bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT, resources: [] } }],
    ['duplicate logical resources', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: [
          { ...SOURCE_RESOURCES[0], imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` },
          { ...SOURCE_RESOURCES[0], providerResourceId: 'other-job', imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` },
        ],
      },
    }],
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
    }],
    ['wrong provider scope', {
      target: {
        scope: { ...SOURCE_SCOPE, providerEnvironmentId: 'rail-other' },
        bindingsFingerprint: SOURCE_BINDINGS_FINGERPRINT,
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` })),
      },
    }],
    ['stale bindings fingerprint', {
      target: {
        scope: SOURCE_SCOPE,
        bindingsFingerprint: 'f'.repeat(64),
        resources: SOURCE_RESOURCES.map((resource) => ({ ...resource, imageUri: `ghcr.io/acme/promoted-app@sha256:${'b'.repeat(64)}` })),
      },
    }],
  ])('rejects %s before a production provider mutation', async (_label, override) => {
    const validation = await runPromotionContentValidation(validReleaseEvidence(override));
    await expect(validation.result).rejects.toThrow(/release evidence/i);
  });
});
