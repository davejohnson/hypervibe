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
    const providerScope=Object.fromEntries(['projectId','projectNumber','projectCreateTime','projectParent','projectInstallationId','projectAttemptId','region','artifactRepository','artifactRepositoryName','artifactRepositoryCreateTime','artifactInstallationId','artifactAttemptId'].map(key=>[key,n[key]]));
    const environment=ctx.repos.environments.create({projectId:project.id,name:'staging',platformBindings:{provider:'cloudrun',projectId:n.projectId,providerScope}});
    const desired={version:1,project:project.name,environments:{staging:{hosting:{provider:'cloudrun'},services:{web:{}},email:{enabled:false},operatorArtifacts:{candidate:{provider:'cloudrun',artifacts:['application-candidate-v1'],nativeScope:Object.fromEntries(['scopeKind','projectId','region','sourceDirectory','sourceCommit','imageName','packageReadAuthentication'].map(key=>[key,n[key]]))}}}}};
    const store=new SpecStore();store.replace(project,desired);
    const prepare=vi.spyOn(capability,'prepare').mockImplementation(async(scope,_artifacts,source)=>{
      expect(source.repository).toBe('github.com/acme/operator');expect(scope.sourceCommit).toBe(n.sourceCommit);return {...n,...scope,sourceRepository:source.repository};
    });
    vi.spyOn(capability,'create').mockResolvedValue({driver:native.context.driver,authentication:native.context.authentication});
    const unrelated=vi.spyOn(adapterFactory,'getProviderAdapter').mockRejectedValue(new Error('Unexpected hosting access'));
    const plan=()=>new PlanService().plan(project,environment.name);
    const apply=(planId:string,confirmActions:string[])=>{const current=store.get(project)!;return executePlanApply(ctx,{project,spec:current.spec,specRevision:current.revision,planId,confirmActions});};
    return {native,capability,ctx,project,environment,desired,store,prepare,unrelated,plan,apply};
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
