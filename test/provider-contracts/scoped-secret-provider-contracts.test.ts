import { reviewedOperationProviders } from './operations-scope.js';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { AwsEngineAdapter } from '../../src/adapters/providers/aws/aws-engine.adapter.js';
import { AzureEngineAdapter } from '../../src/adapters/providers/azure/azure-engine.adapter.js';
import type { IHostingAdapter } from '../../src/domain/ports/hosting.port.js';
import { registryCredentialLifecycle } from '../../src/domain/ports/registry-credential.port.js';

const legacyReviewed: Array<[string, Pick<IHostingAdapter, 'capabilities'> & Partial<Pick<IHostingAdapter, 'observe' | 'setEnvVars'>>, boolean]> = [
  ['railway', new RailwayAdapter(), true],
  ['cloudrun', new CloudRunAdapter(), false],
];
// Engine access is reviewed separately: these are not legacy IHostingAdapters.
const engineReviewed = [
  ['aws', new AwsEngineAdapter()],
  ['azure', new AzureEngineAdapter()],
] as const;
const registryPasswordCopies = new Set(['railway', 'cloudrun']);

describe('named-provider secret-only contract coverage', () => {
  it('covers every hosting provider', () => {
    expect([...legacyReviewed.map(([name]) => name), ...engineReviewed.map(([name]) => name)].sort()).toEqual(reviewedOperationProviders('hosting'));
  });
  it.each(legacyReviewed)('%s explicitly admits a deferred secret writer', (_name, adapter, implemented) => {
    expect(adapter.capabilities.supportsDeferredSecretUpdates === true).toBe(implemented);
  });
  it.each(legacyReviewed)('%s declares native credential activation and value evidence separately', (_name, adapter) => {
    expect(['deferred', 'provider-rollout']).toContain(adapter.capabilities.credentialUpdateActivation);
    expect(['readback', 'acknowledgement']).toContain(adapter.capabilities.credentialValueEvidence);
  });
  it.each(legacyReviewed)('%s exposes credential observation and configuration updates', (_name, adapter) => {
    expect(typeof adapter.observe).toBe('function');
    expect(typeof adapter.setEnvVars).toBe('function');
  });
  it.each(legacyReviewed)('%s has an explicit separate container-pull credential boundary', (_name, adapter) => {
    const implemented = registryPasswordCopies.has(_name);
    expect(Boolean(registryCredentialLifecycle(adapter))).toBe(implemented);
    if (!implemented) {
      expect(['native-workload-identity', 'build-input']).toContain(adapter.capabilities.registryCredentialModel);
      expect(adapter.capabilities.registryCredentialGuidance).toBeTruthy();
    }
  });
  it.each(engineReviewed)('%s engine access does not implement legacy secret writers or registry-password copying', (_name, adapter) => {
    expect(adapter).not.toHaveProperty('observe');
    expect(adapter).not.toHaveProperty('setEnvVars');
    expect(adapter.capabilities).not.toHaveProperty('supportsDeferredSecretUpdates');
    expect(adapter.capabilities).not.toHaveProperty('credentialUpdateActivation');
    expect(adapter.capabilities).not.toHaveProperty('credentialValueEvidence');
    expect(registryCredentialLifecycle(adapter)).toBeUndefined();
  });
});
