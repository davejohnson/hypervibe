import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { IRuntimeIdentities, RuntimeIdentityBinding, RuntimeIdentityRequest, RuntimeIdentityObservation, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import { parseAzureResourceGroupScope } from './azure-environment-scope.js';
import { azurePreparedGrantId, azurePreparedGrantDescription } from './azure-prepared-hosting.js';
import { azurePreparedHoldingTransition } from './azure-prepared-release.js';
const MI_API='2024-11-30', APP_API='2026-01-01', VAULT_API='2024-11-01', RBAC_API='2022-04-01';
const READER_ROLE='4633458b-17de-408a-b874-0445c86b69e6';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const guid=(value:unknown)=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
type Native=Record<string,any>;
interface Connection {client:AzureResourceManagerClient;tenantId:string;subscriptionId:string;deployClientId:string;location:string;deployment?:CloudDeploymentConnectionV1}
interface ReaderGrant {vaultId:string;createdAt:string;assignmentId:string;principalId:string}
const readerGrantSchema=z.object({vaultId:z.string().regex(/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[A-Za-z0-9_().-]+\/providers\/Microsoft\.KeyVault\/vaults\/[A-Za-z0-9-]+$/i),
 createdAt:z.string().datetime({offset:true}),assignmentId:z.string().min(1),principalId:z.string().guid()}).strict().refine(value=>value.assignmentId.toLowerCase().startsWith(`${value.vaultId}/providers/Microsoft.Authorization/roleAssignments/`.toLowerCase())&&uuid(value.assignmentId.split('/').at(-1)));
const failure=()=>new Error('Exact Azure runtime identity, ownership, or reader authority could not be verified.');
/** One identity/reader frontier per reviewed action. No secret data-plane requests. */
export class AzureRuntimeIdentities implements IRuntimeIdentities {
 constructor(private readonly connected:()=>Connection){}
 private coordinates(request:RuntimeIdentityRequest){
  const connection=this.connected(),{environment,service}=request;
  if(!uuid(connection.tenantId)||!uuid(connection.subscriptionId)||!uuid(connection.deployClientId))throw failure();
  const group=parseAzureResourceGroupScope(String(environment.platformBindings.projectId??''),connection.subscriptionId).resourceGroupId;
  const managed=environment.platformBindings.environmentId;
  if(typeof managed!=='string'||!managed.toLowerCase().startsWith(`${group}/providers/Microsoft.App/managedEnvironments/`.toLowerCase())||managed.split('/').length!==9)throw failure();
  const retained=request.binding?.evidence;
  const prepared=connection.deployment?.runtimeIdentities.find(item=>item.workload===service.name);
  if(connection.deployment&&(!prepared||prepared.principal.kind!=='azure-managed-identity'||connection.deployment.environment!==environment.name
   ||!same(group,`/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.deployment.nativeScope.resourceGroup}`)))throw failure();
  const owner=prepared?.owner??hash([connection.tenantId,connection.subscriptionId,environment.projectId,environment.id,service.name]);
  const name=resourceName('runtime',{scope:[environment.projectId,environment.id,service.name],minLength:3,maxLength:128});
  const identityId=prepared?.principal.kind==='azure-managed-identity'?prepared.principal.identityResourceId:`${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
  const bound=(environment.platformBindings.services as Record<string,{serviceId?:string}>|undefined)?.[service.name]?.serviceId;
  const workloadId=bound??`${group}/providers/Microsoft.App/containerApps/${resourceName(service.name,{minLength:2,maxLength:32})}`;
  if(!workloadId.toLowerCase().startsWith(`${group}/providers/Microsoft.App/containerApps/`.toLowerCase())||workloadId.split('/').length!==9)throw failure();
  if(request.binding&&(request.binding.provider!=='azure-container-apps'||Object.entries({tenantId:connection.tenantId,subscriptionId:connection.subscriptionId,environmentId:environment.id,serviceName:service.name,owner,workloadId}).some(([key,value])=>retained?.[key]!==undefined&&!same(retained[key],value))))throw failure();
  return {...connection,group,managed,identityId,owner,workloadId,bound,prepared};
 }
 private async read(request:RuntimeIdentityRequest){
  const scope=this.coordinates(request), retained=request.binding?.evidence;
  const app=await scope.client.getNullable<Native>(scope.workloadId,APP_API);
  const installedApp=scope.deployment?.preparedResources?.workloads.find(item=>item.workload===request.service.name);
  if(app&&(!scope.bound||!same(app.id,scope.workloadId)||!same(app.properties?.managedEnvironmentId,scope.managed)||app.properties?.provisioningState!=='Succeeded'))throw failure();
  if(app&&(installedApp?(app.systemData?.createdAt!==installedApp.lifetimeId||app.tags?.hypervibeInstallation!==scope.deployment!.installationId||app.tags?.hypervibeDeployment!==scope.owner)
   :app.tags?.['managed-by']!=='hypervibe'||app.tags?.['hypervibe-environment-id']!==request.environment.id))throw failure();
  const holding=app&&installedApp?azurePreparedHoldingTransition(scope.deployment!,request.environment,request.service.name,app):null;
  if(scope.bound&&!app&&request.mode==='ensure')throw failure();
  if(!app){
   for(const [id,version] of [[scope.group,'2024-11-01'],[scope.managed,APP_API]]){
    const namespace=await scope.client.getNullable<Native>(id,version);
    if(!namespace||!same(namespace.id,id)||namespace.tags?.['managed-by']!=='hypervibe'||namespace.tags?.['hypervibe-environment-id']!==request.environment.id||namespace.properties?.provisioningState!=='Succeeded')throw failure();
   }
  }
  const kind=retained?.kind??(scope.prepared?'user':app?'system':'user');
  if(!['system','user'].includes(kind))throw failure();
  let native:Native|null=null, principalId:string|undefined,clientId:string|undefined;
  if(kind==='system'){
   if(!app||!String(app.identity?.type).includes('SystemAssigned')||!uuid(app.identity?.principalId)||app.identity?.tenantId&&!same(app.identity.tenantId,scope.tenantId))throw failure();
   principalId=app.identity.principalId;
  } else {
   native=await scope.client.getNullable<Native>(scope.identityId,MI_API);
   if(native){
    const properties=native.properties;
    if(!same(native.id,scope.identityId)||!uuid(properties?.principalId)||!uuid(properties?.clientId)||!same(properties?.tenantId,scope.tenantId)||same(properties.clientId,scope.deployClientId)||native.systemData?.createdAt!==undefined&&typeof native.systemData.createdAt!=='string')throw failure();
    if(scope.prepared){
     const expected=scope.prepared.principal;if(expected.kind!=='azure-managed-identity'||!same(properties.clientId,expected.clientId)||!same(properties.principalId,expected.principalId)
      ||native.tags?.hypervibeInstallation!==scope.prepared.installationId||native.tags?.hypervibeDeployment!==scope.owner||native.tags?.hypervibePurpose!==`runtime-${request.service.name}`
      ||retained?.installationId&&retained.installationId!==scope.prepared.installationId)throw failure();
    }else{
     const creationAttempt=retained?.creationAttempt??request.binding?.pending?.step.target.recoverAttemptId??request.binding?.pending?.attemptId;
     if(!creationAttempt||native.tags?.hypervibeRuntime!==scope.owner||native.tags?.hypervibeAttempt!==creationAttempt)throw failure();
    }
    principalId=properties.principalId;clientId=properties.clientId;
    if(app&&!holding&&!Object.keys(app.identity?.userAssignedIdentities??{}).some(id=>same(id,scope.identityId)))throw failure();
   } else if(retained?.principalId||scope.prepared)throw failure();
  }
  if(retained?.principalId&&!same(principalId,retained.principalId)||retained?.clientId&&!same(clientId,retained.clientId)||retained?.createdAt&&native?.systemData?.createdAt!==retained.createdAt)throw failure();
  let grants:ReaderGrant[]=[];
  if(retained?.readerGrants){grants=z.array(readerGrantSchema).max(100).parse(JSON.parse(retained.readerGrants));if(grants.some(g=>!same(g.principalId,principalId)))throw failure();}
  const desired=new Set<string>();
  if(scope.prepared){
   const approved=scope.deployment!.deployment.workloads.find(item=>item.name===request.service.name)!.runtimeSecrets;
   const supplied=Object.entries(request.environmentSpec?.secretDestinations??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>({key,reference:runtimeSecretReferenceSchema.parse(value)}));
   if(!isDeepStrictEqual(supplied,[...approved].sort((a,b)=>a.key.localeCompare(b.key))))throw failure();
  }
  for(const raw of Object.values(request.environmentSpec?.secretDestinations??{})){
   const parsed=runtimeSecretReferenceSchema.safeParse(raw);if(!parsed.success)throw failure();const d=parsed.data.destination;
   if(d.provider!=='azure-key-vault'||!same(d.tenantId,scope.tenantId)||!same(d.subscriptionId,scope.subscriptionId))throw failure();
   desired.add(`/subscriptions/${scope.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`);
  }
  const vaults:ReaderGrant[]=[];
  if(principalId)for(const vaultId of [...desired].sort()){
   const vault=await scope.client.getNullable<Native>(vaultId,VAULT_API);
   if(!vault||!same(vault.id,vaultId)||!same(vault.properties?.tenantId,scope.tenantId)||vault.properties?.enableRbacAuthorization!==true||vault.properties?.provisioningState!=='Succeeded'||typeof vault.systemData?.createdAt!=='string')throw failure();
   const previous=grants.find(g=>same(g.vaultId,vaultId));if(previous&&previous.createdAt!==vault.systemData.createdAt)throw failure();
   const assignmentId=scope.deployment?.preparedResources?azurePreparedGrantId(scope.owner,`runtime-${request.service.name}:vault:${vaultId.toLowerCase()}`,vaultId)
    :`${vaultId}/providers/Microsoft.Authorization/roleAssignments/${guid([scope.owner,vaultId.toLowerCase(),principalId.toLowerCase()])}`;
   if(previous&&!same(previous.assignmentId,assignmentId))throw failure();
   vaults.push({vaultId,createdAt:vault.systemData.createdAt,assignmentId,principalId});
  }
  const state={scope,app,native,kind,principalId,clientId,grants,vaults,holding};
  if(scope.prepared){
   // Administrator installation owns these grants. Local plan/apply may bind
   // exact observed proof, never repair them using deployment authority.
   if(scope.deployment?.preparedResources){
    const registry=scope.deployment.preparedResources.registry,key=`runtime-${request.service.name}:pull`,id=azurePreparedGrantId(scope.owner,key,registry.id);
    const pull=await scope.client.getNullable<Native>(id,RBAC_API),p=pull?.properties;
    if(!pull||!same(pull.id,id)||!same(p?.principalId,principalId)||!same(p?.scope,registry.id)
      ||!same(p?.roleDefinitionId,`/subscriptions/${scope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`)
      ||p?.principalType!=='ServicePrincipal'||p?.condition!=null||p?.description!==azurePreparedGrantDescription(scope.owner,key))throw failure();
   }
   for(const grant of vaults)if(!await this.assignment(state,grant))throw failure();
   state.grants=vaults;
  }
  return state;
 }
 private binding(request:RuntimeIdentityRequest,state:Awaited<ReturnType<AzureRuntimeIdentities['read']>>,grants=state.grants):RuntimeIdentityBinding{
  const {scope}=state;if(!state.principalId)throw failure();
  return{provider:'azure-container-apps',evidence:{tenantId:scope.tenantId,subscriptionId:scope.subscriptionId,environmentId:request.environment.id,serviceName:request.service.name,owner:scope.owner,workloadId:scope.workloadId,kind:state.kind,principalId:state.principalId,
   ...(state.kind==='user'?{identityId:scope.identityId,clientId:state.clientId!,...(state.native!.systemData?.createdAt?{createdAt:state.native!.systemData.createdAt}:{}),...(scope.prepared?{installationId:scope.prepared.installationId}:{creationAttempt:state.native!.tags.hypervibeAttempt})}:{}),readerGrants:JSON.stringify(grants)}};
 }
 private identity(request:RuntimeIdentityRequest,state:Awaited<ReturnType<AzureRuntimeIdentities['read']>>):ProviderRuntimeIdentity{
  if(!state.principalId)throw failure();const {scope}=state;return{provider:'azure',principal:state.principalId,source:state.app&&!state.holding?'observed':'configured',scope:{tenantId:scope.tenantId,subscriptionId:scope.subscriptionId,environmentId:request.environment.id,serviceName:request.service.name,workloadResource:scope.workloadId,...(state.kind==='user'?{identityResourceId:scope.identityId,clientId:state.clientId!}:{} )}};
 }
 private step(state:Awaited<ReturnType<AzureRuntimeIdentities['read']>>,phase:string,grant?:ReaderGrant):RuntimeIdentityStep{
  return{operation:phase==='create'?'create':'attach',requiresConfirm:true,target:{phase,identityId:state.scope.identityId,owner:state.scope.owner,workloadId:state.scope.workloadId,...(state.principalId?{principalId:state.principalId}:{}),...(grant??{})},description:phase==='create'?'Prepare an isolated Azure user-assigned runtime identity before creating this workload.':phase==='bind-existing'?'Record the existing Azure runtime principal without replacing it.':`Grant this runtime principal read access to every secret in the selected app and environment vault ${grant?.vaultId}.`};
 }
 private async assignment(state:{scope:ReturnType<AzureRuntimeIdentities['coordinates']>;principalId?:string},grant:ReaderGrant){
  const native=await state.scope.client.getNullable<Native>(grant.assignmentId,RBAC_API);if(!native)return null;
  const description=state.scope.deployment?.preparedResources?azurePreparedGrantDescription(state.scope.owner,`runtime-${state.scope.prepared!.workload}:vault:${grant.vaultId.toLowerCase()}`):`Hypervibe runtime ${state.scope.owner}`;
  const p=native.properties;if(!same(native.id,grant.assignmentId)||!same(p?.principalId,state.principalId)||!same(p?.roleDefinitionId,`/subscriptions/${state.scope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${READER_ROLE}`)||!same(p?.scope,grant.vaultId)||p?.principalType!=='ServicePrincipal'||p?.description!==description||p?.condition!=null)throw failure();return native;
 }
 async inspect(request:RuntimeIdentityRequest):Promise<RuntimeIdentityObservation>{try{
  const state=await this.read(request),pending=request.binding?.pending;
  if(request.mode==='destroy')return{state:'waiting',reason:'Retained runtime identities and reader grants require a separately reviewed retirement after all workloads are removed.'};
  if(pending){
   const original=pending.step.operation==='recover'?{...pending.step,operation:pending.step.target.recoverOperation as RuntimeIdentityStep['operation']}:pending.step;
   const recoverAttemptId=pending.step.target.recoverAttemptId??pending.attemptId;
   if(original.target.phase==='create'&&!state.native)return{state:'unknown',reason:'Unacknowledged Azure identity creation must not be replayed.'};
   if(original.target.phase==='reader-grant'){
    const grant=state.vaults.find(g=>same(g.vaultId,original.target.vaultId));if(!grant||!await this.assignment(state,grant))return{state:'unknown',reason:'Unacknowledged Azure reader grant must not be replayed.'};
   }
   return{state:'action',step:{...original,operation:'recover',target:{...original.target,recoverAttemptId,recoverOperation:original.operation}}};
  }
  if(!state.principalId)return{state:'action',step:this.step(state,'create')};
  if(!request.binding?.evidence.principalId)return{state:'action',step:this.step(state,'bind-existing')};
  for(const grant of state.vaults){const native=await this.assignment(state,grant),retained=state.grants.find(g=>same(g.vaultId,grant.vaultId));if(native&&!retained)throw failure();if(!native)return{state:'action',step:this.step(state,'reader-grant',grant)};}
  return{state:'ready',identity:this.identity(request,state)};
 }catch{return{state:'unknown',reason:'Azure runtime ownership and reader permissions could not be verified.'};}}
 async apply(request:RuntimeIdentityRequest&{step:RuntimeIdentityStep;attemptId:string}){
  let mutationAttempted=false;try{
   const {step}=request,state=await this.read(request);
   if(step.operation==='recover'){
    const observed=await this.inspect(request);if(observed.state!=='action'||observed.step.operation!=='recover'||!isDeepStrictEqual(observed.step,step))throw failure();
    const grant=state.vaults.find(g=>same(g.vaultId,step.target.vaultId));
    return{receipt:{success:true,message:'Exact Azure runtime operation recovered without another write.'},binding:this.binding(request,state,grant?[...state.grants.filter(g=>!same(g.vaultId,grant.vaultId)),grant]:state.grants)};
   }
   const withoutPending=request.binding?.evidence.principalId?{...request.binding,pending:undefined}:undefined;
   const fresh=await this.inspect({...request,binding:withoutPending});if(fresh.state!=='action'||!isDeepStrictEqual(fresh.step,step))throw failure();
   if(step.target.phase==='create'){
    return{receipt:{success:false,message:'Azure runtime identity creation is blocked until native atomic creation ownership is verified.',data:{mutationAttempted:false,reason:'create_ownership_unverified'}}};
   }else if(step.target.phase==='reader-grant'){
    const grant=state.vaults.find(g=>same(g.vaultId,step.target.vaultId));if(!grant)throw failure();
    mutationAttempted=true;await state.scope.client.request('PUT',grant.assignmentId,RBAC_API,{properties:{principalId:state.principalId,principalType:'ServicePrincipal',roleDefinitionId:`/subscriptions/${state.scope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${READER_ROLE}`,description:`Hypervibe runtime ${state.scope.owner}`}});
    const after=await this.read(request);if(!await this.assignment(after,grant))throw failure();
    return{receipt:{success:true,message:'Azure runtime reader grant verified.'},binding:this.binding(request,after,[...after.grants.filter(g=>!same(g.vaultId,grant.vaultId)),grant])};
   }else if(step.target.phase!=='bind-existing')throw failure();
   return{receipt:{success:true,message:'Azure runtime identity verified.'},binding:this.binding(request,await this.read(request))};
  }catch{return{receipt:{success:false,message:'Azure runtime operation is incomplete; retain its recovery record.',data:{mutationAttempted}}};}
 }
}
