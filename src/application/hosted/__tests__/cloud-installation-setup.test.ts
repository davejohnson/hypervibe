import { describe, expect, it, vi } from 'vitest';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1, prepareCloudInstallationSetupV1,
  parseCloudInstallationSetupV1, cloudInstallationSetupConfirmationsV1, cloudInstallationSetupStagesV1 } from '../cloud-installation.js';
import type { CloudInstallationAction, CloudInstallationDriver, CloudInstallationEvidence, CloudInstallationIntent,
  CloudInstallationProvider, CloudInstallationRecord } from '../../../domain/ports/cloud-installation.port.js';

// Synthetic shared-boundary semantics. These test the same manifest/confirmation
// contract across the named roster; serialized native contracts remain separate.
function fixture(provider: CloudInstallationProvider = 'gcp', changed: Partial<CloudInstallationIntent> = {}) {
  const intent: CloudInstallationIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customerId: 'customer', appId: 'app', environment: 'staging', provider, mode: 'connect', keys: ['API_KEY'],
    source: { repository: 'github.com/studio/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
    nativeScope: { account: 'selected-account' }, hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
      serviceAccountEmail: 'host@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' }, ...changed };
  let record: CloudInstallationRecord | null = null;
  let authorized = true, present = false;
  const action: CloudInstallationAction = { id: 'writer', type: 'create', resource: { kind: 'secret', name: 'scoped-writer', provider },
    verified: true, requiresConfirm: true, reason: 'Create the selected writer.',
    metadata: { operation: 'createWriter', category: 'identity', execution: 'api', native: {} } };
  const evidence: CloudInstallationEvidence = { resources: [{ kind: 'writer', id: 'native-unique-writer', identity: {} }], native: {} };
  const driver: CloudInstallationDriver = { provider, parseScope: value => value as Record<string, string>,
    parseAction: value => value as CloudInstallationAction, parseEvidence: value => value as CloudInstallationEvidence,
    plan: async () => ({ actions: [action], review: { resources: [{ kind: 'writer', name: 'scoped-writer', scope: 'selected-account' }],
      permissions: [{ principal: 'scoped-writer', scope: 'one-secret', actions: ['write-version'], purpose: 'writer' }], costs: [], warnings: [] } }),
    inspect: async () => present ? { state: 'satisfied', evidence } : { state: 'action-required' },
    mutate: vi.fn(async context => { await context.beforeMutation(); present = true; return { state: 'acknowledged' as const, evidence }; }),
    recover: async () => present ? { state: 'satisfied', evidence } : { state: 'unknown', reason: 'not_converged' }, connections: () => [] };
  const context = { driver, authorize: async () => authorized, authentication: { host: {
    verifyIdentity: async () => intent.hostIdentity, getIdToken: async () => 'synthetic-id', getAccessToken: async () => 'synthetic-access' } },
  store: { read: async () => structuredClone(record), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord) => {
    if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
  } } };
  return { intent, action, evidence, driver, context, plan: () => planCloudInstallationV1({ ...context, intent }), revoke: () => { authorized = false; } };
}

describe('bounded hosted setup approval', () => {
  it.each(['aws', 'azure', 'gcp'] as const)('%s keeps its existing single native plan and action gates', async provider => {
    const f = fixture(provider), record = await f.plan();
    expect(cloudInstallationSetupStagesV1({ record, driver: f.driver })).toEqual([]);
    const setup = prepareCloudInstallationSetupV1({ record, driver: f.driver });
    expect(setup.review).toEqual(record.plan.review);
    expect(setup.root.plan).toEqual(record.plan);
    const restarted = JSON.parse(JSON.stringify(setup));
    expect(parseCloudInstallationSetupV1(restarted, f.driver)).toEqual(setup);
    const confirmActions = cloudInstallationSetupConfirmationsV1({ setup: restarted, approvedDigest: setup.digest, record, driver: f.driver });
    expect(confirmActions).toEqual(['writer']);
    const ready = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions });
    expect(ready.status).toBe('ready');
    expect(f.driver.mutate).toHaveBeenCalledOnce();
    expect(cloudInstallationSetupConfirmationsV1({ setup, approvedDigest: setup.digest, record: ready, driver: f.driver })).toEqual(['writer']);
  });
  it.each(['customer', 'app', 'environment', 'source', 'scope', 'keys', 'host', 'purpose'])(
    'does not authorize a valid newly planned change in %s', async change => {
      const f = fixture(), root = await f.plan();
      const setup = prepareCloudInstallationSetupV1({ record: root, driver: f.driver });
      const selected = structuredClone(f.intent);
      if (change === 'customer') selected.customerId = 'other-customer';
      if (change === 'app') selected.appId = 'other-app';
      if (change === 'environment') selected.environment = 'production';
      if (change === 'source') selected.source.revision = 'c'.repeat(40);
      if (change === 'scope') selected.nativeScope.account = 'other-account';
      if (change === 'keys') selected.keys.push('OTHER_KEY');
      if (change === 'host') selected.hostIdentity.subject = '123456789012345678902';
      if (change === 'purpose') selected.purpose = 'collection'; // even omitted historical purpose is not rewritten
      const other = fixture('gcp', selected), changed = await other.plan();
      expect(() => cloudInstallationSetupConfirmationsV1({ setup, approvedDigest: setup.digest, record: changed, driver: f.driver })).toThrow();
      expect(f.driver.mutate).not.toHaveBeenCalled();
    });
  it('requires the persisted approval digest and rejects a modified aggregate review', async () => {
    const f = fixture(), record = await f.plan(), setup = prepareCloudInstallationSetupV1({ record, driver: f.driver });
    expect(() => cloudInstallationSetupConfirmationsV1({ setup, approvedDigest: '', record, driver: f.driver })).toThrow();
    const changed = structuredClone(setup); changed.review.permissions[0].actions.push('read-value');
    expect(() => cloudInstallationSetupConfirmationsV1({ setup: changed, approvedDigest: setup.digest, record, driver: f.driver })).toThrow();
    expect(() => prepareCloudInstallationSetupV1({ record, driver: f.driver,
      continuationInstallationIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] })).toThrow();
    expect(f.driver.mutate).not.toHaveBeenCalled();
  });
  it('resumes unattempted approved actions after read-only recovery verifies the prior write', async () => {
    const f = fixture();
    const second = { ...f.action, id: 'trust', dependsOn: ['writer'], resource: { ...f.action.resource, name: 'writer-trust' } };
    f.driver.plan = async () => ({ actions: [f.action, second], review: { permissions: [], costs: [], warnings: [] } });
    const existing = new Set<string>(); let readbackReady = false;
    f.driver.inspect = async context => existing.has(context.action.id) && readbackReady
      ? { state: 'satisfied', evidence: f.evidence } : { state: 'action-required' };
    f.driver.mutate = vi.fn(async context => { await context.beforeMutation(); existing.add(context.action.id);
      return { state: 'acknowledged' as const, evidence: f.evidence }; });
    f.driver.recover = async context => existing.has(context.action.id) && readbackReady
      ? { state: 'satisfied', evidence: f.evidence } : { state: 'pending', reason: 'not_converged' };
    const root = await f.plan(), setup = prepareCloudInstallationSetupV1({ record: root, driver: f.driver });
    const confirmed = (record: CloudInstallationRecord) => cloudInstallationSetupConfirmationsV1({ setup,
      approvedDigest: setup.digest, record, driver: f.driver });
    const pending = await applyCloudInstallationV1({ ...f.context, installationId: root.installationId,
      planDigest: root.plan.digest, confirmActions: confirmed(root) });
    expect(pending.status).toBe('pending'); expect(() => confirmed(pending)).toThrow();
    readbackReady = true;
    const recovered = await reconcileCloudInstallationV1({ ...f.context, installationId: root.installationId, planDigest: root.plan.digest });
    expect(recovered.completed.writer).toBeDefined();
    expect(recovered.reason).toBe('not_installed');
    expect(confirmed(recovered)).toEqual(['writer', 'trust']);
    expect((await applyCloudInstallationV1({ ...f.context, installationId: root.installationId,
      planDigest: root.plan.digest, confirmActions: confirmed(recovered) })).status).toBe('ready');
    expect(f.driver.mutate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.driver.mutate).mock.calls.filter(([context]) => context.action.id === 'writer')).toHaveLength(1);
  });

  it('preserves live authorization checks after confirmations were derived', async () => {
    const f = fixture(), record = await f.plan(), setup = prepareCloudInstallationSetupV1({ record, driver: f.driver });
    const confirmActions = cloudInstallationSetupConfirmationsV1({ setup, approvedDigest: setup.digest, record, driver: f.driver });
    f.revoke();
    const result = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions });
    expect(result.status).toBe('blocked'); expect(f.driver.mutate).not.toHaveBeenCalled();
  });
});
