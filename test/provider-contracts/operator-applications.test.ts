import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLOUD_INSTALLATION_PROVIDERS, OPERATOR_APPLICATION_PROVIDERS } from '../../src/domain/ports/cloud-installation.port.js';
import { planCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import { createAwsCloudInstallationDriver } from '../../src/adapters/providers/aws/aws-cloud-installation.js';
import { createAzureCloudInstallationDriver } from '../../src/adapters/providers/azure/azure-cloud-installation.js';
import { createGcpCloudInstallationDriver } from '../../src/adapters/providers/gcp/gcp-cloud-installation.js';

describe('operator registration provider review boundary', () => {
  it('requires official-source review for every executable registration provider without expanding hosted clouds', () => {
    const sources = JSON.parse(readFileSync(new URL('./operator-applications/source.json', import.meta.url), 'utf8')).sources;
    expect([...new Set(sources.map((row: { provider: string }) => row.provider))].sort()).toEqual([...OPERATOR_APPLICATION_PROVIDERS].sort());
    expect(CLOUD_INSTALLATION_PROVIDERS).toEqual(['aws', 'azure', 'gcp']);
  });
  for (const provider of OPERATOR_APPLICATION_PROVIDERS) it.each([createAwsCloudInstallationDriver, createAzureCloudInstallationDriver, createGcpCloudInstallationDriver])(
    `rejects ${provider} through every real hosted cloud factory before any authority or journal access`, async factory => {
      const authorize = vi.fn(), store = { read: vi.fn(), compareAndSwap: vi.fn() };
      await expect(planCloudInstallationV1({ driver: factory(), intent: { schemaVersion: 1, installationId: '11111111-1111-4111-8111-111111111111',
        customerId: 'operator', appId: 'operator', environment: 'test', provider, applicationProvider: provider, mode: 'connect', stage: 'scope-preparation', keys: [],
        source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
        execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope: {} },
        authentication: { kind: 'operator-application' }, authorize, store } as any)).rejects.toThrow();
      expect(authorize).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled(); expect(store.compareAndSwap).not.toHaveBeenCalled();
    });
});
