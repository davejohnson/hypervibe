import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { createEntraOperatorApplicationDriver } from '../entra-operator-application.js';

import { entraNativeFixture } from './entra-operator-application.fixture.js';

function fixture(options: Parameters<typeof entraNativeFixture>[0] = {}) {
  const native = entraNativeFixture(options), driver = createEntraOperatorApplicationDriver({ fetch: native.request }); let record: any;
  const intent: any = { schemaVersion: 1, installationId: randomUUID(), customerId: 'app', appId: 'app', environment: 'test',
    source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 1, specDigest: 'a'.repeat(64) },
    provider: 'microsoft-entra', applicationProvider: 'microsoft-entra', execution: { kind: 'operator-application', authentication: 'local-operator' },
    mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope: { tenantId: native.tenantId, name: 'azure', origin: 'https://operator.example.test',
      googleSubject: '123456789012345678901', googleServiceAccount: 'runtime@owned-project.iam.gserviceaccount.com' } };
  const context = { driver, authentication: { kind: 'operator-application' as const, administrator: { getAccessToken: async (scope: string) => {
    expect(scope).toBe('https://graph.microsoft.com/.default'); return 'synthetic-transient-graph-token'; } } },
    authorize: async () => true, store: { read: async () => record ?? null, compareAndSwap: async (_id: string, revision: number | null, value: any) => {
      if ((record?.revision ?? null) !== revision) return false; record = structuredClone(value); return true;
    } } };
  return { native, driver, intent, context, record: () => record };
}
describe('Entra keyless operator registration', () => {
  it('creates an exact multi-tenant callback then separate FIC without issuing any password', async () => {
    const f = fixture(); let record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(f.native.writes).toEqual([]); expect(record.plan.actions).toHaveLength(2);
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest,
      confirmActions: record.plan.actions.map(action => action.id) });
    expect(record.status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(2);
    expect(f.native.writes[0].body).toMatchObject({ signInAudience: 'AzureADMultipleOrgs', web: { redirectUris: ['https://operator.example.test/cloud-authorizations/azure'] } });
    expect(f.native.writes[0].body).not.toHaveProperty('passwordCredentials');
    expect(f.native.writes[1].body).toMatchObject({ issuer: 'https://accounts.google.com', subject: '123456789012345678901', audiences: ['api://AzureADTokenExchange'] });
    expect(JSON.stringify(record)).not.toContain('synthetic-transient-graph-token');
    await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(f.native.writes).toHaveLength(2);
  });
  it.each(['application', 'federation'] as const)('does not replay a lost %s acknowledgment', async lost => {
    const f = fixture({ lost }); const planned = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    let record = await applyCloudInstallationV1({ ...f.context, installationId: planned.installationId, planDigest: planned.plan.digest, confirmActions: planned.plan.actions.map(action => action.id) });
    const writes = f.native.writes.length;
    record = await reconcileCloudInstallationV1({ ...f.context, installationId: planned.installationId, planDigest: planned.plan.digest });
    expect(f.native.writes).toHaveLength(writes);
    expect(record.completed[planned.plan.actions[lost === 'application' ? 0 : 1].id]).toBeDefined();
  });
  it('keeps denied reads unknown and exposes no echoed credentials', async () => {
    const f = fixture({ denied: true });
    await expect(planCloudInstallationV1({ ...f.context, intent: f.intent })).rejects.toThrow(/insufficient_permissions/);
    expect(f.native.writes).toEqual([]);
  });
  it('blocks changed native callbacks before dependent trust', async () => {
    const f = fixture(); const record = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest,
      confirmActions: [record.plan.actions[0].id], onlyActionId: record.plan.actions[0].id });
    f.native.corrupt();
    const changed = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest,
      confirmActions: [record.plan.actions[1].id], onlyActionId: record.plan.actions[1].id });
    expect(changed.status).not.toBe('scope-ready'); expect(f.native.writes).toHaveLength(1);
  });
  it('reviews a native rejection separately and permits only the reviewed new attempt', async () => {
    const options = { deniedWrites: true }, f = fixture(options);
    const plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    const target = { ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest };
    const rejected = await applyCloudInstallationV1({ ...target, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(rejected.attempts[0].status).toBe('rejected'); expect(f.native.writes).toEqual([]);
    options.deniedWrites = false;
    const retry = await reviewCloudInstallationRetryV1(target as any);
    expect(retry.retryActions).toEqual([{ actionId: plan.plan.actions[0].id, attemptId: rejected.attempts[0].id }]);
    const result = await applyCloudInstallationV1({ ...target, confirmActions: plan.plan.actions.map(action => action.id), retryActions: retry.retryActions });
    expect(result.status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(2);
    expect(result.attempts[0].status).toBe('rejected'); expect(result.attempts[1].status).toBe('succeeded');
  });

  it('retains an unexpected create success status as uncertain, without another POST', async () => {
    const f = fixture({ createStatus: 200 }), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    const target = { ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest };
    const result = await applyCloudInstallationV1({ ...target, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.attempts[0].status).toBe('uncertain'); expect(f.native.writes).toHaveLength(1);
    await reconcileCloudInstallationV1(target); expect(f.native.writes).toHaveLength(1);
  });

});
