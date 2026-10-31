import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { CloudRunLocalPreparedRuntime } from '../../adapters/providers/gcp/cloudrun-local-prepared-runtime.js';
import { CloudRunPreparedHosting } from '../../adapters/providers/gcp/cloudrun-prepared-hosting.js';
import { planPreparedHosting } from '../../domain/services/hosting-prepared.service.js';
import { applyPreparedHosting } from '../apply-prepared-hosting.js';
import { observeRuntimeAccess,planRuntimeAccess,applyRuntimeAccessAction } from '../../domain/services/runtime-access.service.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import type { LocalPreparedHostingReceiptV1 } from '../../domain/ports/local-holding-preparation.port.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
import type { IProviderAdapter } from '../../domain/ports/provider.port.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { createPreparedDirectReleaseControl,completePreparedDirectRelease,reviewPreparedDirectReleaseActions } from '../../domain/services/prepared-direct-release.service.js';
import type { Service } from '../../domain/entities/service.entity.js';

// Real publication/holding SQLite journals, shared runtime-access plan/apply,
// native IAM serialization. Reconstructed responses, not live grant evidence.
// Cloud Run's Cloud SQL integration requires its service identity to have
// roles/cloudsql.client; administrative sign-in does not confer this on runtime.
// https://docs.cloud.google.com/sql/docs/postgres/connect-run
let directory:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'hv-prepared-sql-'));vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC','true');SqliteAdapter.resetInstance();SqliteAdapter.getInstance(join(directory,'state.db')).migrate();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();SqliteAdapter.resetInstance();rmSync(directory,{recursive:true,force:true});});
async function fixture(envVars:Record<string,string>={},secretReference=false){
  const f=await localHoldingApplicationFixture();
  for(let phase=0;phase<2;phase++){const p=await f.plan();if('error'in p)throw new Error(p.error);expect(await f.apply(p.planRunId,p.actions.map(a=>a.id))).toMatchObject({result:{success:true}});}
  const load=()=>f.ctx.repos.environments.findById(f.environment.id)!;
  const receipt=load().platformBindings.localPreparedHosting as LocalPreparedHostingReceiptV1;
  const account=receipt.runtimeIdentities.find(i=>i.workload==='web')!.principal;if(account.kind!=='gcp-service-account')throw new Error();
  const secretResource=`projects/${f.native.scope.projectNumber}/secrets/operator-token`;
  const environmentSpec=environmentSpecSchema.parse({...f.store.get(f.project)!.spec.environments.staging,envVars,database:{provider:'cloudsql',engine:'postgres'},
    ...(secretReference?{secretDestinations:{API_TOKEN:{destination:{provider:'gcp-secret-manager',projectId:'operator-project',projectNumber:f.native.scope.projectNumber,secretId:'operator-token'},version:'1'}}}:{})});
  const state={denied:false,denyAfterWrite:false,lost:false,absentAfterWrite:false,writes:0,policy:{etag:'original-etag',version:3,bindings:[{role:'roles/viewer',members:['user:unrelated@example.test']}]}};
  const secret={writes:0,lost:false,absentAfterWrite:false,denied:false,denyAfterWrite:false,replaced:false,
    policy:{etag:'secret-original',version:3,bindings:[{role:'roles/secretmanager.viewer',members:['user:unrelated@example.test']}]}};
  const request:typeof fetch=async(input,init={})=>{
    const url=String(input);
    if(url===`https://secretmanager.googleapis.com/v1/${secretResource}`)return Response.json({name:secretResource,createTime:secret.replaced?'2026-10-02T00:00:00Z':'2026-10-01T00:00:00Z'});
    if(url===`https://secretmanager.googleapis.com/v1/${secretResource}/versions/1`)return Response.json({name:`${secretResource}/versions/1`,state:'ENABLED'});
    if(url===`https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy?options.requestedPolicyVersion=3`)return secret.denied?Response.json({}, {status:403}):Response.json(secret.policy);
    if(url===`https://secretmanager.googleapis.com/v1/${secretResource}:setIamPolicy`){
      expect((load().platformBindings.runtimeIdentities as any).web.pending).toBeDefined();secret.writes++;
      const body=JSON.parse(String(init.body));expect(body.policy.etag).toBe('secret-original');
      expect(body.policy.bindings).toEqual([{role:'roles/secretmanager.viewer',members:['user:unrelated@example.test']},
        {role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:${account.serviceAccountEmail}`]}]);
      if(!secret.absentAfterWrite)secret.policy={etag:'secret-updated',version:3,bindings:[
        {role:'roles/secretmanager.viewer',members:['user:unrelated@example.test']},
        {role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:${account.serviceAccountEmail}`]},
      ]};
      if(secret.denyAfterWrite)secret.denied=true;
      if(secret.lost)throw new Error('Synthetic lost secret IAM acknowledgement');return Response.json(secret.policy);
    }
    if(url.endsWith(':testIamPermissions')&&url.includes('iam.googleapis.com'))return Response.json({permissions:['iam.serviceAccounts.actAs']});
    if(url===`https://cloudresourcemanager.googleapis.com/v1/projects/operator-project:getIamPolicy`
      ||url===`https://cloudresourcemanager.googleapis.com/v3/projects/${f.native.scope.projectNumber}:getIamPolicy`)return state.denied?Response.json({}, {status:403}):Response.json(state.policy);
    if(url===`https://cloudresourcemanager.googleapis.com/v1/projects/operator-project:setIamPolicy`){
      expect((load().platformBindings.runtimeIdentities as any).web.pending).toBeDefined();state.writes++;
      const body=JSON.parse(String(init.body));expect(body.policy.etag).toBe(state.policy.etag);
      expect(body.policy.bindings).toEqual([{role:'roles/viewer',members:['user:unrelated@example.test']},{role:'roles/cloudsql.client',members:[`serviceAccount:${account.serviceAccountEmail}`]}]);
      if(!state.absentAfterWrite)state.policy={...body.policy,etag:'updated-etag'};
      if(state.denyAfterWrite)state.denied=true;
      if(state.lost)throw new Error('Synthetic lost IAM acknowledgment');return Response.json(state.policy);
    }
    return f.native.request(input,init);
  };
  let runtime=new CloudRunLocalPreparedRuntime(async()=>receipt,async()=>'synthetic-local-holding-token',request);
  const preparedHosting=new CloudRunPreparedHosting(()=>{throw new Error('No hosted authority');},async()=>'synthetic-local-holding-token',request,()=>undefined,()=>async()=>receipt);
  const hosting={name:'cloudrun',get runtimeIdentities(){return runtime;},preparedHosting} as unknown as IHostingAdapter & IProviderAdapter;
  const metadata=await planPreparedHosting({environment:load(),environmentSpec,hosting});expect(metadata).not.toBeNull();
  vi.spyOn(f.ctx.adapterFactory,'getHostingAdapter').mockResolvedValue({success:true,adapter:hosting});
  expect(await applyPreparedHosting({ctx:f.ctx,project:f.project,environmentName:'staging',environmentSpec,action:metadata!,confirmedActionIds:new Set([metadata!.id]),authorize:()=>true})).toMatchObject({success:true});
  const input=()=>({environment:load(),environmentSpec,hosting,storageAdapters:{}});
  const plan=async()=>planRuntimeAccess(await observeRuntimeAccess(input())).filter(action=>action.resource.name==='web');
  const apply=(action:any,confirm=true)=>applyRuntimeAccessAction({...input(),action,confirmedActionIds:new Set(confirm?[action.id]:[]),
    save:bindings=>{f.ctx.repos.environments.updatePlatformBindings(f.environment.id,bindings);}});
  return {...f,load,account,receipt,state,secret,secretResource,plan,apply,request,environmentSpec,
    restart:()=>{runtime=new CloudRunLocalPreparedRuntime(async()=>receipt,async()=>'synthetic-local-holding-token',request);}};
}
describe('local prepared Cloud SQL runtime prerequisite',()=>{
  // Cloud Run requires the final service account to read referenced secrets:
  // https://docs.cloud.google.com/run/docs/configuring/services/secrets
  // IAM is on Secret (all versions), not SecretVersion. Reconstructed serialized
  // native observations exercise the real shared SQLite plan/apply boundary.
  it('reviews missing secret reader access before the separate SQL grant without manual IAM setup',async()=>{
    const f=await fixture({},true),[action]=await f.plan();
    expect(action).toMatchObject({verified:true,requiresConfirm:true,metadata:{step:{target:{phase:'local-prepared-secret-access',readerResource:f.secretResource}}}});
    expect((await f.apply(action,false)).success).toBe(false);expect(f.secret.writes).toBe(0);
    expect((await f.apply(action)).success).toBe(true);expect(f.secret.writes).toBe(1);expect(f.state.writes).toBe(0);
    const [sql]=await f.plan();expect(sql.metadata?.step).toMatchObject({target:{phase:'local-prepared-cloudsql-access'}});
    expect((await f.apply(sql)).success).toBe(true);expect(await f.plan()).toEqual([]);
    for(const workload of f.receipt.preparedResources.workloads)expect(f.native.services.get(workload.id).template.serviceAccount).toBe(workload.holding.principal.kind==='gcp-service-account'?workload.holding.principal.serviceAccountEmail:undefined);
  });
  it.each([false,true])('reconciles an uncertain secret reader grant without resubmission, absent=%s',async absent=>{
    const f=await fixture({},true),[action]=await f.plan();
    expect(action).toMatchObject({verified:true,requiresConfirm:true});
    f.secret.lost=true;f.secret.absentAfterWrite=absent;expect((await f.apply(action)).success).toBe(false);
    f.restart();
    const [recovery]=await f.plan();expect(recovery.requiresConfirm).not.toBe(true);
    expect((await f.apply(recovery,false)).success).toBe(!absent);expect(f.secret.writes).toBe(1);expect(f.state.writes).toBe(0);
  });
  it('retains acknowledged secret reader access through denied readback and recovers read-only',async()=>{
    const f=await fixture({},true),[action]=await f.plan();expect(action).toMatchObject({verified:true});
    f.secret.denyAfterWrite=true;expect((await f.apply(action)).success).toBe(false);f.secret.denied=false;
    const [recovery]=await f.plan();expect((await f.apply(recovery,false)).success).toBe(true);expect(f.secret.writes).toBe(1);
  });
  it('rejects changed secret lifetime before applying a reviewed reader grant',async()=>{
    const f=await fixture({},true),[action]=await f.plan();expect(action).toMatchObject({verified:true});
    f.secret.replaced=true;expect((await f.apply(action)).success).toBe(false);expect(f.secret.writes).toBe(0);
  });
  it('keeps unknown secret policy blocked without implying absence',async()=>{
    const f=await fixture({},true);f.secret.denied=true;expect((await f.plan()).some(a=>a.verified)).toBe(false);expect(f.secret.writes).toBe(0);
  });
  it('preserves already authorized reader access and skips its write',async()=>{
    const f=await fixture({},true);f.secret.policy.bindings.push({role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:${f.account.serviceAccountEmail}`]});
    const [action]=await f.plan();expect(action.metadata?.step).toMatchObject({target:{phase:'local-prepared-cloudsql-access'}});
    expect((await f.apply(action)).success).toBe(true);expect(f.secret.writes).toBe(0);
  });
  it('rejects an out-of-project reference without changing either identity',async()=>{
    const f=await fixture({},true);
    (f.environmentSpec.secretDestinations!.API_TOKEN.destination as {projectId:string}).projectId='another-project';
    expect((await f.plan()).some(a=>a.verified)).toBe(false);expect(f.secret.writes).toBe(0);expect(f.state.writes).toBe(0);
  });
  it('reviews one exact client grant to the final identity and requires confirmation before IAM mutation',async()=>{
    const f=await fixture(),[action]=await f.plan();expect(action).toMatchObject({verified:true,requiresConfirm:true,metadata:{step:{target:{phase:'local-prepared-cloudsql-access'}}}});
    expect((await f.apply(action,false)).success).toBe(false);expect(f.state.writes).toBe(0);
    expect((await f.apply(action)).success).toBe(true);expect(f.state.writes).toBe(1);expect(await f.plan()).toEqual([]);
    expect(f.load().platformBindings.localPreparedHosting).toEqual(f.receipt);
    for(const workload of f.receipt.preparedResources.workloads)expect(f.native.services.get(workload.id).template.serviceAccount).toBe(workload.holding.principal.kind==='gcp-service-account'?workload.holding.principal.serviceAccountEmail:undefined);
  });
  it.each([false,true])('recovers lost IAM acknowledgment, absent=%s, without resubmission',async absent=>{
    const f=await fixture();f.state.lost=true;f.state.absentAfterWrite=absent;const [action]=await f.plan();await f.apply(action);
    expect(f.state.writes).toBe(1);const [recovery]=await f.plan();expect(recovery.requiresConfirm).not.toBe(true);await f.apply(recovery,false);
    expect(f.state.writes).toBe(1);if(!absent)expect(await f.plan()).toEqual([]);
  });
  it('blocks unknown project policy without granting runtime readiness',async()=>{
    const f=await fixture();f.state.denied=true;const actions=await f.plan();expect(actions.some(a=>a.verified)).toBe(false);expect(f.state.writes).toBe(0);
  });
  it('retains an acknowledged grant after readback denial and then recovers without repeating it',async()=>{
    const f=await fixture();f.state.denyAfterWrite=true;const [action]=await f.plan();expect((await f.apply(action)).success).toBe(false);
    expect((f.load().platformBindings.runtimeIdentities as any).web.pending).toBeDefined();expect(f.state.writes).toBe(1);
    f.state.denied=false;const [recovery]=await f.plan();expect((await f.apply(recovery,false)).success).toBe(true);expect(f.state.writes).toBe(1);
  });
  it('releases the first application with the native Cloud SQL socket mount only after its separately reviewed final identity grant',async()=>{
    const connectionName='operator-project:us-central1:primary-db';
    const envVars={CLOUD_SQL_CONNECTION_NAME:connectionName,DATABASE_URL:`postgresql://app:synthetic-db-secret@/app?host=${encodeURIComponent(`/cloudsql/${connectionName}`)}`};
    const f=await fixture(envVars),web=f.receipt.preparedResources.workloads.find(item=>item.workload==='web')!;
    const image=`us-central1-docker.pkg.dev/operator-project/hypervibe/application-candidate@sha256:${'f'.repeat(64)}`;
    const adc=join(directory,'synthetic-adc.json');writeFileSync(adc,JSON.stringify({type:'authorized_user',client_id:'synthetic-client',client_secret:'synthetic-client-secret',refresh_token:'synthetic-refresh'}),{mode:0o600});
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS',adc);let patches=0;
    vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
      const url=new URL(String(input));
      if(url.href==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-local-holding-token',token_type:'Bearer',expires_in:3600});
      if(url.hostname==='run.googleapis.com'&&url.pathname===`/v2/${web.id}`&&init.method==='PATCH'){
        expect((f.load().platformBindings.preparedDirectReleaseAttempts as any).web.status).toBe('attempted');patches++;
        const body=JSON.parse(String(init.body));
        expect(body.template.volumes).toEqual([{name:'cloudsql',cloudSqlInstance:{instances:[connectionName]}}]);
        expect(body.template.containers[0].volumeMounts).toEqual([{name:'cloudsql',mountPath:'/cloudsql'}]);
        expect(body.template.serviceAccount).toBe(f.account.serviceAccountEmail);
        // Independent native Service representation: a PATCH echo would not
        // establish that Google's observed mount matches the reviewed payload.
        f.native.services.set(web.id,{...f.native.services.get(web.id),generation:'2',observedGeneration:'2',etag:'application-etag',
          latestCreatedRevision:`${web.id}/revisions/application-00002`,latestReadyRevision:`${web.id}/revisions/application-00002`,
          ingress:'INGRESS_TRAFFIC_ALL',invokerIamDisabled:false,template:{serviceAccount:f.account.serviceAccountEmail,executionEnvironment:'EXECUTION_ENVIRONMENT_GEN2',
            scaling:{minInstanceCount:0,maxInstanceCount:100},timeout:'300s',maxInstanceRequestConcurrency:80,
            volumes:[{name:'cloudsql',cloudSqlInstance:{instances:['operator-project:us-central1:primary-db']}}],
            containers:[{image,ports:[{containerPort:8080}],env:Object.entries(envVars).map(([name,value])=>({name,value})),
              volumeMounts:[{name:'cloudsql',mountPath:'/cloudsql'}],resources:{limits:{cpu:'1',memory:'512Mi'},cpuIdle:true,startupCpuBoost:false},
              startupProbe:{tcpSocket:{port:8080},periodSeconds:240,timeoutSeconds:240,failureThreshold:1}}]}});
        return Response.json({name:'projects/operator-project/locations/us-central1/operations/application',done:true,response:{name:web.id,uid:web.lifetimeId}});
      }
      return f.request(input,init);
    });
    const adapter=new CloudRunAdapter();await adapter.connect({authMode:'default',projectId:'operator-project',region:'us-central1'});adapter.configureLocalPreparedHosting(async()=>f.receipt);
    const now=new Date(),service:Service={id:'local-web',projectId:f.project.id,name:'web',buildConfig:{public:true},envVarSpec:{},createdAt:now,updatedAt:now};
    const action=reviewPreparedDirectReleaseActions([{id:'service:web',type:'update',verified:true,requiresConfirm:true,resource:{kind:'service',provider:'cloudrun',name:'web'},reason:'Reviewed first release'}],f.load(),{web:image})[0]!;
    const control=createPreparedDirectReleaseControl({planRunId:'reviewed-sql-release',action,confirmed:true,expectedImage:image,load:f.load,
      save:(before,next)=>!!f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id,before.platformBindings,next),authorize:()=>true});
    expect((await adapter.deploy(service,f.load(),{...envVars,IMAGE_URI:image},{preparedRelease:control})).receipt.success).toBe(false);expect(patches).toBe(0);
    const [grant]=await f.plan();expect((await f.apply(grant)).success).toBe(true);expect(f.state.writes).toBe(1);
    const deployed=await adapter.deploy(service,f.load(),{...envVars,IMAGE_URI:image},{preparedRelease:control});
    expect(deployed.receipt.success,deployed.receipt.error).toBe(true);expect(patches).toBe(1);
    const before=f.load(),next=completePreparedDirectRelease(before,deployed.receipt.data!.preparedRelease);
    expect(f.ctx.repos.environments.compareAndSwapPlatformBindings(before.id,before.platformBindings,next)).toBeTruthy();
    expect(f.load().platformBindings.preparedHosting).toMatchObject({pendingFirstRelease:['worker']});
    expect(f.load().platformBindings.localPreparedHosting).toEqual(f.receipt);
  });
});
