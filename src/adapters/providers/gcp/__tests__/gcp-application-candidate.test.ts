import { describe, expect, it } from 'vitest';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { candidateBoundary } from './gcp-application-candidate.fixture.js';
import { createGcpOperatorArtifactCapability } from '../gcp-operator-artifacts.js';
const digest = 'sha256:' + 'd'.repeat(64);
describe('private GAR application candidate publication', () => {
  it.each([false,true])('recovers a lost push acknowledgment=%s by immutable readback, without another push', async lostAck => {
    const f = candidateBoundary({ lostAck }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(record.plan.actions).toHaveLength(1); expect(f.writes).toEqual([]);
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [record.plan.actions[0].id] });
    record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status, JSON.stringify(record)).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [] });
    expect(f.writes).toHaveLength(1);
    expect(f.requests.some(url => /:setIamPolicy|repositories\?/.test(url))).toBe(false);
    expect(JSON.stringify(record)).toContain(digest); expect(JSON.stringify(record)).not.toContain('synthetic-short-lived-token');
    expect(f.commands.filter(value => value.args[0] === 'pull').length).toBeGreaterThan(0);
  });
  it.each(['replaced','denied','publicRemoved','wrongImage','billingChanged','billingDisabled'] as const)('rejects %s before publication', async variant => {
    const f = candidateBoundary(); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    f.options[variant] = true;
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toEqual([]);
  });
  it('retains an uncertain absent publication without blind replay', async () => {
    const f = candidateBoundary({ lostAck: true, absentAfterPush: true }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    for (let i = 0; i < 2; i++) record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });
  it('does not accept a matching registry digest receipt whose downloaded configuration differs from the reviewed image',async()=>{
    const f=candidateBoundary({wrongPulledImage:true});let record=await planCloudInstallationV1({...f.context,intent:f.intent});
    record=await applyCloudInstallationV1({...f.context,installationId:record.installationId,planDigest:record.plan.digest,confirmActions:record.plan.actions.map(a=>a.id)});
    record=await reconcileCloudInstallationV1({...f.context,installationId:record.installationId,planDigest:record.plan.digest});
    expect(record.status).not.toBe('scope-ready');expect(f.writes).toHaveLength(1);
  });

  it('keeps historical scopes readable but refuses new publication authority without approved billing',async()=>{
    const f=candidateBoundary();delete f.intent.nativeScope.billingAccountName;
    expect(f.context.driver.parseScope(f.intent.nativeScope)).toEqual(f.intent.nativeScope);
    await expect(planCloudInstallationV1({...f.context,intent:f.intent})).rejects.toThrow();
    expect(f.requests).toEqual([]);expect(f.writes).toEqual([]);
  });

  it('requires billing proof in the exact binding when creating a new candidate declaration',()=>{
    const f=candidateBoundary(),n=f.intent.nativeScope,capability=createGcpOperatorArtifactCapability();
    const declaration=Object.fromEntries(['scopeKind','projectId','region','sourceDirectory','sourceCommit','imageName','packageReadAuthentication'].map(key=>[key,n[key]]));
    const binding={...n};delete binding.billingAccountName;
    expect(()=>capability.parseDeclaration(declaration,['application-candidate-v1'],{providerScope:binding})).toThrow();
  });

});
