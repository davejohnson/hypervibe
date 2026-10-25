import { describe, expect, it } from 'vitest';
import '../../src/application/providers.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { cloudInstallationDriverFactories } from '../../src/application/hosted/cloud-installation-providers.js';
import { parseCloudInstallationIntentV1 } from '../../src/domain/services/cloud-installation-runtime.js';

// Explicit capability review; schema/registry presence is not live certification.
// See docs/local-cloud-scope-preparation.md and connect-cloud-scope-preparation.md.
const reviewed = { railway: false, cloudrun: true, ecs: false, 'azure-container-apps': false,
  fly: false, digitalocean: false, vercel: false };
const nativeScope = { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: 'new-project', displayName: 'New Project' };
describe('local empty-project capability provider roster', () => {
  it('requires all registered hosting providers to have an explicit local allocation review', () => {
    expect(providerRegistry.namesFor('hosting').sort()).toEqual(Object.keys(reviewed).sort());
    for (const [provider, supported] of Object.entries(reviewed)) {
      const capability = providerRegistry.getLocalScopePreparation(provider);
      expect(Boolean(capability), provider).toBe(supported);
      if (capability) {
        expect(capability.schemaVersion).toBe(1);
        expect(capability.parseScope(nativeScope)).toEqual(nativeScope);
        expect(capability.parseRecord).toBeTypeOf('function');
        expect(capability.create).toBeTypeOf('function');
        expect(capability.continuation?.parseSelection({ scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' }, { region: 'us-west1' }))
          .toEqual({ scopeKind: 'operator-hosting-v1', billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC', hostingRegion: 'us-west1' });
        expect(() => capability.continuation?.parseSelection({ scopeKind: 'operator-hosting-v1', projectId: 'other-project' })).toThrow();
        expect(() => capability.parseScope({ ...nativeScope, billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' })).toThrow();
      }
    }
  });
  it('never enables local ADC through the existing hosted AWS, Azure or GCP installation registry', () => {
    for (const [provider, factory] of Object.entries(cloudInstallationDriverFactories)) {
      const driver = factory(); expect(driver.localScopePreparation).toBeUndefined();
      expect(() => parseCloudInstallationIntentV1({ schemaVersion: 1,
        installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'local-project', appId: 'local-project',
        environment: 'test', provider, hostingProvider: 'cloudrun', mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope,
        execution: { kind: 'local-administrator', authentication: 'google-user-adc' },
        source: { kind: 'local-spec', repository: 'github.com/example/app', specRevision: 1, specDigest: 'a'.repeat(64) } }, driver)).toThrow('invalid_contract');
    }
  });
});
