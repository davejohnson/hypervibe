import { describe, expect, it } from 'vitest';
import { CLOUD_INSTALLATION_PROVIDERS } from '../../../domain/ports/cloud-installation.port.js';
import { cloudInstallationDriverFactories } from '../cloud-installation-providers.js';
import { parseCloudInstallationIntentV1 } from '../cloud-installation.js';

describe('hosted installation provider roster', () => {
  it('keeps every reviewed native provider in the normal packaged factory registry', () => {
    expect([...CLOUD_INSTALLATION_PROVIDERS].sort()).toEqual(['aws', 'azure', 'gcp']);
    expect(Object.keys(cloudInstallationDriverFactories).sort()).toEqual([...CLOUD_INSTALLATION_PROVIDERS].sort());
    for (const provider of CLOUD_INSTALLATION_PROVIDERS) {
      const driver = cloudInstallationDriverFactories[provider]();
      expect(driver.provider).toBe(provider);
      for (const operation of ['parseScope', 'parseAction', 'parseEvidence', 'plan', 'inspect', 'mutate', 'recover', 'connections'] as const)
        expect(typeof driver[operation]).toBe('function');
    }
  });
  it('declares project scope preparation only for GCP and rejects AWS/Azure stage requests before provider access', () => {
    const matrix = { aws: false, azure: false, gcp: true };
    expect(Object.keys(matrix).sort()).toEqual([...CLOUD_INSTALLATION_PROVIDERS].sort());
    for (const provider of CLOUD_INSTALLATION_PROVIDERS) {
      const driver = cloudInstallationDriverFactories[provider]();
      expect(!!driver.scopePreparation).toBe(matrix[provider]);
      if (matrix[provider]) continue;
      expect(() => parseCloudInstallationIntentV1({ schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        customerId: 'customer-a', appId: 'sequence', environment: 'production', provider, mode: 'connect', stage: 'scope-preparation', keys: ['API_KEY'],
        source: { repository: 'github.com/example/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) }, nativeScope: {},
        hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
          serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
      }, driver)).toThrow('invalid_contract');
    }
  });
});
