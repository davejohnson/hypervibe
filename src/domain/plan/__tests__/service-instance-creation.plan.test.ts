import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithWorkspaceDirectories } from '../../../lib/workspace-context.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createToolContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';

const recordedEmpty = JSON.parse(readFileSync(new URL('../../../../test/provider-contracts/railway/service-instance/empty-defaults-observation.json', import.meta.url), 'utf8'));
const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SG_SITE_URL', 'SG_SCRIPT_NAME', 'SG_SCRIPT_KEY', 'PLANNER_SECRET'];

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  SqliteAdapter.resetInstance();
});

async function setup(database = false, options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const fixture = await railwayHttpFixture({ rejectDuplicateServiceNames: true, ...options });
  const projects = new ProjectRepository();
  const project = projects.create({ name: 'contract-project', defaultPlatform: 'railway' });
  const environments = new EnvironmentRepository();
  const production = environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId, environmentId: productionId, services: { web: { serviceId: 'production-web' } },
  } });
  const staging = environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId,
  } });
  new SpecStore().replace(project, {
    version: 1, project: project.name,
    secrets: Object.fromEntries(keys.map(key => [key, { ownership: 'delegated', principal: 'github:owner', environments: ['staging'] }])),
    environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
      staging: {
        hosting: { provider: 'railway' },
        deploy: { strategy: 'manual' },
        services: { web: { volume: { mountPath: '/data' } } },
        ...(database ? { database: { provider: 'railway', engine: 'postgres' } } : {}),
        envVars: { MARQR_MEDIA_DIR: '/data/marqr_media' },
      },
    },
  });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'railway', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
  connections.updateStatus(connection.id, 'verified');
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter });
  vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter as never });
  const planner = new PlanService();
  const plan = async () => {
    const result = await planner.plan(project, 'staging', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const apply = async (result: Awaited<ReturnType<typeof plan>>) => {
    const current = new SpecStore().get(project)!;
    return executePlanApply(createToolContext(), { project, spec: current.spec, specRevision: current.revision,
      planId: result.planRunId, confirmActions: result.actions.filter(action => action.type !== 'noop').map(action => action.id) });
  };
  return { fixture, environments, production, staging, project, plan, apply };
}

// Independent expected behavior: Railway official CLI b62467ef environment/new.rs
// retains shared Service IDs and creates target ServiceInstances using isCreated.
// Synthetic responses validate that contract; they do not prove live defaults.
describe('accepted shared hosting service gets an isolated environment instance', () => {
  it('creates only the target instance of the already-bound parent instead of a duplicate Service', async () => {
    const f = await setup();
    const productionInstance = structuredClone(f.fixture.services.get('production-web')!.instances.get(productionId));
    const first = await f.plan();
    expect(first.inputRequired).toEqual([]);
    expect(f.fixture.mutations).toEqual([]);
    // RED must cross the real application/planner/provider HTTP boundary first.
    expect(await f.apply(first)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toMatchObject({ id: 'service:web', type: 'create', requiresConfirm: true,
      metadata: { operation: 'serviceInstanceCreate', target: { serviceId: 'production-web', projectId, environmentId: stagingId } } });
    expect(f.fixture.mutations.map(m => m.field)).toEqual(['environmentPatchCommit']);
    expect(f.fixture.mutations[0].args).toMatchObject({ environmentId: stagingId, patch: { services: { 'production-web': { isCreated: true } } } });
    expect(f.fixture.services.get('production-web')!.instances.get(productionId)).toEqual(productionInstance);
    expect(f.fixture.services.get('production-web')!.instances.get(stagingId)?.source).toEqual({});
    expect(f.fixture.variables.get(`production-web/${stagingId}`) ?? {}).toEqual({});
    expect(f.fixture.services.has('staging-web')).toBe(false);
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toMatchObject({ web: { serviceId: 'production-web' } });
    expect(f.fixture.contractErrors).toEqual([]);
  });

  it('defers database creation and variable wiring beyond the empty instance stage', async () => {
    const f=await setup(true);
    const plan=await f.plan();
    expect(plan.actions.map(action=>action.id)).toEqual(['service:web']);
    expect(plan.inputRequired).toEqual([]);
    expect(plan.actions[0].dependsOn ?? []).not.toContain('database:railway');
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.fixture.mutations.map(mutation=>mutation.field)).toEqual(['environmentPatchCommit']);
    expect(f.fixture.variables.get(`production-web/${stagingId}`) ?? {}).toEqual({});
    expect(f.fixture.services.has('staging-Postgres')).toBe(false);
  });

  it('finalizes the observed native empty defaults after workflow completion without another write', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    const f=await setup(false,{instanceCreationWorkflowStatus:'Running',afterInstanceCreate:()=>{
      fixture.environments.get(stagingId)!.config.services!['production-web']=structuredClone(recordedEmpty.instanceConfig);
      (fixture.services.get('production-web')!.instances.get(stagingId)! as any).source=recordedEmpty.source;
    }});
    fixture=f.fixture;
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:false}});
    f.fixture.backupWorkflows.set('instance-workflow',{status:'Complete',error:null});
    const plan=await f.plan();
    expect(plan.actions[0]).toMatchObject({verified:true,metadata:{operation:'serviceInstanceFinalize'}});
    const count=f.fixture.mutations.length;
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.fixture.mutations).toHaveLength(count);
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toMatchObject({web:{serviceId:'production-web'}});
  });

  it('keeps the acknowledged instance pending while its native workflow runs, then finalizes without writes', async () => {
    const f = await setup(false, { instanceCreationWorkflowStatus: 'Running' });
    const first = await f.plan();
    expect(await f.apply(first)).toMatchObject({ kind:'executed', result:{success:false} });
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toBeUndefined();
    expect(f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates).toMatchObject({ web:{workflowId:'instance-workflow'} });
    const pending = await f.plan();
    expect(pending.actions.find(action => action.id==='service:web')?.metadata, JSON.stringify(pending.actions)).toHaveProperty('blockedReason');
    f.fixture.backupWorkflows.set('instance-workflow', {status:'Complete',error:null});
    const recovered = await f.plan();
    expect(recovered.actions.find(action => action.id==='service:web')?.metadata?.operation).toBe('serviceInstanceFinalize');
    const count = f.fixture.mutations.length;
    expect(await f.apply(recovered)).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.fixture.mutations).toHaveLength(count);
    expect(f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates).toEqual({});
  });

  it('retains a lost acknowledgement and never creates or adopts automatically on replay', async () => {
    const f = await setup(false, { dropInstanceCreateResponse:true });
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:false}});
    const marker = f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates;
    expect(marker).toHaveProperty('web');
    const count = f.fixture.mutations.length;
    const retry = await f.plan();
    expect(retry.actions.find(action=>action.id==='service:web')?.metadata?.blockedReason).toBe('service_instance_acknowledgement_missing');
    await f.apply(retry);
    expect(f.fixture.mutations).toHaveLength(count);
    expect(f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates).toEqual(marker);
  });

  it('blocks an existing staged change without applying it or creating any service', async () => {
    const f = await setup();
    const patch = {id:'foreign-staged',environmentId:stagingId,status:'STAGED',patch:{services:{'production-web':{variables:{PRIVATE:{value:'synthetic-only'}}}}}};
    f.fixture.environmentPatches.set(`staged:${stagingId}`, patch);
    const plan = await f.plan();
    expect(plan.actions.find(action=>action.id==='service:web')?.metadata?.blockedReason).toBe('service_instance_state_unverified');
    await f.apply(plan);
    expect(f.fixture.mutations).toEqual([]);
    expect(f.fixture.environmentPatches.get(`staged:${stagingId}`)).toEqual(patch);
    expect(JSON.stringify(plan)).not.toContain('synthetic-only');
  });

  it('rechecks the accepted parent binding after plan and refuses a changed identity', async () => {
    const f = await setup();
    const plan = await f.plan();
    f.environments.updatePlatformBindings(f.production.id,{services:{web:{serviceId:'different-parent'}}});
    await f.apply(plan);
    expect(f.fixture.mutations).toEqual([]);
  });

  it('keeps unexpected inherited source pending and stops before any follow-on operation', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    const f = await setup(false,{ afterInstanceCreate:()=>{
      fixture.services.get('production-web')!.instances.get(stagingId)!.source={image:'nginx:unexpected'};
    }});
    fixture=f.fixture;
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:false}});
    expect(f.fixture.mutations.map(m=>m.field)).toEqual(['environmentPatchCommit']);
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toBeUndefined();
    expect(f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates).toHaveProperty('web');
  });

  it('preserves an earlier uncertain global create privately while reviewing a distinct instance operation', async () => {
    const f = await setup();
    const marker = { provider:'railway',operation:'create',resourceName:'web',providerScope:{projectId,environmentId:stagingId},state:'unresolved' };
    const runs = new RunRepository();
    const old = runs.create({projectId:f.project.id,environmentId:f.staging.id,type:'deploy'});
    runs.addReceipt(old.id,{step:'deploy-web',status:'failure',result:{service:'web',serviceCreateRecovery:marker},
      error:'Synthetic string-only BAD_USER_INPUT: service already exists',timestamp:new Date().toISOString()});
    runs.updateStatus(old.id,'failed','Synthetic string-only rejection');
    f.environments.updatePlatformBindings(f.staging.id,{serviceCreateRecovery:{web:marker}});
    const plan=await f.plan();
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    expect(plan.actions.find(action=>action.id==='service:web')?.metadata).toMatchObject({operation:'serviceInstanceCreate', priorCreateRecoverySha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(f.fixture.mutations.map(m=>m.field)).toEqual(['environmentPatchCommit']);
    const current=f.environments.findById(f.staging.id)!.platformBindings;
    expect(current.serviceCreateRecovery).toEqual({});
    const history=current.serviceInstanceCreateHistory as Array<{recordEncrypted:string}>;
    expect(history).toHaveLength(1);
    expect(getSecretStore().decryptObject(history[0].recordEncrypted)).toMatchObject({marker,disposition:'unresolved-not-retried'});
    expect(JSON.stringify(plan)).not.toContain('recordEncrypted');
    expect(runs.findById(old.id)!.receipts[0].result?.serviceCreateRecovery).toEqual(marker);
  });

  it('does not finalize a target on which another actor has deployed uploaded code', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    const f=await setup(false,{afterInstanceCreate:()=>{
      fixture.services.get('production-web')!.instances.get(stagingId)!.latestDeployment={id:'foreign-upload',status:'SUCCESS'};
    }});
    fixture=f.fixture;
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:false}});
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toBeUndefined();
    expect(f.fixture.mutations.map(m=>m.field)).toEqual(['environmentPatchCommit']);
  });

  it('keeps committed binding and workflow evidence when repository export fails, then retries export without writes', async () => {
    const f=await setup();
    const plan=await f.plan();
    const original=(EnvironmentRepository.prototype as any).syncRepoBindings;
    let failed=false;
    vi.spyOn(EnvironmentRepository.prototype as any,'syncRepoBindings').mockImplementation(function(this:EnvironmentRepository, environment:any){
      if (!failed && environment.platformBindings.serviceInstanceCreates?.web?.completed) { failed=true; throw new Error('Synthetic filesystem export failure'); }
      return original.call(this,environment);
    });
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:false}});
    expect(failed).toBe(true);
    const committed=f.environments.findById(f.staging.id)!.platformBindings;
    expect(committed.services).toMatchObject({web:{serviceId:'production-web'}});
    expect(committed.serviceInstanceCreates).toMatchObject({web:{completed:true,workflowId:'instance-workflow'}});
    const count=f.fixture.mutations.length;
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.fixture.mutations).toHaveLength(count);
  });

  it.each(['old-marker', 'older-intent'])('survives actual command hydration of a stale %s after committed export failure', async mode => {
    const f=await setup();
    const marker={provider:'railway',operation:'create',resourceName:'web',providerScope:{projectId,environmentId:stagingId},state:'unresolved'};
    f.environments.updatePlatformBindings(f.staging.id,{serviceCreateRecovery:{web:marker}});
    const stale=structuredClone(f.environments.findById(f.staging.id)!.platformBindings);
    const plan=await f.plan();
    const original=(EnvironmentRepository.prototype as any).syncRepoBindings;
    let failed=false;
    vi.spyOn(EnvironmentRepository.prototype as any,'syncRepoBindings').mockImplementation(function(this:EnvironmentRepository,environment:any){
      if (!failed && environment.platformBindings.serviceInstanceCreates?.web?.completed) {failed=true;throw new Error('Synthetic export failure');}
      return original.call(this,environment);
    });
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:false}});
    const committed=f.environments.findById(f.staging.id)!.platformBindings;
    expect(committed.serviceInstanceCreates).toMatchObject({web:{completed:true}});
    if (mode==='older-intent') {
      const {operation:_operation,...intent}=plan.actions[0].metadata!;
      stale.serviceInstanceCreates={web:intent};
      stale.serviceCreateRecovery={};
    }
    const root=mkdtempSync(path.join(tmpdir(),'hypervibe-instance-hydrate-'));
    try {
      mkdirSync(path.join(root,'.git'));mkdirSync(path.join(root,'.hypervibe'));
      writeFileSync(path.join(root,'.hypervibe','spec.json'),JSON.stringify(new SpecStore().get(f.project)!.spec));
      writeFileSync(path.join(root,'.hypervibe','bindings.json'),JSON.stringify({version:1,project:f.project.name,environments:{staging:{platformBindings:stale}}}));
      vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC','false');
      await runWithWorkspaceDirectories([root],async()=>{
        expect(createToolContext().resolveProjectOrThrow({project:f.project.name}).id).toBe(f.project.id);
        const current=f.environments.findById(f.staging.id)!.platformBindings;
        expect(current.serviceCreateRecovery).toEqual({});
        expect(current.services).toMatchObject({web:{serviceId:'production-web'}});
        expect(current.serviceInstanceCreates).toMatchObject({web:{workflowId:'instance-workflow',completed:true}});
        const count=f.fixture.mutations.length;
        expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
        expect(f.fixture.mutations).toHaveLength(count);
      });
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it('retains native acknowledgement when desired state changes while the request is in flight', async () => {
    let f: Awaited<ReturnType<typeof setup>>;
    f=await setup(false,{afterInstanceCreate:()=>{
      const store=new SpecStore(); const current=structuredClone(store.get(f.project)!.spec);
      current.environments.staging.envVars={...current.environments.staging.envVars,NEW_SETTING:'changed'}; store.replace(f.project,current);
    }});
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:false}});
    expect(f.environments.findById(f.staging.id)!.platformBindings.serviceInstanceCreates).toMatchObject({web:{workflowId:'instance-workflow'}});
    expect(f.environments.findById(f.staging.id)!.platformBindings.services).toBeUndefined();
  });

  it('keeps pending work visible when the service is removed from desired state', async () => {
    const f=await setup(false,{instanceCreationWorkflowStatus:'Running'});
    await f.apply(await f.plan());
    const store=new SpecStore(); const current=structuredClone(store.get(f.project)!.spec);
    current.environments.staging.services={}; current.secrets={}; store.replace(f.project,current);
    const plan=await f.plan();
    expect(plan.actions.find(action=>action.id==='service:web')?.metadata?.blockedReason).toBe('service_instance_desired_removed');
    const count=f.fixture.mutations.length;
    await f.apply(plan);
    expect(f.fixture.mutations).toHaveLength(count);
  });

  it('accepts consistent bindings to one parent from two sibling environments', async () => {
    const f=await setup();
    const secondId='environment-existing-preview';
    f.fixture.environments.set(secondId,{id:secondId,name:'preview',config:{services:{'production-web':{}}}});
    const instance=structuredClone(f.fixture.services.get('production-web')!.instances.get(productionId)!);
    f.fixture.services.get('production-web')!.instances.set(secondId,{...instance,id:'preview-instance',environmentId:secondId});
    f.environments.create({projectId:f.project.id,name:'preview',platformBindings:{provider:'railway',projectId,environmentId:secondId,services:{web:{serviceId:'production-web'}}}});
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.fixture.mutations.map(m=>m.field)).toEqual(['environmentPatchCommit']);
  });

  it('normalizes explicitly null source fields on an otherwise empty new instance', async () => {
    let fixture: Awaited<ReturnType<typeof railwayHttpFixture>>;
    const f=await setup(false,{afterInstanceCreate:()=>{
      (fixture.environments.get(stagingId)!.config.services!['production-web'] as any).source={repo:null,image:null,branch:null};
    }});
    fixture=f.fixture;
    expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:true}});
  });
});
