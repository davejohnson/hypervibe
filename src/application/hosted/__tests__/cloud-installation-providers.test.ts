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
  it('requires exact existing native targets for first-writer authorization across the complete provider roster', () => {
    const matrix = {
      aws: { scope: { accountId: '123456789012', region: 'us-west-2' }, destination: { provider: 'aws-secrets', accountId: '123456789012', region: 'us-west-2', secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:retained-AbCdEf' } },
      azure: { scope: { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'app-production', location: 'westus2' },
        destination: { provider: 'azure-key-vault', tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'app-production', vaultName: 'app-production', secretName: 'retained' } },
      gcp: { scope: { projectId: 'customer-project', projectNumber: '123456789' }, destination: { provider: 'gcp-secret-manager', projectId: 'customer-project', projectNumber: '123456789', secretId: 'retained' } },
    };
    expect(Object.keys(matrix).sort()).toEqual([...CLOUD_INSTALLATION_PROVIDERS].sort());
    for (const provider of CLOUD_INSTALLATION_PROVIDERS) {
      const driver = cloudInstallationDriverFactories[provider]();
      const intent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'sequence',
        environment: 'production', provider, mode: 'connect-existing', keys: ['API_KEY'], nativeScope: matrix[provider].scope,
        source: { repository: 'github.com/example/sequence', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
        hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
          serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
        migrationTargets: [{ key: 'API_KEY', destination: matrix[provider].destination }] };
      expect(parseCloudInstallationIntentV1(intent, driver).mode).toBe('connect-existing');
      expect(() => parseCloudInstallationIntentV1({ ...intent, migrationTargets: undefined }, driver)).toThrow('invalid_contract');
      expect(() => parseCloudInstallationIntentV1({ ...intent, stage: 'scope-preparation' }, driver)).toThrow('invalid_contract');
      expect(() => parseCloudInstallationIntentV1({ ...intent, purpose: 'deployment', stage: 'deployment', keys: [] }, driver)).toThrow('invalid_contract');
    }
  });
  it('restricts exclusive scope allocation to the named GCP new-project capability', () => {
    const scopes = {
      aws: { accountId: '123456789012', region: 'us-west-2' },
      azure: { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resourceGroup: 'app-production', location: 'westus2' },
      gcp: { projectId: 'customer-project', projectNumber: '123456789' },
    };
    expect(Object.keys(scopes).sort()).toEqual([...CLOUD_INSTALLATION_PROVIDERS].sort());
    for (const provider of CLOUD_INSTALLATION_PROVIDERS) {
      const driver = cloudInstallationDriverFactories[provider]();
      expect(driver.parseScope(scopes[provider])).toEqual(scopes[provider]);
      expect(() => driver.parseScope({ ...scopes[provider], allocationMode: 'create-exclusive-v1' })).toThrow();
      const projectScope = { scopeKind: 'new-project', projectId: 'customer-project', displayName: 'Customer application',
        billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC', allocationMode: 'create-exclusive-v1' };
      if (provider === 'gcp') expect(driver.parseScope(projectScope)).toEqual(projectScope);
      else expect(() => driver.parseScope(projectScope)).toThrow();
    }
  });
});
