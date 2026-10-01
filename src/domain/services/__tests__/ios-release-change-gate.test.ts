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
    const workflow = generated();
    const provenance = step(workflow, 'Resolve release provenance');
    const expected = JSON.parse(workflow.jobs.eligibility.env.HYPERVIBE_EXPECTED_SERVER_RELEASE);
    const github = {rest: {actions: {
      getWorkflowRun: vi.fn(async () => ({data: {id: 55, conclusion: 'success', path: expected.workflowPath, head_sha: DISPATCH_REF_SHA}})),
      listWorkflowRunArtifacts: vi.fn(async () => ({data: {total_count: 1, artifacts: [{id: 90, expired: false, name: expected.artifactPrefix + SHA, workflow_run: {id: 55, head_sha: DISPATCH_REF_SHA}}]}})),
    }}};
    const execution = runScript(provenance.with.script, github, {eventName: 'workflow_dispatch', repo: {owner: 'owner', repo: 'app'}, payload: {inputs: {commit_sha: SHA, server_run_id: '55'}}}, workflow.jobs.eligibility.env);
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

function baseline(options: {changedWorkflow?: boolean; expired?: boolean; incomplete?: boolean; error?: boolean; retry?: boolean; missingCompletedArtifact?: boolean} = {}) {
  const workflow = generated();
  const env = {...workflow.jobs.eligibility.env, GITHUB_RUN_ID: '99', GITHUB_WORKFLOW_SHA: DISPATCH_REF_SHA, GITHUB_WORKFLOW_REF: 'owner/app/.github/workflows/hypervibe-ios-release-staging.yml@refs/heads/main'};
  const runs = [{id: 12, created_at: '2026-09-26T02:00:00Z', updated_at: '2026-09-26T02:10:00Z', head_sha: DISPATCH_REF_SHA, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH},
    {id: 11, created_at: '2026-09-26T01:00:00Z', updated_at: '2026-09-26T01:10:00Z', head_sha: BASE, conclusion: 'success', path: env.HYPERVIBE_IOS_WORKFLOW_PATH}];
  if (options.retry) runs[1].updated_at = '2026-09-26T03:10:00Z';
  const listArtifacts = vi.fn(async ({run_id}: {run_id: number}) => ({data: {total_count: run_id === 12 ? 0 : 1, artifacts: run_id === 12 ? [] : [
    {id: 80, name: 'hypervibe-ios-release-staging-' + BASE, expired: options.expired ?? false, workflow_run: {id: 11, head_sha: BASE}},
  ]}}));
  const getContent = vi.fn(async ({ref}: {ref: string}) => ({data: {type: 'file', encoding: 'base64', content: Buffer.from(options.changedWorkflow && ref === BASE ? 'old managed workflow' : 'same managed workflow').toString('base64')}}));
  const listRuns = vi.fn(async () => {
    if (options.error) throw new Error('Forbidden');
    return {data: {total_count: options.incomplete ? 1000 : 2, workflow_runs: runs}};
  });
  const result = runScript(step(workflow, 'Find last successful beta').with.script,
    {rest: {actions: {listWorkflowRuns: listRuns, listWorkflowRunArtifacts: listArtifacts,
      listJobsForWorkflowRun: vi.fn(async () => ({data: {total_count: 4, jobs: [
        {id: 1, run_id: 12, name: 'eligibility', status: 'completed', conclusion: 'success'},
        ...['prepare', 'build', 'release'].map((name, index) => ({id: index + 2, run_id: 12, name, status: 'completed', conclusion: options.missingCompletedArtifact ? 'success' : 'skipped'})),
      ]}}))}, repos: {getContent}}},
    {repo: {owner: 'owner', repo: 'app'}}, env);
  return {...result, listArtifacts, getContent, listRuns};
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
