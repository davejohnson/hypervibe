import '../providers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { resolveManagedWorkflowContract } from '../../domain/services/ci-deploy.service.js';
import { environmentDeploymentContractHash } from '../../domain/services/deployment-contract.service.js';
import { installReleaseEvidenceValidator, releaseEvidenceValidatorRequire } from '../../domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { buildGcpPromotionWorkflow, gcpCiReleaseScopes, prepareGcpPromotionPolicy, projectGcpPromotionUids } from '../gcp-promotion-workflow.js';
import { appliedCiPromotionPolicy, buildCiReleaseConfiguration } from '../../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import { RELEASE_SCRIPT } from '../../adapters/providers/gcp/gcp-ci-release-script.js';

const repository = 'acme/promoted-app'; const environment = 'production-gcp'; const gcp = 'target-project'; const region = 'us-central1';
const raw = { version: 1, project: 'promoted-app', gitRemoteUrl: `https://github.com/${repository}`,
  environments: {
    staging: { hosting: { provider: 'railway' }, services: { 'staging-web': { workloadKind: 'web' }, 'staging-worker': { workloadKind: 'worker' } }, deploy: { strategy: 'branch', branch: 'main' } },
    [environment]: { hosting: { provider: 'cloudrun', gcpProjectId: gcp }, services: { web: { workloadKind: 'web', healthCheckPath: '/health' }, worker: { workloadKind: 'worker' } },
      migrations: { mode: 'releaseCommand', command: 'npm run migrate' }, deploy: { strategy: 'branch', branch: 'main', autoDeploy: false, promoteFrom: 'staging', promotionTests: { workflow: '.github/workflows/test.yml', packageReadToken: true } } },
  } };
const spec = projectSpecSchema.parse(raw);
const documentSha = 'd'.repeat(40); const candidateSha = 'b'.repeat(40); const workflowSha = 'a'.repeat(40);
const repoIdentity = { id: 17, full_name: repository, default_branch: 'main' };
const manifest = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json"}');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = 'sha256:' + hash(manifest);
const image = `ghcr.io/${repository}@${digest}`;
const uids = { 'services/prod-web': '22222222-2222-4222-8222-222222222221', 'workerPools/prod-worker': '22222222-2222-4222-8222-222222222222', 'jobs/prod-migrate': '22222222-2222-4222-8222-222222222223' };
const policySha = '8'.repeat(40); const testsContent = 'on: workflow_call\njobs: {}\n';
const fixtureKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const copyVerificationKey = fixtureKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const connection = new CloudRunAdapter();
const sourcePath = '.github/workflows/deploy-railway-staging.yml';
const positive = { id: 61, event: 'workflow_dispatch', run_attempt: 2, head_branch: 'main', head_sha: workflowSha, status: 'completed', conclusion: 'success',
  run_started_at: '2026-04-05T10:00:00Z', updated_at: '2026-04-05T10:20:00Z', path: sourcePath, repository: repoIdentity, head_repository: repoIdentity };
const artifact = { id: 72, name: 'hypervibe-server-release-v4-staging-' + candidateSha, expired: false, created_at: '2026-04-05T10:10:00Z',
  workflow_run: { id: 61, head_branch: 'main', head_sha: workflowSha, repository_id: 17, head_repository_id: 17 } };
const attemptJobs = { total_count: 1, jobs: [{ id: 4, run_id: 61, run_attempt: 2, head_sha: workflowSha, name: 'deploy', status: 'completed', conclusion: 'success', started_at: positive.run_started_at, completed_at: positive.updated_at }] };
const req = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let dir: string;
beforeEach(async () => {
  await connection.connect({ projectId: gcp, credentials: JSON.stringify({ type: 'service_account', project_id: gcp, client_email: 'deploy@target-project.iam.gserviceaccount.com',
    private_key: fixtureKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-gcp-promotion-')); SqliteAdapter.resetInstance(); initializeDatabase(path.join(dir, 'test.db')); });
afterEach(() => { SqliteAdapter.resetInstance(); fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const project = new ProjectRepository().create({ name: spec.project, defaultPlatform: 'railway', gitRemoteUrl: raw.gitRemoteUrl });
  const envs = new EnvironmentRepository(); new SpecStore().replace(project, spec);
  const sourceBinding = { provider: 'railway', projectId: 'rail-project', environmentId: 'rail-stage', services: { 'staging-web': { serviceId: 'rail-web' }, 'staging-worker': { serviceId: 'rail-worker' } } };
  const staging = envs.create({ projectId: project.id, name: 'staging', platformBindings: sourceBinding });
  const source = resolveManagedWorkflowContract({ project, environmentName: 'staging', environmentSpec: spec.environments.staging! });
  if (!source.ok) throw new Error(source.error);
  const lock = { [sourcePath]: { inputHash: source.inputHash, contentHash: source.renderedContentHash, managedPaths: [sourcePath] } };
  const sourceBindings = { ...sourceBinding, ci: { deployBranch: lock } }; envs.updatePlatformBindings(staging.id, sourceBindings);
  const scopes = gcpCiReleaseScopes(spec, environment, gcp, () => undefined, policySha);
  const targetBindings = { provider: 'cloudrun', projectId: gcp, environmentId: region, services: { web: { serviceId: 'prod-web' }, worker: { workerPoolName: 'prod-worker' } },
    engine: { kind: 'opentofu', releaseJob: 'prod-migrate', ci: { repository, policySha, provider: 'projects/333/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@target-project.iam.gserviceaccount.com', trust: hash(JSON.stringify(['17', repository, scopes])) },
      promotion: { repositoryId: '17', copyVerificationKey, testsHash: hash(testsContent), contractHash: environmentDeploymentContractHash(spec, environment), uids } } };
  const target = envs.create({ projectId: project.id, name: environment, platformBindings: targetBindings });
  const definition = buildGcpPromotionWorkflow(project, spec, target); if ('blocked' in definition) throw new Error(definition.blocked);
  const workflow = YAML.parse(definition.policyContent); const stageWorkflow = source.workflow.content;
  const historical = structuredClone(spec); historical.environments.staging!.envVars = { OBSERVED: 'earlier' };
  const files = { '.github/workflows/test.yml': testsContent, '.hypervibe/spec.json': JSON.stringify(spec), '.hypervibe/bindings.json': JSON.stringify({ environments: { staging: { platformBindings: sourceBindings }, [environment]: { platformBindings: targetBindings } } }), [sourcePath]: stageWorkflow };
  const listWorkflowRuns = vi.fn(async (_request: { page: number }) => ({ data: { total_count: 1, workflow_runs: [positive] } }));
  const github = { rest: {
    repos: { get: async () => ({ data: repoIdentity }), getContent: vi.fn(async ({ path: filename, ref }: { path: keyof typeof files; ref: string }) => {
      const value = filename === '.hypervibe/spec.json' && ref === candidateSha ? JSON.stringify(historical) : files[filename];
      return { data: { path: filename, type: 'file', encoding: 'base64', content: Buffer.from(value).toString('base64'), size: Buffer.byteLength(value) } };
    }), compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => ({ data: { status: 'ahead', base_commit: { sha: basehead.split('...')[0] }, merge_base_commit: { sha: basehead.split('...')[0] } } }) },
    actions: { listWorkflowRuns, getWorkflowRun: vi.fn(async () => ({ data: positive })), listWorkflowRunArtifacts: vi.fn(async () => ({ data: { total_count: 1, artifacts: [artifact] } })), listJobsForWorkflowRunAttempt: async () => ({ data: attemptJobs }) },
    git: { getRef: async () => ({ data: { ref: 'refs/heads/main', object: { type: 'commit', sha: documentSha } } }) },
  } };
  // Run the actual managed Railway producer. The promotion selects and downloads these bytes by artifact and run ID.
  const stage = YAML.parse(stageWorkflow).jobs.deploy.steps.find((step: { name?: string }) => step.name === 'Write server release evidence');
  const validator = installReleaseEvidenceValidator(stageWorkflow, dir);
  let evidenceText = '';
  const stageRequire = releaseEvidenceValidatorRequire(validator, { writeFileSync: (_file, data) => { evidenceText = data; } });
  new Function('require', 'process', stage.with.script)(stageRequire, { env: { ...stage.env, HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath,
    HYPERVIBE_RELEASE_SHA: candidateSha, GITHUB_REPOSITORY: repository, HYPERVIBE_RELEASE_IMAGE_URI: image,
    HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: environmentDeploymentContractHash(historical, 'staging'), HYPERVIBE_CREDENTIAL_OPERATIONS: '{}', HYPERVIBE_CREDENTIAL_DEPLOYMENTS: '[]' } });
  const downloadDir = path.join(dir, 'staging-release'); fs.mkdirSync(downloadDir);
  const execute = async (step: { with: { script: string } }, env: Record<string, string>, requireFn: (name: string) => unknown = req) => {
    const output: Record<string, string> = {};
    const context = { sha: documentSha, repo: { owner: 'acme', repo: 'promoted-app' }, eventName: 'workflow_dispatch', ref: 'refs/heads/main' };
    await new AsyncFunction('require', 'process', 'github', 'context', 'core', step.with.script)(requireFn, { env: { ...workflow.env, RUNNER_TEMP: dir, ...env } }, github, context, { setOutput: (k: string, v: string) => { output[k] = v; } });
    return output;
  };
  const evidence = JSON.parse(evidenceText);
  const select = async (job: 'candidate' | 'release' = 'candidate', tested?: string) => {
    const [selectStep, download, verify] = workflow.jobs[job].steps;
    const outputs = await execute(selectStep, {});
    expect(download.with['run-id']).toEqual('${{ steps.staged.outputs.run }}'); expect(outputs.run).toBe(String(positive.id));
    expect(download.with['artifact-ids']).toEqual('${{ steps.staged.outputs.artifact }}'); expect(outputs.artifact).toBe(String(artifact.id));
    fs.writeFileSync(path.join(downloadDir, 'hypervibe-server-release.json'), JSON.stringify(evidence));
    return (await execute(verify, { SELECTION: outputs.selection!, ...(tested && { TESTED: tested }) })).candidate!;
  };
  return { github, workflow, select, execute, definition, project, target, targetBindings, evidence, envs, files };
}

describe('production promotion from a managed Railway staging release', () => {
  it('admits the real staging gate for a Google Cloud production plan and refuses unevidenced sources on all engines', () => {
    expect(engineEnvironmentProblems(spec, environment)).toEqual([]);
    for (const provider of ['cloudrun', 'aws', 'azure']) {
      const other = structuredClone(spec); other.environments.staging!.hosting.provider = provider;
      expect(engineEnvironmentProblems(other, environment).join(' ')).toContain('Railway staging workflow');
    }
    for (const provider of ['aws', 'azure']) { const other = structuredClone(spec); other.environments[environment]!.hosting.provider = provider;
      expect(engineEnvironmentProblems(other, environment).join(' ')).toContain('deploy.promoteFrom'); }
    expect(hash(RELEASE_SCRIPT)).toBe('46e1cded043faa2bc92ddf89f325ddcd6b40e19f45cc98746a138d2462319e72');
  });
  it('runs the reusable tests at the staged application SHA, then reacquires the same release before cloud access', async () => {
    const { workflow, select, github } = fixture();
    expect(workflow.on).toEqual({ workflow_call: { secrets: { NODE_AUTH_TOKEN: { required: true } } } }); expect(workflow.jobs.release.environment).toEqual(environment);
    expect(workflow.jobs.candidate.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.promotion_tests).toMatchObject({ needs: 'candidate', uses: './.github/workflows/test.yml', with: { commit_sha: '${{ needs.candidate.outputs.sha }}' },
      permissions: { contents: 'read' }, secrets: { NODE_AUTH_TOKEN: '${{ secrets.NODE_AUTH_TOKEN }}' } });
    expect(workflow.jobs.release.needs).toEqual(['candidate', 'promotion_tests']); expect(workflow.jobs.release.steps[3].id).toBe('auth');
    const tested = await select(); expect(await select('release', tested)).toEqual(tested);
    expect(JSON.parse(tested)).toEqual({ source: { environment: 'staging', sha: candidateSha, runId: 61, runAttempt: 2, artifactId: 72 },
      deployments: ['web', 'worker'].map(name => ({ name, sourceImage: image, image: `${region}-docker.pkg.dev/${gcp}/hypervibe/${environment}-${name}@${digest}` })) });
    expect(github.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(4);
    await expect(select('release', tested.replace(candidateSha, documentSha))).rejects.toThrow(/Staging changed/);
  });
  it('refuses an older artifact left on a retried run, an untrusted producer and a stale or partial release', async () => {
    const { select, github, evidence } = fixture();
    github.rest.actions.listWorkflowRunArtifacts.mockResolvedValueOnce({ data: { total_count: 1, artifacts: [{ ...artifact, created_at: '2026-04-04T10:00:00Z' }] } });
    await expect(select()).rejects.toThrow(/exactly one/);
    github.rest.actions.getWorkflowRun.mockResolvedValueOnce({ data: { ...positive, event: 'pull_request' } });
    await expect(select()).rejects.toThrow(/producer/);
    github.rest.actions.listWorkflowRuns.mockResolvedValueOnce({ data: { total_count: 1, workflow_runs: [{ ...positive, status: 'in_progress' }] } });
    await expect(select()).rejects.toThrow(/latest staging/);
    evidence.target.resources[0].imageUri = 'ghcr.io/acme/other@' + digest; await expect(select()).rejects.toThrow(/immutable image/);
    evidence.target.resources.pop(); await expect(select()).rejects.toThrow(/immutable image/);
  });
  it('finds the latest attempt even when an old run was retried on a later page, without inspecting every run', async () => {
    const { select, github } = fixture();
    const previous = Array.from({ length: 100 }, (_, index) => ({ ...positive, id: 100 + index, run_attempt: 1,
      run_started_at: new Date(Date.UTC(2026, 0, 1, index)).toISOString(), updated_at: new Date(Date.UTC(2026, 0, 1, index, 2)).toISOString() }));
    github.rest.actions.listWorkflowRuns.mockImplementation(async ({ page }) => ({ data: { total_count: 101, workflow_runs: page === 1 ? previous : [positive] } }));
    expect(JSON.parse(await select()).source.runId).toBe(positive.id);
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(github.rest.actions.getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledTimes(1);
  });
  it('does not grant an older workflow with the same display name, path and branch authority over the current release', () => {
    const { definition } = fixture();
    const policy = '8'.repeat(40);
    const caller = YAML.parse(definition.content);
    expect(caller.jobs.promote?.uses).toBe(`${repository}/.github/workflows/hypervibe-promote-${environment}.yml@${policy}`);
    const releases = [{ environmentName: environment, branch: 'main', autoDeploy: false, promotionSource: 'staging', policySha: policy }];
    const config = buildCiReleaseConfiguration({ projectId: gcp, projectNumber: '333', repository, repositoryId: '17', releases, runtimeServiceAccountEmail: `runtime@${gcp}.iam.gserviceaccount.com` });
    const fields = JSON.stringify(config.files);
    expect(fields).toContain(`assertion.job_workflow_ref == '${caller.jobs.promote.uses}'`);
    expect(fields).toContain(`assertion.job_workflow_sha == '${policy}'`);
  });
  it('first publishes the isolated policy, pins its reviewed commit in a second publication and retains that pin across app commits', async () => {
    const { definition, workflow } = fixture();
    const contract = JSON.parse(Buffer.from(workflow.env.HV_PROMOTION, 'base64').toString());
    const head = '3'.repeat(40); const updated = '4'.repeat(40); const published = new Map<string, string>();
    const file = async (path: string, sha: string) => published.get(sha + '/' + path) ?? null;
    const prepare = (sha: string) => prepareGcpPromotionPolicy(contract, { head: sha, file }, dir);
    expect(await prepare(policySha)).toHaveProperty('blocked', expect.stringContaining(definition.policyPath));
    expect(fs.readFileSync(path.join(dir, definition.policyPath), 'utf8')).toBe(definition.policyContent);
    expect(fs.existsSync(path.join(dir, definition.path))).toBe(false);
    published.set(policySha + '/' + definition.policyPath, definition.policyContent);
    published.set(policySha + '/' + contract.tests.workflow, testsContent);
    expect(await prepare(policySha)).toHaveProperty('blocked', expect.stringContaining(definition.path));
    const caller = fs.readFileSync(path.join(dir, definition.path), 'utf8');
    expect(YAML.parse(caller).jobs.promote.uses).toBe(repository + '/' + definition.policyPath + '@' + policySha);
    for (const sha of [head, updated]) {
      published.set(sha + '/' + definition.policyPath, definition.policyContent); published.set(sha + '/' + definition.path, caller);
      published.set(sha + '/' + contract.tests.workflow, testsContent);
      expect(await prepare(sha)).toEqual({ policySha });
    }
    published.set(policySha + '/' + contract.tests.workflow, 'unreviewed tests from an older commit');
    expect(await prepare(updated)).toHaveProperty('blocked', expect.stringContaining(definition.path));
    expect(fs.readFileSync(path.join(dir, definition.path), 'utf8')).toContain('@' + updated);
  });
  it('requires an exact immutable policy and refuses a stale or incomplete copy in the published bindings', async () => {
    const { select, definition, files } = fixture();
    const releases = [{ environmentName: environment, branch: 'main', autoDeploy: false, promotionSource: 'staging' }];
    const config = { projectId: gcp, projectNumber: '333', repository, repositoryId: '17', releases, runtimeServiceAccountEmail: `runtime@${gcp}.iam.gserviceaccount.com` };
    expect(() => buildCiReleaseConfiguration(config)).toThrow(/exact published/);
    expect(YAML.parse(definition.content).jobs.promote).not.toHaveProperty('with');
    const bindings = JSON.parse(files['.hypervibe/bindings.json']);
    bindings.environments[environment].platformBindings.engine.migration = { copyAttempt: { status: 'incomplete', id: '5e40de40-de40-4e40-8e40-de40de40de40' } };
    files['.hypervibe/bindings.json'] = JSON.stringify(bindings);
    await expect(select()).rejects.toThrow(/completed migration copy/);
    files['.github/workflows/test.yml'] += '# changed after approval';
    await expect(select()).rejects.toThrow(/required tests changed/);
  });
  it('refuses a fabricated completed database copy in mutable repository bindings before any cloud access', async () => {
    const { select, files } = fixture();
    const bindings = JSON.parse(files['.hypervibe/bindings.json']);
    bindings.environments[environment].platformBindings.engine.migration = { database: { match: true },
      copyAttempt: { id: 'de40de40-de40-4e40-8e40-de40de40de40', status: 'complete', startedAt: '2026-04-05T09:00:00Z' },
      copiedAt: '2026-04-05T09:30:00.000Z', promotionCopySignature: Buffer.alloc(256, 1).toString('base64') };
    files['.hypervibe/bindings.json'] = JSON.stringify(bindings);
    await expect(select()).rejects.toThrow(/signature/);
  });
  it('accepts a deployment connection signature only on its verified database, job and copy', async () => {
    const { select, files } = fixture();
    const id = 'de40de40-de40-4e40-8e40-de40de40de40'; const copiedAt = '2026-04-05T09:30:00.000Z';
    const bindings = JSON.parse(files['.hypervibe/bindings.json']);
    const migration = { database: { match: false }, copyAttempt: { id, status: 'complete', startedAt: '2026-04-05T09:00:00Z' }, copiedAt,
      promotionCopySignature: connection.signVerifiedPromotionCopy({ repository, environment, gcpProjectId: gcp, region, job: 'prod-migrate', copyAttemptId: id, copiedAt }) };
    bindings.environments[environment].platformBindings.engine.migration = migration;
    const publish = () => { files['.hypervibe/bindings.json'] = JSON.stringify(bindings); };
    expect(connection.promotionCopyPublicKey(gcp)).toBe(copyVerificationKey);
    publish(); await expect(select()).rejects.toThrow(/matching database copy/);
    migration.database.match = true;
    publish(); expect(JSON.parse(await select()).copyAttemptId).toBe(id);
    migration.copyAttempt.id = '12341234-1234-4234-8234-123412341234';
    publish(); await expect(select()).rejects.toThrow(/signature/);
    expect(() => connection.signVerifiedPromotionCopy({ repository, environment, gcpProjectId: 'other-project', region, job: 'prod-migrate', copyAttemptId: id, copiedAt })).toThrow(/connected/);
  });
  it('rejects a reverted private provider binding even when repository bindings claim the current access grant', () => {
    const { definition } = fixture();
    const releases = gcpCiReleaseScopes(spec, environment, gcp, () => undefined, policySha);
    const configuration = buildCiReleaseConfiguration({ projectId: gcp, projectNumber: '333', repository, repositoryId: '17', releases, runtimeServiceAccountEmail: `runtime@${gcp}.iam.gserviceaccount.com` });
    const resource = (configuration.files['ci-release.tf.json'] as { resource: Record<string, Record<string, any>> }).resource.google_iam_workload_identity_pool_provider!.ci_github;
    const row = { type: 'google_iam_workload_identity_pool_provider', mode: 'managed', address: 'google_iam_workload_identity_pool_provider.ci_github',
      values: { ...resource, name: definition.provider } };
    const state = { values: { root_module: { resources: [row] } } };
    expect(appliedCiPromotionPolicy(state, configuration, definition.provider)).toBe(true);
    row.values.attribute_condition = `assertion.repository == '${repository}'`;
    expect(appliedCiPromotionPolicy(state, configuration, definition.provider)).toBe(false);
  });
  it('prevents another project or workflow from acquiring protected production credentials', () => {
    const separate = structuredClone(spec); separate.environments.gcp = { ...spec.environments[environment]!, hosting: { provider: 'cloudrun' }, deploy: { strategy: 'branch', branch: 'dev' } };
    const releases = gcpCiReleaseScopes(separate, environment, gcp, () => 'stage-project', policySha);
    expect(releases).toHaveLength(1); expect(releases[0]).toMatchObject({ environmentName: environment, branch: 'main', autoDeploy: false });
    const access = buildCiReleaseConfiguration({ projectId: gcp, projectNumber: '333', repository, repositoryId: '17', releases, runtimeServiceAccountEmail: `runtime@${gcp}.iam.gserviceaccount.com` });
    expect(JSON.stringify(access.files)).toContain("assertion.job_workflow_sha == '" + policySha + "'");
    expect(gcpCiReleaseScopes(separate, 'gcp', 'stage-project', () => gcp)).toEqual([{ environmentName: 'gcp', branch: 'dev', autoDeploy: true }]);
    expect(() => gcpCiReleaseScopes(separate, environment, gcp, () => gcp)).toThrow(/separate Google Cloud project/);
  });
  it('requires the retained provider UID at the exact managed resource address and kind, including migrations', () => {
    const { definition } = fixture();
    const resources = [ ['service', 'web', 'services/prod-web'], ['worker_pool', 'worker', 'workerPools/prod-worker'], ['job', 'release_command', 'jobs/prod-migrate'] ].map(([suffix, key, id]) => ({
      address: `google_cloud_run_v2_${suffix}.${key}`, type: `google_cloud_run_v2_${suffix}`, mode: 'managed', values: { id: `projects/${gcp}/locations/${region}/${id}`, uid: uids[id as keyof typeof uids] },
    }));
    const state = { values: { root_module: { resources } } };
    expect(projectGcpPromotionUids(state, gcp, region, definition.services, 'prod-migrate')).toEqual(uids);
    resources[1]!.values.id = 'projects/other/locations/us-central1/workerPools/prod-worker';
    expect(() => projectGcpPromotionUids(state, gcp, region, definition.services, 'prod-migrate')).toThrow(/retained Cloud Run/);
  });
  it.each(['success', 'changed manifest', 'failed migration', 'recreated worker', 'split traffic', 'changed migration command', 'changed after patch', 'retry succeeded migration', 'second container after patch', 'retry after failed rollout', 'lost acknowledgment', 'lost and unproven', 'migration after final copy', 'execution predates copy', 'unproven task retry policy', 'lost acknowledgment then restaged digest'] as const)('executes the generated registry copy, migration and Cloud Run release (%s)', async mode => {
    const { select, execute, workflow, definition, files } = fixture();
    let candidate = await select();
    const canonicalImage = (service: string) => `${region}-docker.pkg.dev/${gcp}/hypervibe/${environment}-${service}@${digest}`;
    const workloads = Object.fromEntries(Object.entries(uids).map(([short, uid]) => {
      const name = `projects/${gcp}/locations/${region}/${short}`; const [kind, resource] = short.split('/');
      const revision = resource + '-00001';
      const containers = [{ image: 'before', ...(kind === 'jobs' && { command: ['/bin/sh'], args: ['-lc', mode === 'changed migration command' ? 'old command' : 'npm run migrate'] }), env: [{ name: 'SETTING', value: 'keep' }] }];
      return [name, { name, uid: mode === 'recreated worker' && kind === 'workerPools' ? 'replaced' : uid,
        etag: 'observed-etag', generation: '3', observedGeneration: '3', terminalCondition: { state: 'CONDITION_SUCCEEDED' },
        latestReadyRevision: name + '/revisions/' + revision, latestCreatedRevision: revision,
        ...(kind === 'services' && { trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: mode === 'split traffic' ? 90 : 100, revision }], uri: 'https://web.example.test' }),
        ...(kind === 'workerPools' && { instanceSplitStatuses: [{ type: 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST', percent: 100, revision }] }),
        template: kind === 'jobs' ? { taskCount: 1, template: { ...(mode !== 'unproven task retry policy' && { maxRetries: 0 }), containers } } : { containers } }];
    }));
    if (mode === 'execution predates copy') {
      const selected = JSON.parse(candidate);
      candidate = JSON.stringify({ ...selected, copyAttemptId: 'de40de40-de40-4e40-8e40-de40de40de40', copiedAt: '2026-04-05T12:30:00Z' });
    }
    const location = path.join(dir, 'provider.json'); fs.writeFileSync(location, JSON.stringify({ workloads, events: [], migrationFails: mode === 'failed migration', raceCommand: mode === 'changed after patch', raceContainer: mode === 'second container after patch',
      failRollout: mode === 'retry after failed rollout', loseResponse: mode === 'lost acknowledgment' || mode === 'lost acknowledgment then restaged digest', lostUnproven: mode === 'lost and unproven' }));
    const fixtureFile = fileURLToPath(new URL('../../../test/fixtures/gcp-promotion/cloud-run.mjs', import.meta.url));
    const copies: string[][] = [];
    const command = (binary: string, args: string[], options: { env: Record<string, string>; input?: string }) => {
      if (binary === process.execPath) return execFileSync(binary, ['--import', fixtureFile, ...args], { env: { ...options.env, HV_FIXTURE: location }, stdio: 'pipe' });
      expect(binary).toBe('skopeo');
      if (args[0] === 'login') { expect(args).toContain('--password-stdin'); expect(args).not.toContain(options.input); return Buffer.alloc(0); }
      if (args[0] === 'inspect') { expect(args).toContain('--raw'); return mode === 'changed manifest' ? Buffer.from('rewritten') : manifest; }
      expect(args).toContain('--all'); expect(args).toContain('--preserve-digests'); expect(args[args.length - 2]).toBe('docker://' + image); copies.push(args);
      fs.writeFileSync(args[args.indexOf('--digestfile') + 1]!, digest); return Buffer.alloc(0);
    };
    const step = workflow.jobs.release.steps[4];
    const effect = (dispatch = '91') => execute(step, { HV_DEPLOY: step.env.HV_DEPLOY, RELEASE_PROGRAM: step.env.RELEASE_PROGRAM, CANDIDATE: candidate,
      GCP_TOKEN: 'fixture-google-token', GH_PACKAGES_TOKEN: 'fixture-github-token', GITHUB_ACTOR: 'runner', PATH: process.env.PATH!, GITHUB_SHA: documentSha, GITHUB_RUN_ID: dispatch, GITHUB_RUN_ATTEMPT: '1' },
    name => name === 'node:child_process' ? { execFileSync: command } : req(name));
    if (['success', 'retry succeeded migration', 'migration after final copy'].includes(mode)) await effect(); else await expect(effect()).rejects.toThrow();
    if (['retry succeeded migration', 'retry after failed rollout', 'lost acknowledgment', 'lost and unproven', 'migration after final copy', 'lost acknowledgment then restaged digest'].includes(mode)) {
      if (mode === 'lost acknowledgment then restaged digest') {
        const selected = JSON.parse(candidate);
        selected.source.runId += 30; selected.source.runAttempt = 1; selected.source.artifactId += 20;
        candidate = JSON.stringify(selected);
      }
      if (mode === 'migration after final copy') {
        const bindings = JSON.parse(files['.hypervibe/bindings.json']);
        const id = 'de40de40-de40-4e40-8e40-de40de40de40'; const copiedAt = '2026-04-05T09:30:00.000Z';
        const signature = connection.signVerifiedPromotionCopy({ repository, environment, gcpProjectId: gcp, region, job: 'prod-migrate', copyAttemptId: id, copiedAt });
        bindings.environments[environment].platformBindings.engine.migration = { database: { match: true }, copyAttempt: { id, status: 'complete',
          startedAt: '2026-04-05T09:00:00Z' }, copiedAt, promotionCopySignature: signature };
        files['.hypervibe/bindings.json'] = JSON.stringify(bindings);
        candidate = await select();
        expect(JSON.parse(candidate).copyAttemptId).toBe('de40de40-de40-4e40-8e40-de40de40de40');
      }
      if (mode === 'lost and unproven') await expect(effect('93')).rejects.toThrow(); else await effect('93');
      const retried = JSON.parse(fs.readFileSync(location, 'utf8'));
      expect(retried.events.filter((event: string) => event === 'run migrations')).toHaveLength(mode === 'migration after final copy' ? 2 : 1);
      if (mode !== 'lost and unproven') {
        const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'promotion.json'), 'utf8'));
        expect(receipt.migration.copyAttemptId).toBe(JSON.parse(candidate).copyAttemptId); expect(receipt.runId).toBe(93);
      }
      return;
    }
    const result = JSON.parse(fs.readFileSync(location, 'utf8'));
    const writes = result.events.filter((e: string) => !e.startsWith('get'));
    const receiptPath = path.join(dir, 'promotion.json');
    if (mode === 'success') {
      expect(copies).toHaveLength(2); expect(writes).toEqual(['patch prod-migrate', 'reserve migration', 'run migrations', 'patch prod-web', 'health /health', 'patch prod-worker']);
      expect(result.workloads[`projects/${gcp}/locations/${region}/jobs/prod-migrate`].template.template.containers[0].image).toEqual(canonicalImage('web'));
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      expect(receipt).toEqual({ version: 1, repository, environment, runId: 91, runAttempt: 1, workflowSha: documentSha, source: JSON.parse(candidate).source,
        gcpProjectId: gcp, region, migration: { key: expect.stringMatching(/^[a-f0-9]{64}$/), jobUid: uids['jobs/prod-migrate'], image: canonicalImage('web'),
          execution: `projects/${gcp}/locations/${region}/jobs/prod-migrate/executions/prod-migrate-1`, executionUid: '44444444-4444-4444-8444-000000000001', completedAt: '2026-04-05T10:00:00Z' },
        services: definition.services.map(({ name, kind, resource, uid }) => ({ name, kind, resource, uid, image: canonicalImage(name) })) });
    } else {
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(writes).toEqual(mode === 'failed migration' || mode === 'execution predates copy' ? ['patch prod-migrate', 'reserve migration', 'run migrations'] : mode === 'changed after patch' || mode === 'second container after patch' ? ['patch prod-migrate'] : []);
      if (mode === 'recreated worker' || mode === 'split traffic' || mode === 'changed migration command') expect(copies).toHaveLength(0);
    }
  }, 30_000);

});
