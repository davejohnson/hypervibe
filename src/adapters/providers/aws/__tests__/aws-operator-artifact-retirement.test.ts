import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { applyCloudInstallationV1, historicalInstallationEvidence, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { awsOperatorArtifactBoundary } from './aws-operator-artifact.fixture.js';
import { awsArtifactRetirementBoundary } from './aws-artifact-retirement.fixture.js';
import type { OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';

async function fixture(data: 'retain'|'delete-owned'='delete-owned') {
  const original=awsOperatorArtifactBoundary(),plan=await planCloudInstallationV1({...original.input,intent:original.intent});
  const completed=await applyCloudInstallationV1({...original.input,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(item=>item.id)});
  expect(completed.status).toBe('scope-ready');
  // No runtime deletion adapter existed before this boundary regression.
  expect(original.capability.retirement).toBeDefined();
  const {createAwsOperatorArtifactRetirementDriver}=await import('../aws-operator-artifact-retirement.js');
  const native=awsArtifactRetirementBoundary(original),reference={installationId:completed.installationId,planDigest:completed.plan.digest};
  const intent:OperatorArtifactIntent={...structuredClone(completed.intent),installationId:randomUUID(),mode:'retire',predecessor:reference,
    retirement:{from:reference,targets:[{...reference,evidenceDigest:canonicalJsonSha256(historicalInstallationEvidence(completed))}],resources:'delete-owned',data}};
  const driver=createAwsOperatorArtifactRetirementDriver([completed],{requestHandler:native.handler});
  const context={...original.input,driver};return{original,completed,native,intent,context};
}
describe('AWS template retirement through real SDK serialization and durable journal',()=>{
  it('deletes only exact versions after stack Retain, then verifies owned bucket absence',async()=>{
    const f=await fixture(),before=JSON.stringify(f.completed),plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    expect(plan.plan.actions).toHaveLength(5);expect(f.native.writes).toEqual([]);
    const result=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(result.status).toBe('retired');expect(f.native.state.bucket).toBe(false);expect(f.original.objects.size).toBe(0);
    expect(f.native.writes).toEqual(['DELETE:/:policy','DeleteStack',expect.stringMatching(/^DELETE:\/cloudformation\/.*:versionId,x-id$/),expect.stringMatching(/^DELETE:\/cloudformation\/.*:versionId,x-id$/),'DELETE:/:']);
    expect(JSON.stringify(f.completed)).toBe(before);expect(JSON.stringify(result)).not.toContain('synthetic-session-secret');
  });
  it('retain removes public version access and stack but reports the active bucket and versions',async()=>{
    const f=await fixture('retain'),plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    const result=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(result.status).toBe('retired');expect(f.native.state.bucket).toBe(true);expect(f.original.objects.size).toBe(2);
    expect(f.native.writes).toEqual(['DELETE:/:policy','DeleteStack']);
    expect(Object.values(result.completed).at(-1)!.native.retirement).toMatchObject({outcome:'retained-by-choice',retained:expect.arrayContaining([{kind:'artifact-bucket',id:f.original.stack().bucket,identity:expect.any(Object),reason:'data-retention'}])});
  });
  it.each(['retain','delete-owned'] as const)('converges %s after deleting an owned-only policy with a reviewed top-level Id',async data=>{
    const f=await fixture(data);f.original.setPolicy({...f.original.policy(),Id:'reviewed-policy-document'});
    const plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    const result=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(result.status).toBe('retired');expect(f.original.policy()).toBeUndefined();expect(f.native.writes.filter(item=>item==='DELETE:/:policy')).toHaveLength(1);
  });
  it.each(['denied','foreignVersion','deleteMarker','multipart','partialVersions','partialBuckets','bucketReplacement'] as const)('blocks %s before any effect',async key=>{
    const f=await fixture();f.native.state[key]=true;
    await expect(planCloudInstallationV1({...f.context,intent:f.intent})).rejects.toThrow();expect(f.native.writes).toEqual([]);
  });
  it.each(['policy','stack','version','bucket'] as const)('recovers lost %s acknowledgment through reads without a second request',async lost=>{
    const f=await fixture(),plan=await planCloudInstallationV1({...f.context,intent:f.intent});f.native.state.lost=lost;
    const call={...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)};
    const first=await applyCloudInstallationV1(call);expect(first.status).toBe('pending');
    const before=[...f.native.writes];const read=await reconcileCloudInstallationV1(call);expect(f.native.writes).toEqual(before);
    expect(read.attempts.filter(a=>a.status!=='succeeded')).toEqual([]);
    const done=await applyCloudInstallationV1(call);expect(done.status).toBe('retired');expect(new Set(f.native.writes).size).toBe(f.native.writes.length);
  });
  it('reads both version markers and every account-bucket page before proving absence',async()=>{
    const f=await fixture();f.native.state.paginateVersions=true;f.native.state.paginateBuckets=true;
    const plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    const done=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(done.status).toBe('retired');expect(f.native.reads.some(item=>item.includes('key-marker')&&item.includes('version-id-marker'))).toBe(true);
    expect(f.native.reads.some(item=>item.includes('continuation-token'))).toBe(true);
  });
  it('stops on a foreign version on the second page before removing any public policy',async()=>{
    const f=await fixture();f.native.state.paginateVersions=true;f.native.state.foreignVersion=true;
    await expect(planCloudInstallationV1({...f.context,intent:f.intent})).rejects.toThrow();expect(f.native.writes).toEqual([]);
  });
  it('rejects a changed account inventory owner between pages before deletion',async()=>{
    const f=await fixture();f.native.state.paginateBuckets=true;f.native.state.pageOwnerMismatch=true;
    await expect(planCloudInstallationV1({...f.context,intent:f.intent})).rejects.toThrow();expect(f.native.writes).toEqual([]);
  });
  it('never replays an unknown delete whose exact resource is still present',async()=>{
    const f=await fixture(),plan=await planCloudInstallationV1({...f.context,intent:f.intent});f.native.state.lostBefore=true;
    const call={...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)};
    expect((await applyCloudInstallationV1(call)).status).toBe('pending');const before=[...f.native.writes];
    expect((await reconcileCloudInstallationV1(call)).status).toBe('pending');expect((await applyCloudInstallationV1(call)).status).toBe('pending');
    expect(f.native.writes).toEqual(before);expect(f.native.state.bucket).toBe(true);
  });
  it('keeps denied readback unknown after a lost delete, then recovers without replay when read access returns',async()=>{
    const f=await fixture(),plan=await planCloudInstallationV1({...f.context,intent:f.intent});f.native.state.lost='policy';
    const call={...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)};
    await applyCloudInstallationV1(call);const before=[...f.native.writes];f.native.state.denied=true;
    const denied=await reconcileCloudInstallationV1(call);expect(denied.status).not.toBe('retired');expect(denied.completed).toEqual({});expect(f.native.writes).toEqual(before);
    f.native.state.denied=false;const recovered=await reconcileCloudInstallationV1(call);expect(recovered.completed[plan.plan.actions[0].id]).toBeDefined();expect(f.native.writes).toEqual(before);
  });
  it('preserves unrelated policy grants when retaining data and blocks whole-bucket deletion of those grants',async()=>{
    const f=await fixture('retain'),extra={Sid:'UnrelatedOwnerGrant',Effect:'Allow',Principal:{AWS:'arn:aws:iam::123456789012:role/other'},Action:'s3:GetObject',Resource:`arn:aws:s3:::${f.original.stack().bucket}/unrelated`};
    f.original.setPolicy({...f.original.policy(),Statement:[...f.original.policy().Statement,extra]});
    const plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    const done=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(done.status).toBe('retired');expect(f.original.policy().Statement).toEqual([extra]);expect(f.native.state.bucket).toBe(true);
    const other=await fixture();other.original.setPolicy({...other.original.policy(),Statement:[...other.original.policy().Statement,{...extra,Resource:`arn:aws:s3:::${other.original.stack().bucket}/unrelated`}]});
    await expect(planCloudInstallationV1({...other.context,intent:other.intent})).rejects.toThrow();expect(other.native.writes).toEqual([]);
  });
  it.each(['account','stack-id','stack-created','object-version','object-owner','object-checksum','policy-drift'] as const)('rejects changed %s before an effect',async change=>{
    const f=await fixture(),plan=await planCloudInstallationV1({...f.context,intent:f.intent});
    if(change==='account')f.original.setCaller({account:'999999999999',arn:'arn:aws:sts::999999999999:assumed-role/other/test',userId:'synthetic'});
    if(change==='stack-id')f.original.stack().id=f.original.stack().id.replace(/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb$/,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    if(change==='stack-created')f.original.stack().created='2026-11-04T00:00:00Z';
    const object=[...f.original.objects.values()][0];
    if(change==='object-version')object.version='replacement-version';if(change==='object-owner')object.metadata['hv-owner']='f'.repeat(64);if(change==='object-checksum')object.digest=Buffer.from('f'.repeat(64),'hex').toString('base64');
    if(change==='policy-drift')f.original.setPolicy({...f.original.policy(),Id:'foreign-policy-revision'});
    const result=await applyCloudInstallationV1({...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});
    expect(result.status).not.toBe('retired');expect(f.native.writes).toEqual([]);
  });
  it('requires a fresh exact retry for a definitely rejected request and retains its failed history',async()=>{
    const f=await fixture(),plan=await planCloudInstallationV1({...f.context,intent:f.intent}),call={...f.context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)};
    f.native.state.denyWrites=true;const rejected=await applyCloudInstallationV1(call);expect(rejected.attempts[0].status).toBe('rejected');
    expect(JSON.stringify(rejected)).not.toMatch(/synthetic private error|synthetic-session-secret|synthetic-session-token|ASIASYNTHETICPUBLISHER/);
    f.native.state.denyWrites=false;const review=await reviewCloudInstallationRetryV1(call);
    expect(review.retryActions).toEqual([{actionId:plan.plan.actions[0].id,attemptId:rejected.attempts[0].id}]);
    const done=await applyCloudInstallationV1({...call,retryActions:review.retryActions});expect(done.status).toBe('retired');expect(done.attempts[0]).toEqual(rejected.attempts[0]);
  });
  it('preserves accepted refresh ancestry and deduplicates the same immutable version selected in both records',async()=>{
    const original=awsOperatorArtifactBoundary(),firstIntent={...original.intent,artifacts:[original.intent.artifacts[0]],nativeScope:original.capability.parseDeclaration({scopeKind:'s3-cloudformation-publication-v1',accountId:'123456789012',region:'us-west-2'},[original.intent.artifacts[0]],{})};
    const firstPlan=await planCloudInstallationV1({...original.input,intent:firstIntent}),first=await applyCloudInstallationV1({...original.input,installationId:firstPlan.installationId,planDigest:firstPlan.plan.digest,confirmActions:firstPlan.plan.actions.map(a=>a.id)});expect(first.status).toBe('scope-ready');
    const nextIntent={...original.intent,installationId:randomUUID(),nativeScope:original.capability.refreshScope!(first,original.intent.nativeScope,original.intent.artifacts),predecessor:{installationId:first.installationId,planDigest:first.plan.digest}};
    const nextPlan=await planCloudInstallationV1({...original.input,intent:nextIntent});let next=nextPlan;
    for(const action of nextPlan.plan.actions)next=await applyCloudInstallationV1({...original.input,installationId:nextPlan.installationId,planDigest:nextPlan.plan.digest,onlyActionId:action.id,confirmActions:action.type==='noop'?[]:[action.id]});expect(next.status).toBe('scope-ready');
    const native=awsArtifactRetirementBoundary(original),from={installationId:next.installationId,planDigest:next.plan.digest};
    const intent:OperatorArtifactIntent={...next.intent,installationId:randomUUID(),mode:'retire',predecessor:from,retirement:{from,targets:[first,next].map(item=>({installationId:item.installationId,planDigest:item.plan.digest,evidenceDigest:canonicalJsonSha256(historicalInstallationEvidence(item))})),resources:'delete-owned',data:'delete-owned'}};
    const {createAwsOperatorArtifactRetirementDriver}=await import('../aws-operator-artifact-retirement.js');
    const context={...original.input,driver:createAwsOperatorArtifactRetirementDriver([first,next],{requestHandler:native.handler})},before=[JSON.stringify(first),JSON.stringify(next)];
    const plan=await planCloudInstallationV1({...context,intent});expect(plan.plan.actions).toHaveLength(5);
    const done=await applyCloudInstallationV1({...context,installationId:plan.installationId,planDigest:plan.plan.digest,confirmActions:plan.plan.actions.map(a=>a.id)});expect(done.status).toBe('retired');
    expect([JSON.stringify(await original.input.store.read(first.installationId)),JSON.stringify(await original.input.store.read(next.installationId))]).toEqual(before);expect(native.writes).toHaveLength(5);
  });
});
