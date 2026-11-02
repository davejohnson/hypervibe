import { describe, expect, it, vi } from 'vitest';
import { probeAzureCreateOnlyContract, type AzureCreateOnlyProbeReview } from './helpers/azure-create-only-probe.js';
// SYNTHETIC acceptance criteria, NOT evidence that Azure implements If-None-Match.
// Official ACA2026-01-01 PUT schema does not document a create-only precondition.
const review: AzureCreateOnlyProbeReview = { appId: '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/probe/providers/Microsoft.App/containerApps/probe',
 environmentId: '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/probe/providers/Microsoft.App/managedEnvironments/probe',
 hypervibeEnvironmentId: 'disposable-local', principalId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-24T00:00:00Z', image: 'example.invalid/probe@sha256:'+'a'.repeat(64), location:'eastus' };
const native = { id: review.appId, location:'eastus', identity:{type:'SystemAssigned',principalId:review.principalId},systemData:{createdAt:review.createdAt},
 tags:{'managed-by':'hypervibe','hypervibe-environment-id':'disposable-local','hypervibe-purpose':'disposable-create-only-probe'},
 properties:{managedEnvironmentId:review.environmentId,provisioningState:'Succeeded',latestRevisionName:'probe--one',latestReadyRevisionName:'probe--one',
 configuration:{activeRevisionsMode:'Single',ingress:{external:false,targetPort:8080,transport:'auto',allowInsecure:false}},
 template:{containers:[{name:'probe',image:review.image,env:[],resources:{cpu:0.25,memory:'0.5Gi'}}],scale:{minReplicas:0,maxReplicas:1}}}};
function fixture(status:number){let puts=0;const context={getAccessToken:async()=> 'synthetic-only',beforeMutation:vi.fn(async()=>{}),signal:new AbortController().signal,
 fetch:vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method==='PUT'){puts++;expect(init.headers).toMatchObject({'If-None-Match':'*'});return new Response(null,{status});}return Response.json(native);}) as typeof fetch};return{context,get puts(){return puts;}};}
describe('reviewable Azure conditional-create probe',()=>{
 it('requires an explicit 412 and unchanged owned configuration before recording contract evidence',async()=>{const f=fixture(412);expect(await probeAzureCreateOnlyContract(review,f.context)).toMatchObject({status:'guard-verified'});expect(f.puts).toBe(1);expect(f.context.beforeMutation).toHaveBeenCalledOnce();});
 it('records accepted upsert as unsupported without retrying or relabeling it create-only',async()=>{const f=fixture(200);expect(await probeAzureCreateOnlyContract(review,f.context)).toMatchObject({status:'guard-not-supported'});expect(f.puts).toBe(1);});
 it('cannot write after the approved probe is revoked',async()=>{const f=fixture(412);f.context.beforeMutation.mockRejectedValue(new Error('revoked'));expect(await probeAzureCreateOnlyContract(review,f.context)).toMatchObject({status:'unknown'});expect(f.puts).toBe(0);});
 it('does not probe another resource lifetime',async()=>{const f=fixture(412);expect(await probeAzureCreateOnlyContract({...review,principalId:'33333333-3333-4333-8333-333333333333'},f.context)).toMatchObject({status:'unknown'});expect(f.puts).toBe(0);});
});
