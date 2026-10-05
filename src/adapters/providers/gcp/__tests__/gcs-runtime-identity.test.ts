import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { GcsStorageAdapter, GcsStorageCredentialsSchema } from '../gcs.adapter.js';

// Synthetic credentials and provider-owned identity evidence. Google documents
// Cloud Run ADC as the assigned workload identity, separate from the deployer:
// https://cloud.google.com/run/docs/securing/service-identity
const projectId = 'cloud-project';
const runtimePrincipal = `runtime@${projectId}.iam.gserviceaccount.com`;
const credentials = JSON.stringify({ type: 'service_account', project_id: projectId,
  client_email: `deploy@${projectId}.iam.gserviceaccount.com`, private_key: 'synthetic-management-key' });
const environment: Environment = { id: 'env-1', projectId: 'local-project', name: 'test',
  platformBindings: { projectId }, createdAt: new Date(), updatedAt: new Date() };
const target = { hostingProvider: 'cloudrun', connectionProvider: 'cloudrun', identity: {
  provider: 'gcp', principal: runtimePrincipal, scope: { projectId }, source: 'observed' as const,
} };

async function adapter() {
  const result = new GcsStorageAdapter({ fetch: vi.fn() as typeof fetch });
  await result.connect({ projectId, credentials, runtimeServiceAccountEmail: runtimePrincipal });
  return result;
}

describe('GCS runtime identity boundary', () => {
  it('preserves the distinct runtime principal when reusing Cloud Run authentication', () => {
    expect(GcsStorageCredentialsSchema.parse({ projectId, credentials,
      runtimeServiceAccountEmail: runtimePrincipal })).toMatchObject({ runtimeServiceAccountEmail: runtimePrincipal });
  });

  it('uses workload ADC and clears the legacy management-key slot', async () => {
    const result = await (await adapter()).getRuntimeEnv(environment, { projectId }, 'documents', 'documents', target);
    expect(result).toEqual({ OBJECT_STORAGE_PROVIDER: 'gcs', OBJECT_STORAGE_BUCKET: 'documents',
      GOOGLE_CLOUD_PROJECT: projectId, GOOGLE_CLOUD_STORAGE_BUCKET: 'documents', GOOGLE_CLOUD_CREDENTIALS_JSON: '' });
    expect(JSON.stringify(result)).not.toContain('synthetic-management-key');
  });

  it.each([
    { ...target, hostingProvider: 'railway', identity: undefined },
    { ...target, identity: undefined },
    { ...target, identity: { ...target.identity, principal: `other@${projectId}.iam.gserviceaccount.com` } },
    { ...target, identity: { ...target.identity, scope: { projectId: 'other-project' } } },
  ])('rejects an alias without matching workload identity: %j', async (runtimeTarget) => {
    await expect((await adapter()).getRuntimeEnv(environment, { projectId }, 'documents', 'documents', runtimeTarget))
      .rejects.toThrow(/runtime|identity|scope/i);
  });

  it('preserves explicitly selected standalone GCS runtime credentials for remote hosting', async () => {
    const result = await (await adapter()).getRuntimeEnv(environment, { projectId }, 'documents', 'documents', {
      hostingProvider: 'railway', connectionProvider: 'gcs',
    });
    expect(result.GOOGLE_CLOUD_CREDENTIALS_JSON).toBe(credentials);
  });
});
