import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore, SecretStore } from '../../../adapters/secrets/secret-store.js';
import '../../../adapters/providers/aws/ecs-express.adapter.js';
import '../../../adapters/providers/azure/azure-container-apps.adapter.js';
import '../../../adapters/providers/azure/azure-postgres.adapter.js';
import '../../../adapters/providers/azure/azure-managed-redis.adapter.js';
import '../../../adapters/providers/azure/azure-blob.adapter.js';
import '../../../adapters/providers/gcp/gcs.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/gcp/cloudsql.adapter.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { providerSecretsForGitHubActions } from '../ci-deploy.service.js';

// Reconstructed credential descriptors, not live authentication. AWS STS documents
// AKIA as long-term and ASIA as temporary; Azure's SDK distinguishes a local
// DefaultAzureCredential chain from an explicitly supplied ClientSecretCredential.
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetAccessKeyInfo.html
// https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains
const azure = { tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'explicit-automation-secret' };
const aws = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'explicit-automation-secret', region: 'us-east-1' };
let directory: string;
let previousDirectory: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-automation-credentials-'));
  previousDirectory = process.env.HYPERVIBE_DATA_DIR;
  process.env.HYPERVIBE_DATA_DIR = directory;
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  if (previousDirectory === undefined) delete process.env.HYPERVIBE_DATA_DIR;
  else process.env.HYPERVIBE_DATA_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

describe('unattended credential export admission', () => {
  const save = (provider: string, credentials: Record<string, unknown>, scope = 'owner/app') => {
    const repository = new ConnectionRepository();
    const connection = repository.create({ provider, scope, credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    repository.updateStatus(connection.id, 'verified');
  };

  it('exports only selected recovery providers from the exact repository scope', () => {
    save('ecs', aws);
    save('gcs', { projectId: 'storage-project', credentials: 'synthetic-gcs-runtime-json' });
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app' }).map(item => item.name))
      .not.toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app', backupProviders: ['gcs'] }))
      .toContainEqual({ name: 'GCP_SERVICE_ACCOUNT_JSON', value: 'synthetic-gcs-runtime-json' });
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/other', backupProviders: ['gcs'] })).toEqual([]);
  });

  it('reuses the exact verified hosting alias for the selected GCS archive', () => {
    save('ecs', aws);
    save('cloudrun', { projectId: 'storage-project', credentials: 'synthetic-gcs-runtime-json' });
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app', backupProviders: ['gcs'] }))
      .toContainEqual({ name: 'GCP_SERVICE_ACCOUNT_JSON', value: 'synthetic-gcs-runtime-json' });
  });

  it('does not export retained legacy key material from a selected native GCS connection', () => {
    save('gcs', { authMode: 'default', credentials: 'retained-legacy-private-key-json' });
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app', backupProviders: ['gcs'] })).toEqual([]);
  });

  it('does not export retained legacy key material from native Cloud Run hosting', () => {
    save('cloudrun', { authMode: 'default', projectId: 'hosting-project', credentials: 'retained-legacy-private-key-json' });
    expect(providerSecretsForGitHubActions('cloudrun', { githubRepo: 'owner/app' })).toEqual([]);
  });

  it.each(['gcs', 'cloudrun'])('preserves exact GitHub federation admission for %s without accepting a mixed private key', provider => {
    const workloadIdentity = {
      schemaVersion: 1, projectId: 'synthetic-project', projectNumber: '123456789012',
      workloadIdentityProvider: 'projects/123456789012/locations/global/workloadIdentityPools/hypervibe/providers/github',
      serviceAccountEmail: 'ci-synthetic@synthetic-project.iam.gserviceaccount.com', serviceAccountUniqueId: '123456789012345678901',
      repository: 'synthetic-owner/synthetic-app', repositoryId: '123456789', repositoryOwnerId: '987654321',
      branch: 'main', environment: 'production', workflow: '.github/workflows/deploy-cloudrun-production.yml',
    };
    const credentials = { authMode: 'github-workload-identity', projectId: 'synthetic-project', workloadIdentity };
    const admission = providerRegistry.getMetadata(provider)?.credentials?.canUseForAutomation;
    expect(admission).toBeTypeOf('function');
    expect(admission!(credentials)).toBe(true);
    expect(admission!({ ...credentials, credentials: 'retained-legacy-private-key-json' })).toBe(false);
    expect(admission!({ ...credentials, projectId: 'wrong-project' })).toBe(false);
  });

  it('rejects conflicting same-named deployment and recovery secrets without exposing either value', () => {
    save('cloudrun', { projectId: 'hosting-project', credentials: 'synthetic-hosting-private-json' });
    save('gcs', { projectId: 'storage-project', credentials: 'synthetic-storage-private-json' });
    const resolve = () => providerSecretsForGitHubActions('cloudrun', { githubRepo: 'owner/app', backupProviders: ['gcs'] });
    expect(resolve).toThrow(/conflicting provider connections/);
    expect(resolve).not.toThrow(/synthetic-hosting|synthetic-storage/);
  });

  it('deduplicates an identical credential selected for hosting and recovery', () => {
    const credentials = { projectId: 'shared-project', credentials: 'synthetic-shared-private-json' };
    save('cloudrun', credentials); save('gcs', credentials);
    const secrets = providerSecretsForGitHubActions('cloudrun', { githubRepo: 'owner/app', backupProviders: ['gcs'] });
    expect(secrets.filter(item => item.name === 'GCP_SERVICE_ACCOUNT_JSON')).toHaveLength(1);
  });

  it('exports the independently selected Cloud SQL recovery connection and exact project scope', () => {
    const credentials = JSON.stringify({ type: 'service_account', project_id: 'database-project',
      client_email: 'recovery@database-project.iam.gserviceaccount.com', private_key: 'synthetic-private-key' });
    save('cloudsql', { projectId: 'database-project', credentials });
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app', backupProviders: ['cloudsql'] })).toEqual([
      { name: 'GCP_SERVICE_ACCOUNT_JSON', value: credentials }, { name: 'GCP_PROJECT_ID', value: 'database-project' },
    ]);
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/other', backupProviders: ['cloudsql'] })).toEqual([]);
  });

  it.each([
    { authMode: 'default', projectId: 'database-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'database-project', client_email: 'recovery@database-project.iam.gserviceaccount.com', private_key: 'synthetic-private-key' }) },
    { projectId: 'database-project', credentials: JSON.stringify({ type: 'authorized_user', refresh_token: 'synthetic-user-token' }) },
    { projectId: 'wrong-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'database-project', client_email: 'recovery@database-project.iam.gserviceaccount.com', private_key: 'synthetic-private-key' }) },
  ])('does not export native, user-session or mismatched Cloud SQL recovery credentials', credentials => {
    save('cloudsql', credentials);
    expect(providerSecretsForGitHubActions('ecs', { githubRepo: 'owner/app', backupProviders: ['cloudsql'] })).toEqual([]);
  });

  it.each([
    { label: 'native Azure with legacy fields', provider: 'azure-container-apps', credentials: { ...azure, authMode: 'default' } },
    { label: 'native Azure scope', provider: 'azure-container-apps', credentials: { authMode: 'default', tenantId: azure.tenantId, subscriptionId: azure.subscriptionId } },
    { label: 'native AWS with legacy fields', provider: 'ecs', credentials: { ...aws, authMode: 'default' } },
    { label: 'temporary AWS token', provider: 'ecs', credentials: { ...aws, sessionToken: 'temporary-session-token' } },
    { label: 'temporary AWS key without token', provider: 'ecs', credentials: { ...aws, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' } },
  ])('does not export $label to GitHub', ({ provider, credentials }) => {
    const repository = new ConnectionRepository();
    const connection = repository.create({ provider, scope: 'owner/app', credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    repository.updateStatus(connection.id, 'verified');
    expect(providerSecretsForGitHubActions(provider, { githubRepo: 'owner/app' })).toEqual([]);
  });

  it.each([
    { provider: 'ecs', credentials: aws, names: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] },
    { provider: 'azure-container-apps', credentials: azure, names: ['AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'] },
  ])('preserves explicit durable $provider credentials in the exact repository scope', ({ provider, credentials, names }) => {
    const repository = new ConnectionRepository();
    const connection = repository.create({ provider, scope: 'owner/app', credentialsEncrypted: getSecretStore().encryptObject(credentials) });
    repository.updateStatus(connection.id, 'verified');
    expect(providerSecretsForGitHubActions(provider, { githubRepo: 'owner/other' })).toEqual([]);
    const exported = providerSecretsForGitHubActions(provider, { githubRepo: 'owner/app' });
    expect(exported.map(item => item.name).sort()).toEqual(names.sort());
    expect(exported.find(item => item.name.endsWith('SECRET'))?.value ?? exported.find(item => item.name === 'AWS_SECRET_ACCESS_KEY')?.value)
      .toBe('explicit-automation-secret');
  });

  it.each(['azure-container-apps', 'azure-postgres', 'azure-managed-redis', 'azureblob'])('%s explicitly distinguishes automation and local credentials', provider => {
    const admission = providerRegistry.getMetadata(provider)?.credentials?.canUseForAutomation;
    expect(admission).toBeTypeOf('function');
    expect(admission!(azure)).toBe(true);
    expect(admission!({ ...azure, authMode: 'servicePrincipal' })).toBe(true);
    expect(admission!({ ...azure, authMode: 'default' })).toBe(false);
    expect(admission!({ authMode: 'default', tenantId: azure.tenantId, subscriptionId: azure.subscriptionId })).toBe(false);
    expect(admission!({ ...azure, clientSecret: '' })).toBe(false);
  });
});
