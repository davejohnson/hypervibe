import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import * as google from '../../adapters/providers/gcp/gcp-cloud-run.client.js';
import * as github from '../../domain/services/github-ops.service.js';
import * as workflows from '../gcp-promotion-workflow.js';
import * as infrastructure from '../infrastructure-engine.js';
import { createCommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { observeEnginePromotion } from '../engine-promotion.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const repository = 'example/invoicing';
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const url = 'https://web-0001-uc.a.run.app';
const workflowPath = '.github/workflows/hypervibe-release-production.yml';
const content = '# generated promotion fixture';
const policyPath = '.github/workflows/hypervibe-promote-production.yml';
const policySha = 'd'.repeat(40), policyContent = '# reviewed reusable policy';
const image = 'us-central1-docker.pkg.dev/project-123/hypervibe/production-web';
const service = { name: 'web', resource: 'web-001', kind: 'services' as const, uid: 'uid-from-state', sourceService: 'web', image };
const started = '2026-11-12T00:00:00Z', created = '2026-11-12T00:01:00Z', finished = '2026-11-12T00:02:00Z';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'promotion-command-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'project.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture(remoteInProject = true) {
  const ctx = createCommandContext();
  const remote = 'https://github.com/' + repository;
  const project = ctx.repos.projects.create({ name: 'invoicing', ...(remoteInProject && { gitRemoteUrl: remote }) });
  const environment = ctx.repos.environments.create({ name: 'production', projectId: project.id });
  const spec = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: remote, environments: {
    staging: { hosting: { provider: 'railway' }, deploy: { strategy: 'branch' }, services: { web: {} } },
    production: { hosting: { provider: 'cloudrun' }, deploy: { strategy: 'branch', autoDeploy: false, promoteFrom: 'staging' }, services: { web: {} } },
  } }).spec;
  // Other boundary tests render from the real applied IDs. Here both commands must demand those exact bytes.
  vi.spyOn(workflows, 'buildGcpPromotionWorkflow').mockReturnValue({ path: workflowPath, repository, repositoryId: '42', content, sourceEnvironment: 'staging',
    branch: 'main', environment: 'production', gcpProjectId: 'project-123', region: 'us-central1', policyPath, policySha, policyContent,
    provider: 'projects/123456/locations/global/workloadIdentityPools/hypervibe/providers/github', services: [service] } as workflows.GcpPromotionWorkflow);
  const adapter = Object.create(GitHubAdapter.prototype) as GitHubAdapter;
  vi.spyOn(github, 'getGitHubAdapter').mockReturnValue({ adapter });
  vi.spyOn(adapter, 'getRepository').mockResolvedValue({ full_name: repository, id: 42, default_branch: 'main' });
  vi.spyOn(adapter, 'getWorkflow').mockResolvedValue({ id: 222, path: workflowPath, state: 'active' });
  vi.spyOn(adapter, 'getRef').mockResolvedValue({ ref: 'refs/heads/main', object: { sha, type: 'commit' } });
  const file = vi.spyOn(adapter, 'getFileContent').mockImplementation(async (_owner, _repo, file, ref) =>
    file === policyPath && ref === policySha ? policyContent : content);
  const send = vi.spyOn(adapter, 'triggerWorkflow').mockResolvedValue();
  const build = vi.spyOn(infrastructure, 'releaseEngineServices');
  const commands = createCommandRegistry(ctx);
  return { ctx, project, environment, adapter, file, send, build, spec,
    observe: () => observeEnginePromotion(ctx, project, spec, ctx.repos.environments.findById(environment.id)!),
    deploy: () => commands.execute('hv_deploy', { project: project.name, env: 'production', confirm: true }),
    trigger: (options = {}) => commands.execute('hv_ci_trigger', { project: project.name, definition: '222', ...options }) };
}

function observedPromotion(f: ReturnType<typeof fixture>) {
  const identity = { full_name: repository, id: 42 };
  const run = { id: 56, name: 'Promote', path: workflowPath, run_attempt: 2, status: 'completed', conclusion: 'success',
    head_sha: sha, head_branch: 'main', event: 'workflow_dispatch', run_started_at: started, created_at: started, updated_at: finished,
    html_url: 'https://github.com/' + repository + '/actions/runs/56', repository: identity, head_repository: identity };
  vi.spyOn(f.adapter, 'listWorkflowRuns').mockResolvedValue({ total_count: 1, workflow_runs: [run] });
  vi.spyOn(f.adapter, 'getWorkflowRun').mockResolvedValue(run);
  const jobs = vi.spyOn(f.adapter, 'listWorkflowRunAttemptJobs').mockResolvedValue({ total_count: 1, jobs: [{
    id: 67, run_id: 56, run_attempt: 2, head_sha: sha, name: 'promote / release', status: 'completed', conclusion: 'success', started_at: started, completed_at: finished,
  }] });
  vi.spyOn(f.adapter, 'listWorkflowRunArtifacts').mockResolvedValue({ total_count: 1, artifacts: [{ id: 72,
    name: 'hypervibe-gcp-promotion-v1-56-2', expired: false, created_at: created, updated_at: created,
    workflow_run: { id: 56, repository_id: 42, head_repository_id: 42, head_branch: 'main', head_sha: sha },
  }] });
  const receipt = vi.spyOn(f.adapter, 'readJsonArtifact').mockResolvedValue({ version: 1, repository, environment: 'production', workflowSha: sha,
    runId: 56, runAttempt: 2, gcpProjectId: 'project-123', region: 'us-central1',
    source: { environment: 'staging', sha: 'c'.repeat(40), runId: 12, runAttempt: 1, artifactId: 51 },
    services: [{ ...service, image: image + '@' + digest }] });
  vi.spyOn(infrastructure, 'resolveEngineContext').mockResolvedValue({ gcpProjectId: 'project-123', region: 'us-central1',
    adapter: { engineAccessToken: vi.fn().mockResolvedValue('fixture') } } as never);
  const value = { name: 'projects/project-123/locations/us-central1/services/web-001', uid: service.uid, uri: url,
    etag: 'applied', generation: '4', observedGeneration: '4', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: 'web-001-00001', latestCreatedRevision: 'web-001-00001',
    trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100, revision: 'web-001-00001' }],
    template: { containers: [{ image: image + '@' + digest }] } };
  const live = vi.spyOn(google, 'cloudRunGet').mockResolvedValue({ state: 'present', value });
  return { jobs, receipt, live, value };
}

describe('manually promoting the staging release', () => {
  it('uses the applied repository from the spec when the project was registered without a remote', async () => {
    const f = fixture(false);
    expect(await f.deploy()).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(await f.trigger()).toMatchObject({ ok: true, data: { status: 'pending' } });
  });

  it.each(['deploy', 'trigger'] as const)('dispatches the reviewed numeric definition from %s and returns pending', async which => {
    const f = fixture();
    expect(await f[which]()).toMatchObject({ ok: true, data: { status: 'pending', workflow: workflowPath, ref: 'main' } });
    expect(f.file).toHaveBeenCalledWith('example', 'invoicing', workflowPath, sha);
    expect(f.send).toHaveBeenCalledExactlyOnceWith('example', 'invoicing', '222', 'main');
    expect(f.build).not.toHaveBeenCalled();
  });

  it('stops an older installed build workflow, a different ref and caller-supplied image overrides', async () => {
    const f = fixture();
    f.file.mockResolvedValueOnce('# old workflow that builds on every dispatch');
    expect(await f.deploy()).toMatchObject({ ok: false });
    expect(await f.trigger({ ref: 'topic' })).toMatchObject({ ok: false });
    expect(await f.trigger({ inputs: { image: 'latest' } })).toMatchObject({ ok: false });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
  });

  it('rejects drift in the pinned reusable policy even when its caller is current', async () => {
    const f = fixture();
    f.file.mockImplementation(async (_owner, _repo, path) => path === policyPath ? '# different rules' : content);
    expect(await f.deploy()).toMatchObject({ ok: false });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('requires the deployed migration to belong to the latest restored database and staged image', async () => {
    const f = fixture();
    const { receipt } = observedPromotion(f);
    const config = workflows.buildGcpPromotionWorkflow(f.project, f.spec, f.environment) as workflows.GcpPromotionWorkflow;
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const releaseCommand = { service: 'web', job: 'schema', uid: 'job-uid', command: 'npm run migrate', requiresCopy: true as const,
      copyVerificationKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    vi.mocked(workflows.buildGcpPromotionWorkflow).mockReturnValue({ ...config, releaseCommand });
    const base = await receipt('example', 'invoicing', 72, 'promotion.json') as Record<string, unknown>;
    const job = 'projects/project-123/locations/us-central1/jobs/schema';
    const copy = '39c51a32-158b-4e78-a98f-8bfb85115652';
    const migration = { jobUid: releaseCommand.uid, image: image + '@' + digest, execution: job + '/executions/schema-abc', executionUid: 'bcee21b0-1fa7-459d-9ab3-990d04735752', completedAt: created, copyAttemptId: copy,
      key: createHash('sha256').update(JSON.stringify([repository, 'production', job, releaseCommand.uid, releaseCommand.command, image + '@' + digest, copy])).digest('hex') };
    const bind = (time: string, status = 'complete', useValidSignature = true) => {
      const copiedAt = new Date(time).toISOString();
      const data = ['hypervibe-gcp-promotion-copy-v1', repository, 'production', job, copy, copiedAt];
      const signature = sign('RSA-SHA256', Buffer.from(JSON.stringify(data)), keys.privateKey).toString('base64');
      f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { engine: { migration: {
        from: 'railway', copiedAt, database: { match: true }, copyAttempt: { id: copy, status }, promotionCopySignature: useValidSignature ? signature : undefined,
      } } });
    };
    bind(started);
    receipt.mockResolvedValue(base);
    expect(await f.observe()).toHaveProperty('blocked');
    receipt.mockResolvedValue({ ...base, migration });
    expect(await f.observe()).toHaveProperty('results');
    for (const drift of [{ copyAttemptId: 'previous' }, { key: '0'.repeat(64) }, { image: 'other@' + digest }, { jobUid: 'other' },
      { execution: job.replace('project-123', 'foreign') + '/executions/schema-abc' }]) {
      receipt.mockResolvedValueOnce({ ...base, migration: { ...migration, ...drift } });
      expect(await f.observe()).toHaveProperty('blocked');
    }
    bind(finished);
    expect(await f.observe()).toHaveProperty('blocked');
    bind(started, 'incomplete');
    expect(await f.observe()).toHaveProperty('blocked');
    bind(started, 'complete', false);
    expect(await f.observe()).toHaveProperty('blocked');
  });

  it('requires the successful workflow attempt, same applied workload and full live traffic allocation', async () => {
    const f = fixture();
    const { live, value, jobs } = observedPromotion(f);
    expect(await f.observe()).toMatchObject({ results: [{ status: 'released', url, imageUri: image + '@' + digest }] });
    for (const changes of [{ uid: 'replacement' }, { template: { containers: [{ image: 'other@' + digest }] } },
      { latestCreatedRevision: 'newer' }, { trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 50, revision: 'web-001-00001' }] }]) {
      live.mockResolvedValueOnce({ state: 'present', value: { ...value, ...changes } });
      expect(await f.observe()).toHaveProperty('blocked');
    }
    jobs.mockResolvedValueOnce({ total_count: 0, jobs: [] });
    expect(await f.observe()).toHaveProperty('blocked');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('accepts the Google project number for the same applied resource and rejects a foreign project number', async () => {
    const f = fixture();
    const { live, value } = observedPromotion(f);
    live.mockResolvedValueOnce({ state: 'present', value: { ...value, name: value.name.replace('project-123', '123456') } });
    expect(await f.observe()).toHaveProperty('results');
    live.mockResolvedValueOnce({ state: 'present', value: { ...value, name: value.name.replace('project-123', '654321') } });
    expect(await f.observe()).toHaveProperty('blocked');
  });
});
