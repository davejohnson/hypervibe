import { describe, expect, it, vi } from 'vitest';
import { cloudInstallationNextStageV1, parseCloudInstallationIntentV1, planCloudInstallationContinuationV1, planCloudInstallationV1 } from '../cloud-installation-runtime.js';
import { createGcpCloudInstallationDriver } from '../../../adapters/providers/gcp/gcp-cloud-installation.js';
import { createAzureCloudInstallationDriver } from '../../../adapters/providers/azure/azure-cloud-installation.js';
import { createAwsCloudInstallationDriver } from '../../../adapters/providers/aws/aws-cloud-installation.js';

// User requirement: operator app registration is a distinct local authority,
// never a hosted cloud installation or the developer's runtime identity.
const intent = { schemaVersion: 1, installationId: '11111111-1111-4111-8111-111111111111', customerId: 'app', appId: 'app', environment: 'test',
  provider: 'microsoft-entra', mode: 'connect', stage: 'scope-preparation', keys: [],
  source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 1, specDigest: 'a'.repeat(64) },
  execution: { kind: 'operator-application', authentication: 'local-operator' }, applicationProvider: 'microsoft-entra', nativeScope: { tenantId: 'tenant' },
  selection: { declarationDigest: 'b'.repeat(64), originDigest: 'c'.repeat(64) } };
const driver: any = { provider: 'microsoft-entra', operatorApplication: { providerName: 'microsoft-entra' },
  parseScope: (value: unknown) => value, parseAction: (value: unknown) => value, parseEvidence: (value: unknown) => value,
  plan: async () => ({ actions: [{ id: 'entra:application:create', type: 'create', resource: { kind: 'project', name: 'operator', provider: 'microsoft-entra' },
    verified: true, requiresConfirm: true, reason: 'Create only the reviewed browser application.', metadata: { operation: 'operator-registration', category: 'identity', execution: 'api', native: {} } }],
    review: { permissions: [], costs: [], warnings: [] } }), connections: () => [],
  scopePreparation: { resolvedScope: (record: any) => record.intent.nativeScope, reviewResources: () => [] } };

describe('operator application actor isolation', () => {
  it('admits the separately registered actor through the actual shared planning journal', async () => {
    let record: any;
    const result = await planCloudInstallationV1({ intent, driver, authentication: { kind: 'operator-application' },
      authorize: async () => true, store: { read: async () => record ?? null, compareAndSwap: async (_id: string, _revision: number | null, value: unknown) => { record = value; return true; } },
    } as any);
    expect(result.intent).toEqual(intent); expect(result.status).toBe('review-required'); expect(result.attempts).toEqual([]);
  });
  it.each([createAwsCloudInstallationDriver, createAzureCloudInstallationDriver, createGcpCloudInstallationDriver])('rejects registration through every hosted cloud factory before any authority callback', async factory => {
    const authority = vi.fn(), store = { read: vi.fn(), compareAndSwap: vi.fn() };
    await expect(planCloudInstallationV1({ intent, driver: factory(), authentication: { kind: 'operator-application' }, authorize: authority, store } as any)).rejects.toThrow();
    expect(authority).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled(); expect(store.compareAndSwap).not.toHaveBeenCalled();
  });
  it('never admits a hosted or artifact actor into the registration driver', () => {
    expect(() => parseCloudInstallationIntentV1({ ...intent, execution: { kind: 'operator-artifact-publisher', authentication: 'google-user-adc' } }, driver)).toThrow();
    expect(() => parseCloudInstallationIntentV1({ ...intent, execution: undefined }, driver)).toThrow();
  });
  it('rejects hosted next-stage and continuation entrypoints before journal access', async () => {
    expect(() => cloudInstallationNextStageV1({}, driver)).toThrow('unsupported');
    const authority = vi.fn(), store = { read: vi.fn(), compareAndSwap: vi.fn() };
    await expect(planCloudInstallationContinuationV1({ driver, authentication: { kind: 'operator-application' },
      authorize: authority, store, scopePreparationId: '11111111-1111-4111-8111-111111111111',
      scopePreparationDigest: 'd'.repeat(64), installationId: '22222222-2222-4222-8222-222222222222' } as any)).rejects.toThrow('unsupported');
    expect(authority).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled();
  });
});
