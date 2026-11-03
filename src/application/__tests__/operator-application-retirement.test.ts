import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudScopePreparationRepository, acceptedJournalLeaf } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { executePlanApply } from '../apply-plan.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { applyCloudInstallationV1, planCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import { inspectOperatorApplications } from '../../domain/services/operator-application.service.js';
import { createEntraOperatorApplicationDriver } from '../../adapters/providers/entra/entra-operator-application.js';
import { entraNativeFixture } from '../../adapters/providers/entra/__tests__/entra-operator-application.fixture.js';
import { DefaultAzureCredential } from '@azure/identity';

// Graph transport is reconstructed from official DELETE/204 and deletedItems
// contracts. Original app/FIC ownership comes from real create/apply receipts.
// Consumers are modeled as already removed by their separate hosting lifecycle;
// no native teardown compatibility is claimed by this application boundary test.
describe('completed operator application retirement', () => {
  let directory: string;
  beforeEach(() => { directory=mkdtempSync(path.join(tmpdir(),'hv-entra-retirement-'));vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC','true');vi.stubEnv('HYPERVIBE_DATA_DIR',directory);SqliteAdapter.resetInstance();SqliteAdapter.getInstance(path.join(directory,'state.db')).migrate(); });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();SqliteAdapter.resetInstance();rmSync(directory,{recursive:true,force:true});});
  async function fixture(existing?: {ctx:ReturnType<typeof createCommandContext>;commands:CommandRegistry;project:any;environment:any;name:string}) {
    const ctx=existing?.ctx??createCommandContext(),commands=existing?.commands??new CommandRegistry();if(!existing)registerCoreTools(commands,ctx);const name=existing?.name??'azure';
    const project=existing?.project??ctx.repos.projects.create({name:'retire-operator',defaultPlatform:'cloudrun',gitRemoteUrl:'https://github.com/acme/operator'});
    const environment=existing?.environment??ctx.repos.environments.create({projectId:project.id,name:'test',platformBindings:{provider:'cloudrun'}});
    const native=entraNativeFixture();let app:any,deleted:any,appGone=false,ficGone=false,lost:string|undefined,denied=false,owners:string[]=[randomUUID()],deleteRejected=false,echo=false,extraFic=false,hideDeleted=false,denyAfterDelete=false,servicePrincipal=false;
    const deletes:string[]=[];const reads:string[]=[];
    const request:typeof fetch=async(input,init)=>{
      const url=new URL(String(input)),method=init?.method??'GET';
      expect(url.origin).toBe('https://graph.microsoft.com');
      if(method==='GET')reads.push(url.pathname);
      if((denied || denyAfterDelete && deletes.length > 0)&&method==='GET')return Response.json({}, {status:403});
      if(method==='DELETE'){
        if (deleteRejected) return Response.json({}, {status:403});
        expect(init?.body).toBeUndefined();expect(url.search).toBe('');expect(new Headers(init?.headers).has('if-match')).toBe(false);
        if(url.pathname===`/v1.0/applications/${native.applicationId}/federatedIdentityCredentials/${native.ficId}`){ficGone=true;deletes.push('federation');}
        else if(url.pathname===`/v1.0/applications/${native.applicationId}`){expect(ficGone).toBe(true);appGone=true;deleted={...app,'@odata.type':'#microsoft.graph.application',deletedDateTime:'2026-11-03T23:00:00Z'};deletes.push('application');}
        else throw Error('Unreviewed DELETE path');
        if(lost===deletes.at(-1))throw Error('Synthetic lost acknowledgement');
        return new Response(null,{status:204});
      }
      if(method==='GET'&&url.pathname==='/v1.0/servicePrincipals'){expect(url.searchParams.get('$filter')).toBe(`appId eq '${native.appId}'`);return Response.json({value:servicePrincipal?[{id:randomUUID(),appId:native.appId}]:[]});}
      if(method==='GET'&&url.pathname===`/v1.0/applications/${native.applicationId}/owners`)return Response.json({value:owners.map(id=>({id})),...(echo?{unselected:'synthetic-transient-graph-token'}:{})});
      if(method==='GET'&&extraFic&&url.pathname===`/v1.0/applications/${native.applicationId}/federatedIdentityCredentials`)return Response.json({value:[{id:randomUUID()},{id:randomUUID()}]});
      if(method==='GET'&&url.pathname===`/v1.0/directory/deletedItems/${native.applicationId}`)return deleted&&!hideDeleted?Response.json(deleted):Response.json({}, {status:404});
      if(method==='GET'&&appGone&&url.pathname===`/v1.0/applications/${native.applicationId}`)return Response.json({}, {status:404});
      if(method==='GET'&&ficGone&&url.pathname===`/v1.0/applications/${native.applicationId}/federatedIdentityCredentials`)return Response.json({value:[]});
      const response=await native.request(input,init);
      if(method==='POST'&&response.status===201){const body=await response.clone().json();if(url.pathname==='/v1.0/applications')app=body;}
      return response;
    };
    vi.stubGlobal('fetch',request);vi.spyOn(DefaultAzureCredential.prototype,'getToken').mockResolvedValue({token:'synthetic-transient-graph-token',expiresOnTimestamp:Date.now()+3600000});
    const capability=providerRegistry.getOperatorApplication('microsoft-entra')!;
    const store=new CloudScopePreparationRepository<any>({projectId:project.id,environmentId:environment.id,environmentName:environment.name},value=>capability.parseRecord(value),{recordType:`operator-applications:${name}`});
    const originalDeclaration = {provider:'microsoft-entra',profile:'hypercloud-connect-v1',originService:'web',runtimeService:'web',nativeScope:{tenantId:native.tenantId}};
    const originalSpec:any=new SpecStore().get(project)?.spec??{version:1,project:project.name,gitRemoteUrl:project.gitRemoteUrl,environments:{test:{hosting:{provider:'cloudrun'},services:{},operatorApplications:{}}}};originalSpec.environments.test.operatorApplications[name]=originalDeclaration;
    const originalSource=new SpecStore().replace(project,originalSpec);
    const setup:any={schemaVersion:1,installationId:randomUUID(),customerId:project.id,appId:project.id,environment:'test',source:{kind:'local-spec',repository:'github.com/acme/operator',specRevision:originalSource.revision,specDigest:canonicalJsonSha256(originalSource.spec)},provider:'microsoft-entra',applicationProvider:'microsoft-entra',execution:{kind:'operator-application',authentication:'local-operator'},mode:'connect',stage:'scope-preparation',keys:[],selection:{declarationDigest:canonicalJsonSha256(originalDeclaration)},nativeScope:{tenantId:native.tenantId,name,origin:'https://operator.example.test',googleSubject:'123456789012345678901',googleServiceAccount:'runtime@owned-project.iam.gserviceaccount.com'}};
    const context:any={driver:createEntraOperatorApplicationDriver({fetch:request}),authentication:{kind:'operator-application',administrator:{getAccessToken:async()=> 'synthetic-transient-graph-token'}},authorize:async()=>true,store};
    let record=await planCloudInstallationV1({...context,intent:setup});record=await applyCloudInstallationV1({...context,installationId:record.installationId,planDigest:record.plan.digest,confirmActions:record.plan.actions.map((a:any)=>a.id)});expect(record.status).toBe('scope-ready');
    const declaration={provider:'microsoft-entra',profile:'hypercloud-connect-v1',originService:'web',runtimeService:'web',nativeScope:{tenantId:native.tenantId},retirement:{from:{installationId:record.installationId,planDigest:record.plan.digest},resources:'delete-owned',data:'retain'}};
    const spec:any=structuredClone(originalSource.spec);spec.environments.test.operatorApplications[name]=declaration;
    const write=await commands.execute('hv_spec',{project:project.name,spec,replace:true});expect(write.ok,JSON.stringify(write)).toBe(true);
    const creation=vi.spyOn(capability,'create').mockRejectedValue(Error('Retirement must not require the disappeared origin or issue credentials'));
    const plan=()=>commands.execute('hv_plan',{project:project.name,env:'test'});
    const apply=async(result:any)=>{expect(result.ok,JSON.stringify(result)).toBe(true);const current=new SpecStore().get(project)!;return executePlanApply(ctx,{project,spec:current.spec,specRevision:current.revision,planId:result.data.planId,confirmActions:result.data.actions.filter((a:any)=>a.requiresConfirm).map((a:any)=>a.id)});};
    return {ctx,commands,project,environment,store,record,spec,plan,apply,creation,deletes,reads,native,set lost(value:string|undefined){lost=value;},set denied(value:boolean){denied=value;},set owners(value:string[]){owners=value;},set deleteRejected(value:boolean){deleteRejected=value;},set echo(value:boolean){echo=value;},set extraFic(value:boolean){extraFic=value;},set hideDeleted(value:boolean){hideDeleted=value;},set denyAfterDelete(value:boolean){denyAfterDelete=value;},set servicePrincipal(value:boolean){servicePrincipal=value;}};
  }
  it('reviews and retires only the owned FIC then soft-deletes the app after consumers are gone',async()=>{
    const f=await fixture(),plan:any=await f.plan();expect(plan.ok,JSON.stringify(plan)).toBe(true);
    expect(plan.data.scope).toBe('operator-applications');expect(plan.data.actions.map((a:any)=>a.type)).toEqual(['destroy','destroy']);
    expect(plan.data.actions[1].dependsOn).toEqual([plan.data.actions[0].id]);
    expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    const leaf=acceptedJournalLeaf(await f.store.findByScope())!;expect(leaf.status).toBe('retired');expect(f.deletes).toEqual(['federation','application']);
    expect(await f.store.read(f.record.installationId)).toEqual(f.record);expect(f.creation).not.toHaveBeenCalled();
    expect(JSON.stringify(leaf)).toContain('deletion-scheduled');expect(JSON.stringify(leaf)).not.toContain('synthetic-transient-graph-token');
  });
  it('shows the same recorded native retirement outcomes in plan, apply and status without extra provider reads', async () => {
    const f = await fixture(), planned: any = await f.plan();
    expect.soft(planned.data.retirement).toEqual({ complete: false, outcomes: [] });
    const applied: any = await f.apply(planned);
    const outcomes = [
      { actionId: planned.data.actions[0].id, resources: [{ kind: 'federation', id: f.native.ficId }], outcome: 'removed', retained: [] },
      { actionId: planned.data.actions[1].id, resources: [{ kind: 'application', id: f.native.applicationId }], outcome: 'deletion-scheduled',
        retained: [{ kind: 'application', id: f.native.applicationId, reason: 'provider-retention', identity: {
          tenantId: f.native.tenantId, applicationId: f.native.applicationId, clientId: f.native.appId,
          createdDateTime: expect.any(String), deletedDateTime: '2026-11-03T23:00:00Z', documentedRecoveryWindowDays: '30',
        } }] },
    ];
    const summary = { complete: true, outcomes };
    expect.soft(applied.result.receipts.at(-1).data.retirement).toEqual(summary);
    const reads = f.reads.length;
    const status: any = await f.commands.execute('hv_status', { project: f.project.name, env: 'test' });
    expect.soft(status.data.registrations[0].retirement).toEqual(summary);
    expect.soft(status.hint).not.toMatch(/setup needs/i);
    expect.soft(status.hint).toMatch(/retain|recoverable/i);
    const repeated: any = await f.plan();
    expect.soft(repeated.data.retirement).toEqual(summary);
    expect(f.reads).toHaveLength(reads);
    expect(JSON.stringify([applied, status, repeated])).not.toContain('synthetic-transient-graph-token');
  });
  it.each(['credential-field', 'private-url', 'extra-outcome-field'])('blocks %s in a provider retirement projection without exposing it', async invalid => {
    const f = await fixture(); await f.apply(await f.plan());
    const capability = providerRegistry.getOperatorApplication('microsoft-entra')!, parse = capability.parseRecord;
    const canary = 'retirement-projection-private-value';
    vi.spyOn(capability, 'parseRecord').mockImplementation(value => {
      const record = parse(value);
      if (record.status === 'retired') {
        const outcome: any = Object.values(record.completed).find((entry: any) => entry.native.operation === 'remove-application')!.native.retirement;
        if (invalid === 'credential-field') outcome.retained[0].identity.credentials = canary;
        if (invalid === 'private-url') outcome.retained[0].identity.applicationId = `postgresql://user:${canary}@private/database`;
        if (invalid === 'extra-outcome-field') outcome.providerResponse = { secret: canary };
      }
      return record;
    });
    const reads = f.reads.length;
    const status: any = await f.commands.execute('hv_status', { project: f.project.name, env: 'test' });
    const plan: any = await f.plan();
    expect(status.ok).toBe(false); expect(plan.ok).toBe(false);
    expect(JSON.stringify([status, plan])).not.toContain(canary);
    expect(f.reads).toHaveLength(reads);
  });
  it('keeps unverified deletion out of partial completion and excludes unrelated provider payloads', async () => {
    const f = await fixture(), planned: any = await f.plan(); f.lost = 'application';
    const applied: any = await f.apply(planned);
    expect(applied.result.receipts.at(-1).data.retirement).toEqual({ complete: false, outcomes: [
      { actionId: planned.data.actions[0].id, resources: [{ kind: 'federation', id: f.native.ficId }], outcome: 'removed', retained: [] },
    ] });
    f.lost = undefined;
    const recovered: any = await f.plan(); expect(recovered.data.retirement.complete).toBe(true);
    const capability = providerRegistry.getOperatorApplication('microsoft-entra')!, parse = capability.parseRecord;
    const canary = 'unselected-private-provider-payload';
    vi.spyOn(capability, 'parseRecord').mockImplementation(value => {
      const record = parse(value);
      if (record.status === 'retired') for (const evidence of Object.values(record.completed)) evidence.native.unrelatedProviderPayload = canary;
      return record;
    });
    const reads = f.reads.length;
    const status: any = await f.commands.execute('hv_status', { project: f.project.name, env: 'test' });
    expect(status.ok).toBe(true);
    expect(status.data.registrations[0].retirement).toEqual(recovered.data.retirement);
    expect(JSON.stringify(status)).not.toContain(canary);
    expect(f.reads).toHaveLength(reads);
    expect(f.deletes).toEqual(['federation', 'application']);
  });
  it('blocks an unremoved runtime consumer before Graph observation',async()=>{
    const f=await fixture();const changed=structuredClone(f.spec);changed.environments.test.services.web={};new SpecStore().replace(f.project,changed);const before=f.reads.length;
    const plan:any=await f.plan();expect(plan.ok).toBe(false);expect(plan.error.message).toMatch(/consumer|runtime|service/i);expect(f.reads.length).toBe(before);expect(f.deletes).toEqual([]);
  });
  it.each(['federation','application'])('recovers lost %s acknowledgment by reads only and preserves the single deletion',async(operation)=>{
    const f=await fixture(),plan:any=await f.plan();f.lost=operation;
    const first:any=await f.apply(plan);expect(first.result.success).toBe(false);expect(f.deletes.filter(value=>value===operation)).toHaveLength(1);
    const before=[...f.deletes];f.lost=undefined;const next:any=await f.plan();expect(next.ok,JSON.stringify(next)).toBe(true);
    expect(f.deletes).toEqual(before);
    if(operation==='federation'){expect(next.data.actions.filter((a:any)=>a.requiresConfirm).map((a:any)=>a.resource.name)).toEqual([f.native.applicationId]);expect(await f.apply(next)).toMatchObject({kind:'executed',result:{success:true}});}
    else {expect(next.data.actions.every((a:any)=>a.type==='noop')).toBe(true);expect(await f.apply(next)).toMatchObject({kind:'executed',result:{success:true}});}
    expect(f.deletes).toEqual(['federation','application']);expect(acceptedJournalLeaf(await f.store.findByScope())!.status).toBe('retired');
  });
  it('keeps a denied post-ack read unresolved and never retries its DELETE',async()=>{
    const f=await fixture(),plan:any=await f.plan();f.denyAfterDelete=true;
    expect((await f.apply(plan) as any).result.success).toBe(false);let leaf=acceptedJournalLeaf(await f.store.findByScope())!;
    expect(leaf.attempts.at(-1)!.status).not.toBe('rejected');expect(f.deletes).toEqual(['federation']);
    const pending:any=await f.plan();expect(pending.ok).toBe(true);expect(pending.data.actions.every((a:any)=>!a.requiresConfirm)).toBe(true);
    expect((await f.apply(pending) as any).result.success).toBe(false);expect(f.deletes).toEqual(['federation']);
    f.denyAfterDelete=false;const next:any=await f.plan();expect(await f.apply(next)).toMatchObject({kind:'executed',result:{success:true}});
    expect(f.deletes).toEqual(['federation','application']);
  });
  it('does not treat active absence without the exact deleted object as completed',async()=>{
    const f=await fixture(),plan:any=await f.plan();f.lost='application';f.hideDeleted=true;
    expect((await f.apply(plan) as any).result.success).toBe(false);const next:any=await f.plan();expect(next.ok).toBe(true);
    expect(next.data.actions.every((a:any)=>!a.requiresConfirm)).toBe(true);expect((await f.apply(next) as any).result.success).toBe(false);
    expect(acceptedJournalLeaf(await f.store.findByScope())!.status).not.toBe('retired');expect(f.deletes).toEqual(['federation','application']);
  });
  it('requires fresh explicit review after a definitely rejected delete',async()=>{
    const f=await fixture(),plan:any=await f.plan();f.deleteRejected=true;expect((await f.apply(plan) as any).result.success).toBe(false);
    expect(acceptedJournalLeaf(await f.store.findByScope())!.attempts.at(-1)!.status).toBe('rejected');expect(f.deletes).toEqual([]);
    f.deleteRejected=false;const retry:any=await f.plan();expect(retry.ok,JSON.stringify(retry)).toBe(true);expect(retry.data.actions.some((a:any)=>a.requiresConfirm)).toBe(true);
    expect(await f.apply(retry)).toMatchObject({kind:'executed',result:{success:true}});
    const remaining:any=await f.plan();expect(await f.apply(remaining)).toMatchObject({kind:'executed',result:{success:true}});expect(f.deletes).toEqual(['federation','application']);
  });
  it.each(['owner','lifetime','credential','trust'])('blocks changed %s before dispatch',async(change)=>{
    const f=await fixture(),plan:any=await f.plan();expect(plan.ok).toBe(true);
    if(change==='owner')f.owners=[randomUUID()];if(change==='lifetime')f.native.changeApplication({createdDateTime:'2020-01-01T00:00:00Z'});
    if(change==='credential')f.native.changeApplication({passwordCredentials:[{keyId:randomUUID()}]});if(change==='trust')f.extraFic=true;
    expect((await f.apply(plan) as any).result.success).toBe(false);expect(f.deletes).toEqual([]);
  });
  it.each(['permission','token-echo'])('keeps %s unknown without exposing response material',async(kind)=>{
    const f=await fixture();if(kind==='permission')f.denied=true;else f.echo=true;
    const plan:any=await f.plan();expect(plan.ok).toBe(false);expect(JSON.stringify(plan)).not.toContain('synthetic-transient-graph-token');expect(f.deletes).toEqual([]);
  });
  it('uses completed original evidence despite expired setup readiness and never replays setup',async()=>{
    const f=await fixture();const changed={...f.record,revision:f.record.revision+1,status:'blocked',reason:'authorization_expired',completed:{}};
    expect(await f.store.compareAndSwap(f.record.installationId,f.record.revision,changed)).toBe(true);
    const plan:any=await f.plan();expect(plan.ok,JSON.stringify(plan)).toBe(true);expect(await f.apply(plan)).toMatchObject({kind:'executed',result:{success:true}});
    expect(await f.store.read(f.record.installationId)).toEqual(changed);expect(f.creation).not.toHaveBeenCalled();
  });
  it.each(['renamed-selector','retained-binding','retained-identity','pending-backup'])('rejects %s before Graph reads',async(kind)=>{
    const f=await fixture();if(kind==='renamed-selector'){const changed=structuredClone(f.spec);changed.environments.test.operatorApplications.azure.originService='absent';new SpecStore().replace(f.project,changed);}
    else {const bindings:any=kind==='retained-binding'?{services:{web:{serviceId:'old'}}}:kind==='retained-identity'?{runtimeIdentities:{web:{provider:'cloudrun',evidence:{serviceAccount:'old'}}}}:{manualRecovery:{unverified:{}}};f.ctx.repos.environments.update(f.environment.id,{platformBindings:bindings});}
    const count=f.reads.length;expect((await f.plan() as any).ok).toBe(false);expect(f.reads).toHaveLength(count);expect(f.deletes).toEqual([]);
  });
  it('keeps a terminal retired leaf without native replay or setup readiness',async()=>{
    const f=await fixture();expect(await f.apply(await f.plan())).toMatchObject({kind:'executed',result:{success:true}});const before=f.reads.length;
    const repeated:any=await f.plan();expect(repeated.ok).toBe(true);expect(repeated.data.actions.every((a:any)=>a.type==='noop')).toBe(true);
    expect(await f.apply(repeated)).toMatchObject({kind:'executed',result:{success:true}});
    const status:any=await inspectOperatorApplications(f.project,'test',new SpecStore().get(f.project)!.spec);
    expect(status.verified).toBe(false);expect(status.registrations[0].status).toBe('retired');expect(f.reads).toHaveLength(before);expect(f.deletes).toEqual(['federation','application']);
  });

  it('advances past a completed first declaration to the next retirement',async()=>{
    const first=await fixture();expect(await first.apply(await first.plan())).toMatchObject({kind:'executed',result:{success:true}});
    const second=await fixture({...first,name:'zulu'});const next:any=await second.plan();expect(next.ok,JSON.stringify(next)).toBe(true);
    expect(next.data.actions.every((a:any)=>a.id.includes(':zulu:retire:'))).toBe(true);expect(next.data.actions.map((a:any)=>a.type)).toEqual(['destroy','destroy']);
    expect(await second.apply(next)).toMatchObject({kind:'executed',result:{success:true}});expect(second.deletes).toEqual(['federation','application']);expect(first.deletes).toEqual(['federation','application']);
  });

  it('does not authorize an unreviewed home-tenant service-principal cascade',async()=>{
    const f=await fixture();f.servicePrincipal=true;const result:any=await f.plan();expect(result.ok).toBe(false);expect(f.deletes).toEqual([]);
  });

  it.each(['desired-sibling','retained-sibling','previous-hosting','pending-backup-identity'])('blocks %s which can still consume shared operator outputs',async(kind)=>{
    const f=await fixture();if(kind==='desired-sibling'){const changed=structuredClone(f.spec);changed.environments.test.services.worker={};new SpecStore().replace(f.project,changed);}
    else {const bindings:any=kind==='retained-sibling'?{services:{worker:{serviceId:'old'}}}:kind==='previous-hosting'?{previousHosting:{provider:'cloudrun',services:{web:{serviceId:'old'}}}}:{recoveryRuntime:{provider:'cloudrun',evidence:{},pending:{attemptId:randomUUID(),step:{component:'identity',operation:'recover',target:{},description:'Recover existing backup identity',requiresConfirm:false}}}};f.ctx.repos.environments.update(f.environment.id,{platformBindings:bindings});}
    const count=f.reads.length;expect((await f.plan() as any).ok).toBe(false);expect(f.reads).toHaveLength(count);expect(f.deletes).toEqual([]);
  });

  it('never reuses an older unaccepted retirement after another disposition has an uncertain attempt', async () => {
    const f = await fixture();
    const oldPlan: any = await f.plan(); expect(oldPlan.ok).toBe(true);
    const changed = structuredClone(f.spec);
    changed.environments.test.operatorApplications.azure.retirement.data = 'delete-owned';
    new SpecStore().replace(f.project, changed);
    const acceptedPlan: any = await f.plan(); expect(acceptedPlan.ok, JSON.stringify(acceptedPlan)).toBe(true);
    f.lost = 'federation';
    expect((await f.apply(acceptedPlan) as any).result.success).toBe(false);
    const before = await f.store.findByScope(), readCount = f.reads.length;
    new SpecStore().replace(f.project, f.spec);
    const result: any = await f.plan();
    expect(result.ok).toBe(false);
    expect(f.reads).toHaveLength(readCount);
    expect(await f.store.findByScope()).toEqual(before);
    expect(f.deletes).toEqual(['federation']);
  });

  it('reports a safe provider-read permission failure without asserting that consumers remain', async () => {
    const f = await fixture(); f.denied = true;
    const result: any = await f.plan();
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/insufficient_permissions/);
    expect(result.error.message).toMatch(/read|sign in|access/i);
    expect(result.error.message).not.toMatch(/removed runtime consumers|finish pending release/i);
    expect(f.deletes).toEqual([]);
  });

});
