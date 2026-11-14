import { reviewedOperationProviders } from './operations-scope.js';
import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { RailwayAdapter } from '../../src/adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../src/adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../src/adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import type { IHostingAdapter } from '../../src/domain/ports/hosting.port.js';
import { registryCredentialLifecycle } from '../../src/domain/ports/registry-credential.port.js';

const reviewed: Array<[string, Pick<IHostingAdapter, 'capabilities'> & Partial<Pick<IHostingAdapter, 'observe' | 'setEnvVars'>>, boolean]> = [
  ['railway', new RailwayAdapter(), true],
  ['cloudrun', new CloudRunAdapter(), false],
  ['ecs', new EcsExpressAdapter(), false],
  ['azure-container-apps', new AzureContainerAppsAdapter(), false],
];
const registryPasswordCopies = new Set(['railway', 'cloudrun', 'ecs', 'azure-container-apps']);

describe('named-provider secret-only contract coverage', () => {
  it('covers every hosting provider', () => {
    expect(reviewed.map(([name]) => name).sort()).toEqual(reviewedOperationProviders('hosting'));
  });
  it.each(reviewed)('%s explicitly admits a deferred secret writer', (_name, adapter, implemented) => {
    expect(adapter.capabilities.supportsDeferredSecretUpdates === true).toBe(implemented);
  });
  it.each(reviewed)('%s declares native credential activation and value evidence separately', (_name, adapter) => {
    expect(['deferred', 'provider-rollout']).toContain(adapter.capabilities.credentialUpdateActivation);
    expect(['readback', 'acknowledgement']).toContain(adapter.capabilities.credentialValueEvidence);
  });
  it.each(reviewed)('%s exposes credential observation and configuration updates', (_name, adapter) => {
    expect(typeof adapter.observe).toBe('function');
    expect(typeof adapter.setEnvVars).toBe('function');
  });
  it.each(reviewed)('%s has an explicit separate container-pull credential boundary', (_name, adapter) => {
    const implemented = registryPasswordCopies.has(_name);
    expect(Boolean(registryCredentialLifecycle(adapter))).toBe(implemented);
    if (!implemented) {
      expect(['native-workload-identity', 'build-input']).toContain(adapter.capabilities.registryCredentialModel);
      expect(adapter.capabilities.registryCredentialGuidance).toBeTruthy();
    }
  });
});
