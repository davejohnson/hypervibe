import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { awsOperatorArtifactBoundary, AWS_OPERATOR_ARTIFACT_KINDS } from '../../adapters/providers/aws/__tests__/aws-operator-artifact.fixture.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { planCloudInstallationV1, applyCloudInstallationV1 } from '../hosted/cloud-installation.js';
import type { CloudInstallationContext, OperatorArtifactIntent } from '../../domain/ports/cloud-installation.port.js';
import { createAwsOperatorArtifactRetirementDriver } from '../../adapters/providers/aws/aws-operator-artifact-retirement.js';
import { awsArtifactRetirementBoundary } from '../../adapters/providers/aws/__tests__/aws-artifact-retirement.fixture.js';

// Requirement evidence: exact saved actions authorize publication; removing or
// changing desired state cannot erase an uncertain non-idempotent native write.
// Native transport fixtures are reconstructed AWS Query/XML/S3 contracts, not
// proof of live compatibility. SQLite, spec/plan/apply, shared journal, provider
// driver and AWS SDK serialization execute without mocked application services.
describe('operator artifact publication through application and SQLite', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-artifact-app-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });
  function fixture(options: Parameters<typeof awsOperatorArtifactBoundary>[0] = {}) {
    const native = awsOperatorArtifactBoundary(options);
    // Only credentials and transport are synthetic; retain the registered
    // capability's parsing, native identity checks and immutable receipt logic.
    vi.spyOn(providerRegistry.getArtifactPublication('s3')!, 'create').mockResolvedValue({
      driver: native.input.driver, authentication: native.input.authentication,
    });
    const retirementNative=awsArtifactRetirementBoundary(native);
    vi.spyOn(providerRegistry.getArtifactPublication('s3')!.retirement!,'create').mockImplementation(async(_scope,_context,targets)=>({
      driver:createAwsOperatorArtifactRetirementDriver(targets,{requestHandler:retirementNative.handler}),authentication:native.input.authentication,
    }));
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'operator-templates', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator.git' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun' } });
    const store = new SpecStore();
    const desired = { version: 1, project: project.name, environments: { staging: {
      hosting: { provider: 'cloudrun' }, services: { web: {} }, email: { enabled: false },
      operatorArtifacts: { templates: { provider: 's3', artifacts: AWS_OPERATOR_ARTIFACT_KINDS,
        nativeScope: { scopeKind: 's3-cloudformation-publication-v1', accountId: '123456789012', region: 'us-west-2' } } },
    } } };
    store.replace(project, desired);
    const ordinary = vi.spyOn(adapterFactory, 'getProviderAdapter').mockRejectedValue(new Error('Unexpected unrelated hosting access'));
    const plan = () => new PlanService().plan(project, environment.name);
    const apply = (planId: string, confirmActions: string[]) => {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions });
    };
    const registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    return { native, retirementNative, ctx, project, environment, store, desired, ordinary, plan, apply, registry };
  }

  it('plans AWS template retirement independently of the unchanged Cloud Run hosting provider', async () => {
    const f = fixture(), publication = await f.plan(); if ('error' in publication) throw new Error(publication.error);
    expect(await f.apply(publication.planRunId, publication.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    const saved = f.ctx.repos.runs.findById(publication.planRunId)!.plan as any;
    const original = f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    const before = JSON.stringify(original), desired: any = structuredClone(f.store.get(f.project)!.spec);
    desired.environments.staging.services = {};
    desired.environments.staging.operatorArtifacts.templates.retirement = { from: { installationId: original.installationId, planDigest: original.plan.digest }, resources: 'delete-owned', data: 'delete-owned' };
    f.store.replace(f.project, desired);
    const removal = await f.plan();
    expect(removal).toMatchObject({ scope: 'operator-artifacts', actions: expect.any(Array) });
    if ('error' in removal) throw new Error(removal.error);
    expect(removal.actions).toHaveLength(5);
    expect(removal.actions.every(action => action.requiresConfirm)).toBe(true);
    expect(f.ordinary).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ctx.repos.runs.findById(original.installationId)!.plan)).toBe(before);
    expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
    expect(await f.apply(removal.planRunId,[])).toMatchObject({kind:'executed',result:{success:false}});expect(f.retirementNative.writes).toEqual([]);
    expect(await f.apply(removal.planRunId,removal.actions.map(action=>action.id))).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.retirementNative.writes).toHaveLength(5);expect(f.retirementNative.state.bucket).toBe(false);
    const terminal=await f.plan();expect(terminal).toMatchObject({scope:'operator-artifacts',retirement:{complete:true}});
    if('error'in terminal)throw new Error(terminal.error);expect(terminal.actions.every(action=>action.type==='noop')).toBe(true);
    expect(JSON.stringify(f.ctx.repos.runs.findById(original.installationId)!.plan)).toBe(before);
  });

  async function retirementFixture() {
    const f=fixture(),publication=await f.plan();if('error'in publication)throw new Error(publication.error);
    expect(await f.apply(publication.planRunId,publication.actions.map(action=>action.id))).toMatchObject({kind:'executed',result:{success:true}});
    const saved=f.ctx.repos.runs.findById(publication.planRunId)!.plan as any,original=f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    const desired:any=structuredClone(f.store.get(f.project)!.spec);desired.environments.staging.services={};
    desired.environments.staging.operatorArtifacts.templates.retirement={from:{installationId:original.installationId,planDigest:original.plan.digest},resources:'delete-owned',data:'delete-owned'};
    return{...f,retirementDesired:desired,original};
  }
  it.each(['desired-host','bound-host','both-host','active-consumer'] as const)('rejects changed %s before constructing an AWS retirement driver',async change=>{
    const f=await retirementFixture(),desired=f.retirementDesired;
    if(change==='desired-host'||change==='both-host')desired.environments.staging.hosting.provider='railway';
    if(change==='bound-host'||change==='both-host')f.ctx.repos.environments.updatePlatformBindings(f.environment.id,{provider:'railway'});
    if(change==='active-consumer')desired.environments.staging.services={web:{}};
    f.store.replace(f.project,desired);expect(await f.plan()).toHaveProperty('error');
    expect(providerRegistry.getArtifactPublication('s3')!.retirement!.create).not.toHaveBeenCalled();expect(f.retirementNative.writes).toEqual([]);
  });
  it('continues a retained AWS stack deletion after SQLite restart without another stack request',async()=>{
    const f=await retirementFixture();f.store.replace(f.project,f.retirementDesired);const plan=await f.plan();if('error'in plan)throw new Error(plan.error);
    f.retirementNative.state.lost='stack';const first=await f.apply(plan.planRunId,plan.actions.map(action=>action.id));expect(first).toMatchObject({kind:'executed',result:{success:false}});
    expect(f.retirementNative.writes).toEqual(['DELETE:/:policy','DeleteStack']);
    SqliteAdapter.resetInstance();SqliteAdapter.getInstance(path.join(directory,'test.db')).migrate();
    const resumed=await f.plan();if('error'in resumed)throw new Error(resumed.error);expect(f.retirementNative.writes).toEqual(['DELETE:/:policy','DeleteStack']);
    const done=await f.apply(resumed.planRunId,resumed.actions.filter(action=>action.type!=='noop').map(action=>action.id));
    expect(done).toMatchObject({kind:'executed',result:{success:true}});expect(f.retirementNative.writes.filter(item=>item==='DeleteStack')).toHaveLength(1);
    expect(f.retirementNative.state.bucket).toBe(false);expect(f.ctx.repos.runs.findById(f.original.installationId)!.plan).toEqual(f.original);
  });
  it('blocks retained Cloud Run automation authority while the selected artifact provider is s3',async()=>{
    const f=await retirementFixture();f.store.replace(f.project,f.retirementDesired);
    const bindings={provider:'cloudrun',projectId:'operator-project',gcpGithubWorkloadIdentity:{schemaVersion:1,projectId:'operator-project',projectNumber:'123456789012',
      workloadIdentityProvider:'projects/123456789012/locations/global/workloadIdentityPools/owned-pool/providers/github',serviceAccountEmail:'ci-deployer@operator-project.iam.gserviceaccount.com',serviceAccountUniqueId:'123456789013',
      repository:'acme/operator',repositoryId:'1234',repositoryOwnerId:'123',branch:'main',environment:'staging',workflow:'.github/workflows/deploy.yml',backupWorkflow:'.github/workflows/hypervibe-backup-staging.yml'}};
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id,bindings);
    const fresh=f.ctx.repos.environments.findById(f.environment.id)!;
    expect(providerRegistry.getMetadata('cloudrun')!.credentials!.automationAuthentication!(fresh)).toMatchObject({oidc:true});
    expect(providerRegistry.getMetadata('s3')!.credentials?.automationAuthentication).toBeUndefined();
    expect(await f.plan()).toHaveProperty('error');expect(providerRegistry.getArtifactPublication('s3')!.retirement!.create).not.toHaveBeenCalled();expect(f.retirementNative.writes).toEqual([]);
  });
  it('prepares a fresh confirmed AWS retry after a definite rejection without replay during planning',async()=>{
    const f=await retirementFixture();f.store.replace(f.project,f.retirementDesired);const plan=await f.plan();if('error'in plan)throw new Error(plan.error);
    f.retirementNative.state.denyWrites=true;expect(await f.apply(plan.planRunId,plan.actions.map(a=>a.id))).toMatchObject({kind:'executed',result:{success:false}});
    expect(f.retirementNative.writes).toEqual(['DELETE:/:policy']);f.retirementNative.state.denyWrites=false;
    const retry=await f.plan();if('error'in retry)throw new Error(retry.error);expect(retry.actions).toHaveLength(1);expect(retry.actions[0].requiresConfirm).toBe(true);expect(f.retirementNative.writes).toEqual(['DELETE:/:policy']);
    expect(await f.apply(retry.planRunId,[retry.actions[0].id])).toMatchObject({kind:'executed',result:{success:true}});
    const remaining=await f.plan();if('error'in remaining)throw new Error(remaining.error);
    expect(await f.apply(remaining.planRunId,remaining.actions.filter(a=>a.type!=='noop').map(a=>a.id))).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.retirementNative.state.bucket).toBe(false);expect(f.retirementNative.writes.filter(item=>item==='DELETE:/:policy')).toHaveLength(2);
  });

  it.each(['removed', 'different-provider', 'invalid-scope'] as const)('retains %s uncertain declarations as read-only recovery instead of falling through to hosting', async change => {
    const f = fixture({ lost: 'stack' }); const planned = await f.plan();
    if ('error' in planned) throw new Error(planned.error);
    expect(planned.scope).toBe('operator-artifacts');
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual(['stack']); f.native.setReadsDenied(true);
    const changed: any = structuredClone(f.desired);
    if (change === 'removed') delete changed.environments.staging.operatorArtifacts;
    else if (change === 'different-provider') changed.environments.staging.operatorArtifacts.templates.provider = 'unregistered-artifact-provider';
    else changed.environments.staging.operatorArtifacts.templates.nativeScope.accountId = 'invalid-native-account';
    f.store.replace(f.project, changed);
    // A real process restart must rediscover the retained SQLite operation even
    // when the current desired map no longer names it.
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    const recovery = await f.plan();
    expect(recovery).toMatchObject({ scope: 'operator-artifacts', actions: [{ type: 'update', requiresConfirm: false, billable: false }] });
    expect(f.ordinary).not.toHaveBeenCalled();
    if ('error' in recovery) throw new Error(recovery.error);
    await f.apply(recovery.planRunId, []);
    expect(f.native.writes).toEqual(['stack']);
    f.native.setReadsDenied(false);
    const observed = await f.plan();
    expect(observed).toMatchObject({ scope: 'operator-artifacts' });
    if ('error' in observed) throw new Error(observed.error);
    expect(observed.actions).toHaveLength(1);
    expect(observed.actions[0]).toMatchObject({ id: planned.actions[0].id, type: 'update', requiresConfirm: false });
    expect(f.native.writes).toEqual(['stack']);
  });

  it('does not bypass unresolved artifact publication by requesting a narrow plan scope', async () => {
    const f = fixture({ lost: 'stack' }); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    expect(f.native.writes).toEqual(['stack']); f.native.setReadsDenied(true);
    const result = await new PlanService().plan(f.project, 'staging', { scope: 'secrets', secretRefs: { API_KEY: 'env:HV_SYNTHETIC_TEST_KEY' } });
    expect(result).toMatchObject({ error: expect.stringMatching(/recover the retained operator artifact operation/) });
    expect(f.ordinary).not.toHaveBeenCalled(); expect(f.native.writes).toEqual(['stack']);
  });

  it('resumes the same reviewed artifacts after an unrelated service edit with a fresh exact plan', async () => {
    // Template bytes and target authority are selected by the exact artifact
    // declaration. A service command edit is neither template replacement nor
    // authority to reuse an old outer plan; a fresh confirmed plan can resume.
    const f = fixture({ lost: 'stack' }); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    expect(f.native.writes).toEqual(['stack']);
    const changed: any = structuredClone(f.desired);
    changed.environments.staging.services.web.startCommand = 'node updated-server.mjs';
    f.store.replace(f.project, changed);
    const stale = await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    expect(stale).toMatchObject({ kind: 'executed', result: { success: false, error: expect.stringMatching(/spec|revision|stale/i) } });
    expect(f.native.writes).toEqual(['stack']);
    const resumed = await f.plan(); if ('error' in resumed) throw new Error(resumed.error);
    expect(resumed).toMatchObject({ scope: 'operator-artifacts' });
    expect(resumed.actions).toHaveLength(4);
    expect(resumed.actions[0]).toMatchObject({ type: 'noop', requiresConfirm: false });
    expect(resumed.actions.slice(1).every(action => action.requiresConfirm && action.type !== 'noop')).toBe(true);
    await f.apply(resumed.planRunId, []); expect(f.native.writes).toEqual(['stack']);
    const reviewed = await f.plan(); if ('error' in reviewed) throw new Error(reviewed.error);
    expect(await f.apply(reviewed.planRunId, reviewed.actions.filter(action => action.requiresConfirm).map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
  });

  it('requires each exact action confirmation and publishes only immutable receipts', async () => {
    const f = fixture(); const first = await f.plan();
    if ('error' in first) throw new Error(first.error);
    expect(first.scope).toBe('operator-artifacts'); expect(first.actions).toHaveLength(4);
    expect(f.native.writes).toEqual([]);
    expect(await f.apply(first.planRunId, [])).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]);
    // Generic apply validates the entire reviewed frontier before starting.
    // Omitting any one consequential confirmation must yield zero mutations.
    for (const omitted of first.actions) {
      const current = await f.plan(); if ('error' in current) throw new Error(current.error);
      await f.apply(current.planRunId, current.actions.filter(action => action.id !== omitted.id).map(action => action.id));
      expect(f.native.writes).toEqual([]);
    }
    const complete = await f.plan(); if ('error' in complete) throw new Error(complete.error);
    expect(await f.apply(complete.planRunId, complete.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
    const saved = f.ctx.repos.runs.findById(first.planRunId)!.plan as any;
    const journal = f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    expect(journal.status).toBe('scope-ready');
    const receipts = f.native.capability.receipts(journal);
    expect(receipts).toHaveLength(2);
    expect(receipts.every(item => item.url.includes('?versionId=') && /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(JSON.stringify(journal)).not.toMatch(/synthetic-session-token|synthetic-session-secret|ASIASYNTHETICPUBLISHER/);
    expect(f.ordinary).not.toHaveBeenCalled();
  });

  it('passes completed unchanged publication to the ordinary planner with deployment inputs', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    f.ordinary.mockResolvedValue({ success: false, error: 'Synthetic ordinary native inspection unavailable' });
    const next = await new PlanService().plan(f.project, 'staging', { envVarOverrides: { SYNTHETIC_SETTING: 'test' }, secretRefs: {} });
    expect('error' in next ? next.error : next.scope).not.toMatch(/Operator artifacts|operator-artifacts/);
    expect(f.ordinary).toHaveBeenCalled(); expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
    f.ordinary.mockClear(); const changed = structuredClone(f.desired);
    changed.environments.staging.operatorArtifacts.templates.nativeScope.region = 'us-east-1'; f.store.replace(f.project, changed);
    expect(await new PlanService().plan(f.project, 'staging', { envVarOverrides: { SYNTHETIC_SETTING: 'test' }, secretRefs: {} })).toHaveProperty('error');
    expect(f.ordinary).not.toHaveBeenCalled(); expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
  });

  it('consumes an explicit refresh of unchanged AWS templates without republishing versions or changing policy', async () => {
    const f = fixture(), first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId, first.actions.map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    const firstPlan = f.ctx.repos.runs.findById(first.planRunId)!.plan as any;
    const prior = f.native.capability.parseRecord(f.ctx.repos.runs.findById(firstPlan.artifactPublication.installationId)!.plan);
    const originalReceipts = f.native.capability.receipts(prior), originalWrites = [...f.native.writes];
    const originalPolicy = structuredClone(f.native.policy());
    expect(originalWrites).toEqual(['stack', 'object', 'object', 'policy']);
    const refreshFrom = { installationId: prior.installationId, planDigest: prior.plan.digest };
    const changed = structuredClone(f.store.get(f.project)!.spec);
    changed.environments.staging.operatorArtifacts!.templates.refreshFrom = refreshFrom;
    f.store.replace(f.project, changed);

    const refreshed = await f.plan(); if ('error' in refreshed) throw new Error(refreshed.error);
    expect(refreshed.scope).toBe('operator-artifacts');
    expect(f.native.writes).toEqual(originalWrites);
    const applied = await f.apply(refreshed.planRunId, refreshed.actions.filter(action => action.requiresConfirm).map(action => action.id));
    const saved = f.ctx.repos.runs.findById(refreshed.planRunId)!.plan as any;
    const successor = f.native.capability.parseRecord(f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan);
    expect(applied, JSON.stringify({ status: successor.status, reason: successor.reason, completed: Object.keys(successor.completed),
      actions: refreshed.actions.map(({ id, type }) => ({ id, type })), attempts: successor.attempts.map(({ actionId, status, reason }) => ({ actionId, status, reason })) }))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    expect(successor.installationId).not.toBe(prior.installationId);
    expect(successor).toMatchObject({ status: 'scope-ready', intent: { predecessor: refreshFrom }, attempts: [] });
    expect(f.native.capability.receipts(successor)).toEqual(originalReceipts);
    expect(f.native.writes).toEqual(originalWrites);
    expect(f.native.policy()).toEqual(originalPolicy);

    // Keeping the consumed marker in desired state must not create another
    // publication. Ordinary hosting inspection is separate from this noop.
    f.ordinary.mockResolvedValue({ success: false, error: 'Synthetic ordinary native inspection unavailable' });
    for (let repeat = 0; repeat < 2; repeat++) {
      f.ordinary.mockClear();
      const again = await f.plan();
      expect('error' in again ? again.error : again.scope).not.toMatch(/Operator artifact|operator-artifacts/);
      expect(f.ordinary).toHaveBeenCalled();
      expect(f.native.capability.receipts(f.native.capability.parseRecord(f.ctx.repos.runs.findById(successor.installationId)!.plan)))
        .toEqual(originalReceipts);
      expect(f.native.writes).toEqual(originalWrites);
      expect(f.native.policy()).toEqual(originalPolicy);
    }
  });

  it('blocks explicit AWS refresh when inherited-resource reads fail without inventing completion or writing', async () => {
    const f = fixture(), first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId, first.actions.map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    const firstPlan = f.ctx.repos.runs.findById(first.planRunId)!.plan as any;
    const prior = f.native.capability.parseRecord(f.ctx.repos.runs.findById(firstPlan.artifactPublication.installationId)!.plan);
    const originalWrites = [...f.native.writes], originalPolicy = structuredClone(f.native.policy());
    const changed = structuredClone(f.store.get(f.project)!.spec);
    changed.environments.staging.operatorArtifacts!.templates.refreshFrom = { installationId: prior.installationId, planDigest: prior.plan.digest };
    f.store.replace(f.project, changed);
    const refreshed = await f.plan(); if ('error' in refreshed) throw new Error(refreshed.error);
    f.native.setReadsDenied(true);
    expect(await f.apply(refreshed.planRunId, refreshed.actions.filter(action => action.requiresConfirm).map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: false } });
    const saved = f.ctx.repos.runs.findById(refreshed.planRunId)!.plan as any;
    const successor = f.native.capability.parseRecord(f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan);
    expect(successor).toMatchObject({ status: 'blocked', completed: {}, attempts: [] });
    expect(f.native.writes).toEqual(originalWrites);
    expect(f.native.policy()).toEqual(originalPolicy);
    expect(f.native.capability.receipts(f.native.capability.parseRecord(f.ctx.repos.runs.findById(prior.installationId)!.plan)))
      .toEqual(f.native.capability.receipts(prior));
  });

  it('does not upload a new AWS template after an inherited noop loses its native object', async () => {
    const f = fixture(), initial = structuredClone(f.store.get(f.project)!.spec);
    initial.environments.staging.operatorArtifacts!.templates.artifacts = ['aws-collection-template-v1'];
    f.store.replace(f.project, initial);
    const first = await f.plan(); if ('error' in first) throw new Error(first.error);
    expect(await f.apply(first.planRunId, first.actions.map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    const firstPlan = f.ctx.repos.runs.findById(first.planRunId)!.plan as any;
    const prior = f.native.capability.parseRecord(f.ctx.repos.runs.findById(firstPlan.artifactPublication.installationId)!.plan);
    const originalWrites = [...f.native.writes], changed = structuredClone(f.store.get(f.project)!.spec);
    changed.environments.staging.operatorArtifacts!.templates.artifacts = ['aws-collection-template-v1', 'aws-deployment-template-v1'];
    changed.environments.staging.operatorArtifacts!.templates.refreshFrom = { installationId: prior.installationId, planDigest: prior.plan.digest };
    f.store.replace(f.project, changed);
    const refreshed = await f.plan(); if ('error' in refreshed) throw new Error(refreshed.error);
    // Independent native disappearance after review: the retained version must
    // still be verified before this successor can perform its new upload.
    f.native.objects.clear();
    expect(await f.apply(refreshed.planRunId, refreshed.actions.filter(action => action.requiresConfirm).map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual(originalWrites);
  });

  it.each(['stack', 'object', 'policy'] as const)('recovers lost %s acknowledgments with no repeated native mutation', async lost => {
    const f = fixture({ lost }); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    let current = planned;
    for (let attempts = 0; attempts < 8; attempts++) {
      await f.apply(current.planRunId, current.actions.filter(action => action.requiresConfirm && action.type !== 'noop').map(action => action.id));
      const proof = f.ctx.repos.runs.findById(current.planRunId)!.plan as any;
      const journal = () => f.ctx.repos.runs.findById(proof.artifactPublication.installationId)!.plan as any;
      if (journal().status === 'scope-ready') break;
      // A final lost-public-policy acknowledgment may reconcile publication to
      // completion during planning and then reach ordinary hosting inspection.
      const next = await f.plan().catch(error => {
        if (journal().status !== 'scope-ready') throw error;
        return undefined;
      });
      if (!next) break;
      if ('error' in next) throw new Error(next.error);
      current = next;
    }
    expect(f.native.writes).toEqual(['stack', 'object', 'object', 'policy']);
  });

  it('rejects a stale spec and forged cross-environment plan before provider writes', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const changed = structuredClone(f.desired); changed.environments.staging.operatorArtifacts.templates.nativeScope.region = 'us-east-1';
    f.store.replace(f.project, changed);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    expect(f.native.writes).toEqual([]);
    f.store.replace(f.project, f.desired);
    const current = await f.plan(); if ('error' in current) throw new Error(current.error);
    const saved = f.ctx.repos.runs.findById(current.planRunId)!; const forged = structuredClone(saved.plan) as any;
    forged.environmentName = 'production'; f.ctx.repos.runs.updatePlan(saved.id, forged); f.native.requests.length = 0;
    expect(await f.apply(current.planRunId, current.actions.map(action => action.id))).toMatchObject({ kind: 'blocked' });
    expect(f.native.writes).toEqual([]); expect(f.native.requests).toEqual([]);
  });

  it('rechecks current desired authority at the native mutation boundary', async () => {
    const f = fixture(); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    const mutate = f.native.input.driver.mutate!.bind(f.native.input.driver);
    vi.spyOn(f.native.input.driver, 'mutate').mockImplementationOnce(async context => {
      const revoked: any = structuredClone(f.desired); delete revoked.environments.staging.operatorArtifacts;
      f.store.replace(f.project, revoked);
      // The real driver still reads native authority; its final beforeMutation
      // hook must reject the changed desired source before CreateStack is sent.
      return mutate(context);
    });
    expect(await f.apply(planned.planRunId, planned.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.native.writes).toEqual([]);
    expect(f.native.input.driver.mutate).toHaveBeenCalledOnce();
  });

  it('exposes exact permission/cost review in the ordinary command envelope', async () => {
    const f = fixture(); const result = await f.registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(result).toMatchObject({ ok: true, data: { scope: 'operator-artifacts', cloudScopeReview: { permissions: expect.any(Array), costs: expect.any(Array) } } });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-session-token|synthetic-session-secret|ASIASYNTHETICPUBLISHER/);
    expect(f.native.writes).toEqual([]);
  });

  it('keeps retained publication recovery reachable through commands after hosting selection changes', async () => {
    const f = fixture({ lost: 'stack' }); const planned = await f.plan(); if ('error' in planned) throw new Error(planned.error);
    await f.apply(planned.planRunId, planned.actions.map(action => action.id));
    f.native.setReadsDenied(true);
    const changed: any = structuredClone(f.desired); delete changed.environments.staging.operatorArtifacts;
    changed.environments.staging.hosting.provider = 'uninstalled-hosting-provider'; f.store.replace(f.project, changed);
    const recovery = await f.registry.execute('hv_plan', { project: f.project.name, env: 'staging' });
    expect(recovery).toMatchObject({ ok: true, data: { scope: 'operator-artifacts' } });
    expect(recovery.data).not.toHaveProperty('localEnv');
    const applied = await f.registry.execute('hv_apply', { project: f.project.name, planId: (recovery.data as any).planId });
    expect(applied).toMatchObject({ ok: true, data: { applied: false } });
    expect(f.native.writes).toEqual(['stack']); expect(f.ordinary).not.toHaveBeenCalled();
  });

  it('keeps current provider validation for unattempted proposals and ordinary work', async () => {
    const f = fixture(); await f.plan();
    const changed: any = structuredClone(f.desired); changed.environments.staging.hosting.provider = 'uninstalled-hosting-provider';
    f.store.replace(f.project, changed); f.native.requests.length = 0;
    expect(await f.registry.execute('hv_plan', { project: f.project.name, env: 'staging' })).toMatchObject({ ok: false });
    expect(f.native.requests).toEqual([]); expect(f.native.writes).toEqual([]);
  });

  it('rejects hosted authentication before native publication planning or mutation', async () => {
    const native = awsOperatorArtifactBoundary();
    const hosted = { ...native.input, authentication: { host: { verifyIdentity: vi.fn() } } } as unknown as CloudInstallationContext<OperatorArtifactIntent>;
    await expect(planCloudInstallationV1({ ...hosted, intent: native.intent })).rejects.toMatchObject({ code: 'authorization_expired' });
    expect(native.requests).toEqual([]); expect(native.writes).toEqual([]);
    const planned = await planCloudInstallationV1({ ...native.input, intent: native.intent }); native.requests.length = 0;
    expect(await applyCloudInstallationV1({ ...hosted, installationId: planned.installationId, planDigest: planned.plan.digest,
      confirmActions: planned.plan.actions.map(action => action.id) })).toMatchObject({ status: 'blocked', reason: 'authorization_expired' });
    expect(native.requests).toEqual([]); expect(native.writes).toEqual([]);
  });
});
