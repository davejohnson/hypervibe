import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { buildManagedTaskCommand, executeManagedEnvironmentTask, safeManagedTaskReceipt } from '../managed-environment-task.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { workflowFilesContentHash } from '../../domain/services/ci-deploy.service.js';
import { releaseEvidenceValidationRuntime } from '../../domain/services/github-ops.service.js';
import '../../ci/providers.js';

const task = {
  kind: 'environment-task' as const,
  enabled: true,
  environment: 'staging',
  service: 'web',
  command: ['npm', 'run', 'tester:setup', '--', '--json'],
  inputs: {
    actor: { type: 'string' as const, flag: '--as', description: 'Operator', required: true, default: '' },
    email: { type: 'string' as const, flag: '--email', description: 'Tester', required: true, default: '' },
    dry_run: { type: 'boolean' as const, flag: '--dry-run', description: 'Preview', required: false, default: true },
  },
  receiptPrefix: '__HLS_TESTER_SETUP_RECEIPT:',
  receiptCountKeys: ['applied', 'skipped', 'propertyCreated'],
};

describe('managed environment task application boundary', () => {
  it('quotes every dispatch value as a literal argv value and defaults to preview', () => {
    expect(buildManagedTaskCommand(task, { actor: 'dave@example.com', email: "tester'$(touch /tmp/injected)@example.com" }))
      .toBe("'npm' 'run' 'tester:setup' '--' '--json' '--as' 'dave@example.com' '--email' 'tester'\"'\"'$(touch /tmp/injected)@example.com' '--dry-run'");
  });

  it.each([
    { actor: 'dave@example.com', email: 'test@example.com', command: 'evil' },
    { actor: 'dave@example.com', email: 'test@example.com', dry_run: 'false' },
    { actor: '', email: 'test@example.com' },
    { actor: 'dave@example.com', email: '--evil' },
    { actor: 'dave@example.com', email: 'line\nvalue' },
  ])('rejects malformed input without accepting an arbitrary command (%j)', (inputs) => {
    expect(() => buildManagedTaskCommand(task, inputs)).toThrow();
  });

  it('publishes only numeric counts and mode, never application logs or string fields', () => {
    const receipt = { version: 1, mode: 'applied', counts: { applied: 3, skipped: 1, propertyCreated: 2 }, password: 'private-secret', testerEmail: 'private@example.com' };
    expect(safeManagedTaskReceipt(`secret output\n${task.receiptPrefix}${JSON.stringify(receipt)}`, task.receiptPrefix, task.receiptCountKeys))
      .toEqual({ version: 1, mode: 'applied', counts: receipt.counts });
  });

  it.each([
    '',
    '__HLS_TESTER_SETUP_RECEIPT:{}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","counts":{"applied":-1,"skipped":0}}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","counts":{"applied":"secret","skipped":0}}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","counts":{"applied":0,"skipped":0}}\n__HLS_TESTER_SETUP_RECEIPT:{}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":["applied"],"counts":{"applied":0,"skipped":0}}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","accountAction":["invited"],"counts":{"applied":0,"skipped":0}}',
    '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","counts":{"applied":0,"skipped":0,"privateSecretLabel":1}}',
  ])('rejects missing, ambiguous, or invalid application receipts (%s)', (output) => {
    expect(() => safeManagedTaskReceipt(output, task.receiptPrefix)).toThrow();
  });
});

// Synthetic application/port evidence for the existing managed release-v4
// contract. Provider wire formats are covered separately by adapter contracts.
function fixture() {
  const sha = 'a'.repeat(40);
  const image = 'ghcr.io/owner/app@sha256:' + 'b'.repeat(64);
  const program = 'c'.repeat(64);
  const workflowSource = `concurrency:\n  group: hypervibe-deploy-staging\n  cancel-in-progress: false\nHYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: ${program}\n`;
  const rawSpec = {
    version: 1, project: 'app', gitRemoteUrl: 'git@github.com:owner/app.git',
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    github: { enabled: true, repository: 'owner/app', canonicalEnvironment: 'staging', actions: { setup: task } },
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web', startCommand: 'npm start', public: true } }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } },
  };
  const spec = projectSpecSchema.parse(rawSpec);
  const scope = { providerProjectId: 'project-staging', providerEnvironmentId: 'env-staging' };
  const resources = [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-staging' }];
  const module = { exports: {} };
  new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
  const contract = (module.exports as { deploymentContractFingerprint(spec: unknown, environment: string): string }).deploymentContractFingerprint(rawSpec, 'staging');
  const evidence = { version: 4, provider: 'railway', environment: 'staging', deploymentContractFingerprint: contract, source: { repository: 'owner/app', sha },
    target: { scope, resources: resources.map((resource) => ({ ...resource, imageUri: image })), bindingsFingerprint: canonicalJsonSha256({ version: 1, provider: 'railway', environment: 'staging', scope, resources }) },
    programFingerprint: program, verifiedAt: '2026-09-29T10:00:00Z' };
  const bindings = {
    version: 1, project: 'app', environments: {
      staging: { platformBindings: {
        provider: 'railway', projectId: 'project-staging', environmentId: 'env-staging',
        services: { web: { serviceId: 'web-staging', workloadKind: 'web' } },
        ci: { deployBranch: { '.github/workflows/deploy-staging.yml': {
          contentHash: workflowFilesContentHash([{ path: '.github/workflows/deploy-staging.yml', content: workflowSource }]),
        } } },
      } },
    },
  };
  const github = {
    getRepository: vi.fn().mockResolvedValue({ default_branch: 'main' }),
    getFileContent: vi.fn().mockResolvedValue(workflowSource),
    listWorkflowRuns: vi.fn().mockResolvedValue({ workflow_runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: sha, head_branch: 'main' }] }),
    getWorkflowRun: vi.fn().mockResolvedValue({ id: 42, path: '.github/workflows/deploy-staging.yml', head_sha: sha, status: 'completed', conclusion: 'success', repository: { full_name: 'owner/app' }, head_repository: { full_name: 'owner/app' } }),
    listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ total_count: 1, artifacts: [{ id: 9, name: `hypervibe-server-release-v4-staging-${sha}`, expired: false, workflow_run: { id: 42, head_sha: sha } }] }),
    readJsonArtifact: vi.fn().mockResolvedValue(evidence),
  };
  const runJob = vi.fn().mockResolvedValue({ jobId: 'job-1', receipt: { success: true }, status: 'completed', exitCode: 0,
    output: '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"preview","counts":{"applied":0,"skipped":0},"accountAction":"would-invite","planned":{"propertyCreated":2}}' });
  vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({ runJob });
  return { github, runJob, evidence, image, params: { spec, rawSpec, bindings, taskId: 'setup', inputs: { actor: 'owner@example.com', email: 'tester@example.com' },
    repository: 'owner/app', sha, executionId: '123', github: github as unknown as GitHubAdapter,
    credentials: { RAILWAY_API_TOKEN: 'private-railway-token', IMAGE_REGISTRY_USERNAME: 'owner', IMAGE_REGISTRY_TOKEN: 'private-registry-token' } } };
}

afterEach(() => vi.restoreAllMocks());
describe('private task release authorization', () => {
  it('executes the verified staging digest with typed literal argv and safe final counts', async () => {
    const { params, runJob, image } = fixture();
    const result = await executeManagedEnvironmentTask(params);
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ name: 'staging' }), expect.objectContaining({ name: 'web' }), expect.stringContaining("'--dry-run'"),
      { declaredTask: { variableMode: 'references', sweep: false, expectedImage: image, executionId: '123', registryCredentials: { username: 'owner', token: 'private-registry-token' } } });
    expect(result).toMatchObject({ status: 'completed', application: { mode: 'preview', counts: { applied: 0, skipped: 0 }, accountAction: 'would-invite', planned: { propertyCreated: 2 } } });
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it.each(['environment', 'sha', 'resource', 'image', 'contract', 'workflow', 'deploying', 'scope', 'secrets', 'lock'])('blocks mismatched %s before running a job', async (mismatch) => {
    const { params, github, evidence, runJob } = fixture();
    if (mismatch === 'environment') evidence.environment = 'production';
    if (mismatch === 'sha') evidence.source.sha = 'd'.repeat(40);
    if (mismatch === 'resource') evidence.target.resources[0].providerResourceId = 'production-web';
    if (mismatch === 'image') evidence.target.resources[0].imageUri = 'ghcr.io/owner/app:latest';
    if (mismatch === 'contract') evidence.deploymentContractFingerprint = 'e'.repeat(64);
    if (mismatch === 'scope') evidence.target.scope.providerEnvironmentId = 'env-production';
    if (mismatch === 'workflow') github.getWorkflowRun.mockResolvedValue({ path: '.github/workflows/untrusted.yml' });
    if (mismatch === 'deploying') github.listWorkflowRuns.mockResolvedValue({ workflow_runs: [{ status: 'in_progress' }] });
    if (mismatch === 'secrets') params.credentials.RAILWAY_API_TOKEN = '';
    if (mismatch === 'lock') github.getFileContent.mockResolvedValue('no deployment lock');
    await expect(executeManagedEnvironmentTask(params)).rejects.toMatchObject({ attempted: false });
    expect(runJob).not.toHaveBeenCalled();
  });

  it.each(['exit', 'cleanup', 'receipt', 'provider-echo'])('fails safely on unverified %s without retrying', async (failure) => {
    const { params, runJob } = fixture();
    const validOutput = '__HLS_TESTER_SETUP_RECEIPT:{"version":1,"mode":"applied","counts":{"applied":2,"skipped":1}}';
    if (failure === 'exit') runJob.mockResolvedValue({ status: 'completed', receipt: { success: true }, output: validOutput });
    if (failure === 'cleanup') runJob.mockResolvedValue({ status: 'completed', exitCode: 0, receipt: { success: true }, output: validOutput, cleanupWarning: 'private-railway-token' });
    if (failure === 'receipt') runJob.mockResolvedValue({ status: 'completed', exitCode: 0, receipt: { success: true }, output: 'private-railway-token' });
    if (failure === 'provider-echo') runJob.mockRejectedValue(new Error('private-registry-token'));
    const error = await executeManagedEnvironmentTask(params).catch((caught: Error) => caught);
    expect(error).toMatchObject({ attempted: true });
    expect(String(error)).not.toContain('private-');
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it('classifies provider-confirmed mutation-free preflight failure as blocked', async () => {
    const { params, runJob } = fixture();
    runJob.mockResolvedValue({ status: 'failed', receipt: { success: false }, mutationAttempted: false });
    await expect(executeManagedEnvironmentTask(params)).rejects.toMatchObject({ attempted: false });
  });

  it('rejects a decoy concurrency string even with a matching accepted content hash', async () => {
    const { params, github, runJob } = fixture();
    const decoy = 'concurrency:\n  group: unrelated\n  cancel-in-progress: false\ndecoy: |\n  group: hypervibe-deploy-staging\nHYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: ' + 'c'.repeat(64) + '\n';
    github.getFileContent.mockResolvedValue(decoy);
    params.bindings.environments.staging.platformBindings.ci.deployBranch['.github/workflows/deploy-staging.yml'].contentHash = workflowFilesContentHash([{ path: '.github/workflows/deploy-staging.yml', content: decoy }]);
    await expect(executeManagedEnvironmentTask(params)).rejects.toMatchObject({ attempted: false });
    expect(runJob).not.toHaveBeenCalled();
  });
});
