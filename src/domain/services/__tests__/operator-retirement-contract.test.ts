import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { CloudScopePreparationRepository, acceptedJournalLeaf } from '../../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { operatorApplicationDeclarationSchema } from '../../ports/operator-application.port.js';
import { operatorArtifactDeclarationSchema } from '../../ports/operator-artifact.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { applyCloudInstallationV1, historicalInstallationEvidence, parseCloudInstallationRecordV1, planCloudInstallationV1, reconcileCloudInstallationV1, cloudInstallationResolvedScopeV1 } from '../cloud-installation-runtime.js';

// Shared-policy fixture, not native API evidence. Expected behavior comes from
// the requested explicit teardown boundary: retirement cannot be creation,
// disconnection, permanent-erasure proof, or permission to recreate a resource.
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-retirement-')); SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db')); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
  const project = new ProjectRepository().create({ name: 'retirement-test' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'test' });
  let exists = true; let deletes = 0; let lostAck = false;
  const proof = { resources: [{ kind: 'application', id: 'immutable-id', identity: { tenantId: 'tenant', createdAt: '2026-11-03T00:00:00Z' } }], native: {} };
  const driver: any = {
    provider: 'microsoft-entra', operatorApplication: { providerName: 'microsoft-entra' }, operatorRetirement: { schemaVersion: 1 },
    parseScope: (value: unknown) => value, parseAction: (value: unknown) => value, parseEvidence: (value: unknown) => value,
    scopePreparation: { resolvedScope: (record: any) => record.intent.nativeScope, reviewResources: () => [] }, connections: () => [],
    plan: async ({ intent }: any) => ({ actions: [{ id: 'operator:identity', type: intent.mode === 'retire' ? 'destroy' : 'create', verified: true,
      requiresConfirm: true, reason: 'Exact synthetic identity lifecycle', resource: { kind: 'project', name: 'operator', provider: 'microsoft-entra' },
      metadata: { operation: intent.mode === 'retire' ? 'retirement' : 'registration', category: 'identity', execution: 'api', native: {} } }],
      review: { permissions: [], costs: [], warnings: [] } }),
    inspect: async ({ intent }: any) => intent.mode === 'retire' ? exists ? { state: 'action-required' } : { state: 'satisfied', evidence: {
      ...proof, native: { retirement: { outcome: 'removed', retained: [] } } } } : { state: 'satisfied', evidence: proof },
    mutate: async (context: any) => { await context.beforeMutation(); deletes++; exists = false; return lostAck ? { state: 'uncertain', reason: 'timeout' } : { state: 'acknowledged' }; },
    recover: async (context: any) => driver.inspect(context),
  };
  const store = new CloudScopePreparationRepository<any>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name },
    value => parseCloudInstallationRecordV1(value, driver), { recordType: 'operator-applications:test' });
  const context: any = { driver, store, authentication: { kind: 'operator-application' }, authorize: async () => true };
  const intent: any = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id, environment: 'test',
    provider: 'microsoft-entra', applicationProvider: 'microsoft-entra', mode: 'connect', stage: 'scope-preparation', keys: [],
    execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope: { tenantId: 'tenant' },
    source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 1, specDigest: 'a'.repeat(64) } };
  const planned = await planCloudInstallationV1({ ...context, intent });
  const prior = await applyCloudInstallationV1({ ...context, installationId: planned.installationId, planDigest: planned.plan.digest, confirmActions: ['operator:identity'] });
  const from = { installationId: prior.installationId, planDigest: prior.plan.digest };
  const selection = { from, resources: 'delete-owned', data: 'retain' };
  const next = { ...intent, installationId: randomUUID(), mode: 'retire', predecessor: from,
    retirement: { ...selection, targets: [{ ...from, evidenceDigest: canonicalJsonSha256(historicalInstallationEvidence(prior)) }] } };
  return { context, driver, store, prior, next, selection, project, environment, proof, deletes: () => deletes, loseAck: () => { lostAck = true; } };
}

describe('explicit completed operator retirement contract', () => {
  it('accepts an exact retirement declaration for applications and artifacts without treating omission as deletion', async () => {
    const f = await fixture();
    const application = { provider: 'microsoft-entra', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web', nativeScope: { tenantId: 'tenant' } };
    expect(operatorApplicationDeclarationSchema.parse({ ...application, retirement: f.selection })).toHaveProperty('retirement', f.selection);
    expect(operatorApplicationDeclarationSchema.parse(application)).not.toHaveProperty('retirement');
    const artifact = { provider: 'cloudrun', nativeScope: {}, artifacts: ['application-candidate-v1'] };
    expect(operatorArtifactDeclarationSchema.parse({ ...artifact, retirement: f.selection })).toHaveProperty('retirement', f.selection);
    expect(() => operatorApplicationDeclarationSchema.parse({ ...application, retirement: { ...f.selection, force: true } })).toThrow();
    expect(() => operatorArtifactDeclarationSchema.parse({ ...artifact, refreshFrom: f.selection.from, retirement: f.selection })).toThrow();
  });

  it('retires through the real durable kernel, preserves its predecessor and cannot fall back to ready creation evidence', async () => {
    const f = await fixture();
    const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    const retired = await applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] });
    expect(retired.status).toBe('retired'); expect(f.deletes()).toBe(1);
    expect(await f.store.read(f.prior.installationId)).toEqual(f.prior);
    expect(acceptedJournalLeaf(await f.store.findByScope())?.installationId).toBe(retired.installationId);
    expect(historicalInstallationEvidence(retired)).toBeUndefined();
    expect(() => cloudInstallationResolvedScopeV1(retired, f.driver)).toThrow();
    expect(new RunRepository().findById(retired.installationId)?.status).toBe('succeeded');
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db'));
    expect(await reconcileCloudInstallationV1({ ...f.context, installationId: retired.installationId, planDigest: retired.plan.digest })).toEqual(retired);
    expect(f.deletes()).toBe(1);
    await expect(planCloudInstallationV1({ ...f.context, intent: { ...f.next, installationId: randomUUID(), mode: 'connect', retirement: undefined, predecessor: { installationId: retired.installationId, planDigest: retired.plan.digest } } })).rejects.toThrow();
  });

  it('keeps completed retirement terminal even if a caller or historical policy tries to reopen it', async () => {
    const f = await fixture(); const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    const retired = await applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] });
    await expect(f.store.compareAndSwap(retired.installationId, retired.revision, { ...retired, revision: retired.revision + 1, status: 'pending' })).rejects.toThrow();
    expect(await f.store.read(retired.installationId)).toEqual(retired);
    const oldDriver = { ...f.driver }; delete oldDriver.operatorRetirement;
    expect(() => parseCloudInstallationRecordV1(retired, oldDriver)).toThrow();
    expect(f.deletes()).toBe(1);
    const permissive = new CloudScopePreparationRepository<any>({ projectId: f.project.id, environmentId: f.environment.id, environmentName: f.environment.name },
      value => parseCloudInstallationRecordV1(value, f.driver), { recordType: 'operator-applications:test', allowHistoricalPredecessor: () => true });
    const plan = vi.spyOn(f.driver, 'plan');
    await expect(planCloudInstallationV1({ ...f.context, store: permissive, intent: { ...f.next, installationId: randomUUID(), mode: 'connect', retirement: undefined,
      predecessor: { installationId: retired.installationId, planDigest: retired.plan.digest } } })).rejects.toThrow();
    expect(plan).not.toHaveBeenCalled();
  });

  it.each(['deletion-scheduled', 'retained-by-choice'])('requires exact retained identities and truthful %s outcome', async outcome => {
    const f = await fixture();
    vi.spyOn(f.driver, 'inspect').mockImplementation(async ({ intent }: any) => intent.mode === 'retire' ? { state: 'satisfied', evidence: {
      ...f.proof, native: { retirement: { outcome, retained: [{ kind: 'application', id: 'immutable-id', identity: {}, reason: 'data-retention' }] } },
    } } : { state: 'satisfied', evidence: f.proof });
    const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    await expect(applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] })).rejects.toThrow();
    expect(f.deletes()).toBe(0);
  });

  it.each(['attempt', 'reason'])('rejects unresolved %s in a claimed terminal retirement', async change => {
    const f = await fixture(); const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    const retired = await applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] });
    const altered = change === 'attempt' ? { ...retired, attempts: retired.attempts.map(attempt => ({ ...attempt, status: 'uncertain' })) } : { ...retired, reason: 'not_converged' };
    expect(() => parseCloudInstallationRecordV1(altered, f.driver)).toThrow();
  });

  it.each(['deletion-scheduled', 'retained-by-choice'])('retains verified %s evidence without declaring resources ready or permanently erased', async outcome => {
    const f = await fixture();
    const retention = { outcome, retained: [{ kind: 'application', id: 'immutable-id', identity: { tenantId: 'tenant', createdAt: '2026-11-03T00:00:00Z' },
      reason: outcome === 'deletion-scheduled' ? 'provider-retention' : 'data-retention', ...(outcome === 'deletion-scheduled' ? { retentionUntil: '2026-12-03T00:00:00Z' } : {}) }] };
    vi.spyOn(f.driver, 'inspect').mockResolvedValue({ state: 'satisfied', evidence: { ...f.proof, native: { retirement: retention } } });
    const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    const retired = await applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] });
    expect(retired.status).toBe('retired'); expect(retired.completed['operator:identity'].native.retirement).toEqual(retention);
    expect(historicalInstallationEvidence(retired)).toBeUndefined(); expect(f.deletes()).toBe(0);
  });

  it('cannot report deliberate data retention as completion of a delete-data request', async () => {
    const f = await fixture(); f.next.retirement.data = 'delete-owned';
    vi.spyOn(f.driver, 'inspect').mockResolvedValue({ state: 'satisfied', evidence: { ...f.proof, native: { retirement: {
      outcome: 'retained-by-choice', retained: [{ kind: 'container', id: 'immutable-id', identity: { lifetime: 'exact' }, reason: 'data-retention' }],
    } } } });
    const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    await expect(applyCloudInstallationV1({ ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] })).rejects.toThrow();
    expect(f.deletes()).toBe(0);
  });

  it('keeps a lost delete acknowledgment for read-only recovery without replay', async () => {
    const f = await fixture(); f.loseAck();
    const next = await planCloudInstallationV1({ ...f.context, intent: f.next });
    const input = { ...f.context, installationId: next.installationId, planDigest: next.plan.digest, confirmActions: ['operator:identity'] };
    expect((await applyCloudInstallationV1(input)).status).not.toBe('retired');
    expect((await reconcileCloudInstallationV1(input)).status).toBe('retired'); expect(f.deletes()).toBe(1);
  });

  it.each(['wrong-digest', 'foreign-source', 'missing-capability', 'missing-predecessor', 'changed-evidence'])('rejects %s before any provider plan or deletion', async change => {
    const f = await fixture(); const spy = vi.spyOn(f.driver, 'plan');
    if (change === 'wrong-digest') f.next.retirement.from.planDigest = 'b'.repeat(64);
    if (change === 'foreign-source') f.next.source = { ...f.next.source, repository: 'github.com/other/app' };
    if (change === 'missing-capability') delete f.driver.operatorRetirement;
    if (change === 'missing-predecessor') delete f.next.predecessor;
    if (change === 'changed-evidence') f.next.retirement.targets[0].evidenceDigest = 'f'.repeat(64);
    await expect(planCloudInstallationV1({ ...f.context, intent: f.next })).rejects.toThrow(); expect(spy).not.toHaveBeenCalled(); expect(f.deletes()).toBe(0);
  });
});
