import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import '../../../adapters/providers/railway/railway.adapter.js';
import { buildBranchDeployWorkflow } from '../github-ops.service.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { environmentDeploymentContractHash } from '../deployment-contract.service.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiReleaseSpec } from '../../spec/spec.schema.js';
import { API_RELEASE_RUNTIME_SOURCE, API_RELEASE_RUNTIME_SHA256, API_RELEASE_EVIDENCE_FILE, API_RELEASE_MAX_BYTES, API_RELEASE_MAX_VERSIONS, buildApiReleaseWorkflowSteps, validateApiReleaseEvidence } from '../api-release-workflow.js';
import { extractGitHubScript, extractWorkflowShell, installReleaseEvidenceValidator } from './managed-ci-workflow.test-utils.js';

const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
const identity = {repository: 'owner/app', environment: 'production', sha, runId: 20, workflow: '.github/workflows/deploy.yml'};
const oldIdentity = {...identity, sha: oldSha, runId: 10};
const serverValidation = {loader: 'const validatorModule = {exports: {}};', sha256: 'd'.repeat(64), expected: {provider: 'railway', environment: 'production', programFingerprint: 'e'.repeat(64), target: {scope: {}, resources: [], bindingsFingerprint: 'f'.repeat(64)}, requireImmutableImage: true}};
const policy = (): ApiReleaseSpec => ({service: 'api', versions: {v1: {path: '/v1', contract: 'api/v1.json', status: 'supported'}}, consumers: {ios: {versions: ['v1']}}, compatibility: {command: 'node check.cjs', workingDirectory: '.'}});
const server = (value = identity) => ({version: 4, source: {repository: value.repository, sha: value.sha}, environment: value.environment, target: {resources: [{logicalName: 'api'}]}, deploymentContractFingerprint: 'c'.repeat(64)});

describe('emitted API release compatibility runtime', () => {
  let dir: string, workspace: string, baselineDirectory: string, candidateDirectory: string;
  let runtime: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-api-gate-'));
    workspace = path.join(dir, 'repo'); baselineDirectory = path.join(dir, 'baseline'); candidateDirectory = path.join(dir, 'candidate');
    fs.mkdirSync(path.join(workspace, 'api'), {recursive: true}); fs.mkdirSync(baselineDirectory);
    fs.writeFileSync(path.join(workspace, 'api/v1.json'), JSON.stringify({paths: {'/v1/items': {get: {responses: {'200': {description: 'ok'}}}}}}));
    fs.writeFileSync(path.join(workspace, 'check.cjs'), `const fs = require('fs'); if (!process.env.HYPERVIBE_API_BASELINE_DIR || !process.env.HYPERVIBE_API_CANDIDATE_DIR) process.exit(2); fs.writeFileSync('checked', 'yes');`);
    fs.writeFileSync(path.join(dir, 'runtime.cjs'), API_RELEASE_RUNTIME_SOURCE);
    runtime = createRequire(import.meta.url)(path.join(dir, 'runtime.cjs'));
  });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); vi.restoreAllMocks(); });
  const prepareParams = () => ({policy: policy(), identity, workspace, baselineDirectory, candidateDirectory, baselineIdentity: null});
  function existingBaseline() {
    runtime.prepareApiRelease({...prepareParams(), identity: oldIdentity, candidateDirectory: baselineDirectory});
    const filename = path.join(dir, 'old-server.json'); fs.writeFileSync(filename, JSON.stringify(server(oldIdentity)));
    runtime.finalizeApiRelease({candidateDirectory: baselineDirectory, serverEvidencePath: filename, identity: oldIdentity});
    fs.copyFileSync(filename, path.join(baselineDirectory, 'hypervibe-server-release.json'));
  }
  it('executes the actual compatibility command against isolated JSON snapshots, then binds evidence to the server release', () => {
    const prepared = runtime.prepareApiRelease(prepareParams());
    expect(fs.readFileSync(path.join(workspace, 'checked'), 'utf8')).toBe('yes');
    expect(prepared.versions.v1.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.compatibility).toMatchObject({status: 'passed', claim: 'project-command'});
    const filename = path.join(dir, 'server.json'); fs.writeFileSync(filename, JSON.stringify(server()));
    runtime.finalizeApiRelease({candidateDirectory, serverEvidencePath: filename, identity});
    expect(JSON.parse(fs.readFileSync(path.join(candidateDirectory, API_RELEASE_EVIDENCE_FILE), 'utf8'))).toMatchObject({...identity, serverEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/)});
  });
  it('retains v1 when adding v2 and rejects removing a previously declared version before executing project code', () => {
    existingBaseline(); fs.unlinkSync(path.join(workspace, 'checked'));
    const removed = policy(); removed.versions = {v2: {path: '/v2', contract: 'api/v2.json', status: 'supported'}}; removed.consumers = {};
    fs.writeFileSync(path.join(workspace, 'api/v2.json'), '{}');
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: removed, baselineIdentity: oldIdentity})).toThrow(/version|ledger/i);
    expect(fs.existsSync(path.join(workspace, 'checked'))).toBe(false);
    const added = policy(); (added.versions as any).v2 = {path: '/v2', contract: 'api/v2.json', status: 'supported'};
    fs.writeFileSync(path.join(workspace, 'api/v2.json'), '{}');
    expect(runtime.prepareApiRelease({...prepareParams(), policy: added, baselineIdentity: oldIdentity}).versions).toHaveProperty('v1');
  });
  it('rejects a changed version route, revival of a tombstone, and retirement without an explicit decision', () => {
    existingBaseline();
    const changed = policy(); changed.versions.v1.path = '/changed';
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: changed, baselineIdentity: oldIdentity})).toThrow(/path|route/i);
    const retired = policy(); retired.versions.v1.status = 'retired'; retired.consumers = {} as never;
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: retired, baselineIdentity: oldIdentity})).toThrow(/retirement/i);
  });
  it('rejects missing, mismatched or modified baseline evidence rather than bootstrapping', () => {
    expect(() => runtime.prepareApiRelease({...prepareParams(), baselineIdentity: oldIdentity})).toThrow(/baseline/i);
    existingBaseline();
    expect(() => runtime.prepareApiRelease({...prepareParams(), baselineIdentity: {...oldIdentity, sha}})).toThrow(/identity|baseline/i);
    fs.writeFileSync(path.join(baselineDirectory, 'contracts/v1.json'), '{}');
    expect(() => runtime.prepareApiRelease({...prepareParams(), baselineIdentity: oldIdentity})).toThrow(/hash|snapshot/i);
  });
  it('fails before release on a failing command, missing contract, external reference or symlink', () => {
    const failing = policy(); failing.compatibility.command = 'node -e "process.exit(8)"';
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: failing})).toThrow(/compatibility/i);
    fs.writeFileSync(path.join(workspace, 'api/v1.json'), JSON.stringify({$ref: 'https://example.com/schema.json'}));
    expect(() => runtime.prepareApiRelease(prepareParams())).toThrow(/reference/i);
    fs.unlinkSync(path.join(workspace, 'api/v1.json')); fs.symlinkSync(path.join(dir, 'runtime.cjs'), path.join(workspace, 'api/v1.json'));
    expect(() => runtime.prepareApiRelease(prepareParams())).toThrow(/symbolic|symlink|regular/i);
  });
  it('does not publish snapshots changed by the command or a build after the gate', () => {
    const mutated = policy(); mutated.compatibility.command = `node -e "require('fs').writeFileSync(process.env.HYPERVIBE_API_CANDIDATE_DIR + '/contracts/v1.json', '{}')"`;
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: mutated})).toThrow(/snapshot|hash/i);
    runtime.prepareApiRelease(prepareParams());
    fs.writeFileSync(path.join(candidateDirectory, 'contracts/v1.json'), '{}');
    const filename = path.join(dir, 'server.json'); fs.writeFileSync(filename, JSON.stringify(server()));
    expect(() => runtime.finalizeApiRelease({candidateDirectory, serverEvidencePath: filename, identity})).toThrow(/snapshot|hash/i);
  });
  it('runs emitted materialization and baseline-selection code; empty complete history alone bootstraps', async () => {
    const steps = buildApiReleaseWorkflowSteps({environmentName: identity.environment, api: policy(), workflowPath: identity.workflow, serverValidation});
    const workflow = `jobs:\n  deploy:\n    steps:\n${steps.beforeDeploy}${steps.afterDeploy}`;
    const filename = path.join(dir, 'emitted.cjs');
    execFileSync('bash', ['-eu', '-c', extractWorkflowShell(workflow, 'Prepare API compatibility runtime')], {env: {...process.env, HYPERVIBE_API_RUNTIME_PATH: filename, HYPERVIBE_API_RUNTIME_BASE64: Buffer.from(API_RELEASE_RUNTIME_SOURCE).toString('base64')}});
    const outputs: Record<string, string> = {};
    const github = {rest: {actions: {listWorkflowRuns: vi.fn().mockResolvedValue({data: {total_count: 0, workflow_runs: []}})}}};
    const source = extractGitHubScript(workflow, 'Resolve previous API release');
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const environment = {HYPERVIBE_API_RUNTIME_PATH: filename, HYPERVIBE_API_RUNTIME_SHA256: API_RELEASE_RUNTIME_SHA256, HYPERVIBE_API_ENVIRONMENT: 'production', HYPERVIBE_API_WORKFLOW: identity.workflow, HYPERVIBE_API_SHA: sha, HYPERVIBE_API_OPERATION: 'deploy', RUNNER_TEMP: dir, GITHUB_RUN_ATTEMPT: '1'};
    await new AsyncFunction('require', 'process', 'github', 'context', 'core', source)(createRequire(import.meta.url), {env: environment}, github, {repo: {owner: 'owner', repo: 'app'}, runId: 20}, {setOutput: (key: string, value: unknown) => outputs[key] = String(value)});
    expect(outputs.has_baseline).toBe('false');
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({workflow_id: identity.workflow, page: 1}));
    environment.HYPERVIBE_API_OPERATION = 'rollback';
    await expect(new AsyncFunction('require', 'process', 'github', 'context', 'core', source)(createRequire(import.meta.url), {env: environment}, github, {repo: {owner: 'owner', repo: 'app'}, runId: 20}, {setOutput() {}})).rejects.toThrow(/rollback/i);
  });
  it('requires both exact artifacts on the latest successful run and fails unknown or incomplete pagination', async () => {
    const run = {id: 10, head_sha: oldSha, path: identity.workflow, conclusion: 'success', status: 'completed', updated_at: '2026-09-26T10:00:00Z'};
    const actions = {listWorkflowRuns: vi.fn().mockResolvedValue({data: {total_count: 1, workflow_runs: [run]}}), listWorkflowRunArtifacts: vi.fn().mockResolvedValue({data: {total_count: 0, artifacts: []}})};
    const select = () => runtime.selectApiBaseline({github: {rest: {actions}}, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: 20});
    await expect(select()).rejects.toThrow(/companion|baseline|artifact/i);
    actions.listWorkflowRuns.mockResolvedValueOnce({data: {total_count: 2, workflow_runs: []}});
    await expect(select()).rejects.toThrow(/incomplete|history/i);
    actions.listWorkflowRuns.mockRejectedValueOnce(new Error('403'));
    await expect(select()).rejects.toThrow();
  });
  it('blocks failed, cancelled or concurrent runs that could have changed the live baseline', async () => {
    const successful = {id: 10, head_sha: oldSha, path: identity.workflow, conclusion: 'success', status: 'completed', updated_at: '2026-09-26T10:00:00Z'};
    const newer = {...successful, id: 11, conclusion: 'failure', updated_at: '2026-09-26T11:00:00Z'};
    const listWorkflowRuns = vi.fn().mockResolvedValue({data: {total_count: 2, workflow_runs: [newer, successful]}});
    const select = () => runtime.selectApiBaseline({github: {rest: {actions: {listWorkflowRuns}}}, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: 20});
    await expect(select()).rejects.toThrow(/may have changed/);
    newer.conclusion = 'cancelled'; await expect(select()).rejects.toThrow(/may have changed/);
    newer.status = 'in_progress'; await expect(select()).rejects.toThrow(/active or unknown/);
  });
  it('paginates exact artifact identities and picks the latest successful attempt by observed completion update', async () => {
    const run = {id: 10, head_sha: oldSha, path: identity.workflow, conclusion: 'success', status: 'completed', updated_at: '2026-09-26T10:00:00Z'};
    const metadata = {expired: false, workflow_run: {id: 10, head_sha: oldSha}};
    const listWorkflowRunArtifacts = vi.fn().mockResolvedValueOnce({data: {total_count: 2, artifacts: [{id: 41, name: 'hypervibe-api-release-v1-production-' + oldSha, ...metadata}]}})
      .mockResolvedValueOnce({data: {total_count: 2, artifacts: [{id: 42, name: 'hypervibe-server-release-v4-production-' + oldSha, ...metadata}]}});
    const actions = {listWorkflowRuns: vi.fn().mockResolvedValue({data: {total_count: 1, workflow_runs: [run]}}), listWorkflowRunArtifacts};
    expect(await runtime.selectApiBaseline({github: {rest: {actions}}, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: 20})).toMatchObject({...oldIdentity, apiArtifactId: 41, serverArtifactId: 42});
    expect(listWorkflowRunArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({page: 2, run_id: 10}));
  });

  it('separates the workflow dispatch head from the deployed artifact source SHA', async () => {
    const run = {id: 10, head_sha: oldSha, path: identity.workflow, conclusion: 'success', status: 'completed', updated_at: '2026-09-26T10:00:00Z'};
    const metadata = {expired: false, workflow_run: {id: 10, head_sha: oldSha}};
    const actions = {listWorkflowRuns: vi.fn().mockResolvedValue({data: {total_count: 1, workflow_runs: [run]}}), listWorkflowRunArtifacts: vi.fn().mockResolvedValue({data: {total_count: 2, artifacts: [
      {id: 41, name: 'hypervibe-api-release-v1-production-' + sha, ...metadata},
      {id: 42, name: 'hypervibe-server-release-v4-production-' + sha, ...metadata},
    ]}})};
    expect(await runtime.selectApiBaseline({github: {rest: {actions}}, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: 20})).toMatchObject({...oldIdentity, sha, apiArtifactId: 41, serverArtifactId: 42});
  });

  it('allows correcting a failed compatibility test only with immutable matching workflow and skipped later provider steps', async () => {
    const previous = {id: 10, head_sha: oldSha, path: identity.workflow, conclusion: 'success', status: 'completed', updated_at: '2026-09-26T10:00:00Z'};
    const failed = {...previous, id: 11, head_sha: sha, conclusion: 'failure', updated_at: '2026-09-26T11:00:00Z'};
    const step = (name: string, number: number, conclusion: string) => ({name, number, conclusion, status: 'completed'});
    const steps = [step('Resolve deploy SHA', 1, 'success'), step('Verify API compatibility before deployment', 2, 'failure'), step('Migrate database', 3, 'skipped'), step('Deploy provider workload', 4, 'skipped'), step('Complete job', 5, 'success')];
    const artifacts = [{id: 41, name: 'hypervibe-api-release-v1-production-' + oldSha}, {id: 42, name: 'hypervibe-server-release-v4-production-' + oldSha}].map(value => ({...value, expired: false, workflow_run: {id: 10, head_sha: oldSha}}));
    const actions = {listWorkflowRuns: vi.fn().mockResolvedValue({data: {total_count: 2, workflow_runs: [failed, previous]}}), listJobsForWorkflowRun: vi.fn().mockResolvedValue({data: {total_count: 1, jobs: [{id: 111, run_id: 11, head_sha: sha, status: 'completed', conclusion: 'failure', name: 'deploy', steps}]}}), listWorkflowRunArtifacts: vi.fn().mockResolvedValue({data: {total_count: 2, artifacts}})};
    const workflow = 'managed API workflow ' + API_RELEASE_RUNTIME_SHA256;
    const repos = {getContent: vi.fn().mockResolvedValue({data: {type: 'file', path: identity.workflow, encoding: 'base64', content: Buffer.from(workflow).toString('base64')}})};
    const select = () => runtime.selectApiBaseline({github: {rest: {actions, repos}}, repository: identity.repository, environment: identity.environment, workflow: identity.workflow, currentRunId: 20, currentWorkflowSha: sha});
    expect(await select()).toMatchObject(oldIdentity);
    steps[3].conclusion = 'success'; await expect(select()).rejects.toThrow(/may have changed/);
  });

  it('publishes a retained retirement tombstone and never revives it', () => {
    existingBaseline();
    const retired = policy(); retired.versions.v1.status = 'retired'; retired.versions.v1.retirement = {id: 'retire-v1', reason: 'reviewed client migration'}; retired.consumers = {};
    runtime.prepareApiRelease({...prepareParams(), policy: retired, baselineIdentity: oldIdentity});
    const filename = path.join(dir, 'server.json'); fs.writeFileSync(filename, JSON.stringify(server()));
    runtime.finalizeApiRelease({candidateDirectory, serverEvidencePath: filename, identity});
    fs.copyFileSync(filename, path.join(candidateDirectory, 'hypervibe-server-release.json'));
    expect(() => runtime.prepareApiRelease({...prepareParams(), baselineDirectory: candidateDirectory, candidateDirectory: path.join(dir, 'next'), baselineIdentity: identity})).toThrow(/tombstone|revived/i);
  });
  it('exports the same pure companion validator for in-memory App Store consumers', () => {
    existingBaseline();
    const manifest = JSON.parse(fs.readFileSync(path.join(baselineDirectory, API_RELEASE_EVIDENCE_FILE), 'utf8'));
    const snapshots = {'contracts/v1.json': fs.readFileSync(path.join(baselineDirectory, 'contracts/v1.json'))};
    expect(validateApiReleaseEvidence({manifest, snapshots, identity: oldIdentity, serverEvidenceSha256: manifest.serverEvidenceSha256})).toMatchObject(oldIdentity);
    expect(() => validateApiReleaseEvidence({manifest, snapshots: {'contracts/v1.json': '{}'}, identity: oldIdentity, serverEvidenceSha256: manifest.serverEvidenceSha256})).toThrow(/hash/i);
    expect(() => validateApiReleaseEvidence({manifest, snapshots, identity: oldIdentity, serverEvidenceSha256: 'a'.repeat(64)})).toThrow(/identity|evidence/i);
  });
  it('executes the emitted compatibility/finalization consumer against the actual runtime and records no release on failure', async () => {
    const pieces = buildApiReleaseWorkflowSteps({environmentName: identity.environment, api: policy(), workflowPath: identity.workflow, runtime: {kind: 'node', version: '24', installCommand: 'node -e "require(\'fs\').writeFileSync(\'installed\', \'yes\')"'}, serverValidation});
    const workflow = `jobs:\n  deploy:\n    steps:\n${pieces.beforeDeploy}${pieces.afterDeploy}`;
    const source = extractGitHubScript(workflow, 'Verify API compatibility before deployment');
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const environment: Record<string, string> = {HYPERVIBE_API_RUNTIME_PATH: path.join(dir, 'runtime.cjs'), HYPERVIBE_API_RUNTIME_SHA256: API_RELEASE_RUNTIME_SHA256, HYPERVIBE_API_POLICY: parseDocument(workflow).toJS().jobs.deploy.steps.find((step: {name: string}) => step.name === 'Verify API compatibility before deployment').env.HYPERVIBE_API_POLICY, HYPERVIBE_API_IDENTITY: JSON.stringify(identity), HYPERVIBE_API_BASELINE_IDENTITY: 'null', HYPERVIBE_API_BASELINE_DIR: baselineDirectory, HYPERVIBE_API_CANDIDATE_DIR: candidateDirectory, GITHUB_WORKSPACE: workspace};
    const outputs: Record<string, string> = {};
    const core = {setOutput: (key: string, value: unknown) => outputs[key] = String(value), info() {}};
    await new AsyncFunction('require', 'process', 'core', 'github', 'context', source)(createRequire(import.meta.url), {env: environment}, core, {}, {});
    expect(outputs.candidate_sha256).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(workspace, 'hypervibe-server-release.json'), JSON.stringify(server()));
    environment.HYPERVIBE_API_CANDIDATE_SHA256 = outputs.candidate_sha256;
    await new AsyncFunction('require', 'process', extractGitHubScript(workflow, 'Bind API compatibility evidence to server release'))(createRequire(import.meta.url), {env: environment});
    expect(JSON.parse(fs.readFileSync(path.join(candidateDirectory, API_RELEASE_EVIDENCE_FILE), 'utf8')).serverEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(workspace, 'installed'), 'utf8')).toBe('yes');
    expect(workflow).toContain('Set up Node for API compatibility');
  });

  it('enforces aggregate artifact and version limits before executing project compatibility code', () => {
    fs.writeFileSync(path.join(workspace, 'api/v1.json'), JSON.stringify({description: 'x'.repeat(API_RELEASE_MAX_BYTES)}));
    expect(() => runtime.prepareApiRelease(prepareParams())).toThrow(/aggregate size/);
    expect(fs.existsSync(path.join(workspace, 'checked'))).toBe(false);
    const many = policy(); many.versions = Object.fromEntries(Array.from({length: API_RELEASE_MAX_VERSIONS + 1}, (_, index) => ['v' + (index + 1), {path: '/v' + (index + 1), contract: 'api/v1.json', status: 'supported'}]));
    expect(() => runtime.prepareApiRelease({...prepareParams(), policy: many})).toThrow(/version limit/);
  });
  it('executes the API gate with real shared server evidence producer/validator and historical policy provenance', async () => {
    const scope = {providerProjectId: 'project-id', providerEnvironmentId: 'production-id'};
    const resources = [{logicalName: 'api', workloadKind: 'web' as const, providerResourceType: 'service' as const, providerResourceId: 'service-id'}];
    const bindingsFingerprint = canonicalJsonSha256({version: 1, provider: 'railway', environment: 'production', scope, resources});
    const projectRuntime = {kind: 'node' as const, version: '24', installCommand: 'true'};
    const currentPolicy = policy(); currentPolicy.versions.v2 = {path: '/v2', contract: 'api/v2.json', status: 'supported'};
    fs.writeFileSync(path.join(workspace, 'api/v2.json'), '{}');
    const workflow = buildBranchDeployWorkflow('railway', {environmentName: 'production', kind: 'production', branch: 'main', autoDeployOnPush: false, serviceNames: ['api'], providerProjectId: scope.providerProjectId, providerEnvironmentId: scope.providerEnvironmentId, providerServiceIds: ['service-id'], releaseTarget: {scope, resources, bindingsFingerprint}, programFingerprint: 'a'.repeat(64), runtime: projectRuntime, api: currentPolicy}, {includeStep: false});
    const validator = installReleaseEvidenceValidator(workflow.content, dir);
    const steps = parseDocument(workflow.content).toJS().jobs.deploy.steps;
    const sourceIdentity = {...oldIdentity, workflow: workflow.path};
    const historicalSpec = {version: 1, project: 'app', runtime: projectRuntime, environments: {production: {api: policy()}}};
    runtime.prepareApiRelease({...prepareParams(), policy: {...policy(), compatibility: {...policy().compatibility, installCommand: 'true'}}, identity: sourceIdentity, candidateDirectory: baselineDirectory});
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const localRequire = createRequire(import.meta.url);
    const producerEnv = {...steps.find((step: {name: string}) => step.name === 'Write server release evidence').env, HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath, GITHUB_REPOSITORY: identity.repository, HYPERVIBE_RELEASE_SHA: oldSha, HYPERVIBE_RELEASE_IMAGE_URI: 'ghcr.io/owner/app@sha256:' + '9'.repeat(64), HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: environmentDeploymentContractHash(historicalSpec, 'production')};
    await new AsyncFunction('require', 'process', extractGitHubScript(workflow.content, 'Write server release evidence'))((name: string) => name === 'fs' ? {...fs, writeFileSync: (filename: string, bytes: string) => fs.writeFileSync(path.join(baselineDirectory, filename), bytes)} : localRequire(name), {env: producerEnv});
    runtime.finalizeApiRelease({candidateDirectory: baselineDirectory, serverEvidencePath: path.join(baselineDirectory, 'hypervibe-server-release.json'), identity: sourceIdentity});
    const env = {...steps.find((step: {name: string}) => step.name === 'Verify API compatibility before deployment').env, HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath, HYPERVIBE_API_RUNTIME_PATH: path.join(dir, 'runtime.cjs'), HYPERVIBE_API_IDENTITY: JSON.stringify({...identity, workflow: workflow.path}), HYPERVIBE_API_BASELINE_IDENTITY: JSON.stringify(sourceIdentity), HYPERVIBE_API_BASELINE_DIR: baselineDirectory, HYPERVIBE_API_CANDIDATE_DIR: candidateDirectory, GITHUB_WORKSPACE: workspace};
    const github = {rest: {repos: {getContent: vi.fn().mockResolvedValue({data: {type: 'file', path: '.hypervibe/spec.json', encoding: 'base64', content: Buffer.from(JSON.stringify(historicalSpec)).toString('base64')}})}}};
    const command = new AsyncFunction('require', 'process', 'github', 'context', 'core', extractGitHubScript(workflow.content, 'Verify API compatibility before deployment'));
    const run = () => command(localRequire, {env}, github, {repo: {owner: 'owner', repo: 'app'}}, {setOutput() {}, info() {}});
    await expect(run()).resolves.toBeUndefined();
    expect(github.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ref: oldSha, path: '.hypervibe/spec.json'}));
    const serverPath = path.join(baselineDirectory, 'hypervibe-server-release.json');
    const altered = JSON.parse(fs.readFileSync(serverPath, 'utf8')); altered.programFingerprint = 'b'.repeat(64); fs.writeFileSync(serverPath, JSON.stringify(altered));
    const manifestPath = path.join(baselineDirectory, API_RELEASE_EVIDENCE_FILE); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.serverEvidenceSha256 = createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.unlinkSync(path.join(workspace, 'checked'));
    await expect(run()).rejects.toThrow(/exact reviewed/);
    expect(fs.existsSync(path.join(workspace, 'checked'))).toBe(false);
  });

});
