import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWithWorkspaceDirectories } from '../../../lib/workspace-context.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../application/devops-providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { SpecStore } from '../../spec/spec.store.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../adapter.factory.js';
import { resolveManagedWorkflowContract, workflowFiles } from '../ci-deploy.service.js';
import { releaseEvidenceValidationRuntime } from '../github-ops.service.js';
import { ConvergeExecutor } from '../../plan/converge.executor.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { applyScheduleActivation } from '../schedule-activation.service.js';
import { managedCiReleaseArtifactName, MANAGED_CI_RELEASE_EVIDENCE_FILE } from '../managed-ci-evidence.js';
import type { PlanAction } from '../../plan/plan.types.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { actionRequiresBackupReadiness } from '../../plan/plan-stage.js';

const SHA = 'a'.repeat(40);
const IMAGE = `us-central1-docker.pkg.dev/gcp-test/app/image@sha256:${'b'.repeat(64)}`;
const pending = { version: 1, state: 'pending', jobName: 'cron-staging', jobUid: 'uid-staging', holdingImage: `registry.example/holding@sha256:${'d'.repeat(64)}` };
let directory: string;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected transport outside synthetic fixture'); }));
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-schedule-activation-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const project = new ProjectRepository().create({ name: 'cron-app', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/owner/app' });
  const selected = {
    hosting: { provider: 'cloudrun', region: 'us-central1' },
    services: { cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 * * * *' } },
    deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    email: { enabled: false }, envFile: { mode: 'off' },
  };
  const rawSpec = { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci' }, environments: { staging: selected, production: selected } };
  const { spec } = new SpecStore().replace(project, rawSpec);
  const environments = new EnvironmentRepository();
  const environment = environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'cloudrun', projectId: 'gcp-test', providerScope: { projectId: 'gcp-test', region: 'us-central1' },
    services: { cron: { serviceId: pending.jobName, jobName: pending.jobName, resourceUid: pending.jobUid, workloadKind: 'cron', resourceType: 'scheduledJob', scheduleActivation: pending } },
  } });
  const other = environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'cloudrun', projectId: 'gcp-other', providerScope: { projectId: 'gcp-other', region: 'us-central1' },
    services: { cron: { serviceId: 'cron-production', jobName: 'cron-production', workloadKind: 'cron', resourceType: 'scheduledJob', scheduleActivation: { ...pending, jobName: 'cron-production', jobUid: 'uid-production' } } },
  } });
  new ServiceRepository().create({ projectId: project.id, name: 'cron' });
  const connections = new ConnectionRepository();
  connections.updateStatus(connections.create({ provider: 'github', scope: 'owner/app', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }) }).id, 'verified');
  const contract = resolveManagedWorkflowContract({ project, environmentName: 'staging', environmentSpec: spec.environments.staging, environment });
  if (!contract.ok) throw new Error(contract.error);
  const files = workflowFiles(contract.workflow);
  vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => files.find(entry => entry.path === file)?.content ?? null);
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
  vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({ ref: 'refs/heads/main', object: { sha: SHA } });
  const run = { id: 101, name: 'Deploy staging', created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z', path: contract.workflow.path, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: SHA,
    head_branch: 'main', event: 'workflow_dispatch', html_url: 'https://github.com/owner/app/actions/runs/101', repository: { full_name: 'owner/app' }, head_repository: { full_name: 'owner/app' } };
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({ total_count: 1, workflow_runs: [run] });
  vi.spyOn(GitHubAdapter.prototype, 'getWorkflowRun').mockImplementation(async () => run);
  const artifact = { id: 201, name: managedCiReleaseArtifactName('staging', SHA), expired: false, created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
    workflow_run: { id: run.id, head_sha: SHA, head_branch: 'main', repository_id: 123, head_repository_id: 123 } };
  vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockImplementation(async () => ({ total_count: 1, artifacts: [artifact] }));
  // Actual generated v4 producer + actual trusted consumer. Provider HTTP/run
  // provenance is synthetic at GitHub's adapter port; no live cloud claim.
  const producer = parse(contract.workflow.content).jobs.deploy.steps.find((step: any) => step.name === 'Write server release evidence');
  let evidenceText = '';
  const realRequire = createRequire(import.meta.url);
  const requireFixture = (name: string) => name === 'fs' ? {
    readFileSync: () => `${releaseEvidenceValidationRuntime().trim()}\n`,
    writeFileSync: (_file: string, text: string) => { evidenceText = text; },
  } : realRequire(name);
  function emitEvidence(fingerprint = contract.ok ? contract.target.deploymentContractFingerprint : '') {
    new Function('require', 'process', producer.with.script)(requireFixture, { env: {
    ...producer.env, GITHUB_REPOSITORY: 'owner/app', HYPERVIBE_RELEASE_SHA: SHA,
    HYPERVIBE_RELEASE_IMAGE_URI: IMAGE,
    HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: fingerprint,
    } });
    return JSON.parse(evidenceText);
  }
  const evidence = emitEvidence();
  vi.spyOn(GitHubAdapter.prototype, 'readArtifactFiles').mockImplementation(async () => ({ [MANAGED_CI_RELEASE_EVIDENCE_FILE]: JSON.stringify(evidence) }));
  const activateSchedule = vi.fn(async () => ({ serviceId: 'fixture', externalId: pending.jobName, status: 'configured' as const,
    receipt: { success: true, message: 'verified trigger', data: { invokerPermissionVerified: true, invokerGrantApplied: false, createdScheduler: true, scheduleActivated: true, jobName: pending.jobName, schedulerJobName: 'cron-staging-trigger' } } }));
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
    capabilities: { supportsDeferredCronActivation: true }, activateSchedule,
  } as any });
  const action: PlanAction = { id: 'service:cron:activate-schedule', type: 'update', verified: true, billable: true, requiresConfirm: true,
    resource: { kind: 'service', name: 'cron', provider: 'cloudrun' }, reason: 'Activate verified release',
    metadata: { operation: 'hostingScheduleActivate', environmentName: 'staging', pending, grantJobInvoker: true, release: {
      repository: 'owner/app', workflow: contract.workflow.path, ref: contract.workflow.branch, targetSha: SHA,
      workflowInputHash: contract.inputHash, workflowContentHash: contract.renderedContentHash,
    } },
  };
  return { project, spec, environment, other, action, evidence, run, artifact, activateSchedule, contract, rawSpec, emitEvidence,
    apply: () => applyScheduleActivation({ project, spec, environmentName: 'staging', action }) };
}

describe('post-release schedule activation contract', () => {
  it('admits actual emitted release evidence, calls the narrow capability, and preserves the other environment', async () => {
    const state = setup();
    expect(resolvePlanActionAuthority(state.action)?.capability).toBe('hosting.schedule.activate');
    expect(actionRequiresBackupReadiness(state.action)).toBe(true);
    const result = await state.apply(); expect(result).toMatchObject({ success: true, data: { applied: 1, skipped: 0, sourceWorkflowRunId: 101 } });
    expect(state.activateSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: 'cron', buildConfig: expect.objectContaining({ cronSchedule: '0 * * * *', startCommand: 'npm run cron' }) }),
      expect.objectContaining({ id: state.environment.id }), { expectedImage: IMAGE, expectedJobUid: pending.jobUid, sourceCommitSha: SHA });
    const environments = new EnvironmentRepository();
    expect((environments.findById(state.environment.id)!.platformBindings.services as any).cron).not.toHaveProperty('scheduleActivation');
    expect(environments.findById(state.other.id)!.platformBindings).toEqual(state.other.platformBindings);
    expect((environments.findById(state.environment.id)!.platformBindings.services as any).cron.resourceUid).toBe(pending.jobUid);
    const after = resolveManagedWorkflowContract({ project: state.project, environmentName: 'staging', environmentSpec: state.spec.environments.staging });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error);
    expect(after.inputHash).toBe(state.contract.inputHash);
    expect(after.target.runtimeResources).toEqual(state.contract.target.runtimeResources);
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.activateSchedule).toHaveBeenCalledOnce();
  });

  it('accepts the committed raw-document fingerprint when parsing adds schema defaults', async () => {
    const state = setup();
    const rawHash = environmentDeploymentContractHash(state.rawSpec, 'staging');
    expect(rawHash).not.toBe(environmentDeploymentContractHash(state.spec, 'staging'));
    const root = path.join(directory, 'repository');
    mkdirSync(path.join(root, '.hypervibe'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', state.project.gitRemoteUrl!], { cwd: root });
    writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(state.rawSpec));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'false');
    Object.assign(state.evidence, state.emitEvidence(rawHash));
    const result = await runWithWorkspaceDirectories([root], state.apply);
    expect(result).toMatchObject({ success: true, data: { applied: 1 } });
  });

  it.each([
    ['wrong environment', (s: ReturnType<typeof setup>) => { s.evidence.environment = 'production'; }],
    ['wrong source', s => { s.evidence.source.sha = 'c'.repeat(40); }],
    ['wrong project', s => { s.evidence.target.scope.providerProjectId = 'another-project'; }],
    ['wrong resource', s => { s.evidence.target.resources[0].providerResourceId = 'cron-production'; }],
    ['old program', s => { s.evidence.programFingerprint = 'c'.repeat(64); }],
    ['old spec', s => { s.evidence.deploymentContractFingerprint = 'c'.repeat(64); }],
    ['mutable image', s => { s.evidence.target.resources[0].imageUri = 'example/app:latest'; }],
    ['holding image', s => { s.evidence.target.resources[0].imageUri = pending.holdingImage; }],
    ['legacy receipt', s => { s.evidence.version = 2; }],
    ['failed release', s => { s.run.conclusion = 'failure'; }],
    ['running release', s => { s.run.status = 'in_progress'; }],
    ['retried release', s => { s.run.run_attempt = 2; }],
    ['wrong producer', s => { s.run.path = '.github/workflows/other.yml'; }],
    ['fork source', s => { s.run.head_repository.full_name = 'fork/app'; }],
    ['expired archive', s => { s.artifact.expired = true; }],
    ['wrong archive run', s => { s.artifact.workflow_run.id = 999; }],
  ] as Array<[string, (state: ReturnType<typeof setup>) => void]>)('blocks %s before provider access', async (_name, mutate) => {
    const state = setup(); mutate(state);
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 0, providerMutations: 0 } });
    expect(state.activateSchedule).not.toHaveBeenCalled();
    expect(adapterFactory.getProviderAdapter).not.toHaveBeenCalled();
    expect((new EnvironmentRepository().findById(state.environment.id)!.platformBindings.services as any).cron.scheduleActivation).toEqual(pending);
  });

  it('blocks an unknown read and a moved branch without trying an older successful run', async () => {
    const state = setup();
    vi.mocked(GitHubAdapter.prototype.readArtifactFiles).mockRejectedValueOnce(new Error('synthetic read failure'));
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    vi.mocked(GitHubAdapter.prototype.getRef).mockResolvedValueOnce({ ref: 'refs/heads/main', object: { sha: 'c'.repeat(40) } });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.activateSchedule).not.toHaveBeenCalled();
  });

  it('rejects a newer deployment that starts while the release artifact is being read', async () => {
    const state = setup();
    vi.mocked(GitHubAdapter.prototype.listWorkflowRuns)
      .mockResolvedValueOnce({ total_count: 1, workflow_runs: [state.run] })
      .mockResolvedValue({ total_count: 2, workflow_runs: [{ ...state.run, id: 102, status: 'in_progress' }] });
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.activateSchedule).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before the executor reaches the activation handler', async () => {
    const state = setup();
    const plan = new RunRepository().create({ projectId: state.project.id, environmentId: state.environment.id, type: 'plan', plan: {
      kind: 'hv_plan', environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions: [state.action],
    } });
    const handler = vi.fn(state.apply);
    const result = await new ConvergeExecutor().execute({ planRunId: plan.id, currentSpecRevision: 1, handler });
    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(state.activateSchedule).not.toHaveBeenCalled();
    expect(GitHubAdapter.prototype.readArtifactFiles).not.toHaveBeenCalled();
  });

  it('counts a matching existing trigger as zero provider writes while completing its local binding', async () => {
    const state = setup();
    state.activateSchedule.mockResolvedValueOnce({ serviceId: 'fixture', externalId: pending.jobName, status: 'configured',
      receipt: { success: true, message: 'already matches', data: { invokerPermissionVerified: true, invokerGrantApplied: false, createdScheduler: false, scheduleActivated: true,
        jobName: pending.jobName, schedulerJobName: 'cron-staging-trigger' } } });
    expect(await state.apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1, providerMutations: 0, bindingsApplied: 1 } });
  });

  it('reports both related provider writes when activation grants invocation and creates the trigger', async () => {
    const state = setup();
    state.activateSchedule.mockResolvedValueOnce({ serviceId: 'fixture', externalId: pending.jobName, status: 'configured',
      receipt: { success: true, message: 'verified invocation and trigger', data: { invokerPermissionVerified: true, createdScheduler: true, invokerGrantApplied: true,
        scheduleActivated: true, jobName: pending.jobName, schedulerJobName: 'cron-staging-trigger' } } });
    expect(await state.apply()).toMatchObject({ success: true, data: { applied: 2, skipped: 0, providerMutations: 2, bindingsApplied: 1 } });
  });

  it('rejects forged authority and unsupported CI without reading or changing a provider', async () => {
    const state = setup();
    state.action.resource.provider = 'railway';
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    state.action.resource.provider = 'cloudrun';
    state.action.metadata = { ...state.action.metadata, extraAuthority: 'unreviewed' };
    expect(resolvePlanActionAuthority(state.action)).toBeNull();
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    delete state.action.metadata.extraAuthority;
    state.spec.devops = { code: { provider: 'gitlab', scope: 'owner/app' }, ci: { provider: 'gitlab-ci' } } as any;
    expect(await state.apply()).toMatchObject({ success: false, status: 'blocked' });
    expect(state.activateSchedule).not.toHaveBeenCalled();
    expect(GitHubAdapter.prototype.readArtifactFiles).not.toHaveBeenCalled();
  });

  it('retains the exact pending binding after an uncertain provider response and reconciles on retry', async () => {
    const state = setup();
    state.activateSchedule.mockResolvedValueOnce({ serviceId: 'fixture', status: 'failed', receipt: { success: false, message: 'uncertain response' } } as any);
    expect(await state.apply()).toMatchObject({ success: false, data: { applied: null } });
    expect((new EnvironmentRepository().findById(state.environment.id)!.platformBindings.services as any).cron.scheduleActivation).toEqual(pending);
    expect(await state.apply()).toMatchObject({ success: true, data: { applied: 1 } });
    expect(state.activateSchedule).toHaveBeenCalledTimes(2);
  });
});
