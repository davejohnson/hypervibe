import { describe, expect, it } from 'vitest';
import * as engine from '../cloud-installation.js';
import { createGcpCloudInstallationDriver } from '../../../adapters/providers/gcp/gcp-cloud-installation.js';
import type { CloudInstallationAction, CloudInstallationDriver, CloudInstallationIntent, CloudInstallationRecord } from '../../../domain/ports/cloud-installation.port.js';

async function fixture() {
  const records = new Map<string, CloudInstallationRecord>(), present = new Set<string>(); let mutations = 0;
  const base: CloudInstallationIntent = { schemaVersion: 1, installationId: '11111111-1111-4111-8111-111111111111', customerId: 'customer', appId: 'app', environment: 'test',
    provider: 'gcp', mode: 'connect', keys: ['KEY'], nativeScope: { projectId: 'customer-project', projectNumber: '123456789012' },
    source: { repository: 'github.com/example/app', branch: 'setup', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
    hostIdentity: { kind: 'gcp-service-account', projectId: 'shared-project', projectNumber: '987654321098', serviceAccountEmail: 'host@shared-project.iam.gserviceaccount.com',
      subject: '999999999999999999999', issuer: 'https://accounts.google.com' } };
  const driver: CloudInstallationDriver = { provider: 'gcp', retirement: { schemaVersion: 1 },
    deployment: { hostingProvider: 'cloudrun', connection: () => { throw new Error('No connection issuance in this fixture'); } },
    parseScope: value => value as Record<string, string>, parseAction: value => value as CloudInstallationAction,
    parseEvidence: value => value as any, connections: () => [],
    plan: async ({ intent }) => ({ actions: [{ id: 'one', type: intent.mode === 'retire' ? 'destroy' : 'create', verified: true, requiresConfirm: true,
      resource: { kind: 'secret', name: 'exact-owned-secret', provider: 'gcp' }, reason: 'Exact fixture resource',
      metadata: { operation: intent.mode === 'retire' ? 'retire' : 'install', category: intent.mode === 'retire' ? 'secret-container' : 'identity', execution: 'api', native: {} } }],
      review: { permissions: [], costs: [], warnings: [] } }),
    inspect: async ({ intent }) => present.has(intent.installationId) ? { state: 'satisfied', evidence: { resources: [], native: {} } } : { state: 'action-required' },
    recover: async ({ intent }) => present.has(intent.installationId) ? { state: 'satisfied', evidence: { resources: [], native: {} } } : { state: 'pending', reason: 'not_converged' },
    mutate: async context => { await context.beforeMutation(); mutations++; present.add(context.intent.installationId); return { state: 'acknowledged' }; },
  };
  const context = { driver, store: { read: async (id: string) => structuredClone(records.get(id) ?? null),
    compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true;
    } }, authorize: async () => true, authentication: { host: { verifyIdentity: async () => base.hostIdentity,
      getAccessToken: async () => 'synthetic-token', getIdToken: async () => 'synthetic-token' } } };
  async function seed(intent: CloudInstallationIntent) {
    const plan = await engine.planCloudInstallationV1({ ...context, intent });
    return engine.applyCloudInstallationV1({ ...context, installationId: intent.installationId, planDigest: plan.plan.digest, confirmActions: ['one'] });
  }
  const collection = await seed(base), deployment = await seed({ ...base, installationId: '22222222-2222-4222-8222-222222222222', keys: [], purpose: 'deployment', stage: 'deployment',
    source: { ...base.source, branch: 'main', revision: 'c'.repeat(40) },
    deployment: { hostingProvider: 'cloudrun', region: 'us-central1', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] } });
  return { driver, context, records: [collection, deployment], mutations: () => mutations };
}

describe('explicit hosted installation retirement boundary', () => {
  it('offers a separate retirement contract without widening trust disconnect', () => {
    // User contract: full customer cleanup must be agent-accessible, while the
    // existing disconnect contract continues preserving values and readers.
    expect((engine as Record<string, unknown>).cloudInstallationRetirementIntentV1).toBeTypeOf('function');
    expect((createGcpCloudInstallationDriver() as any).retirement).toMatchObject({ schemaVersion: 1 });
  });
  it('runs separate confirmed retirement through durable shared plan/apply/reconcile with different setup/source branches', async () => {
    const f = await fixture(); const intent = engine.cloudInstallationRetirementIntentV1({ records: f.records,
      installationId: '33333333-3333-4333-8333-333333333333', data: 'delete-owned' }, f.driver);
    expect(intent.source.branch).toBe('main'); expect(intent.retirement.records).toHaveLength(2);
    const plan = await engine.planCloudInstallationV1({ ...f.context, intent });
    expect(await engine.applyCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: plan.plan.digest, confirmActions: [] }))
      .toMatchObject({ status: 'blocked', reason: 'confirmation_required' });
    expect(f.mutations()).toBe(2);
    const done = await engine.applyCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: plan.plan.digest, confirmActions: ['one'] });
    expect(done.status).toBe('retired'); expect(engine.parseCloudInstallationRecordV1(done, f.driver).status).toBe('retired');
    expect(await engine.reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: plan.plan.digest })).toEqual(done);
    expect(f.mutations()).toBe(3);
  });
  it.each(['pending', 'wrong-scope', 'extra-record', 'nested-retirement', 'tampered-evidence', 'redacted-completed'] as const)('rejects %s originals before any native plan', async change => {
    const f = await fixture(), records = structuredClone(f.records);
    if (change === 'pending') records[0].attempts[0].status = 'uncertain';
    if (change === 'wrong-scope') records[0].intent.nativeScope.projectNumber = '111111111111';
    if (change === 'extra-record') records.push(records[0]);
    if (change === 'nested-retirement') records[0].intent.mode = 'retire';
    if (change === 'tampered-evidence') records[0].plan.digest = 'f'.repeat(64);
    if (change === 'redacted-completed') records[0].completed.one = '[REDACTED]' as any;
    expect(() => engine.cloudInstallationRetirementIntentV1({ records, installationId: '33333333-3333-4333-8333-333333333333', data: 'delete-owned' }, f.driver)).toThrow('invalid_contract');
    expect(f.mutations()).toBe(2);
  });
});
