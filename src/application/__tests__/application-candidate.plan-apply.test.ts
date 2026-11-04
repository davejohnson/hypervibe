import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { candidateBoundary } from '../../adapters/providers/gcp/__tests__/gcp-application-candidate.fixture.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { prepareOperatorImages, runOperatorCommand } from '../../adapters/providers/gcp/operator-image-build.js';
import { OperatorArtifactPreparationError, isOperatorArtifactAction } from '../../domain/ports/operator-artifact.port.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { createGcpOperatorArtifactRetirementDriver } from '../../adapters/providers/gcp/gcp-operator-artifact-retirement.js';
import { artifactRetirementBoundary } from '../../adapters/providers/gcp/__tests__/gcp-artifact-retirement.fixture.js';

// SQLite, ordinary spec/plan/apply and provider driver are real. Only local
// Docker/ADC preparation and serialized native responses are synthetic.
describe('reviewed private candidate publication through application and SQLite',()=>{
  let directory:string;
  beforeEach(()=>{directory=mkdtempSync(path.join(tmpdir(),'hv-candidate-app-'));vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC','true');SqliteAdapter.resetInstance();SqliteAdapter.getInstance(path.join(directory,'state.db')).migrate();});
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();SqliteAdapter.resetInstance();rmSync(directory,{recursive:true,force:true});});
  function fixture(lostAck=false) {
    const native=candidateBoundary({lostAck}), capability=providerRegistry.getArtifactPublication('cloudrun')!;
    const ctx=createCommandContext(),project=ctx.repos.projects.create({name:'original-operator-app',defaultPlatform:'cloudrun',gitRemoteUrl:'https://github.com/acme/operator.git'});
    native.intent.customerId=project.id;native.intent.appId=project.id;
    const n=native.intent.nativeScope;
    const providerScope=Object.fromEntries(['projectId','projectNumber','projectCreateTime','projectParent','projectInstallationId','projectAttemptId','billingAccountName','region','artifactRepository','artifactRepositoryName','artifactRepositoryCreateTime','artifactInstallationId','artifactAttemptId'].map(key=>[key,n[key]]));
    const environment=ctx.repos.environments.create({projectId:project.id,name:'staging',platformBindings:{provider:'cloudrun',projectId:n.projectId,providerScope}});
    const desired={version:1,project:project.name,environments:{staging:{hosting:{provider:'cloudrun'},services:{web:{}},email:{enabled:false},operatorArtifacts:{candidate:{provider:'cloudrun',artifacts:['application-candidate-v1'],nativeScope:Object.fromEntries(['scopeKind','projectId','region','sourceDirectory','sourceCommit','imageName','packageReadAuthentication'].map(key=>[key,n[key]]))}}}}};
    const store=new SpecStore();store.replace(project,desired);
    const prepare=vi.spyOn(capability,'prepare').mockImplementation(async(scope,_artifacts,source)=>{
      expect(source.repository).toBe('github.com/acme/operator');expect(scope.sourceCommit).toBe(n.sourceCommit);return {...n,...scope,sourceRepository:source.repository};
    });
    vi.spyOn(capability,'create').mockResolvedValue({driver:native.context.driver,authentication:native.context.authentication});
    const retirementNatives = new Map<string, ReturnType<typeof artifactRetirementBoundary>>();
    vi.spyOn(capability.retirement!,'create').mockImplementation(async(_scope,_context,targets)=>{
      let boundary=retirementNatives.get(targets[0].installationId);
      if(!boundary){boundary=artifactRetirementBoundary(targets[0],native.request);retirementNatives.set(targets[0].installationId,boundary);}
      return {driver:createGcpOperatorArtifactRetirementDriver(targets,{fetch:boundary.request}),authentication:native.context.authentication};
    });
    const unrelated=vi.spyOn(adapterFactory,'getProviderAdapter').mockRejectedValue(new Error('Unexpected hosting access'));
    const plan=()=>new PlanService().plan(project,environment.name);
    const apply=(planId:string,confirmActions:string[])=>{const current=store.get(project)!;return executePlanApply(ctx,{project,spec:current.spec,specRevision:current.revision,planId,confirmActions});};
    return {native,capability,ctx,project,environment,desired,store,prepare,unrelated,plan,apply,retirementNatives};
  }
  async function retirementFixture(data: 'retain' | 'delete-owned' = 'delete-owned') {
    const f=fixture(),published=await f.plan();if('error'in published)throw new Error(published.error);
    expect(await f.apply(published.planRunId,published.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:true}});
    const saved=f.ctx.repos.runs.findById(published.planRunId)!.plan as any;
    const prior=f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    const desired=structuredClone(f.store.get(f.project)!.spec);desired.environments.staging.services={};
    desired.environments.staging.operatorArtifacts!.candidate.retirement={from:{installationId:prior.installationId,planDigest:prior.plan.digest},resources:'delete-owned',data};
    f.store.replace(f.project,desired);return {...f,prior,retirementDesired:desired};
  }
  it('requires exact publication confirmation and retains immutable content without changing repository or runtime permissions',async()=>{
    const f=fixture(),p=await f.plan();if('error'in p)throw new Error(p.error);
    expect(p.scope).toBe('operator-artifacts');expect(p.actions).toHaveLength(1);expect(f.native.writes).toEqual([]);
    expect(await f.apply(p.planRunId,[])).toMatchObject({kind:'executed',result:{success:false}});expect(f.native.writes).toEqual([]);
    expect(await f.apply(p.planRunId,p.actions.map(a=>a.id))).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.native.writes).toHaveLength(1);
    const saved=f.ctx.repos.runs.findById(p.planRunId)!.plan as any;
    const journal=f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    expect(journal.status).toBe('scope-ready');const receipts=f.capability.receipts(journal);
    expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({kind:'application-candidate-v1',authenticatedPull:'verified',sourceCommit:f.native.intent.nativeScope.sourceCommit});
    expect(JSON.stringify(receipts)).toContain('@sha256:');expect(JSON.stringify(journal)).not.toContain('synthetic-short-lived-token');
    expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.unrelated).not.toHaveBeenCalled();
  });
  it('plans explicit completed publication retirement without preparing another image or deleting its shared repository',async()=>{
    const f=fixture(),published=await f.plan();if('error'in published)throw new Error(published.error);
    expect(await f.apply(published.planRunId,published.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:true}});
    const saved=f.ctx.repos.runs.findById(published.planRunId)!.plan as any;
    const prior=f.ctx.repos.runs.findById(saved.artifactPublication.installationId)!.plan as any;
    const priorBytes=JSON.stringify(prior),writes=f.native.writes.length;
    const desired=structuredClone(f.store.get(f.project)!.spec);
    desired.environments.staging.services={};
    desired.environments.staging.operatorArtifacts!.candidate.retirement={
      from:{installationId:prior.installationId,planDigest:prior.plan.digest},resources:'delete-owned',data:'delete-owned',
    };
    f.store.replace(f.project,desired);
    const removal=await f.plan();
    expect(removal).toMatchObject({scope:'operator-artifacts'});
    if('error'in removal)throw new Error(removal.error);
    expect(removal.actions).toHaveLength(2);
    expect(removal.actions.every(item=>item.type==='destroy'&&item.requiresConfirm===true)).toBe(true);
    const malformed=structuredClone(f.ctx.repos.runs.findById(removal.planRunId)!.plan) as any;
    delete malformed.artifactPublication.bindingHash;for(const action of malformed.actions)delete action.metadata.bindingHash;
    expect(planRunDocumentSchema.safeParse(malformed).success).toBe(false);expect(malformed.actions.every((action:any)=>!isOperatorArtifactAction(action))).toBe(true);
    expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.unrelated).not.toHaveBeenCalled();
    expect(f.native.writes).toHaveLength(writes);
    expect(JSON.stringify(f.ctx.repos.runs.findById(prior.installationId)!.plan)).toBe(priorBytes);
    const boundary=f.retirementNatives.get(prior.installationId)!;
    expect(await f.apply(removal.planRunId,[])).toMatchObject({kind:'executed',result:{success:false}});expect(boundary.writes).toEqual([]);
    expect(await f.apply(removal.planRunId,removal.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:true}});
    expect(boundary.writes).toHaveLength(2);
    const terminal=await f.plan();expect(terminal).toMatchObject({scope:'operator-artifacts'});
    if('error'in terminal)throw new Error(terminal.error);expect(terminal.actions.every(item=>item.type==='noop')).toBe(true);
    expect(f.prepare).toHaveBeenCalledTimes(1);expect(JSON.stringify(f.ctx.repos.runs.findById(prior.installationId)!.plan)).toBe(priorBytes);
  });
  it('reports deliberately retained image data in the saved-plan/apply and terminal inspection results',async()=>{
    const f=await retirementFixture('retain'),planned=await f.plan();if('error'in planned)throw new Error(planned.error);
    expect.soft(planned.retirement).toEqual({complete:false,outcomes:[]});
    expect(planned.actions).toHaveLength(1);
    const applied:any=await f.apply(planned.planRunId,planned.actions.map(item=>item.id));
    expect(applied).toMatchObject({kind:'executed',result:{success:true}});
    const summary={complete:true,outcomes:[{actionId:planned.actions[0].id,
      resources:[{kind:'artifact-tag',id:planned.actions[0].resource.name}],outcome:'retained-by-choice',
      retained:[{kind:'artifact-image',id:expect.stringMatching(/@sha256:[a-f0-9]{64}$/),
        identity:{digest:expect.stringMatching(/^sha256:[a-f0-9]{64}$/),uploadTime:expect.any(String),repositoryCreateTime:expect.any(String)},reason:'data-retention'}]}]};
    expect.soft(applied.result.receipts.at(-1).data.retirement).toEqual(summary);
    expect(applied.result.receipts.at(-1).message).toMatch(/Artifact data.*remain by choice.*charges may continue/);
    const terminal=await f.plan();if('error'in terminal)throw new Error(terminal.error);
    expect.soft(terminal.retirement).toEqual(summary);
    expect(terminal.actions.every(item=>item.type==='noop')).toBe(true);
    expect(f.retirementNatives.get(f.prior.installationId)!.writes).toHaveLength(1);
    expect(terminal.warnings.join(' ')).toMatch(/charges|cost/i);
    expect(JSON.stringify([applied,terminal])).not.toContain('synthetic-short-lived-token');
  });
  it.each(['desired-service','native-service','runtime-identity','retained-backup-runtime','retained-ci','provider-change','foreign-source','missing-proof'] as const)('rejects retirement selection %s before provider reads or deletion',async variant=>{
    const f=await retirementFixture(),desired=structuredClone(f.retirementDesired),bindings=structuredClone(f.environment.platformBindings);
    if(variant==='desired-service')desired.environments.staging.services={web:{workloadKind:'web'}};
    if(variant==='native-service')bindings.services={web:{serviceId:'native-service'}};
    if(variant==='runtime-identity')bindings.runtimeIdentities={web:{provider:'cloudrun'}};
    if(variant==='retained-backup-runtime')bindings.recoveryRuntime={provider:'cloudrun',evidence:{accountUniqueId:'123456789',sourceSnapshot:JSON.stringify({runnerImage:'example.test/helper@sha256:'+'a'.repeat(64)})}};
    if(variant==='retained-ci')bindings.gcpGithubWorkloadIdentity={schemaVersion:1,projectId:f.native.intent.nativeScope.projectId,projectNumber:'123456789012',
      workloadIdentityProvider:'projects/123456789012/locations/global/workloadIdentityPools/owned-pool/providers/github',serviceAccountEmail:'ci-deployer@operator-project.iam.gserviceaccount.com',
      serviceAccountUniqueId:'123456789013',repository:'acme/operator',repositoryId:'1234',repositoryOwnerId:'123',branch:'main',environment:'staging',workflow:'.github/workflows/deploy.yml',backupWorkflow:'.github/workflows/hypervibe-backup-staging.yml'};
    if(variant==='provider-change')bindings.provider='railway';
    if(variant==='foreign-source')desired.gitRemoteUrl='https://github.com/other/operator.git';
    if(variant==='missing-proof')desired.environments.staging.operatorArtifacts!.candidate.retirement!.from.planDigest='0'.repeat(64);
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id,bindings);f.store.replace(f.project,desired);
    expect(await f.plan()).toHaveProperty('error');expect(f.capability.retirement!.create).not.toHaveBeenCalled();expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects a saved removal after complete binding drift without changing either journal',async()=>{
    const f=await retirementFixture(),plan=await f.plan();if('error'in plan)throw new Error(plan.error);
    const boundary=f.retirementNatives.get(f.prior.installationId)!,before=JSON.stringify(f.ctx.repos.runs.findById(f.prior.installationId)!.plan);
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id,{...f.environment.platformBindings,unrelated:{retained:'changed'}});
    expect(await f.apply(plan.planRunId,plan.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:false}});
    expect(boundary.writes).toEqual([]);expect(JSON.stringify(f.ctx.repos.runs.findById(f.prior.installationId)!.plan)).toBe(before);
  });
  it('recovers a retained uncertain removal after declaration omission with no preparation or DELETE replay',async()=>{
    const f=await retirementFixture(),plan=await f.plan();if('error'in plan)throw new Error(plan.error);
    const boundary=f.retirementNatives.get(f.prior.installationId)!;boundary.state.lostTagAck=true;
    expect(await f.apply(plan.planRunId,plan.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:false}});expect(boundary.writes).toHaveLength(1);
    const desired=structuredClone(f.retirementDesired);delete desired.environments.staging.operatorArtifacts;f.store.replace(f.project,desired);
    const recovery=await f.plan();if('error'in recovery)throw new Error(recovery.error);
    expect(recovery.scope).toBe('operator-artifacts');expect(recovery.actions.every(item=>item.type==='update'&&!item.requiresConfirm)).toBe(true);
    expect(boundary.writes).toHaveLength(1);expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('stops dependent version deletion when a concurrent binding change follows successful tag removal',async()=>{
    const f=await retirementFixture(),plan=await f.plan();if('error'in plan)throw new Error(plan.error);
    const boundary=f.retirementNatives.get(f.prior.installationId)!,request=boundary.request;
    boundary.request=async(input,init)=>{const response=await request(input,init);if(init?.method==='DELETE')f.ctx.repos.environments.updatePlatformBindings(f.environment.id,
      {...f.environment.platformBindings,unrelated:{retained:'concurrent'}});return response;};
    expect(await f.apply(plan.planRunId,plan.actions.map(item=>item.id))).toMatchObject({kind:'executed',result:{success:false}});
    expect(boundary.writes).toHaveLength(1);expect(boundary.state.image).toBe(true);
    const recovery=await f.plan();if('error'in recovery)throw new Error(recovery.error);
    expect(recovery.actions.every(item=>item.type!=='create')).toBe(true);expect(boundary.writes).toHaveLength(1);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.unrelated).toEqual({retained:'concurrent'});
    const continuation=await f.plan();if('error'in continuation)throw new Error(continuation.error);
    expect(continuation.actions.filter(item=>item.type!=='noop')).toEqual([expect.objectContaining({type:'destroy',requiresConfirm:true})]);
    boundary.request=request;
    expect(await f.apply(continuation.planRunId,continuation.actions.filter(item=>item.type!=='noop').map(item=>item.id))).toMatchObject({kind:'executed',result:{success:true}});
    expect(boundary.writes).toHaveLength(2);expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.unrelated).toEqual({retained:'concurrent'});
  });
  it('carries a real local command failure through plan without exposing command output or creating a publication',async()=>{
    const f=fixture();let dispatched=false;
    f.prepare.mockImplementation((scope,artifacts,source)=>prepareOperatorImages({...scope,sourceRepository:source.repository},artifacts,async()=>{
      dispatched=true;return runOperatorCommand(process.execPath,['-e',"process.stderr.write('synthetic-private-command-output');process.exit(23)"]);
    }));
    const result=await f.plan();expect(dispatched).toBe(true);
    expect(result).toMatchObject({error:expect.stringContaining('source-verification')});
    expect(result).toMatchObject({error:expect.stringContaining('command-failed')});
    expect(result).toMatchObject({error:expect.stringContaining('command=exit, exitCode=23')});
    expect(result).toMatchObject({error:expect.stringContaining('coding agent')});
    expect(JSON.stringify(result)).not.toContain('synthetic-private-command-output');expect(f.native.writes).toEqual([]);
  });
  it('keeps cleanup unverified in plan while ignoring an arbitrary exception message',async()=>{
    const f=fixture(),error=new OperatorArtifactPreparationError({phase:'image-build',reason:'command-failed',cleanup:'unverified',recoveryDirectory:'hypervibe-candidate-Abc123',
      commandFailure:{kind:'exit',exitCode:1,reported:['npm-E403','build-command-failed'],dockerfileLine:5,buildStep:'npm-install'}});
    error.message='private provider response';f.prepare.mockRejectedValue(error);
    const result=await f.plan();expect(result).toMatchObject({error:expect.stringContaining('cleanup is incomplete')});
    expect(result).toMatchObject({error:expect.stringContaining('hypervibe-candidate-Abc123/cleanup.json')});
    expect(result).toMatchObject({error:expect.stringContaining('phase=image-build')});
    expect(result).toMatchObject({error:expect.stringContaining('npm E403')});
    expect(result).toMatchObject({error:expect.stringContaining('npm dependency-install instruction')});
    expect(result).toMatchObject({error:expect.stringContaining('not a verified cause')});
    expect(JSON.stringify(result)).not.toContain('private provider response');expect(f.native.writes).toEqual([]);
  });
  it.each(['unknown','invalid-phase','invalid-recovery-directory'] as const)('keeps %s exceptions behind the generic plan boundary',async fault=>{
    const f=fixture(),error=fault==='unknown'?new Error('private-provider-token')
      :new OperatorArtifactPreparationError({phase:'cleanup',reason:'cleanup-unverified',cleanup:'unverified',recoveryDirectory:'hypervibe-candidate-Abc123'});
    if(fault==='invalid-phase')Object.assign(error,{phase:'private-provider-token'});
    if(fault==='invalid-recovery-directory')Object.assign(error,{recoveryDirectory:'/private-provider-token/cleanup.json'});
    f.prepare.mockRejectedValue(error);const result=await f.plan();
    expect(result).toMatchObject({error:expect.stringContaining('Operator artifacts could not be verified')});
    expect(JSON.stringify(result)).not.toContain('private-provider-token');expect(f.native.writes).toEqual([]);
  });
  it('recovers a lost push across restart/declaration removal without rebuilding or resubmitting',async()=>{
    const f=fixture(true);f.native.options.absentAfterPush=true;const p=await f.plan();if('error'in p)throw new Error(p.error);
    await f.apply(p.planRunId,p.actions.map(a=>a.id));expect(f.native.writes).toHaveLength(1);
    const changed:any=structuredClone(f.desired);delete changed.environments.staging.operatorArtifacts;f.store.replace(f.project,changed);
    SqliteAdapter.resetInstance();SqliteAdapter.getInstance(path.join(directory,'state.db')).migrate();
    const recovery=await f.plan();if('error'in recovery)throw new Error(recovery.error);expect(recovery.actions).toHaveLength(1);expect(recovery.actions[0]).toMatchObject({type:'update',requiresConfirm:false});
    f.native.options.absentAfterPush=false;await f.apply(recovery.planRunId,[]);expect(f.native.writes).toHaveLength(1);expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects stale and changed target authority before a push',async()=>{
    const f=fixture(),p=await f.plan();if('error'in p)throw new Error(p.error);
    const changed=structuredClone(f.desired);changed.environments.staging.operatorArtifacts.candidate.nativeScope.imageName='other-image';f.store.replace(f.project,changed);
    expect(await f.apply(p.planRunId,p.actions.map(a=>a.id))).toMatchObject({kind:'executed',result:{success:false}});expect(f.native.writes).toEqual([]);
  });
  it('does not inherit candidate publication support from other registered hosting/storage providers',()=>{
    const f=fixture();for(const provider of ['s3','ecs','azure-container-apps','railway','fly','digitalocean','vercel']){
      const capability=providerRegistry.getArtifactPublication(provider);if(capability)expect(()=>capability.parseDeclaration(f.desired.environments.staging.operatorArtifacts.candidate.nativeScope,['application-candidate-v1'],f.environment.platformBindings)).toThrow();
      else expect(capability).toBeUndefined();
    }
  });
});
