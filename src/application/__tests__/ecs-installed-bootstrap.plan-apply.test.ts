import { createRequire } from 'node:module';
import * as ecs from '@aws-sdk/client-ecs';
import * as managedCi from '../../domain/services/managed-ci.service.js';
import * as ciDeploy from '../../domain/services/ci-deploy.service.js';
import { buildEcsExpressGitHubActionsSteps } from '../../adapters/providers/aws/ecs-express-ci.workflow.js';
import { extractGitHubScript } from '../../domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { buildBranchDeployWorkflow, resolveBranchDeployTargets } from '../../domain/services/github-ops.service.js';
import { applySecretReference, assertDeploymentSecretReferences } from '../apply-secret-references.js';
import { orderActions } from '../../domain/plan/converge.executor.js';
import { GitHubAdapter } from '../../adapters/providers/github/github.adapter.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { EcsExpressAdapter } from '../../adapters/providers/aws/ecs-express.adapter.js';
import { ecsTransientFixture, accountId, region } from '../../adapters/providers/aws/__tests__/ecs-transient.fixture.js';
import { awsDeploymentNames } from '../../adapters/providers/aws/aws-cloud-deployment.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { resolveReviewedBranchDeployTargets } from '../../domain/services/managed-ci-targets.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import '../providers.js';

// Actual SQLite, PlanService, apply, orchestrator and AWS SDK serialization.
// Only credential/client construction and the HTTP transport are injected.
// Independent native bootstrap state below is not copied from Create requests.
// AWS resolves native secrets when a task starts, so an inert first image must
// receive neither application secrets nor the final task role:
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-ecs-first-app-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'app', defaultPlatform: 'ecs', gitRemoteUrl: 'https://github.com/example/app.git' });
  const wire = ecsTransientFixture(false, true), names = awsDeploymentNames(wire.input.connection), clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${names.clusterName}`;
  const serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web', lifetime = '2023-11-14T22:13:20.000Z';
  const load = () => ctx.repos.environments.findByProjectAndName(project.id, 'production')!;
  const tags = () => [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: load().id },
    { key: 'hypervibe-owner', value: 'd'.repeat(64) }, { key: 'hypervibe-installation', value: wire.input.connection.installationId }];
  const state = { cluster: false, hideService: false, currentTask: undefined as any, registeredTask: undefined as any, changedLifetime: false, deniedTask: false, loseRelease: false }, operations: string[] = [];
  const json = (body: unknown) => ({ response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(body)) } });
  const xml = (body: string) => ({ response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(body) } });
  const bootstrap = { image: 'public.ecr.aws/docker/library/node:24-alpine', containerPort: 8080,
    command: ['node', '-e', "require('http').createServer((_,res)=>{res.writeHead(200);res.end('hypervibe bootstrap')}).listen(8080)"], environment: [], secrets: [] };
  const handler = { handle: async (request: any) => {
    const raw = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8');
    const query = new URLSearchParams(raw), operation = query.get('Action') ?? request.headers['x-amz-target']?.split('.').at(-1); operations.push(operation);
    const body = raw.startsWith('{') ? JSON.parse(raw) : {};
    if (operation === 'RegisterTaskDefinition') { state.registeredTask = { ...body, taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:2`, revision: 2, status: 'ACTIVE' }; return json({ taskDefinition: state.registeredTask }); }
    if (operation === 'UpdateExpressGatewayService') { state.currentTask = structuredClone(state.registeredTask); if (state.loseRelease) throw new Error('Synthetic lost release acknowledgment'); return json({ service: { serviceArn } }); }
    if (operation === 'DescribeTaskDefinition' && state.deniedTask) return { response: { statusCode: 403, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify({ __type: 'AccessDeniedException', message: 'Denied' })) } };
    if (operation === 'DescribeTaskDefinition' && state.currentTask) return json({ taskDefinition: state.currentTask });
    if (operation === 'DescribeTaskDefinition' && state.registeredTask?.taskDefinitionArn === body.taskDefinition) return json({ taskDefinition: state.registeredTask });
    if (operation === 'ListClusters') return json({ clusterArns: state.cluster ? [clusterArn] : [] });
    if (operation === 'CreateCluster') { state.cluster = true; return json({ cluster: { clusterArn } }); }
    if (operation === 'DescribeClusters') return json(state.cluster ? { clusters: [{ clusterArn, clusterName: names.clusterName, status: 'ACTIVE', tags: tags() }], failures: [] } : { clusters: [], failures: [{ arn: clusterArn, reason: 'MISSING' }] });
    if (operation === 'DescribeRepositories') return json({ repositories: [{ repositoryName: `hypervibe/${names.clusterName}`, repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/hypervibe/${names.clusterName}`, repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/hypervibe/${names.clusterName}`, createdAt: 1_700_000_000 }] });
    if (operation === 'ListTagsForResource') return json({ tags: tags().map(t => ({ Key: t.key, Value: t.value })) });
    if (operation === 'DescribeSecurityGroups') return xml(`<DescribeSecurityGroupsResponse><securityGroupInfo><item><groupId>sg-1</groupId><groupName>${names.clusterName}-hypervibe-workloads</groupName><vpcId>vpc-1</vpcId><tagSet>${[...tags(), { key: 'hypervibe-ecs-cluster-arn', value: clusterArn }].map(t => `<item><key>${t.key}</key><value>${t.value}</value></item>`).join('')}</tagSet></item></securityGroupInfo></DescribeSecurityGroupsResponse>`);
    if (operation === 'ListServices') return json({ serviceArns: wire.state.created && !state.hideService ? [serviceArn] : [] });
    if (operation === 'DescribeExpressGatewayService') return json({ service: { serviceArn, serviceName: 'web', cluster: clusterArn, createdAt: 1_700_000_000 + (state.changedLifetime ? 1 : 0), tags: tags(), currentDeployment: state.currentTask ? 'revision-2' : 'revision-1', status: { statusCode: 'ACTIVE' },
      activeConfigurations: [{ serviceRevisionArn: state.currentTask ? 'revision-2' : 'revision-1', executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, taskDefinitionArn: state.currentTask?.taskDefinitionArn ?? `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`, primaryContainer: state.currentTask?.containerDefinitions[0] ?? bootstrap, networkConfiguration: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'] }, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }] }] } });
    if (operation === 'DescribeTaskDefinition') return json({ taskDefinition: { taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`, family: 'fixture', revision: 1, status: 'ACTIVE', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, containerDefinitions: [{ name: 'Main', ...bootstrap, portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }] }] } });
    return wire.handler.handle(request);
  } };
  const adapter = new EcsExpressAdapter(); await adapter.connectTransient(wire.input, { requestHandler: handler });
  // Verified connection selection is a fixture input; native authentication and
  // each project/service/runtime observation still execute on the real adapter.
  ctx.repos.connections.upsertVerifiedBatch([{ provider: 'ecs', scope: 'github.com/example/app', credentialsEncrypted: ctx.secretStore.encryptObject({ fixture: 'synthetic-transient-selection' }) }]);
  vi.spyOn(providerRegistry, 'createAdapter').mockImplementation(async provider => { if (provider !== 'ecs') throw new Error('Unexpected provider'); return adapter; });
  const store = new SpecStore(); store.replace(project, { version: 1, project: 'app', gitRemoteUrl: project.gitRemoteUrl,
    secrets: { API_KEY: { ownership: 'delegated', principal: 'email:contributor@example.test', environments: ['production'], required: true } },
    environments: { production: { hosting: { provider: 'ecs', region }, email: { enabled: false }, envFile: { mode: 'off' }, deploy: { strategy: 'manual' },
      envVars: { APPLICATION_SECRET: 'synthetic-first-application-value' }, secretDestinations: { API_KEY: wire.reference }, services: { web: { workloadKind: 'web', public: true } } } } });
  const plan = () => new PlanService().plan(project, 'production');
  const apply = (planId: string, confirmActions: string[]) => { const current = store.get(project)!; return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions }); };
  return { ctx, project, wire, state, handler, adapter, store, load, plan, apply, operations, serviceArn, lifetime, clusterArn };
}
async function createBootstrap(f: Awaited<ReturnType<typeof fixture>>) {
  for (let phase = 0; phase < 5 && !f.wire.state.created; phase++) {
    const p = await f.plan(); if ('error' in p) throw new Error(p.error);
    await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
  }
  expect(f.wire.state.created).toBeDefined();
}
async function managedRelease(f: Awaited<ReturnType<typeof fixture>>, options: { denyRelease?: boolean } = {}) {
  const spec = f.store.get(f.project)!.spec;
  spec.environments.production.deploy = { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false };
  spec.devops = { code: { provider: 'github', scope: 'example/app' }, ci: { provider: 'github-actions' } } as never;
  f.store.replace(f.project, spec);
  f.ctx.repos.connections.upsertVerifiedBatch([{ provider: 'github', scope: 'example/app', credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'synthetic-github-token', login: 'example' }) }]);
  vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' } as never);
  // The GitHub planning/execution port is synthetic here; the actual application
  // plan/executor and emitted AWS release execute against one native SDK fixture.
  // GitHub workflow/provenance transport is covered by its independent CI suites.
  vi.spyOn(managedCi, 'planManagedCiDeploy').mockResolvedValue({ actions: [], warnings: [] });
  vi.spyOn(managedCi, 'planManagedCiAppliedSpecHash').mockImplementation(async input => ({ actions: [{
    id: 'ci:github-actions:production:applied-spec-hash', type: 'update', verified: true,
    resource: { kind: 'ci', name: 'applied-spec-hash:production', provider: 'github' }, reason: 'Synthetic accepted GitHub contract',
    dependsOn: input.dependsOn, metadata: { operation: 'githubActionsAppliedSpecHash', repository: 'example/app', environmentName: 'production', desiredHash: 'a'.repeat(64) },
  }], warnings: [] }));
  vi.spyOn(ciDeploy, 'planGitHubActionsRelease').mockImplementation(async input => ({ action: {
    id: 'ci:github-actions:production:release', type: 'update', verified: true,
    resource: { kind: 'ci', name: 'release:production', provider: 'github' }, reason: 'Synthetic exact managed release',
    dependsOn: input.dependsOn, metadata: { operation: 'githubActionsRelease', targetSha: 'b'.repeat(40), repository: 'example/app', environmentName: 'production', workflow: '.github/workflows/deploy-ecs-production.yml', ref: 'main', workflowInputHash: 'a'.repeat(64), workflowContentHash: 'c'.repeat(64) },
  }, warnings: [] }));
  const sequence: string[] = [];
  vi.spyOn(ciDeploy, 'applyGitHubActionsAppliedSpecHash').mockImplementation(async () => { sequence.push('marker'); return { success: true, message: 'Synthetic marker acknowledged' }; });
  vi.spyOn(ciDeploy, 'applyGitHubActionsRelease').mockImplementation(async () => {
    sequence.push('release');
    if (options.denyRelease) return { success: false, status: 'blocked', message: 'Synthetic CI authorization denied' };
    const [target] = resolveReviewedBranchDeployTargets(f.project, f.store.get(f.project)!.spec).targets;
    target.deploymentAccess = { origin: 'https://hypervibe.dev', projectId: 'app', connectionId: f.wire.input.connection.installationId,
      environment: 'production', sourceBranch: 'main', connection: f.wire.input.connection };
    const script = extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + buildEcsExpressGitHubActionsSteps(target).steps, 'Release exact digest to bound ECS Express services');
    const nativeRequire = createRequire(import.meta.url);
    const require = (name: string) => name === '@aws-sdk/client-ecs' ? { ...ecs, ECSClient: class extends ecs.ECSClient {
      constructor(config: any) { super({ ...config, requestHandler: f.handler }); }
    } } : nativeRequire(name);
    const source = JSON.stringify(f.store.get(f.project)!.spec);
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64'), size: Buffer.byteLength(source) } }) } } };
    const env = { AWS_ECS_CLUSTER_ARN: f.clusterArn, AWS_ECS_EXPRESS_SERVICE_ARNS_JSON: JSON.stringify([f.serviceArn]),
      IMAGE_URI: `${accountId}.dkr.ecr.${region}.amazonaws.com/hypervibe/image@sha256:${'e'.repeat(64)}`, DEPLOY_SHA: 'b'.repeat(40) };
    const fetch = async (url: string) => String(url).startsWith('https://app.example.test') ? new Response('ok') : Response.json({ kind: 'aws-sts',
      principal: f.wire.input.connection.principals.release, accessKeyId: 'ASIA' + '2'.repeat(17), secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900_000).toISOString() });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('require', 'process', 'fetch', 'core', 'github', 'context', script)(require, { env }, fetch,
      { getIDToken: async () => 'synthetic-oidc', setSecret() {}, setOutput() {} }, github,
      { repo: { owner: 'example', repo: 'app' }, sha: 'b'.repeat(40), ref: 'refs/heads/main' });
    return { success: true, message: 'Emitted native release verified' };
  });
  return sequence;
}
describe('installed ECS first workload through the saved application plan', () => {
  it('starts without local bindings and retains exact pending bootstrap identity through re-entry', async () => {
    const f = await fixture(); expect(f.load()).toBeNull();
    for (let phase = 0; phase < 5 && !f.wire.state.created; phase++) {
      const p = await f.plan(); expect(p).not.toHaveProperty('error'); if ('error' in p) throw new Error(p.error);
      expect(p.blocked, JSON.stringify(p)).toEqual([]);
      expect(JSON.stringify(p)).not.toContain('synthetic-first-application-value');
      const applied = await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
      if (f.wire.state.created) expect(applied).toMatchObject({ kind: 'executed', result: { success: false, receipts: [
        { actionId: 'service:web', status: 'succeeded', data: { runtimeRolloutRequired: true } },
        { actionId: 'secret:API_KEY', status: 'blocked' },
      ] } });
      else expect(applied, JSON.stringify({ p, applied })).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    expect(f.wire.state.created).toBeDefined();
    expect(f.wire.state.created.primaryContainer).toMatchObject({ environment: [], secrets: [] }); expect(f.wire.state.created.taskRoleArn).toBeUndefined();
    expect(f.load().platformBindings.services).toMatchObject({ web: { serviceId: f.serviceArn, resourceUid: f.lifetime } });
    expect(f.load().platformBindings.runtimeRollouts).toMatchObject([{ service: 'web', provider: 'ecs' }]);
    expect(f.load().platformBindings.delegatedEnvBindings ?? []).toEqual([]);
    const first = structuredClone(f.load().platformBindings), before = f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op));
    const replan = await f.plan(); expect(replan).not.toHaveProperty('error'); if ('error' in replan) throw new Error(replan.error);
    expect(replan.actions.find(action => action.id === 'secret:API_KEY')?.metadata).toMatchObject({ activation: 'application-release' });
    const reapplied = await f.apply(replan.planRunId, replan.actions.filter(a => a.requiresConfirm).map(a => a.id));
    expect(reapplied, JSON.stringify(reapplied)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op))).toEqual(before);
    expect(f.load().platformBindings.services).toEqual(first.services);
    expect(f.load().platformBindings.runtimeRollouts).toMatchObject([{ service: 'web', provider: 'ecs' }]);
    expect(f.load().platformBindings.delegatedEnvBindings ?? []).toEqual([]);
    const spec = f.store.get(f.project)!.spec; spec.environments.production.deploy = { strategy: 'branch', trigger: 'ci', branch: 'main', autoDeploy: false };
    const [target] = resolveReviewedBranchDeployTargets(f.project, spec).targets;
    expect(target.releaseTarget?.resources).toMatchObject([{ logicalName: 'web', providerResourceId: f.serviceArn }]);
    expect(target.releaseTarget?.bindingsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target.runtimeResources).toMatchObject([{ logicalName: 'web', providerResourceId: f.serviceArn, providerResourceUid: f.lifetime }]);
    expect(JSON.stringify(target)).not.toContain('synthetic-first-application-value');
    expect(JSON.stringify(f.load().platformBindings)).not.toContain('synthetic-first-application-value');
    await f.adapter.disconnect();
  });
  it('orders infrastructure marker before the exact image release and only then accepts native references', async () => {
    const f = await fixture(); await createBootstrap(f); const sequence = await managedRelease(f);
    const p = await f.plan(); expect(p).not.toHaveProperty('error'); if ('error' in p) throw new Error(p.error);
    const ids = orderActions(p.actions).map(a => a.id), marker = 'ci:github-actions:production:applied-spec-hash', release = 'ci:github-actions:production:release';
    expect(ids.indexOf(marker)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(release)).toBeGreaterThan(ids.indexOf(marker));
    expect(ids.indexOf('secret:API_KEY')).toBeGreaterThan(ids.indexOf(release));
    expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
    const result = await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(sequence).toEqual(['marker', 'release']);
    expect(f.load().platformBindings.secretVersionBindings).toMatchObject({ API_KEY: { reference: f.wire.reference } });
    expect(f.load().platformBindings.secretVersionBindings).not.toHaveProperty('API_KEY.activation');
    expect(f.operations.filter(op => op === 'UpdateExpressGatewayService')).toHaveLength(1);
    expect(f.state.currentTask.containerDefinitions[0].image).toContain('@sha256:');
    expect(f.state.currentTask.containerDefinitions[0].secrets).toEqual([{ name: 'API_KEY', valueFrom: f.wire.reference.destination.secretArn + ':::' + f.wire.reference.version }]);
    await f.adapter.disconnect();
  });
  it('creates the initial managed-CI binding without prematurely accepting references', async () => {
    const f = await fixture(); await managedRelease(f);
    for (let phase = 0; phase < 6 && !f.wire.state.created; phase++) {
      const p = await f.plan(); expect(p).not.toHaveProperty('error'); if ('error' in p) throw new Error(p.error);
      const result = await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
      expect(result, JSON.stringify({ p, result })).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    expect(f.wire.state.created).toBeDefined();
    expect(f.wire.state.created.primaryContainer).toMatchObject({ environment: [], secrets: [] });
    expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
    await f.adapter.disconnect();
  });
  it.each(['reference', 'confirmation', 'provider'] as const)('blocks initial binding when its reviewed creation %s authority is missing', async drift => {
    const f = await fixture(); await managedRelease(f);
    for (let phase = 0; phase < 6; phase++) {
      const p = await f.plan(); if ('error' in p) throw new Error(p.error);
      const create = p.actions.find(a => a.id === 'service:web' && a.type === 'create');
      if (!create) { await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id)); continue; }
      expect(create.metadata?.creationSecretReferences).toEqual({ API_KEY: f.wire.reference });
      const actions = structuredClone(p.actions), reviewed = actions.find(a => a.id === 'service:web')!;
      if (drift === 'reference') (reviewed.metadata!.creationSecretReferences as any).API_KEY.version = 'f'.repeat(32);
      if (drift === 'provider') reviewed.resource.provider = 'cloudrun';
      const before = f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op));
      await expect(assertDeploymentSecretReferences({ ctx: f.ctx, project: f.project, spec: f.store.get(f.project)!.spec,
        environmentName: 'production', actions, confirmed: new Set(drift === 'confirmation' ? [] : ['service:web']) })).rejects.toThrow();
      expect(f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op))).toEqual(before);
      expect(f.wire.state.created).toBeUndefined();
      await f.adapter.disconnect(); return;
    }
    throw new Error('Expected initial CI binding stage');
  });
  it('constructs real managed marker and release actions without making reference acceptance a marker prerequisite', async () => {
    const f = await fixture(); await createBootstrap(f); await managedRelease(f);
    vi.mocked(managedCi.planManagedCiAppliedSpecHash).mockRestore();
    vi.mocked(ciDeploy.planGitHubActionsRelease).mockRestore();
    const resolved = resolveBranchDeployTargets(f.project);
    const workflow = buildBranchDeployWorkflow('ecs', resolved.targets[0], resolved.migration);
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, filePath) =>
      ciDeploy.workflowFiles(workflow).find(file => file.path === filePath)?.content ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'getEnvironmentVariable').mockResolvedValue(null);
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({ ref: 'refs/heads/main', object: { sha: 'b'.repeat(40) } });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({ total_count: 0, workflow_runs: [] });
    const p = await f.plan(); expect(p).not.toHaveProperty('error'); if ('error' in p) throw new Error(p.error);
    const marker = p.actions.find(a => a.metadata?.operation === 'githubActionsAppliedSpecHash');
    const release = p.actions.find(a => a.metadata?.operation === 'githubActionsRelease');
    const reference = p.actions.find(a => a.id === 'secret:API_KEY');
    expect(marker, JSON.stringify(p)).toMatchObject({ type: 'update', verified: true });
    expect(release, JSON.stringify(p)).toMatchObject({ type: 'update', verified: true, dependsOn: [marker!.id], metadata: { targetSha: 'b'.repeat(40) } });
    expect(marker?.dependsOn).not.toContain(reference?.id);
    expect(reference?.dependsOn).toContain(release?.id);
    expect(release?.metadata?.blockedReason).toBeUndefined();
    await f.adapter.disconnect();
  });
  it.each(['denied', 'lost-ack'] as const)('retains unaccepted references after %s and requires release recovery before acceptance', async failure => {
    const f = await fixture(); await createBootstrap(f); await managedRelease(f, { denyRelease: failure === 'denied' });
    f.state.loseRelease = failure === 'lost-ack';
    const p = await f.plan(); if ('error' in p) throw new Error(p.error);
    const result = await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
    expect(f.operations.filter(op => op === 'UpdateExpressGatewayService')).toHaveLength(failure === 'lost-ack' ? 1 : 0);
    const next = await f.plan(); expect(next).not.toHaveProperty('error'); if ('error' in next) throw new Error(next.error);
    expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
    expect(next.actions.find(a => a.id === 'secret:API_KEY')).toMatchObject({ type: 'update', metadata: { activation: 'application-release' }, dependsOn: expect.arrayContaining(['ci:github-actions:production:release']) });
    // Replanning itself does not retry CI dispatch or a native update. Existing
    // GitHub release recovery owns any subsequent execution and evidence check.
    expect(f.operations.filter(op => op === 'UpdateExpressGatewayService')).toHaveLength(failure === 'lost-ack' ? 1 : 0);
    await f.adapter.disconnect();
  });
  it.each(['lifetime', 'denied-read', 'missing-reference', 'tampered-mode'] as const)('rejects reference acceptance from stale or unverified %s evidence without provider writes', async failure => {
    const f = await fixture(); await createBootstrap(f); await managedRelease(f);
    const p = await f.plan(); if ('error' in p) throw new Error(p.error);
    const action = structuredClone(p.actions.find(a => a.id === 'secret:API_KEY')!);
    if (failure === 'lifetime') f.state.changedLifetime = true;
    if (failure === 'denied-read') f.state.deniedTask = true;
    if (failure === 'tampered-mode') action.metadata!.activation = 'unreviewed-mode';
    const before = f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op));
    const accepted = await applySecretReference({ ctx: f.ctx, project: f.project, spec: f.store.get(f.project)!.spec, environmentName: 'production', action, confirmed: new Set(), applyRunId: 'synthetic-read-only-acceptance' });
    expect(accepted).toMatchObject({ success: false, status: 'blocked' });
    expect(f.load().platformBindings.secretVersionBindings).toBeUndefined();
    expect(f.operations.filter(op => /^(Create|Put|Attach|Update|Register|Tag)/.test(op))).toEqual(before);
    await f.adapter.disconnect();
  });
  it('does not replay a lost create acknowledgment when subsequent list visibility is absent', async () => {
    const f = await fixture();
    for (let phase = 0; phase < 5; phase++) {
      const p = await f.plan(); expect(p).not.toHaveProperty('error'); if ('error' in p) throw new Error(p.error);
      if (p.actions.some(a => a.id === 'service:web' && a.type === 'create')) {
        f.wire.state.loseCreate = true; f.state.hideService = true;
        const failed = await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id));
        expect(failed).toMatchObject({ kind: 'executed', result: { success: false } });
        expect(f.operations.filter(op => op === 'CreateExpressGatewayService')).toHaveLength(1);
        expect(f.load().platformBindings.serviceCreateRecovery).toMatchObject({ web: { provider: 'ecs', state: 'unresolved' } });
        expect((f.load().platformBindings.serviceCreateRecovery as any).web.serviceId).toBeUndefined();
        const again = await f.plan(); expect(again).not.toHaveProperty('error'); if ('error' in again) throw new Error(again.error);
        const retried = await f.apply(again.planRunId, again.actions.filter(a => a.requiresConfirm).map(a => a.id));
        expect(f.operations.filter(op => op === 'CreateExpressGatewayService'), JSON.stringify({ again, retried })).toHaveLength(1);
        expect(f.load().platformBindings.services).not.toHaveProperty('web.serviceId');
        await f.adapter.disconnect(); return;
      }
      expect(await f.apply(p.planRunId, p.actions.filter(a => a.requiresConfirm).map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    throw new Error('Expected service creation frontier');
  });

});
