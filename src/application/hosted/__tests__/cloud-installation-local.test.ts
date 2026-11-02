import { describe, expect, it, vi } from 'vitest';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1,
  parseCloudInstallationRecordV1, cloudInstallationNextStageV1 } from '../cloud-installation.js';
import type { CloudInstallationAction, CloudInstallationContext, CloudInstallationRecord } from '../../../domain/ports/cloud-installation.port.js';

// Synthetic provider semantics test local authorization and durable recovery only.
// Native CreateProject transport evidence lives in gcp-local-project-allocation.test.ts.
const intent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customerId: 'local-project', appId: 'app-project', environment: 'test', provider: 'gcp',
  mode: 'connect', stage: 'scope-preparation', keys: [],
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun',
  source: { kind: 'local-spec', repository: 'github.com/example/app', specRevision: 3, specDigest: 'b'.repeat(64) },
  nativeScope: { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: 'example-project', displayName: 'Example' } };
const action: CloudInstallationAction = { id: 'gcp:project', type: 'create', resource: { kind: 'project', name: 'example-project', provider: 'gcp' },
  verified: true, requiresConfirm: true, reason: 'Allocate the reviewed empty project.',
  metadata: { operation: 'create-project', category: 'scope', execution: 'api', native: { allocationMode: 'create-exclusive-v1' } } };
const evidence = { resources: [{ kind: 'project', id: 'projects/123456789', identity: { projectId: 'example-project' } }], native: {} };
function fixture(actions = [action]) {
  let saved: CloudInstallationRecord | null = null; let present = false;
  const driver = { provider: 'gcp', localScopePreparation: { hostingProvider: 'cloudrun' },
    parseScope: (value: unknown) => value, parseAction: (value: unknown) => value, parseEvidence: (value: unknown) => value,
    scopePreparation: { resolvedScope: () => intent.nativeScope, reviewResources: () => [] },
    plan: vi.fn(async () => ({ actions, review: { permissions: [], costs: [], warnings: [] } })),
    inspect: vi.fn(async () => present ? { state: 'satisfied', evidence } : { state: 'action-required' }),
    mutate: vi.fn(async (context: any) => { expect(saved!.attempts.at(-1)?.status).toBe('attempted'); await context.beforeMutation(); present = true; return { state: 'acknowledged', evidence }; }),
    recover: vi.fn(async () => present ? { state: 'satisfied', evidence } : { state: 'unknown', reason: 'not_converged' }),
    connections: vi.fn(() => []) };
  const store = { read: vi.fn(async () => saved && structuredClone(saved)),
    compareAndSwap: vi.fn(async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((saved?.revision ?? null) !== revision) return false; saved = structuredClone(next); return true;
    }) };
  const context = { driver, store, authorize: vi.fn(async () => true),
    authentication: { kind: 'local-administrator', administrator: { getAccessToken: vi.fn(async () => 'synthetic-transient-user-token') } } } as unknown as CloudInstallationContext;
  const plan = (value: unknown = intent) => planCloudInstallationV1({ ...context, intent: value });
  const apply = (confirmActions = [action.id]) => applyCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest, confirmActions });
  const reconcile = () => reconcileCloudInstallationV1({ ...context, installationId: saved!.installationId, planDigest: saved!.plan.digest });
  return { driver, store, context, plan, apply, reconcile, saved: () => saved! };
}
describe('local empty-project shared lifecycle', () => {
  it('plans and applies one exact project action without any host identity or source commit assertion', async () => {
    const f = fixture(); const planned = await f.plan();
    expect(planned.intent.source).toEqual(intent.source);
    expect(planned.intent).not.toHaveProperty('hostIdentity');
    expect((await f.apply([])).reason).toBe('confirmation_required');
    expect(f.driver.mutate).not.toHaveBeenCalled();
    expect((await f.apply()).status).toBe('scope-ready');
    expect(f.driver.mutate).toHaveBeenCalledOnce();
    expect((await f.reconcile()).status).toBe('scope-ready');
    expect(f.driver.mutate).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.saved())).not.toContain('synthetic-transient-user-token');
  });
  it('rejects additional actions before persisting or dispatching a local plan', async () => {
    const f = fixture([action, { ...action, id: 'gcp:billing' }]);
    await expect(f.plan()).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(f.store.compareAndSwap).not.toHaveBeenCalled(); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('does not turn local project completion into a hosted continuation or a provider write on noop', async () => {
    const f = fixture([{ ...action, type: 'noop', requiresConfirm: false }]);
    f.driver.inspect.mockResolvedValue({ state: 'satisfied', evidence });
    await f.plan(); expect((await f.apply([])).status).toBe('scope-ready');
    expect(f.driver.mutate).not.toHaveBeenCalled(); expect(f.saved().attempts).toEqual([]);
    expect(() => cloudInstallationNextStageV1(f.saved(), f.context.driver)).toThrow('unsupported');
  });
  it.each([
    { stage: 'collection' }, { stage: 'deployment' }, { provider: 'aws' }, { provider: 'azure' },
    { keys: ['SECRET'] }, { mode: 'disconnect' }, { purpose: 'deployment' },
    { hostIdentity: {} }, { installed: [] }, { scopePreparation: { installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', planDigest: 'c'.repeat(64) } },
    { source: { ...intent.source, branch: 'main', revision: 'a'.repeat(40) } },
  ])('rejects local authority outside empty project preparation: %j', async change => {
    const f = fixture(); await expect(f.plan({ ...intent, ...change })).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(f.driver.plan).not.toHaveBeenCalled();
  });
  it('requires an explicitly declared local driver and local authentication', async () => {
    const f = fixture(); delete (f.driver as { localScopePreparation?: unknown }).localScopePreparation;
    await expect(f.plan()).rejects.toMatchObject({ code: 'invalid_contract' });
    const g = fixture(); (g.context as any).authentication = { host: { verifyIdentity: vi.fn() } };
    await expect(g.plan()).rejects.toMatchObject({ code: 'authorization_expired' });
    expect(g.driver.plan).not.toHaveBeenCalled();
  });
  it('rechecks current local approval after native reads and retains an uncertain attempt across restart', async () => {
    const f = fixture(); await f.plan();
    f.driver.mutate.mockImplementationOnce(async context => { vi.mocked(f.context.authorize).mockResolvedValue(false); await context.beforeMutation(); return { state: 'acknowledged', evidence }; });
    expect((await f.apply()).status).toBe('blocked');
    const g = fixture(); await g.plan(); g.driver.mutate.mockImplementationOnce(async context => { await context.beforeMutation(); throw new Error('lost reply'); });
    expect((await g.apply()).status).toBe('pending');
    expect(parseCloudInstallationRecordV1(JSON.parse(JSON.stringify(g.saved())), g.context.driver).attempts[0].status).toBe('uncertain');
    expect((await g.apply()).status).toBe('pending'); expect(g.driver.mutate).toHaveBeenCalledOnce();
  });
});
