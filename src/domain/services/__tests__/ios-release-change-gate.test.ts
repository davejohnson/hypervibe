import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { buildIosReleaseWorkflow } from '../ios-release-workflow.service.js';

// Reconstructed GitHub API evidence, not live scheduler/approval validation.
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run
// https://docs.github.com/en/rest/commits/commits#compare-two-commits
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DISPATCH_REF_SHA = 'c'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: any[]) => Promise<unknown>;
function generated(environmentName = 'staging', workingDirectory = '.', inputs: string[] | null = ['mobile', 'packages/shared']) {
  return parse(buildIosReleaseWorkflow({
    provider: 'railway', providerName: 'Railway', serverWorkflowPath: `.github/workflows/deploy-railway-${environmentName}.yml`,
    target: { environmentName, kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerServiceIds: ['web-id'],
      programFingerprint: 'd'.repeat(64), releaseTarget: {scope: {providerProjectId: 'project-id', providerEnvironmentId: environmentName},
        bindingsFingerprint: 'e'.repeat(64), resources: [{logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: 'web-id'}]} },
    ios: {bundleId: 'com.example.app', platform: 'IOS', capabilities: [], release: {services: ['web'], trigger: 'after-server-deploy',
      build: {workingDirectory, ...(inputs ? {inputs} : {}), command: 'make ios', ipaPath: 'build/app.ipa', requiredSecrets: []},
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
function releaseAttemptFixture() {
  const workflow = generated();
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
  const execute = (eventName: string) => runScript(step(workflow, 'Resolve release provenance').with.script, github,
    {eventName, repo: {owner: 'owner', repo: 'app'}, payload: {workflow_run: run, inputs: {commit_sha: SHA, server_run_id: '55'}}},
    workflow.jobs.eligibility.env);
  return {workflow, run, artifact, job, jobs, github, execute};
}

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
  function recheck(f: ReturnType<typeof releaseAttemptFixture>) {
    const steps = f.workflow.jobs.release.steps;
    const check = steps.find((entry: any) => entry.name === 'Recheck server release attempt');
    expect(steps.indexOf(check)).toBe(steps.findIndex((entry: any) => entry.name === 'Run Hypervibe-managed TestFlight release') - 1);
    return runScript(check.with.script, f.github, {repo: {owner: 'owner', repo: 'app'}}, {
      ...f.workflow.jobs.release.env, HYPERVIBE_SERVER_RUN_ID: '55', HYPERVIBE_SERVER_RUN_ATTEMPT: '2',
      HYPERVIBE_SERVER_ARTIFACT_ID: '90', HYPERVIBE_RELEASE_SHA: SHA,
    });
  }
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
  it('resolves the deployed artifact SHA when a dispatched run at ref B deployed source A', async () => {
    const execution = releaseAttemptFixture().execute('workflow_dispatch');
    await execution.result;
    expect(execution.outputs.sha).toBe(SHA);
    expect(execution.outputs.artifact_id).toBe('90');
  });
});

function manifest(workflow: any) {
  return {version: 2, environment: 'staging', mobile: {repository: 'owner/app', sha: BASE,
    buildContractFingerprint: workflow.jobs.eligibility.env.HYPERVIBE_IOS_BUILD_CONTRACT_FINGERPRINT},
  server: {repository: 'owner/app', sha: BASE},
  app: {bundleId: 'com.example.app', appId: 'app-id', buildId: 'build-id', ipaSha256: 'f'.repeat(64)}};
}
function relevance(options: {files?: unknown; status?: string; mergeBase?: string; evidence?: unknown; force?: boolean; error?: boolean; baseline?: string; workingDirectory?: string} = {}) {
  const workflow = options.workingDirectory ? generated('staging', options.workingDirectory, null) : generated();
  const emitted = step(workflow, 'Determine iOS change relevance');
  const compare = vi.fn(async () => {
    if (options.error) throw new Error('API unavailable');
    return {data: {status: options.status ?? 'ahead', merge_base_commit: {sha: options.mergeBase ?? BASE},
      files: options.files === undefined ? [{filename: 'web/page.tsx', status: 'modified'}, {filename: 'infra/main.tf', status: 'added'}] : options.files}};
  });
  const read = vi.fn(() => JSON.stringify(options.evidence === undefined ? manifest(workflow) : options.evidence));
  const execution = runScript(emitted.with.script, {rest: {repos: {compareCommitsWithBasehead: compare}}},
    {eventName: 'workflow_dispatch', repo: {owner: 'owner', repo: 'app'}, payload: {inputs: {force: options.force ?? false}}},
    {...workflow.jobs.eligibility.env, HYPERVIBE_CANDIDATE_SHA: SHA, HYPERVIBE_BASELINE_SHA: options.baseline ?? BASE, HYPERVIBE_BASELINE_PATH: '/beta.json'}, read);
  return {...execution, compare, read};
}

describe('executed comparison from the last completed beta', () => {
  it('skips web and infrastructure changes while comparing the entire unbuilt range', async () => {
    const result = relevance(); await result.result;
    expect(result.outputs.should_release).toBe('false');
    expect(result.compare).toHaveBeenCalledWith({owner: 'owner', repo: 'app', basehead: BASE + '...' + SHA, per_page: 1, page: 1});
  });
  it.each(['mobile/View.swift', 'packages/shared/api.ts', 'package-lock.json', '.github/workflows/hypervibe-ios-release-staging.yml'])('builds when an earlier unbuilt commit affects %s', async filename => {
    const result = relevance({files: [{filename, status: 'modified'}, {filename: 'web/page.tsx', status: 'modified'}]});
    await result.result; expect(result.outputs.should_release).toBe('true');
  });
  it('detects a file moved out of the mobile tree', async () => {
    const result = relevance({files: [{filename: 'archive/View.swift', previous_filename: 'mobile/View.swift', status: 'renamed'}]});
    await result.result; expect(result.outputs.should_release).toBe('true');
  });
  it('treats a path prefix without a directory boundary as irrelevant', async () => {
    const result = relevance({files: [{filename: 'mobile-web/home.tsx', status: 'modified'}]});
    await result.result; expect(result.outputs.should_release).toBe('false');
  });
  it.each([
    {evidence: null}, {evidence: {}}, {baseline: ''}, {status: 'diverged'}, {mergeBase: DISPATCH_REF_SHA},
    {files: null}, {files: [{filename: 'web/a.ts', status: 'renamed'}]}, {error: true},
    {files: Array.from({length: 300}, (_, index) => ({filename: `web/${index}.tsx`, status: 'modified'}))},
  ])('requires a build when baseline/comparison evidence is absent, unknown, or truncated (%j)', async options => {
    const result = relevance(options); await result.result; expect(result.outputs.should_release).toBe('true');
  });
  it.each(['environment', 'fingerprint', 'repository', 'sha', 'bundle', 'version', 'ipa'])('does not skip using stale or differently scoped %s evidence', async field => {
    const evidence = manifest(generated());
    if (field === 'environment') evidence.environment = 'production';
    if (field === 'fingerprint') evidence.mobile.buildContractFingerprint = '0'.repeat(64);
    if (field === 'repository') evidence.mobile.repository = 'another/repo';
    if (field === 'sha') evidence.mobile.sha = SHA;
    if (field === 'bundle') evidence.app.bundleId = 'another.bundle';
    if (field === 'version') evidence.version = 1;
    if (field === 'ipa') evidence.app.ipaSha256 = '';
    const result = relevance({evidence}); await result.result;
    expect(result.outputs.should_release).toBe('true'); expect(result.compare).not.toHaveBeenCalled();
  });
  it('manual force bypasses only relevance and leaves the earlier provenance steps mandatory', async () => {
    const result = relevance({force: true}); await result.result;
    expect(result.outputs.should_release).toBe('true'); expect(result.compare).not.toHaveBeenCalled();
    const steps = generated().jobs.eligibility.steps;
    expect(steps.findIndex((item: any) => item.name === 'Verify server release gate')).toBeLessThan(steps.findIndex((item: any) => item.name === 'Determine iOS change relevance'));
    expect(step(generated(), 'Verify server release gate').if).toBeUndefined();
  });
});

function baseline(options: {changedWorkflow?: boolean; expired?: boolean; incomplete?: boolean; error?: boolean; retry?: boolean; missingCompletedArtifact?: boolean;
  staleArtifact?: boolean; skippedRelease?: boolean; attemptChanged?: boolean; wrongSkippedAttempt?: boolean; omittedJobAttempt?: boolean; omittedSkippedJobSha?: boolean} = {}) {
  const workflow = generated();
  const env = {...workflow.jobs.eligibility.env, GITHUB_RUN_ID: '99', GITHUB_WORKFLOW_SHA: DISPATCH_REF_SHA, GITHUB_WORKFLOW_REF: 'owner/app/.github/workflows/hypervibe-ios-release-staging.yml@refs/heads/main'};
  // GitHub workflow-run/job/artifact shapes reconstructed from the official REST
  // contract: attempt-scoped jobs may omit run_attempt, artifacts have no attempt.
  // https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
  const runs = [{id: 12, status: 'completed', run_attempt: 1, run_started_at: '2026-09-26T02:00:00Z', created_at: '2026-09-26T02:00:00Z', updated_at: '2026-09-26T02:10:00Z', head_sha: DISPATCH_REF_SHA, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH},
    {id: 11, status: 'completed', run_attempt: 1, run_started_at: '2026-09-26T01:00:00Z', created_at: '2026-09-26T01:00:00Z', updated_at: '2026-09-26T01:10:00Z', head_sha: BASE, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH}];
  if (options.retry || options.staleArtifact) Object.assign(runs[1], {run_attempt: 2, run_started_at: '2026-09-26T03:00:00Z', updated_at: '2026-09-26T03:10:00Z'});
  const releaseHour = options.retry || options.staleArtifact ? '03' : '01';
  const artifact = {id: 80, name: 'hypervibe-ios-release-staging-' + BASE, expired: options.expired ?? false,
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
    return {data: options.attemptChanged && run_id === 11 ? {...run, run_attempt: run.run_attempt + 1} : run};
  });
  const result = runScript(step(workflow, 'Find last successful beta').with.script,
    {rest: {actions: {listWorkflowRuns: listRuns, listWorkflowRunArtifacts: listArtifacts,
      getWorkflowRun: getRun, listJobsForWorkflowRun: listJobs, listJobsForWorkflowRunAttempt: listJobs}, repos: {getContent}}},
    {repo: {owner: 'owner', repo: 'app'}}, env);
  return {...result, listArtifacts, getContent, listRuns, listJobs, getRun};
}
describe('executed successful beta discovery', () => {
  it('does not advance the baseline for a successful skipped run without a beta artifact', async () => {
    const result = baseline(); await result.result;
    expect(result.outputs).toEqual({artifact_id: '80', run_id: '11', sha: BASE});
    expect(result.listArtifacts.mock.calls.map(([arg]) => arg.run_id)).toEqual([12, 11]);
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(BASE);
    expect(result.getContent.mock.calls.map(([arg]) => arg.ref)).toContain(DISPATCH_REF_SHA);
  });
  it('requires a build when a successful beta artifact was deleted instead of proving a skipped release', async () => {
    const result = baseline({missingCompletedArtifact: true}); await result.result;
    expect(result.outputs).toEqual({});
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


describe('exact mobile source contract before protected build jobs', () => {
  it('fails before a build when deployed source A has different mobile configuration than workflow B', async () => {
    const workflow = generated();
    const gate = step(workflow, 'Verify mobile source contract');
    const github = {rest: {repos: {getContent: vi.fn(async () => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({environments: {staging: {ios: {bundleId: 'another.app'}}}})).toString('base64')}}))}}};
    const execution = runScript(gate.with.script, github, {repo: {owner: 'owner', repo: 'app'}}, {...workflow.jobs.eligibility.env, ...gate.env, HYPERVIBE_CANDIDATE_SHA: SHA});
    await expect(execution.result).rejects.toThrow(/mobile.*source|source.*mobile/i);
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
  const result = relevance({workingDirectory, files: [{filename: 'mobile/View.swift', status: 'modified'}]});
  await result.result;
  expect(result.outputs.should_release).toBe('true');
});
