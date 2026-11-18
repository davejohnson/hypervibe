import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { buildIosReleaseWorkflow } from '../ios-release-workflow.service.js';
import { assertSameReleaseAttempt } from '../ios-release-attempt.js';

// Reconstructed GitHub API evidence, not live scheduler/approval validation.
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run
// https://docs.github.com/en/rest/commits/commits#compare-two-commits
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DISPATCH_REF_SHA = 'c'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: any[]) => Promise<unknown>;
function generated(environmentName = 'staging', workingDirectory = '.', inputs: string[] | null = ['mobile', 'packages/shared'], expectedInfoPlist?: Record<string, string>, branch = 'main') {
  return parse(buildIosReleaseWorkflow({
    provider: 'railway', providerName: 'Railway', serverWorkflowPath: `.github/workflows/deploy-railway-${environmentName}.yml`,
    target: { environmentName, kind: environmentName === 'production' ? 'production' : 'staging', branch,
      autoDeployOnPush: environmentName !== 'production', serviceNames: ['web'], providerServiceIds: ['web-id'],
      programFingerprint: 'd'.repeat(64), releaseTarget: {scope: {providerProjectId: 'project-id', providerEnvironmentId: environmentName},
        bindingsFingerprint: 'e'.repeat(64), resources: [{logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-id'}]} },
    ios: {bundleId: 'com.example.app', platform: 'IOS', capabilities: [], release: {services: ['web'], trigger: 'after-server-deploy',
      build: {workingDirectory, ...(inputs ? {inputs} : {}), command: 'make ios', ipaPath: 'build/app.ipa', requiredSecrets: [], ...(expectedInfoPlist ? {expectedInfoPlist} : {})},
      signing: {provider: 'project'}, testflight: {groups: ['Internal'], usesNonExemptEncryption: false, submitForBetaReview: false}}} as never,
  })!.files[0].content);
}
function step(workflow: any, name: string) {
  const result = workflow.jobs.eligibility?.steps.find((item: any) => item.name === name);
  expect(result, `missing emitted ${name} step`).toBeDefined();
  return result;
}
function runScript(script: string, github: unknown, context: unknown, env: Record<string, string>, readFileSync = vi.fn()) {
  const outputs: Record<string, string> = {};
  const core = {setOutput: (key: string, value: unknown) => {outputs[key] = String(value);}, info: vi.fn(), warning: vi.fn()};
  const result = new AsyncFunction('github', 'context', 'process', 'core', 'require', script)(github, context, {env}, core, (name: string) => name === 'fs' ? {readFileSync} : localRequire(name));
  return {result, outputs, core};
}

// Reconstructed from GitHub's workflow-run, job and artifact REST contracts.
// A rerun retains its run id; artifact metadata has no attempt identifier.
// https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
// https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts
function releaseAttemptFixture(environmentName = 'staging', branch = 'main') {
  const workflow = generated(environmentName, '.', ['mobile', 'packages/shared'], undefined, branch);
  const expected = JSON.parse(workflow.jobs.eligibility.env.HYPERVIBE_EXPECTED_SERVER_RELEASE);
  const run = {id: 55, status: 'completed', conclusion: 'success', path: expected.workflowPath,
    head_sha: DISPATCH_REF_SHA, run_attempt: 2, run_started_at: '2026-10-22T11:00:00Z',
    repository: {full_name: 'owner/app'}, head_repository: {full_name: 'owner/app'}};
  const artifact = {id: 90, expired: false, name: expected.artifactPrefix + SHA,
    created_at: '2026-10-22T11:02:00Z', updated_at: '2026-10-22T11:02:00Z',
    workflow_run: {id: 55, head_sha: DISPATCH_REF_SHA}};
  const job = {id: 70, run_id: 55, run_attempt: 2, head_sha: DISPATCH_REF_SHA, name: 'deploy', status: 'completed', conclusion: 'success',
    started_at: '2026-10-22T11:01:00Z', completed_at: '2026-10-22T11:03:00Z'};
  const jobs = {total_count: 1, jobs: [job]};
  const github = {rest: {actions: {
    getWorkflowRun: vi.fn(async () => ({data: run})),
    listWorkflowRunArtifacts: vi.fn(async () => ({data: {total_count: 1, artifacts: [artifact]}})),
    listJobsForWorkflowRunAttempt: vi.fn(async () => ({data: jobs})),
  }}};
  const execute = (eventName: string, force = false) => runScript(step(workflow, 'Resolve release provenance').with.script, github,
    {eventName, repo: {owner: 'owner', repo: 'app'}, payload: {workflow_run: run, inputs: {commit_sha: SHA, server_run_id: '55', force: String(force)}}},
    workflow.jobs.eligibility.env);
  return {workflow, run, artifact, job, jobs, github, execute};
}

function recheck(f: ReturnType<typeof releaseAttemptFixture>) {
  const steps = f.workflow.jobs.release.steps;
  const check = steps.find((entry: any) => entry.name === 'Recheck server release attempt');
  expect(steps.indexOf(check)).toBe(steps.findIndex((entry: any) => entry.name === 'Run Hypervibe-managed TestFlight release') - 1);
  return runScript(check.with.script, f.github, {repo: {owner: 'owner', repo: 'app'}}, {
    ...f.workflow.jobs.release.env, HYPERVIBE_SERVER_RUN_ID: '55', HYPERVIBE_SERVER_RUN_ATTEMPT: '2',
    HYPERVIBE_SERVER_ARTIFACT_ID: '90', HYPERVIBE_RELEASE_SHA: SHA,
  });
}

// Regression reported in invoice-express#231: run.path may carry @refs/heads/main.
// GitHub separately defines the workflow ref and workflow SHA:
// https://docs.github.com/en/actions/reference/workflows-and-actions/variables
// These execute generated consumers with synthetic metadata, not a live release.
describe.each(['staging', 'production'])('workflow metadata identity (%s)', environmentName => {
  it('uses the configured producer branch rather than assuming main', async () => {
    const f = releaseAttemptFixture(environmentName, 'release/staging');
    f.run.path += '@refs/heads/release/staging';
    await f.execute('workflow_run').result;
    await recheck(f).result;
  });
  it.each(['', '@refs/heads/main'])('accepts server provenance with suffix %j', async suffix => {
    const f = releaseAttemptFixture(environmentName);
    f.run.path += suffix;
    for (const event of ['workflow_dispatch', 'workflow_run']) {
      const execution = f.execute(event);
      await execution.result;
      expect(execution.outputs).toMatchObject({sha: SHA, artifact_id: '90', server_run_attempt: '2'});
    }
  });
  it.each(['', '@refs/heads/main'])('accepts upload revalidation with suffix %j', async suffix => {
    const f = releaseAttemptFixture(environmentName);
    f.run.path += suffix;
    await recheck(f).result;
  });
  it('accepts equivalent metadata spelling on a second read without changing attempt identity', async () => {
    const f = releaseAttemptFixture(environmentName);
    f.github.rest.actions.getWorkflowRun.mockResolvedValueOnce({data: f.run})
      .mockResolvedValue({data: {...f.run, path: f.run.path + '@refs/heads/main'}});
    await f.execute('workflow_run').result;
    await recheck(f).result;
  });
  it('rejects an unexpected ref on a second read', async () => {
    const f = releaseAttemptFixture(environmentName);
    f.github.rest.actions.getWorkflowRun.mockResolvedValueOnce({data: f.run})
      .mockResolvedValue({data: {...f.run, path: f.run.path + '@refs/tags/main'}});
    await expect(f.execute('workflow_run').result).rejects.toThrow();
    await expect(recheck(f).result).rejects.toThrow();
  });
  it.each(['@refs/tags/main', '@refs/heads/untrusted', '@', '@@refs/heads/main', '@refs/heads/main\n', '/other.yml', '.bak'])
    ('rejects untrusted or malformed server metadata %j at both boundaries', async suffix => {
      const f = releaseAttemptFixture(environmentName);
      f.run.path += suffix;
      const initial = f.execute('workflow_run');
      await expect(initial.result).rejects.toThrow();
      expect(initial.outputs).toEqual({});
      await expect(recheck(f).result).rejects.toThrow();
    });
  it('does not let an allowed suffix hide changed workflow source evidence', async () => {
    const f = releaseAttemptFixture(environmentName);
    f.run.path += '@refs/heads/main';
    f.run.head_sha = 'f'.repeat(40);
    await expect(f.execute('workflow_run').result).rejects.toThrow();
    await expect(recheck(f).result).rejects.toThrow();
  });
});

it('preserves exact metadata comparison for existing callers without a normalization ref', () => {
  const f = releaseAttemptFixture();
  f.run.path += '@refs/heads/main';
  expect(() => assertSameReleaseAttempt(f.run, {...f.run})).not.toThrow();
  expect(() => assertSameReleaseAttempt(f.run, {...f.run, path: f.run.path + '-other'})).toThrow();
});

describe.each(['workflow_dispatch', 'workflow_run'])('current server attempt (%s)', eventName => {
  it.each(['skipped deploy with retained artifact', 'successful deploy with retained artifact'])('rejects %s', async kind => {
    const f = releaseAttemptFixture();
    f.artifact.created_at = '2026-10-21T11:02:00Z';
    if (kind.startsWith('skipped')) f.job.conclusion = 'skipped';
    const execution = f.execute(eventName);
    await expect(execution.result).rejects.toThrow();
    expect(execution.outputs).toEqual({});
  });
  it('accepts a fresh completed deployment of source A by workflow B', async () => {
    const f = releaseAttemptFixture();
    const execution = f.execute(eventName);
    await execution.result;
    expect(execution.outputs.sha).toBe(SHA);
    expect(execution.outputs.artifact_id).toBe('90');
    expect(execution.outputs.server_run_attempt).toBe('2');
    expect(f.github.rest.actions.listJobsForWorkflowRunAttempt).toHaveBeenCalledWith({
      owner: 'owner', repo: 'app', run_id: 55, attempt_number: 2, per_page: 100,
    });
  });
  it('accepts an omitted optional job attempt within the exact attempt endpoint', async () => {
    const f = releaseAttemptFixture();
    delete (f.job as Partial<typeof f.job>).run_attempt;
    await f.execute(eventName).result;
  });
  it('rejects a rerun started between provenance reads', async () => {
    const f = releaseAttemptFixture();
    f.github.rest.actions.getWorkflowRun.mockResolvedValueOnce({data: f.run})
      .mockResolvedValue({data: {...f.run, run_attempt: 3}});
    const execution = f.execute(eventName);
    await expect(execution.result).rejects.toThrow(/attempt changed/);
    expect(execution.outputs).toEqual({});
  });
  it('keeps an unknown job observation from authorizing release', async () => {
    const f = releaseAttemptFixture();
    f.github.rest.actions.listJobsForWorkflowRunAttempt.mockRejectedValue(new Error('Unavailable'));
    const execution = f.execute(eventName);
    await expect(execution.result).rejects.toThrow();
    expect(execution.outputs).toEqual({});
  });
  it.each([
    ['skipped current deploy', (f: ReturnType<typeof releaseAttemptFixture>) => { f.job.conclusion = 'skipped'; }],
    ['missing deploy', f => { f.jobs.jobs = []; f.jobs.total_count = 0; }],
    ['duplicate deploy', f => { f.jobs.jobs.push({...f.job, id: 71}); f.jobs.total_count = 2; }],
    ['incomplete jobs', f => { f.jobs.total_count = 101; }],
    ['old job attempt', f => { f.job.run_attempt = 1; }],
    ['wrong job run', f => { f.job.run_id = 56; }],
    ['omitted job source', f => { delete (f.job as Partial<typeof f.job>).head_sha; }],
    ['missing latest start', f => { delete (f.run as Partial<typeof f.run>).run_started_at; }],
    ['null artifact creation time', f => { f.artifact.created_at = null as never; }],
    ['artifact from before deploy job', f => { f.artifact.created_at = '2026-10-22T11:00:30Z'; }],
    ['artifact from after deploy job', f => { f.artifact.created_at = '2026-10-22T11:04:00Z'; }],
  ] satisfies Array<[string, (f: ReturnType<typeof releaseAttemptFixture>) => void]>)('rejects %s without release outputs', async (_name, corrupt) => {
    const f = releaseAttemptFixture(); corrupt(f);
    const execution = f.execute(eventName);
    await expect(execution.result).rejects.toThrow();
    expect(execution.outputs).toEqual({});
  });
});

describe('emitted recheck immediately before TestFlight release', () => {
  it('accepts the same current run and artifact identity', async () => {
    const f = releaseAttemptFixture(); await f.execute('workflow_run').result;
    await recheck(f).result;
  });
  it.each(['rerun', 'replacement', 'skipped', 'stale artifact', 'expired'])('blocks %s after eligibility', async kind => {
    const f = releaseAttemptFixture(); await f.execute('workflow_run').result;
    if (kind === 'rerun') f.run.run_attempt = 3;
    if (kind === 'replacement') f.artifact.id = 91;
    if (kind === 'skipped') f.job.conclusion = 'skipped';
    if (kind === 'stale artifact') f.artifact.created_at = '2026-10-21T11:02:00Z';
    if (kind === 'expired') f.artifact.expired = true;
    await expect(recheck(f).result).rejects.toThrow();
  });
});

describe('executed iOS change gate before protected jobs', () => {
  it('has an environment-free gate and excludes skipped iOS jobs from environment approvals', () => {
    const workflow = generated();
    expect(workflow.jobs.eligibility).toBeDefined();
    expect(workflow.jobs.eligibility.environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.eligibility)).not.toContain('secrets.');
    expect(workflow.jobs.prepare.needs).toContain('eligibility');
    expect(workflow.jobs.prepare.if).toContain("needs.eligibility.outputs.should_release == 'true'");
    expect(workflow.jobs.build.needs).toContain('prepare');
    expect(workflow.jobs.release.needs).toContain('build');
  });
  it('serializes one app across environments without holding the server deploy lock', () => {
    const staging = generated('staging'); const production = generated('production');
    expect(staging.concurrency.group).not.toBe('hypervibe-deploy-staging');
    expect(staging.concurrency.group).toBe(production.concurrency.group);
    expect(staging.concurrency['cancel-in-progress']).toBe(false);
  });
});

function manifest(workflow: any, environment: string) {
  return {version: 2, environment, mobile: {repository: 'owner/app', sha: BASE,
    buildContractFingerprint: workflow.jobs.eligibility.env.HYPERVIBE_IOS_BUILD_CONTRACT_FINGERPRINT},
  server: {repository: 'owner/app', sha: BASE},
  app: {bundleId: 'com.example.app', appId: 'app-id', buildId: 'build-id', ipaSha256: 'f'.repeat(64)}};
}
function relevance(environmentName: string, options: {files?: unknown; status?: string; mergeBase?: string; evidence?: unknown; force?: boolean; error?: boolean; baseline?: string; candidate?: string; workingDirectory?: string; expectedInfoPlist?: Record<string, string>} = {}) {
  const workflow = generated(environmentName, options.workingDirectory ?? '.', options.workingDirectory ? null : ['mobile', 'packages/shared'], options.expectedInfoPlist);
  const emitted = step(workflow, 'Determine iOS change relevance');
  const compare = vi.fn(async () => {
    if (options.error) throw new Error('API unavailable');
    return {data: {status: options.status ?? 'ahead', merge_base_commit: {sha: options.mergeBase ?? BASE},
      files: options.files === undefined ? [{filename: 'web/page.tsx', status: 'modified'}, {filename: 'infra/main.tf', status: 'added'}] : options.files}};
  });
  const read = vi.fn(() => JSON.stringify(options.evidence === undefined ? manifest(workflow, environmentName) : options.evidence));
  const execution = runScript(emitted.with.script, {rest: {repos: {compareCommitsWithBasehead: compare}}},
    {eventName: options.force === undefined ? 'workflow_run' : 'workflow_dispatch', repo: {owner: 'owner', repo: 'app'},
      payload: options.force === undefined ? {} : {inputs: {force: String(options.force)}}},
    {...workflow.jobs.eligibility.env, HYPERVIBE_CANDIDATE_SHA: options.candidate ?? SHA, HYPERVIBE_BASELINE_SHA: options.baseline ?? BASE, HYPERVIBE_BASELINE_PATH: '/beta.json'}, read);
  return {...execution, compare, read};
}

describe.each(['staging', 'production'])('generated iOS release decision (%s)', environmentName => {
  it('skips web and infrastructure changes while comparing the entire unbuilt range', async () => {
    const result = relevance(environmentName); await result.result;
    expect(result.outputs.should_release).toBe('false');
    expect(result.compare).toHaveBeenCalledWith({owner: 'owner', repo: 'app', basehead: BASE + '...' + SHA, per_page: 1, page: 1});
  });
  it('skips an unforced dispatch at the same validated beta commit without comparing files', async () => {
    const result = relevance(environmentName, {candidate: BASE, force: false}); await result.result;
    expect(result.outputs.should_release).toBe('false');
    expect(result.compare).not.toHaveBeenCalled();
  });
  it.each([
    {status: 'added', filename: 'mobile/View.swift'},
    {status: 'removed', filename: 'packages/shared/api.ts'},
    {status: 'modified', filename: 'package-lock.json'},
    {status: 'modified', filename: `.github/workflows/hypervibe-ios-release-${environmentName}.yml`},
    {status: 'renamed', filename: 'mobile/View.swift', previous_filename: 'archive/View.swift'},
    {status: 'renamed', filename: 'archive/View.swift', previous_filename: 'mobile/View.swift'},
  ])('builds for a $status input at $filename', async file => {
    const result = relevance(environmentName, {files: [file, {filename: 'web/page.tsx', status: 'modified'}]});
    await result.result; expect(result.outputs.should_release).toBe('true');
  });
  it('treats a path prefix without a directory boundary as irrelevant', async () => {
    const result = relevance(environmentName, {files: [{filename: 'mobile-web/home.tsx', status: 'modified'}]});
    await result.result; expect(result.outputs.should_release).toBe('false');
  });
  it.each([
    ['previously unchecked metadata', undefined],
    ['different embedded backend', {AppEnvironment: 'staging', APIBaseURL: 'https://invoiceperfect.com'}],
  ] as const)('builds for a changed metadata contract despite web-only changes: %s', async (_label, previous) => {
    const evidence = manifest(generated(environmentName, '.', ['mobile', 'packages/shared'], previous), environmentName);
    const result = relevance(environmentName, {evidence, expectedInfoPlist: {AppEnvironment: 'staging', APIBaseURL: 'https://staging.invoiceperfect.com'}});
    await result.result;
    expect(result.outputs.should_release).toBe('true');
    expect(result.compare).not.toHaveBeenCalled();
  });
  it('requires a build when a rename has an empty previous filename', async () => {
    const result = relevance(environmentName, {files: [{filename: 'archive/View.swift', status: 'renamed', previous_filename: ''}]});
    await result.result;
    expect(result.outputs.should_release).toBe('true');
  });
  it.each([
    {evidence: null}, {evidence: {}}, {baseline: ''}, {status: 'diverged'}, {mergeBase: DISPATCH_REF_SHA},
    {files: null}, {files: [{filename: 'web/a.ts', status: 'renamed'}]}, {error: true},
    {files: Array.from({length: 300}, (_, index) => ({filename: `web/${index}.tsx`, status: 'modified'}))},
  ])('requires a build when baseline/comparison evidence is absent, unknown, or truncated (%j)', async options => {
    const result = relevance(environmentName, options); await result.result; expect(result.outputs.should_release).toBe('true');
  });
  it.each(['environment', 'fingerprint', 'repository', 'sha', 'bundle', 'version', 'ipa'])('does not skip using stale or differently scoped %s evidence', async field => {
    const evidence = manifest(generated(environmentName), environmentName);
    if (field === 'environment') evidence.environment = environmentName === 'production' ? 'staging' : 'production';
    if (field === 'fingerprint') evidence.mobile.buildContractFingerprint = '0'.repeat(64);
    if (field === 'repository') evidence.mobile.repository = 'another/repo';
    if (field === 'sha') evidence.mobile.sha = SHA;
    if (field === 'bundle') evidence.app.bundleId = 'another.bundle';
    if (field === 'version') evidence.version = 1;
    if (field === 'ipa') evidence.app.ipaSha256 = '';
    const result = relevance(environmentName, {evidence}); await result.result;
    expect(result.outputs.should_release).toBe('true'); expect(result.compare).not.toHaveBeenCalled();
  });
  it('manual force bypasses only relevance and leaves the earlier provenance steps mandatory', async () => {
    const result = relevance(environmentName, {force: true}); await result.result;
    expect(result.outputs.should_release).toBe('true'); expect(result.compare).not.toHaveBeenCalled();
    const workflow = generated(environmentName);
    const eligibility = workflow.jobs.eligibility;
    const decision = step(workflow, 'Determine iOS change relevance');
    expect(eligibility.outputs.should_release).toBe('${{ steps.' + decision.id + '.outputs.should_release }}');
    expect(workflow.jobs.prepare.needs).toBe('eligibility');
    expect(workflow.jobs.prepare.if).toBe("${{ needs.eligibility.outputs.should_release == 'true' }}");
    for (const name of ['Resolve release provenance', 'Download verified server release evidence', 'Verify server release gate', 'Verify mobile source contract']) {
      const required = step(workflow, name);
      expect(eligibility.steps.indexOf(required)).toBeLessThan(eligibility.steps.indexOf(decision));
      expect(required.if).toBeUndefined();
      expect(required['continue-on-error']).toBeUndefined();
    }
  });
  it.each([
    ['untrusted workflow ref', /outside the configured branch/],
    ['expired server artifact', /unexpired server release artifact/],
  ] as const)('rejects a forced release with %s', async (invalid, expectedError) => {
    const f = releaseAttemptFixture(environmentName);
    if (invalid === 'untrusted workflow ref') f.run.path += '@refs/heads/unreviewed';
    else f.artifact.expired = true;
    const execution = f.execute('workflow_dispatch', true);
    await expect(execution.result).rejects.toThrow(expectedError);
    expect(execution.outputs).toEqual({});
  });
});

function baseline(options: {changedWorkflow?: boolean; expired?: boolean; incomplete?: boolean; error?: boolean; retry?: boolean; missingCompletedArtifact?: boolean;
  staleArtifact?: boolean; skippedRelease?: boolean; attemptChanged?: boolean; wrongSkippedAttempt?: boolean; omittedJobAttempt?: boolean; omittedSkippedJobSha?: boolean;
  environmentName?: string; pathSuffix?: string; currentWorkflowRef?: string; finalPathSuffix?: string; serverBranch?: string} = {}) {
  const environmentName = options.environmentName ?? 'staging';
  const workflow = generated(environmentName, '.', ['mobile', 'packages/shared'], undefined, options.serverBranch);
  const env = {...workflow.jobs.eligibility.env, GITHUB_RUN_ID: '99', GITHUB_WORKFLOW_SHA: DISPATCH_REF_SHA,
    GITHUB_WORKFLOW_REF: options.currentWorkflowRef ?? `owner/app/.github/workflows/hypervibe-ios-release-${environmentName}.yml@refs/heads/main`};
  // GitHub workflow-run/job/artifact shapes reconstructed from the official REST
  // contract: attempt-scoped jobs may omit run_attempt, artifacts have no attempt.
  // https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
  const runs = [{id: 12, status: 'completed', run_attempt: 1, run_started_at: '2026-09-26T02:00:00Z', created_at: '2026-09-26T02:00:00Z', updated_at: '2026-09-26T02:10:00Z', head_sha: DISPATCH_REF_SHA, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH},
    {id: 11, status: 'completed', run_attempt: 1, run_started_at: '2026-09-26T01:00:00Z', created_at: '2026-09-26T01:00:00Z', updated_at: '2026-09-26T01:10:00Z', head_sha: BASE, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH}];
  for (const run of runs) run.path += options.pathSuffix ?? '';
  if (options.retry || options.staleArtifact) Object.assign(runs[1], {run_attempt: 2, run_started_at: '2026-09-26T03:00:00Z', updated_at: '2026-09-26T03:10:00Z'});
  const releaseHour = options.retry || options.staleArtifact ? '03' : '01';
  const artifact = {id: 80, name: `hypervibe-ios-release-${environmentName}-` + BASE, expired: options.expired ?? false,
    created_at: `2026-09-26T${options.staleArtifact ? '01' : releaseHour}:05:00Z`, updated_at: `2026-09-26T${releaseHour}:05:00Z`, workflow_run: {id: 11, head_sha: BASE}};
  const listArtifacts = vi.fn(async ({run_id}: {run_id: number}) => ({data: {total_count: run_id === 12 ? 0 : 1, artifacts: run_id === 12 ? [] : [
    artifact,
  ]}}));
  const getContent = vi.fn(async ({ref}: {ref: string}) => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(options.changedWorkflow && ref === BASE ? 'old managed workflow' : 'same managed workflow').toString('base64')}}));
  const listRuns = vi.fn(async () => {
    if (options.error) throw new Error('Forbidden');
    return {data: {total_count: options.incomplete ? 1000 : 2, workflow_runs: runs}};
  });
  const listJobs = vi.fn(async ({run_id}: {run_id: number; attempt_number?: number}) => {
    const run = runs.find(item => item.id === run_id)!;
    const hour = run_id === 12 ? '02' : releaseHour;
    return {data: {total_count: 4, jobs: ['eligibility', 'prepare', 'build', 'release'].map((name, index) => ({
      id: run_id * 10 + index, run_id, ...(options.omittedSkippedJobSha && run_id === 12 ? {} : {head_sha: run.head_sha}),
      ...(options.omittedJobAttempt ? {} : {run_attempt: options.wrongSkippedAttempt && run_id === 12 ? 2 : run.run_attempt}),
      name, status: 'completed', conclusion: (run_id === 12 && name !== 'eligibility' && !options.missingCompletedArtifact)
        || (run_id === 11 && name === 'release' && options.skippedRelease) ? 'skipped' : 'success',
      started_at: `2026-09-26T${hour}:01:00Z`, completed_at: `2026-09-26T${hour}:09:00Z`,
    }))}};
  });
  const getRun = vi.fn(async ({run_id}: {run_id: number}) => {
    const run = runs.find(item => item.id === run_id)!;
    return {data: {...run, ...(options.attemptChanged && run_id === 11 ? {run_attempt: run.run_attempt + 1} : {}),
      ...(options.finalPathSuffix !== undefined ? {path: env.HYPERVIBE_IOS_WORKFLOW_PATH + options.finalPathSuffix} : {})}};
  });
  const result = runScript(step(workflow, 'Find last successful beta').with.script,
    {rest: {actions: {listWorkflowRuns: listRuns, listWorkflowRunArtifacts: listArtifacts,
      getWorkflowRun: getRun, listJobsForWorkflowRun: listJobs, listJobsForWorkflowRunAttempt: listJobs}, repos: {getContent}}},
    {repo: {owner: 'owner', repo: 'app'}}, env);
  return {...result, listArtifacts, getContent, listRuns, listJobs, getRun};
}
describe('executed successful beta discovery', () => {
  it.each(['staging', 'production'])('compares from the last completed %s beta across a later skipped run', async environmentName => {
    const result = baseline({environmentName}); await result.result;
    expect(result.outputs).toEqual({artifact_id: '80', run_id: '11', sha: BASE});
    const decision = relevance(environmentName, {baseline: result.outputs.sha});
    await decision.result;
    expect(decision.outputs.should_release).toBe('false');
    expect(decision.compare).toHaveBeenCalledWith(expect.objectContaining({basehead: BASE + '...' + SHA}));
    expect(result.listArtifacts.mock.calls.map(([arg]) => arg.run_id)).toEqual([12, 11]);
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(BASE);
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(DISPATCH_REF_SHA);
  });
  it.each(['staging', 'production'])('builds when the last completed %s release has lost its artifact', async environmentName => {
    const result = baseline({environmentName, missingCompletedArtifact: true}); await result.result;
    expect(result.outputs).toEqual({});
    const decision = relevance(environmentName, {baseline: result.outputs.sha ?? ''});
    await decision.result;
    expect(decision.outputs.should_release).toBe('true');
    expect(decision.compare).not.toHaveBeenCalled();
  });
  it('uses latest completed release order when an older run is retried successfully', async () => {
    const result = baseline({retry: true}); await result.result;
    expect(result.listArtifacts.mock.calls[0][0].run_id).toBe(11);
    expect(result.outputs.sha).toBe(BASE);
  });
  it.each([
    {staleArtifact: true}, {skippedRelease: true}, {attemptChanged: true}, {wrongSkippedAttempt: true}, {omittedSkippedJobSha: true},
  ])('builds instead of trusting a previous attempt or changing history (%j)', async options => {
    const result = baseline(options); await result.result;
    expect(result.outputs).toEqual({});
  });
  it('accepts attempt-scoped jobs that omit their optional attempt field', async () => {
    const result = baseline({omittedJobAttempt: true}); await result.result;
    expect(result.outputs.sha).toBe(BASE);
    expect(result.listJobs).toHaveBeenCalledWith({owner: 'owner', repo: 'app', run_id: 11, attempt_number: 1, per_page: 100});
  });
  it.each([{changedWorkflow: true}, {expired: true}, {incomplete: true}, {error: true}])('keeps uncertain history out of the skip decision (%j)', async options => {
    const result = baseline(options); await result.result;
    expect(result.outputs).toEqual({});
  });
});

describe.each(['staging', 'production'])('previous beta workflow metadata (%s)', environmentName => {
  // workflow_run executes the consumer on the default branch, independently
  // of the triggering server branch. GitHub documents this event contract:
  // https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run
  it.each(['', '@refs/heads/main'])('uses the consumer ref when the server branch differs (%j)', async pathSuffix => {
    const result = baseline({environmentName, serverBranch: 'staging', pathSuffix}); await result.result;
    expect(result.outputs).toEqual({artifact_id: '80', run_id: '11', sha: BASE});
  });
  it.each(['', '@refs/heads/main'])('accepts the same workflow with suffix %j', async pathSuffix => {
    const result = baseline({environmentName, pathSuffix}); await result.result;
    expect(result.outputs).toEqual({artifact_id: '80', run_id: '11', sha: BASE});
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(BASE);
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(DISPATCH_REF_SHA);
  });
  it('accepts equivalent normalized identity during final baseline revalidation', async () => {
    const result = baseline({environmentName, finalPathSuffix: '@refs/heads/main'}); await result.result;
    expect(result.outputs.sha).toBe(BASE);
  });
  it('rejects an unexpected ref during final baseline revalidation', async () => {
    const result = baseline({environmentName, finalPathSuffix: '@refs/tags/main'}); await result.result;
    expect(result.outputs).toEqual({});
  });
  it.each(['@refs/tags/main', '@refs/heads/untrusted', '@', '@@refs/heads/main', '@refs/heads/main\n', '/other.yml', '.bak'])
    ('keeps malformed or untrusted baseline metadata %j out of skip decisions', async pathSuffix => {
      const result = baseline({environmentName, pathSuffix}); await result.result;
      expect(result.outputs).toEqual({});
    });
  it('does not infer trust for the current workflow from a matching path prefix', async () => {
    const result = baseline({environmentName, currentWorkflowRef: `owner/app/.github/workflows/hypervibe-ios-release-${environmentName}.yml@refs/tags/main`});
    await result.result;
    expect(result.outputs).toEqual({});
  });
  it('keeps different workflow source bytes out even with an allowed metadata suffix', async () => {
    const result = baseline({environmentName, pathSuffix: '@refs/heads/main', changedWorkflow: true}); await result.result;
    expect(result.outputs).toEqual({});
  });
});


describe('exact mobile source contract before protected build jobs', () => {
  it.each(['staging', 'production'])('rejects a forced %s build when the deployed mobile configuration differs from the reviewed workflow', async environmentName => {
    const workflow = generated(environmentName);
    const gate = step(workflow, 'Verify mobile source contract');
    const github = {rest: {repos: {getContent: vi.fn(async () => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({environments: {[environmentName]: {ios: {bundleId: 'another.app'}}}})).toString('base64')}}))}}};
    const execution = runScript(gate.with.script, github,
      {eventName: 'workflow_dispatch', repo: {owner: 'owner', repo: 'app'}, payload: {inputs: {force: 'true'}}},
      {...workflow.jobs.eligibility.env, ...gate.env, HYPERVIBE_CANDIDATE_SHA: SHA});
    await expect(execution.result).rejects.toThrow(/mobile.*source|source.*mobile/i);
  });
  it.each(['matching', 'different', 'omitted'] as const)('verifies %s embedded backend expectations in the exact deployed source', async variant => {
    const expectedInfoPlist = {AppEnvironment: 'staging', APIBaseURL: 'https://staging.invoiceperfect.com'};
    const workflow = generated('staging', '.', ['mobile', 'packages/shared'], expectedInfoPlist);
    const gate = step(workflow, 'Verify mobile source contract');
    const historicalSpec = {environments: {staging: {ios: {bundleId: 'com.example.app', release: {
      services: ['web'], build: {inputs: ['mobile', 'packages/shared'], command: 'make ios', ipaPath: 'build/app.ipa',
        ...(variant === 'omitted' ? {} : {expectedInfoPlist: {...expectedInfoPlist,
          APIBaseURL: variant === 'different' ? 'https://invoiceperfect.com' : expectedInfoPlist.APIBaseURL}})},
      testflight: {groups: ['Internal']},
    }}}}};
    const getContent = vi.fn(async () => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(historicalSpec)).toString('base64')}}));
    const execution = runScript(gate.with.script, {rest: {repos: {getContent}}}, {repo: {owner: 'owner', repo: 'app'}},
      {...workflow.jobs.eligibility.env, ...gate.env, HYPERVIBE_CANDIDATE_SHA: SHA},
      vi.fn(() => JSON.stringify({deploymentContractFingerprint: environmentDeploymentContractHash(historicalSpec, 'staging')})));
    if (variant === 'matching') await expect(execution.result).resolves.toBeUndefined();
    else await expect(execution.result).rejects.toThrow(/mobile.*configuration.*reviewed workflow/i);
    expect(getContent).toHaveBeenCalledWith({owner: 'owner', repo: 'app', path: '.hypervibe/spec.json', ref: SHA});
  });
});


it.each([true, false])('executes source fingerprints with equivalent defaults and requires the exact server contract hash (valid=%s)', async validHash => {
  const workflow = generated();
  const gate = step(workflow, 'Verify mobile source contract');
  const historicalSpec = {environments: {staging: {ios: {bundleId: 'com.example.app', release: {
    services: ['web'], build: {inputs: ['mobile', 'packages/shared'], command: 'make ios', ipaPath: 'build/app.ipa'},
    testflight: {groups: ['Internal']},
  }}}}};
  const getContent = vi.fn(async () => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(historicalSpec)).toString('base64')}}));
  const execution = runScript(gate.with.script, {rest: {repos: {getContent}}}, {repo: {owner: 'owner', repo: 'app'}},
    {...workflow.jobs.eligibility.env, ...gate.env, HYPERVIBE_CANDIDATE_SHA: SHA},
    vi.fn(() => JSON.stringify({deploymentContractFingerprint: validHash ? environmentDeploymentContractHash(historicalSpec, 'staging') : 'f'.repeat(64)})));
  if (validHash) await expect(execution.result).resolves.toBeUndefined();
  else await expect(execution.result).rejects.toThrow(/source|contract/i);
  expect(getContent).toHaveBeenCalledWith({owner: 'owner', repo: 'app', path: '.hypervibe/spec.json', ref: SHA});
});


it.each(['./mobile', 'mobile/', './mobile/', 'mobile\\native'])('never skips legacy workingDirectory %s because of path spelling', async workingDirectory => {
  const result = relevance('staging', {workingDirectory, files: [{filename: 'mobile/View.swift', status: 'modified'}]});
  await result.result;
  expect(result.outputs.should_release).toBe('true');
});
