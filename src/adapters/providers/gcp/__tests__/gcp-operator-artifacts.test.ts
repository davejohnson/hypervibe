import { describe, expect, it } from 'vitest';
import { createGcpOperatorArtifactCapability } from '../gcp-operator-artifacts.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';

import { gcpOperatorArtifactBoundary as fixture } from './gcp-operator-artifact.fixture.js';
const digest = 'sha256:' + 'd'.repeat(64);
describe('GAR operator immutable image publication', () => {
  it.each([false,true])('recovers a lost push acknowledgment=%s by immutable readback, without another push', async lostAck => {
    const f = fixture({ lostAck }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(record.plan.actions).toHaveLength(1); expect(f.writes).toEqual([]);
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [record.plan.actions[0].id] });
    record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status, JSON.stringify(record)).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
    expect(JSON.stringify(record)).toContain(digest); expect(JSON.stringify(record)).not.toContain('synthetic-short-lived-token');
    expect(f.commands.filter(value => value.args[0] === 'pull').length).toBeGreaterThan(0);
  });
  it.each(['replaced','denied','publicRemoved','wrongImage','billingChanged','billingDisabled'] as const)('rejects %s before publication', async variant => {
    const f = fixture(); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    f.options[variant] = true;
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toEqual([]);
  });
  it('retains an uncertain absent publication without blind replay', async () => {
    const f = fixture({ lostAck: true, absentAfterPush: true }); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    for (let i = 0; i < 2; i++) record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status).not.toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });

  it('preserves immutable legacy publication receipts without granting another push',async()=>{
    const f=fixture();let record=await planCloudInstallationV1({...f.context,intent:f.intent});
    record=await applyCloudInstallationV1({...f.context,installationId:record.installationId,planDigest:record.plan.digest,confirmActions:record.plan.actions.map(a=>a.id)});
    expect(record.status).toBe('scope-ready');
    const capability=createGcpOperatorArtifactCapability(),receipts=capability.receipts(record);
    // Historical publication schema omitted approved billing. Receipt identity
    // remains immutable; it cannot authorize a new plan or direct mutation.
    delete record.intent.nativeScope.billingAccountName;
    expect(f.context.driver.parseScope(record.intent.nativeScope)).toEqual(record.intent.nativeScope);
    expect(capability.receipts(record)).toEqual(receipts);
    const requests=f.requests.length;
    const result=await f.context.driver.mutate({intent:record.intent,action:record.plan.actions[0],completed:{},
      authentication:f.context.authentication,signal:AbortSignal.timeout(1000),beforeMutation:async()=>{},
      attempt:{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',actionId:record.plan.actions[0].id,status:'attempted',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});
    expect(result).toMatchObject({state:'rejected',reason:'authorization_revoked'});
    expect(f.requests).toHaveLength(requests);expect(f.writes).toHaveLength(1);
  });
});
