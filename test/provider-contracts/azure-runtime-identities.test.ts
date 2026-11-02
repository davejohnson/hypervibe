import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureRuntimeIdentities } from '../../src/adapters/providers/azure/azure-runtime-identities.js';
import { AzureResourceManagerClient } from '../../src/adapters/providers/azure/azure-resource-manager.client.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import type { RuntimeIdentityBinding, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../src/domain/ports/runtime-identity.port.js';
import type { IProviderAdapter } from '../../src/domain/ports/provider.port.js';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction, runtimeAccessBindings } from '../../src/domain/services/runtime-access.service.js';
// Reconstructed native responses from Microsoft Managed Identity 2024-11-30,
// Key Vault ARM 2024-11-01 and RBAC 2022-04-01; transport alone is replaced.
// https://learn.microsoft.com/en-us/rest/api/managedidentity/user-assigned-identities/create-or-update?view=rest-managedidentity-2024-11-30
// https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/create?view=rest-authorization-2022-04-01
const tenantId='11111111-1111-4111-8111-111111111111',subscriptionId='22222222-2222-4222-8222-222222222222';
const clientId='33333333-3333-4333-8333-333333333333', principalId='44444444-4444-4444-8444-444444444444';
const group=`/subscriptions/${subscriptionId}/resourceGroups/staging`, managed=`${group}/providers/Microsoft.App/managedEnvironments/staging`;
const app=`${group}/providers/Microsoft.App/containerApps/web`, vault=`/subscriptions/${subscriptionId}/resourceGroups/collection/providers/Microsoft.KeyVault/vaults/app-secrets`;
const role=`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`;
const timestamp='2026-10-24T00:00:00Z';
const historicalIdentity=`${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime-8f94120c25`;
const historicalOwner='6bcc765070fe15048b20ea242bce7288be7f71134aa9c55e37b1a765657dcdc8';
function fixture(options:{existing?:boolean;denied?:boolean;lose?:boolean;omitIdentitySystemData?:boolean}={}) {
 const client=new AzureResourceManagerClient({tenantId,subscriptionId,clientId,clientSecret:'synthetic-only'});
 const writes:Array<{method:string;id:string;body:any}>=[]; const resources=new Map<string,any>();
 const environment:any={id:'staging-local',projectId:'customer-app',name:'staging',createdAt:new Date(timestamp),updatedAt:new Date(timestamp),platformBindings:{provider:'azure-container-apps',projectId:group,environmentId:managed,...(options.existing?{services:{web:{serviceId:app}}}:{})}};
 resources.set(group,{id:group,tags:{'managed-by':'hypervibe','hypervibe-environment-id':environment.id},properties:{provisioningState:'Succeeded'}});
 resources.set(managed,{id:managed,tags:{'managed-by':'hypervibe','hypervibe-environment-id':environment.id},properties:{provisioningState:'Succeeded'}});
 if(options.existing)resources.set(app,{id:app,tags:{'managed-by':'hypervibe','hypervibe-environment-id':environment.id},identity:{type:'SystemAssigned',principalId,tenantId},properties:{managedEnvironmentId:managed,provisioningState:'Succeeded'}});
 resources.set(vault,{id:vault,systemData:{createdAt:timestamp},properties:{tenantId,enableRbacAuthorization:true,provisioningState:'Succeeded'}});
 const transport=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input)),method=init?.method??'GET';
  if(url.origin==='https://login.microsoftonline.com')return Response.json({access_token:'synthetic-arm-token',expires_in:3600});
  expect(url.origin).toBe('https://management.azure.com');const id=url.pathname;
  if(options.denied)return new Response(null,{status:403});
  if(method==='GET')return resources.has(id)?Response.json(resources.get(id)):new Response(null,{status:404});
  const body=init?.body?JSON.parse(String(init.body)):undefined;writes.push({method,id,body});
  if(method==='PUT'&&id.includes('/userAssignedIdentities/')) {
   resources.set(id,{id,name:id.split('/').at(-1),location:'canadacentral',tags:body.tags,properties:{tenantId,clientId:'55555555-5555-4555-8555-555555555555',principalId},...(options.omitIdentitySystemData?{}:{systemData:{createdAt:timestamp}})});
  } else if(method==='PUT'&&id.includes('/roleAssignments/')) {
   expect(body.properties).toMatchObject({principalId,roleDefinitionId:role,principalType:'ServicePrincipal'});
   resources.set(id,{id,properties:{...body.properties,scope:vault}});
  } else if(method==='DELETE')resources.delete(id);
  else throw new Error('Unexpected native mutation');
  if(options.lose)throw new Error('Lost response synthetic');
  return Response.json(resources.get(id)??{});
 });vi.stubGlobal('fetch',transport);
 const driver=new AzureRuntimeIdentities(()=>({client,tenantId,subscriptionId,deployClientId:clientId,location:'canadacentral'}));
 const request:RuntimeIdentityRequest={environment,service:{name:'web',buildConfig:{}},mode:'ensure',environmentSpec:environmentSpecSchema.parse({hosting:{provider:'azure-container-apps'},services:{web:{}},secretDestinations:{API_TOKEN:{destination:{provider:'azure-key-vault',tenantId,subscriptionId,resourceGroup:'collection',vaultName:'app-secrets',secretName:'api-token'},version:'a'.repeat(32)}}})};
 async function apply(step:RuntimeIdentityStep,attemptId='attempt-one',binding?:RuntimeIdentityBinding){const pending={provider:'azure-container-apps',evidence:binding?.evidence??{},pending:{attemptId,step}};return driver.apply({...request,binding:pending,step,attemptId});}
 // A fixed native fixture represents an exact historical operation, not a
 // current successful create. The real create path is blocked below.
 async function recoverIdentity(step:RuntimeIdentityStep){
  expect(step.target).toMatchObject({identityId:historicalIdentity,owner:historicalOwner});
  resources.set(historicalIdentity,{id:historicalIdentity,name:'runtime-8f94120c25',location:'canadacentral',tags:{hypervibeRuntime:historicalOwner,hypervibeAttempt:'attempt-one'},properties:{tenantId,clientId:'55555555-5555-4555-8555-555555555555',principalId},...(options.omitIdentitySystemData?{}:{systemData:{createdAt:timestamp}})});
  const binding={provider:'azure-container-apps',evidence:{},pending:{attemptId:'attempt-one',step}};
  const recovered=await driver.inspect({...request,binding});if(recovered.state!=='action')throw Error('missing recovery');
  return apply(recovered.step,'recovery-attempt',binding);
 }
 return{driver,request,apply,recoverIdentity,writes,resources,transport};
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('Azure runtime identity frontier',()=>{
 it('recovers a historical UAMI before the first app and grants reader access as a separately reviewed action',async()=>{
  const f=fixture();const first=await f.driver.inspect(f.request);expect(first).toMatchObject({state:'action',step:{operation:'create',requiresConfirm:true}});if(first.state!=='action')throw Error('missing action');
  const created=await f.recoverIdentity(first.step);expect(created.receipt.success).toBe(true);expect(f.writes).toHaveLength(0);
  const next=await f.driver.inspect({...f.request,binding:created.binding});expect(next).toMatchObject({state:'action',step:{operation:'attach',target:{phase:'reader-grant',vaultId:vault}}});if(next.state!=='action')throw Error('missing grant');
  const granted=await f.apply(next.step,'attempt-two',created.binding);expect(granted.receipt.success).toBe(true);expect(f.writes).toHaveLength(1);
  expect(await f.driver.inspect({...f.request,binding:granted.binding})).toMatchObject({state:'ready',identity:{provider:'azure',principal:principalId,source:'configured'}});
  expect(f.writes.every(write=>!write.id.includes('/containerApps/')&&!write.id.includes('/vaults/app-secrets/secrets/'))).toBe(true);
 });
 it('recovers a historical native identity after a lost response without a PUT',async()=>{
  const f=fixture({lose:true});const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');
  const historical=await f.recoverIdentity(planned.step);expect(historical.receipt.success).toBe(true);
  const pending={provider:'azure-container-apps',evidence:{},pending:{attemptId:'attempt-one',step:planned.step}};
  const recovery=await f.driver.inspect({...f.request,binding:pending});expect(recovery).toMatchObject({state:'action',step:{operation:'recover'}});if(recovery.state!=='action')throw Error('missing recovery');
  expect((await f.apply(recovery.step,'recovery-attempt',pending)).receipt.success).toBe(true);expect(f.writes).toHaveLength(0);
 });
 it('preserves an existing system identity and binds it without creating another principal',async()=>{
  const f=fixture({existing:true});const observed=await f.driver.inspect(f.request);expect(observed).toMatchObject({state:'action',step:{operation:'attach',target:{phase:'bind-existing',principalId}}});if(observed.state!=='action')throw Error('missing action');
  const bound=await f.apply(observed.step);expect(bound.receipt.success).toBe(true);expect(f.writes).toEqual([]);
  expect(await f.driver.inspect({...f.request,binding:bound.binding})).toMatchObject({state:'action',step:{target:{phase:'reader-grant',principalId}}});
 });
 it('does not turn permission denial into identity creation',async()=>{const f=fixture({denied:true});expect(await f.driver.inspect(f.request)).toMatchObject({state:'unknown'});expect(f.writes).toEqual([]);});
 it('does not recover an unobserved create by resubmitting',async()=>{const f=fixture();const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');const binding={provider:'azure-container-apps',evidence:{},pending:{attemptId:'lost',step:planned.step}};expect(await f.driver.inspect({...f.request,binding})).toMatchObject({state:'unknown'});expect(f.writes).toEqual([]);});
});

// The official IdentityGet example omits optional systemData; generated clientId
// and principalId, rather than creation-time metadata, establish UAMI lifetime.
it('accepts a valid UAMI response without optional systemData', async()=>{
 const f=fixture({omitIdentitySystemData:true});const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');
 const created=await f.recoverIdentity(planned.step);expect(created.receipt.success).toBe(true);expect(created.binding?.evidence).toMatchObject({principalId,clientId:'55555555-5555-4555-8555-555555555555'});
});
it('rejects a same-named replacement principal before another permission write',async()=>{
 const f=fixture();const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');const created=await f.recoverIdentity(planned.step);
 const id=historicalIdentity;f.resources.get(id).properties.principalId='77777777-7777-4777-8777-777777777777';
 expect(await f.driver.inspect({...f.request,binding:created.binding})).toMatchObject({state:'unknown'});expect(f.writes).toHaveLength(0);
});
it('does not authorize a different vault by editing the saved reader step',async()=>{
 const f=fixture();const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');const created=await f.recoverIdentity(planned.step);
 const grant=await f.driver.inspect({...f.request,binding:created.binding});if(grant.state!=='action')throw Error('missing grant');
 expect((await f.apply({...grant.step,target:{...grant.step.target,vaultId:vault+'-other'}},'attempt-two',created.binding)).receipt.success).toBe(false);expect(f.writes).toHaveLength(0);
});
it('recovers a lost reader grant acknowledgment without resending the assignment',async()=>{
 const options={lose:false},f=fixture(options);const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');const created=await f.recoverIdentity(planned.step);
 const grant=await f.driver.inspect({...f.request,binding:created.binding});if(grant.state!=='action')throw Error('missing grant');options.lose=true;
 expect((await f.apply(grant.step,'attempt-two',created.binding)).receipt.success).toBe(false);
 const binding={...created.binding!,pending:{attemptId:'attempt-two',step:grant.step}};
 const recovered=await f.driver.inspect({...f.request,binding});if(recovered.state!=='action')throw Error('missing recovery');
 expect((await f.apply(recovered.step,'recover-grant',binding)).receipt.success).toBe(true);expect(f.writes).toHaveLength(1);
});
it('does not create a production identity inside another environment’s bound Azure namespace',async()=>{
 const f=fixture();const request={...f.request,environment:{...f.request.environment,id:'production-local',name:'production'}};
 expect(await f.driver.inspect(request)).toMatchObject({state:'unknown'});expect(f.writes).toEqual([]);
});

it('carries native UAMI and vault-reader evidence through shared observation, exact planning, apply, and re-entry',async()=>{
 const f=fixture({omitIdentitySystemData:true});
 const hosting={name:'azure-container-apps',runtimeIdentities:f.driver} as unknown as IProviderAdapter;
 const input={environment:f.request.environment,environmentSpec:f.request.environmentSpec!,hosting,storageAdapters:{}};
 const save=(bindings:Record<string,unknown>)=>{input.environment.platformBindings={...input.environment.platformBindings,...structuredClone(bindings)};};
 const historical=await f.driver.inspect(f.request);if(historical.state!=='action')throw Error('missing historical action');
 await f.recoverIdentity(historical.step);
 save({runtimeIdentities:{web:{provider:'azure-container-apps',evidence:{},pending:{attemptId:'attempt-one',step:historical.step}}}});
 for(const phase of ['create','reader-grant']){
  const observed=await observeRuntimeAccess(input);expect(observed.invalid).toBeUndefined();
  const actions=planRuntimeAccess(observed);expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({verified:true,requiresConfirm:true,metadata:{operation:'runtimeIdentity',step:{target:{phase}}}});
  expect(await applyRuntimeAccessAction({...input,action:actions[0],confirmedActionIds:new Set(),save})).toMatchObject({success:false,status:'blocked'});
  const before=f.writes.length;
  expect(await applyRuntimeAccessAction({...input,action:actions[0],confirmedActionIds:new Set([actions[0].id]),save})).toMatchObject({success:true});
  expect(f.writes).toHaveLength(before+(phase==='create'?0:1));
  expect(runtimeAccessBindings(input.environment)).not.toBeNull();
 }
 const ready=await observeRuntimeAccess(input);
 expect(ready.identities[0].observation).toMatchObject({state:'ready',identity:{provider:'azure',principal:principalId}});
 expect(planRuntimeAccess(ready)).toEqual([]);
 expect(f.writes.map(write=>write.id)).toEqual([expect.stringContaining('/roleAssignments/')]);
 expect(JSON.stringify(input.environment.platformBindings)).not.toContain('synthetic-arm-token');
 expect(JSON.stringify(input.environment.platformBindings)).not.toContain('synthetic-only');
});

it('rejects unrecognized retained reader evidence instead of carrying it into later plans',async()=>{
 const f=fixture();const create=await f.driver.inspect(f.request);if(create.state!=='action')throw Error('missing action');
 const created=await f.recoverIdentity(create.step);const grant=await f.driver.inspect({...f.request,binding:created.binding});if(grant.state!=='action')throw Error('missing grant');
 const granted=await f.apply(grant.step,'attempt-two',created.binding);
 const altered=structuredClone(granted.binding!);const grants=JSON.parse(altered.evidence.readerGrants);grants[0].unexpectedValue='synthetic-sensitive-value';altered.evidence.readerGrants=JSON.stringify(grants);
 expect(await f.driver.inspect({...f.request,binding:altered})).toMatchObject({state:'unknown'});
 expect(f.writes).toHaveLength(1);
});

it('blocks first runtime UAMI mutation because ARM does not publish an atomic create admission contract',async()=>{
 const f=fixture();const planned=await f.driver.inspect(f.request);if(planned.state!=='action')throw Error('missing action');
 expect(await f.apply(planned.step)).toMatchObject({receipt:{success:false,data:{mutationAttempted:false,reason:'create_ownership_unverified'}}});
 expect(f.writes).toEqual([]);
});

it('preserves reader grants when references leave desired state or older active ACA revisions still consume them',async()=>{
 const f=fixture({existing:true});const first=await f.driver.inspect(f.request);if(first.state!=='action')throw Error('missing action');
 const bound=await f.apply(first.step);const grant=await f.driver.inspect({...f.request,binding:bound.binding});if(grant.state!=='action')throw Error('missing reader action');
 const granted=await f.apply(grant.step,'attempt-two',bound.binding);expect(granted.receipt.success).toBe(true);
 const activeRevision=`${app}/revisions/web--older`;f.resources.set(activeRevision,{id:activeRevision,name:'web--older',properties:{active:true,template:{containers:[{image:'example.invalid/app@sha256:'+'a'.repeat(64),env:[{name:'API_TOKEN',secretRef:'api-token'}]}]}}});
 const evidence=granted.binding!.evidence.readerGrants;const nativeBefore=structuredClone([...f.resources]);const writes=f.writes.length;
 const withoutReferences={...f.request,environmentSpec:{...f.request.environmentSpec!,secretDestinations:{}},binding:granted.binding};
 expect(await f.driver.inspect(withoutReferences)).toMatchObject({state:'ready'});
 expect(await f.driver.inspect({...withoutReferences,mode:'destroy'})).toMatchObject({state:'waiting'});
 expect((await f.driver.apply({...withoutReferences,mode:'destroy',attemptId:'unapproved-retirement',step:{...grant.step,operation:'destroy'}})).receipt.success).toBe(false);
 expect(granted.binding!.evidence.readerGrants).toBe(evidence);expect(f.writes).toHaveLength(writes);expect([...f.resources]).toEqual(nativeBefore);
});
