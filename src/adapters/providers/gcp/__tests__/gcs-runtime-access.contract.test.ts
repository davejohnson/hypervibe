import { describe, expect, it, vi } from 'vitest';
import type { StorageRuntimeAccessTarget } from '../../../../domain/ports/storage-runtime-access.port.js';
import { GcsStorageAdapter } from '../gcs.adapter.js';
import { gcpRuntimeOwner } from '../cloudrun-runtime-identities.js';

// Reconstructed native GCS policy version 3/etag and IAM account responses.
// https://cloud.google.com/storage/docs/json_api/v1/buckets/getIamPolicy
// https://cloud.google.com/storage/docs/json_api/v1/buckets/setIamPolicy
// https://cloud.google.com/storage/docs/access-control/iam#conditions
const projectId = 'cloud-project'; const principal = `runtime@${projectId}.iam.gserviceaccount.com`;
const now = new Date();
const target: StorageRuntimeAccessTarget = { environment: { id: 'env-1', projectId: 'local-project', name: 'production',
  platformBindings: { projectId, services: { web: { serviceId: 'web' } } }, createdAt: now, updatedAt: now },
  serviceName: 'web', storageName: 'documents', externalId: 'documents-bucket', context: { projectId },
  identity: { provider: 'gcp', principal, source: 'observed', scope: { projectId, environmentId: 'env-1', serviceName: 'web',
    serviceAccountUniqueId: '123456789012345678901', workloadUid: 'workload-uid', workloadResource: `projects/${projectId}/locations/us-central1/services/web` } } };
async function fixture(options: { broad?: boolean; lost?: boolean; wrongBucket?: boolean; legacy?: boolean } = {}) {
  const unrelated = { role: 'roles/storage.objectViewer', members: ['user:someone@example.com'], condition: { title: 'expiry', expression: "request.time < timestamp('2030-01-01T00:00:00Z')" } };
  let policy: any = { resourceId: 'projects/_/buckets/documents-bucket', etag: 'initial-etag', version: 3, bindings: [unrelated] };
  const writes: any[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('run.googleapis.com')) return Response.json({ name: target.identity.scope.workloadResource, uid: 'workload-uid', etag: 'workload-etag',
      template: { serviceAccount: options.legacy ? `legacy@${projectId}.iam.gserviceaccount.com` : principal } });
    if (url.includes('iam.googleapis.com')) return Response.json({ name: `projects/${projectId}/serviceAccounts/${principal}`, projectId,
      uniqueId: target.identity.scope.serviceAccountUniqueId, email: principal, description: gcpRuntimeOwner(projectId, target.environment, 'web') + 'create-1' });
    if (url.includes('cloudresourcemanager')) return Response.json({ etag: 'project-etag', bindings: options.broad ? [{ role: 'roles/storage.objectUser', members: [`serviceAccount:${principal}`] }] : [] });
    if (url.includes('/iam')) {
      if (init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); policy = { ...writes.at(-1), etag: 'next-etag' }; if (options.lost) throw new Error('echo synthetic-management-key'); }
      return Response.json(policy);
    }
    return Response.json({ name: options.wrongBucket ? 'other-bucket' : target.externalId, iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      labels: { hypervibe_environment_id: target.environment.id, hypervibe_storage_name: 'documents' } });
  });
  const adapter = new GcsStorageAdapter({ fetch: fetcher, tokenProvider: async () => ({ token: 'synthetic-token', email: 'deploy' }) });
  await adapter.connect({ credentials: JSON.stringify({ type: 'service_account', project_id: projectId, client_email: `deploy@${projectId}.iam.gserviceaccount.com`, private_key: 'synthetic-management-key' }) });
  return { driver: adapter.runtimeAccess!, writes, fetcher, unrelated, policy: () => policy, setPolicy(value: any) { policy = value; } };
}
describe('GCS exact bucket workload grant', () => {
  it('adds an owned bucket+object condition with the observed etag and preserves unrelated conditional grants', async () => {
    const f = await fixture(); expect(f.driver).toBeDefined();
    expect(await f.driver.observe(target)).toEqual({ state: 'absent' }); expect(f.writes).toHaveLength(0);
    const created = await f.driver.grant(target, 'attempt-1'); expect(created.receipt.success).toBe(true);
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ version: 3, etag: 'initial-etag', bindings: [f.unrelated, {
      role: 'roles/storage.objectUser', members: [`serviceAccount:${principal}`], condition: {
        expression: "resource.name == 'projects/_/buckets/documents-bucket' || resource.name.startsWith('projects/_/buckets/documents-bucket/objects/')",
      },
    }] });
    expect(await f.driver.observe(target, created.binding)).toMatchObject({ state: 'present' });
    expect((await f.driver.grant(target, 'attempt-1', created.binding)).receipt.success).toBe(true); expect(f.writes).toHaveLength(1);
    expect((await f.driver.revoke(target, created.binding!)).success).toBe(true);
    expect(f.policy().bindings).toEqual([f.unrelated]);
  });
  it.each([{ broad: true }, { wrongBucket: true }])('blocks uncertain scope and existing broad project access: %j', async options => {
    const f = await fixture(options); expect(f.driver).toBeDefined();
    expect(await f.driver.observe(target)).toMatchObject({ state: 'unknown' });
    expect((await f.driver.grant(target, 'attempt-1')).receipt.success).toBe(false); expect(f.writes).toHaveLength(0);
  });
  it('recovers a lost acknowledgement only for the exact retained attempt without rewriting IAM', async () => {
    const f = await fixture({ lost: true }); expect(f.driver).toBeDefined();
    expect((await f.driver.grant(target, 'attempt-1')).receipt.success).toBe(false);
    const recovered = await f.driver.grant(target, 'attempt-1'); expect(recovered.receipt.success).toBe(true); expect(f.writes).toHaveLength(1);
    expect((await f.driver.grant(target, 'attempt-2')).receipt.success).toBe(false);
    expect(JSON.stringify(recovered)).not.toContain('synthetic-management-key');
  });

  it('grants the prepared new identity before activation only with exact live legacy principal, UID and etag evidence', async () => {
    const f = await fixture({ legacy: true });
    const prepared = { ...target, identity: { ...target.identity, source: 'configured' as const,
      activation: { previousPrincipal: `legacy@${projectId}.iam.gserviceaccount.com`, workloadEtag: 'workload-etag' } } };
    const granted = await f.driver.grant(prepared, 'transition-1'); expect(granted.receipt.success).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect((await f.driver.grant({ ...prepared, identity: { ...prepared.identity, activation: { ...prepared.identity.activation, workloadEtag: 'stale-etag' } } }, 'other-attempt')).receipt.success).toBe(false);
    expect(f.writes).toHaveLength(1);
  });
});
