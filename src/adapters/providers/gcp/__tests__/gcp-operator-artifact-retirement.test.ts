import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyCloudInstallationV1, historicalInstallationEvidence, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { createGcpOperatorArtifactCapability } from '../gcp-operator-artifacts.js';
import { createGcpOperatorArtifactRetirementDriver } from '../gcp-operator-artifact-retirement.js';
import { candidateBoundary } from './gcp-application-candidate.fixture.js';
import { artifactRetirementBoundary } from './gcp-artifact-retirement.fixture.js';
import { gcpOperatorArtifactBoundary } from './gcp-operator-artifact.fixture.js';

async function fixture(data: 'retain' | 'delete-owned' = 'delete-owned', publicImage: false | 'holding-v1' | 'backup-runner-v1' = false) {
  const publication = publicImage ? gcpOperatorArtifactBoundary({},undefined,publicImage) : candidateBoundary(), planned = await planCloudInstallationV1({ ...publication.context, intent: publication.intent });
  const original = await applyCloudInstallationV1({ ...publication.context, installationId: planned.installationId, planDigest: planned.plan.digest,
    confirmActions: planned.plan.actions.map(action => action.id) }); expect(original.status).toBe('scope-ready');
  const originalBytes = JSON.stringify(original), commandCount = publication.commands.length;
  const boundary = artifactRetirementBoundary(original, publication.request), reference = { installationId: original.installationId, planDigest: original.plan.digest };
  const intent: OperatorArtifactIntent = { ...original.intent, installationId: randomUUID(), mode: 'retire', predecessor: reference,
    retirement: { from: reference, resources: 'delete-owned', data, targets: [{ ...reference, evidenceDigest: canonicalJsonSha256(historicalInstallationEvidence(original)) }] } };
  const records = new Map<string, CloudInstallationRecord<OperatorArtifactIntent>>([[original.installationId, structuredClone(original)]]);
  let allow = true;
  const context = { driver: createGcpOperatorArtifactRetirementDriver([original], { fetch: boundary.request }),
    authentication: publication.context.authentication, authorize: async () => allow,
    store: { read: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord<OperatorArtifactIntent>) => {
        if (revision !== (records.get(id)?.revision ?? null)) return false;
        const before = records.get(id);
        for (const attempt of before?.attempts ?? []) if (attempt.evidence) {
          const after = next.attempts.find(value => value.id === attempt.id)!;
          for (const [key, value] of Object.entries(attempt.evidence.native)) expect(after.evidence?.native[key]).toEqual(value);
        }
        records.set(id, structuredClone(next)); return true;
      } } };
  return { ...boundary, original, originalBytes, publication, commandCount, intent, context, records, revoke: () => { allow = false; },
    plan: () => planCloudInstallationV1({ ...context, intent }),
    apply: (record: CloudInstallationRecord<OperatorArtifactIntent>, confirmActions = record.plan.actions.map(action => action.id), retryActions?: Array<{ actionId: string; attemptId: string }>) =>
      applyCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions, retryActions }),
    recover: (record: CloudInstallationRecord<OperatorArtifactIntent>) => reconcileCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest }) };
}
describe('owned GCP publication retirement through serialized REST and retained native journal', () => {
  it('deletes only the original tag then exact immutable version with force=false; retains history and the shared repository', async () => {
    const f = await fixture(), plan = await f.plan(); expect(f.writes).toEqual([]);
    expect(plan.plan.actions.map(action => action.type)).toEqual(['destroy', 'destroy']);
    const result = await f.apply(plan); expect(result.status).toBe('retired');
    expect(f.writes).toEqual([`/v1/${f.tagName}`, `/v1/${f.version}?force=false`]);
    expect(JSON.stringify(f.records.get(f.original.installationId))).toBe(f.originalBytes);
    expect(f.publication.commands).toHaveLength(f.commandCount);
    expect(createGcpOperatorArtifactCapability().parseRecord(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('synthetic-short-lived-token');
    const again = await f.recover(result); expect(again.status).toBe('retired'); expect(f.writes).toHaveLength(2);
  });
  it('honors retain without deleting image bytes or claiming public access was revoked', async () => {
    const f = await fixture('retain'), plan = await f.plan(), result = await f.apply(plan);
    expect(result.status).toBe('retired'); expect(f.writes).toEqual([`/v1/${f.tagName}`]); expect(f.state.image).toBe(true);
    expect(Object.values(result.completed)[0].native.retirement).toMatchObject({ outcome: 'retained-by-choice', retained: [{ id: expect.stringContaining('@sha256:') }] });
    expect(plan.plan.review.warnings.join(' ')).toContain('including any existing public read access');
    expect(plan.plan.review.permissions.flatMap(item=>item.actions)).not.toContain('artifactregistry.versions.delete');
  });
  it.each(['holding-v1','backup-runner-v1'] as const)('retires public %s without rechecking publication billing/public grants or touching unrelated images', async kind => {
    const f=await fixture('delete-owned',kind); f.publication.options.billingDisabled=true; f.publication.options.publicRemoved=true;
    const result=await f.apply(await f.plan()); expect(result.status).toBe('retired');
    expect(f.writes).toEqual([`/v1/${f.tagName}`,`/v1/${f.version}?force=false`]);
    expect(f.requests.some(request=>request.path.includes(':getIamPolicy')||request.path.includes('billingInfo'))).toBe(false);
  });
  it.each(['denied', 'missingPermission', 'immutableTags', 'replacement', 'foreignTag', 'foreignLaterPage', 'malformedList', 'duplicatePage'] as const)(
    'blocks %s before any delete', async key => { const f = await fixture(); f.state[key] = true; await expect(f.plan()).rejects.toThrow(); expect(f.writes).toEqual([]); });
  it.each(['lostTagAck', 'lostVersionAck'] as const)('recovers %s by reading exact absence, never repeating a delete', async key => {
    const f = await fixture(); f.state[key] = true; const plan = await f.plan(), first = await f.apply(plan);
    expect(first.status).toBe('pending'); const writes = f.writes.length;
    const observed = await f.recover(first); expect(f.writes).toHaveLength(writes);
    if (key === 'lostTagAck') {
      expect(observed.completed[plan.plan.actions[0].id]).toBeDefined(); expect(observed.completed[plan.plan.actions[1].id]).toBeUndefined();
      expect((await f.apply(observed)).status).toBe('retired');
    } else expect(observed.status).toBe('retired');
    expect(f.writes).toHaveLength(2);
  });
  it('retains a pending delete operation across restart until the same operation confirms completion', async () => {
    const f = await fixture(); f.state.operationPending = true; const first = await f.apply(await f.plan()); expect(first.status).toBe('pending');
    expect(first.attempts.at(-1)?.evidence?.native.operationName).toBe(f.operation);
    expect((await f.recover(first)).status).toBe('pending'); expect(f.writes).toHaveLength(2);
    f.state.operationPending = false; const complete = await f.recover(first); expect(complete.status).toBe('retired'); expect(f.writes).toHaveLength(2);
    expect(complete.attempts.at(-1)?.evidence?.native.operationName).toBe(f.operation);
  });
  it('keeps uncertain still-present deletion pending without replay or dependent effects',async()=>{
    const f=await fixture();f.state.lostTagBeforeEffect=true;const first=await f.apply(await f.plan());expect(first.status).toBe('pending');
    expect((await f.recover(first)).status).toBe('pending');expect((await f.recover(first)).status).toBe('pending');
    expect(f.writes).toHaveLength(1);expect(f.state.tag).toBe(true);expect(f.state.image).toBe(true);
  });
  it('can prove completed deletion with current read authority after delete permissions were removed',async()=>{
    const f=await fixture();f.state.lostVersionAck=true;const first=await f.apply(await f.plan());expect(first.status).toBe('pending');
    f.state.readOnlyPermissions=true;
    expect((await f.recover(first)).status).toBe('retired');expect(f.writes).toHaveLength(2);
  });
  it('does not call a denied read absence after an accepted delete or lose its attempt', async () => {
    const f = await fixture(), plan = await f.plan(); f.state.denyAfterDelete = true;
    const first = await f.apply(plan); expect(first.status).toBe('pending'); expect(first.attempts).toHaveLength(1);
    expect((await f.recover(first)).status).toBe('pending'); expect(f.writes).toHaveLength(1);
    f.state.denyAfterDelete = false; const observed = await f.recover(first); expect(observed.completed[plan.plan.actions[0].id]).toBeDefined();
    expect(f.writes).toHaveLength(1);
  });
  it('requires a fresh exact retry confirmation for a definitely rejected deletion', async () => {
    const f = await fixture(), plan = await f.plan(); f.state.rejectDelete = true;
    const first = await f.apply(plan); expect(first.attempts.at(-1)?.status).toBe('rejected');
    f.state.rejectDelete = false; expect((await f.apply(first)).status).toBe('blocked'); expect(f.writes).toHaveLength(1);
    const retry = await reviewCloudInstallationRetryV1({ ...f.context, installationId: first.installationId, planDigest: first.plan.digest });
    expect(retry.retryActions).toEqual([{ actionId: plan.plan.actions[0].id, attemptId: first.attempts[0].id }]);
    expect((await f.apply(first, plan.plan.actions.map(action => action.id), retry.retryActions)).status).toBe('retired'); expect(f.writes).toHaveLength(3);
  });
  it('rechecks current authorization before deletion and rejects forged native targets', async () => {
    const f = await fixture(), plan = await f.plan(); f.revoke(); expect((await f.apply(plan)).status).toBe('blocked'); expect(f.writes).toEqual([]);
    const forged = structuredClone(plan.plan.actions[0]); forged.metadata.native.tag = 'hv-' + randomUUID();
    await expect(f.context.driver.inspect({ intent: f.intent, action: forged, authentication: f.context.authentication, signal: new AbortController().signal,
      beforeMutation: async () => {}, completed: {}, lineage: [], attempts: [] } as any)).resolves.toMatchObject({ state: 'unknown' });
    expect(f.writes).toEqual([]);
  });
  it.each(['uncorrelated-attempt','missing-attempt'] as const)('rejects %s historical publication evidence before native reads',async variant=>{
    const f=await fixture(),original=structuredClone(f.original),intent=structuredClone(f.intent);
    if(variant==='missing-attempt')original.attempts=[];
    else { const proof=Object.values(original.completed)[0],id=randomUUID();proof.native.attemptId=id;proof.native.tag='hv-'+id; }
    intent.retirement!.targets[0].evidenceDigest=canonicalJsonSha256(historicalInstallationEvidence(original));
    const driver=createGcpOperatorArtifactRetirementDriver([original],{fetch:f.request});
    await driver.plan({intent,authentication:f.context.authentication,signal:new AbortController().signal,beforeMutation:async()=>{},completed:{},attempts:[]} as any).catch(()=>undefined);
    expect(f.requests).toEqual([]);expect(f.writes).toEqual([]);
  });
});
