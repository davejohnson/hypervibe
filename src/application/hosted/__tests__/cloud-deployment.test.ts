import { describe, expect, it, vi } from 'vitest';
import * as lifecycle from '../cloud-installation.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import type { CloudInstallationDriver, CloudInstallationIntent, CloudInstallationRecord } from '../../../domain/ports/cloud-installation.port.js';

// Synthetic provider semantics test only the shared purpose/authorization boundary.
// Provider-native IAM support and token identity require separate transport evidence.
const intent: CloudInstallationIntent = {
  schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'app-a', environment: 'production',
  provider: 'gcp', purpose: 'deployment', stage: 'deployment', mode: 'connect', keys: [],
  deployment: { hostingProvider: 'cloudrun', region: 'us-central1', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  nativeScope: { projectId: 'customer-project', projectNumber: '987654321', region: 'us-central1' },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
};
const principal = (name: string, uniqueId: string) => ({ kind: 'gcp-service-account' as const, projectId: 'customer-project', projectNumber: '987654321',
  serviceAccountEmail: `${name}@customer-project.iam.gserviceaccount.com`, serviceAccountUniqueId: uniqueId });
function receipt(record: CloudInstallationRecord) {
  const { schemaVersion, installationId, customerId, appId, environment, source, provider, nativeScope, hostIdentity } = record.intent;
  return { schemaVersion, purpose: 'deployment' as const, installationId, planDigest: record.plan.digest, customerId, appId, environment, source, provider,
    hostingProvider: 'cloudrun', deployment: record.intent.deployment!, nativeScope, hostIdentity,
    runtimeIdentities: [{ workload: 'web', installationId, owner: 'd'.repeat(64), principal: principal('runtime', '333333333333333333333') }],
    principals: { provision: principal('provision', '111111111111111111111'), release: principal('release', '222222222222222222222') } };
}
function fixture() {
  const saved = new Map<string, CloudInstallationRecord>(); let present = false;
  const evidence = { resources: [{ kind: 'deployment-identity', id: 'native-id', identity: { uniqueId: '123' } }], native: {} };
  const driver: CloudInstallationDriver = {
    provider: 'gcp', parseScope: value => value as Record<string, string>, parseAction: value => value as any, parseEvidence: value => value as any,
    deployment: { hostingProvider: 'cloudrun', connection: vi.fn(record => receipt(record)) },
    plan: vi.fn(async () => ({ actions: [{ id: 'deployment-identities', type: 'create' as const, resource: { provider: 'gcp' as const, kind: 'project' as const, name: 'customer-project' },
      verified: true, requiresConfirm: true, reason: 'Install separate provision and release identities.',
      metadata: { operation: 'install-deployment', category: 'identity' as const, execution: 'api' as const, native: {} } }],
    review: { permissions: [], costs: [], warnings: [] } })),
    inspect: async () => present ? { state: 'satisfied', evidence } : { state: 'action-required' },
    mutate: async context => { await context.beforeMutation(); present = true; return { state: 'acknowledged', evidence }; },
    recover: async () => present ? { state: 'satisfied', evidence } : { state: 'pending', reason: 'not_converged' }, connections: () => [],
  };
  const context = { driver, authorize: async () => true, authentication: { host: {
    verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => 'transient-only', getIdToken: async () => 'transient-only',
  } }, store: { read: async (id: string) => structuredClone(saved.get(id) ?? null), compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => {
    if ((saved.get(id)?.revision ?? null) !== revision) return false; saved.set(id, structuredClone(next)); return true;
  } } };
  const plan = () => lifecycle.planCloudInstallationV1({ ...context, intent });
  const apply = (record: CloudInstallationRecord) => lifecycle.applyCloudInstallationV1({ ...context, installationId: record.installationId,
    planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
  return { context, driver, plan, apply };
}
describe('purpose-specific deployment installation boundary', () => {
  it('requires reviewed deployment topology even when the source digest exists', async () => {
    const f = fixture();
    const withoutTopology = { ...intent }; delete withoutTopology.deployment;
    await expect(lifecycle.planCloudInstallationV1({ ...f.context, intent: withoutTopology })).rejects.toThrow();
    expect(f.driver.plan).not.toHaveBeenCalled();
  });
  it('uses the reviewed shared lifecycle and projects only a value-free deployment receipt', async () => {
    const f = fixture(); const plan = await f.plan();
    expect(() => lifecycle.cloudInstallationDeploymentConnectionV1(plan, f.driver)).toThrow();
    const ready = await f.apply(plan);
    expect(lifecycle.cloudInstallationDeploymentConnectionV1(ready, f.driver)).toEqual(receipt(ready));
    expect(() => lifecycle.cloudInstallationConnectionsV1(ready, f.driver)).toThrow();
    expect(JSON.stringify(ready)).not.toContain('transient-only');
  });
  it('rejects collection keys, migration, implicit stage, and undeclared deployment capability before provider work', async () => {
    for (const change of [{ keys: ['API_KEY'] }, { stage: undefined }, { stage: 'collection' }, { mode: 'migrate' }, { purpose: undefined }, { deployment: undefined }]) {
      const f = fixture();
      await expect(lifecycle.planCloudInstallationV1({ ...f.context, intent: { ...intent, ...change } })).rejects.toThrow();
      expect(f.driver.plan).not.toHaveBeenCalled();
    }
    const f = fixture(); delete f.driver.deployment;
    await expect(f.plan()).rejects.toThrow(); expect(f.driver.plan).not.toHaveBeenCalled();
  });
  it('rejects aliased principals, cross-environment receipts, host substitution and value-bearing fields', async () => {
    const f = fixture(); const ready = await f.apply(await f.plan());
    const original = receipt(ready);
    for (const changed of [
      { ...original, principals: { provision: original.principals.provision, release: original.principals.provision } },
      { ...original, environment: 'staging' },
      { ...original, hostIdentity: { ...original.hostIdentity, subject: '999999999999999999999' } },
      { ...original, accessToken: 'must-not-persist' },
      { ...original, runtimeIdentities: [] },
      { ...original, runtimeIdentities: [{ ...original.runtimeIdentities[0], principal: original.principals.provision }] },
      { ...original, principals: { ...original.principals, release: { ...original.principals.release, serviceAccountUniqueId: original.principals.provision.serviceAccountUniqueId } } },
    ]) {
      vi.mocked(f.driver.deployment!.connection).mockReturnValue(changed);
      expect(() => lifecycle.cloudInstallationDeploymentConnectionV1(ready, f.driver)).toThrow();
    }
  });
  it('does not allow deployment installation to create or return collection secret targets', async () => {
    const f = fixture(); const proposal = await f.driver.plan({} as any);
    proposal.actions[0].metadata.category = 'secret-container';
    vi.mocked(f.driver.plan).mockResolvedValue(proposal);
    await expect(f.plan()).rejects.toThrow();
  });
});

// User requirement: an app without delegated secrets can still prepare its scope
// and then review deployment access. Synthetic shared lifecycle, not native proof.
describe('deployment scope preparation lineage', () => {
  const nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  function preparation() {
    const f = fixture();
    Object.assign(f.driver, { scopePreparation: { resolvedScope: (record: CloudInstallationRecord) => record.intent.nativeScope, reviewResources: () => [] } });
    f.driver.deployment!.prepareIntent = vi.fn(() => intent.deployment!);
    const { deployment: _topology, ...base } = intent;
    return { ...f, prep: { ...base, stage: 'scope-preparation' as const } };
  }
  it('prepares a keyless app and separately derives final deployment topology from its source', async () => {
    const f = preparation();
    const plan = await lifecycle.planCloudInstallationV1({ ...f.context, intent: f.prep });
    const ready = await f.apply(plan);
    expect(ready.status).toBe('scope-ready');
    expect(lifecycle.cloudInstallationNextStageV1(ready, f.driver)).toBe('deployment');
    expect(() => lifecycle.cloudInstallationDeploymentConnectionV1(ready, f.driver)).toThrow();
    const spec = { project: { name: 'app-a' } } as unknown as ProjectSpec;
    const final = await lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: ready.installationId,
      scopePreparationDigest: ready.plan.digest, installationId: nextId, spec });
    expect(final.intent).toMatchObject({ purpose: 'deployment', stage: 'deployment', keys: [], deployment: intent.deployment,
      scopePreparation: { installationId: ready.installationId, planDigest: ready.plan.digest } });
    expect(f.driver.deployment!.prepareIntent).toHaveBeenCalledWith(spec, expect.objectContaining({ stage: 'deployment' }));
    expect(final.status).toBe('review-required');
  });
  it('requires source for the final stage and rejects changing purpose across a prepared scope', async () => {
    const f = preparation(); const ready = await f.apply(await lifecycle.planCloudInstallationV1({ ...f.context, intent: f.prep }));
    await expect(lifecycle.planCloudInstallationContinuationV1({ ...f.context, scopePreparationId: ready.installationId,
      scopePreparationDigest: ready.plan.digest, installationId: nextId })).rejects.toThrow();
    const before = vi.mocked(f.driver.plan).mock.calls.length;
    await expect(lifecycle.planCloudInstallationV1({ ...f.context, intent: { ...intent, installationId: nextId,
      purpose: 'collection', stage: 'collection', deployment: undefined, keys: ['API_KEY'],
      scopePreparation: { installationId: ready.installationId, planDigest: ready.plan.digest } } })).rejects.toThrow();
    expect(f.driver.plan).toHaveBeenCalledTimes(before);
  });
});
