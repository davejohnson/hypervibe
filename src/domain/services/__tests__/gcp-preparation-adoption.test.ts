import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import type { Project } from '../../entities/project.entity.js';
import { reviewGcpPreparationAdoption } from '../gcp-preparation-adoption.js';

const deploy = 'hypervibe-deploy@demo-project.iam.gserviceaccount.com';
const runtime = 'hypervibe-runtime@demo-project.iam.gserviceaccount.com';
const target = { gcpProjectId: 'demo-project', deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime, buildSourceBucket: { name: 'demo-project-hv-build-source' } };
const project = { id: 'project-1', name: 'demo', policies: { cloudPreparation: { cloudrun: {
  provider: 'cloudrun', version: 'gcp-cloudrun-v2', preparedAt: '2026-10-01T00:00:00.000Z', gcpProjectId: 'demo-project',
  deployServiceAccountEmail: deploy, runtimeServiceAccountEmail: runtime, runtimeServiceAccountUniqueId: '222', requiredApis: [], requiredRoles: [],
} } } } as unknown as Project;

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-adoption-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
afterEach(() => { vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

const bucket = { name: 'demo-project-hv-build-source', projectNumber: '123', location: 'US', labels: { 'managed-by': 'hypervibe' },
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } };
const repositoryName = 'projects/demo-project/locations/us-central1/repositories/hypervibe';
const repository = { name: repositoryName, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', description: 'Container images built by Hypervibe' };

function google(found: { bucket?: unknown; objects?: unknown[]; repository?: unknown; packages?: unknown[] }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('cloudresourcemanager.googleapis.com/v3/projects/')) return Response.json({ name: 'projects/123', projectId: 'demo-project', state: 'ACTIVE' });
    if (url.includes(':getIamPolicy')) return Response.json({ bindings: [] });
    if (url.includes('/serviceAccounts/')) return Response.json(url.includes('hypervibe-deploy')
      ? { email: deploy, uniqueId: '111', name: `projects/demo-project/serviceAccounts/${deploy}`, projectId: 'demo-project' }
      : { email: runtime, uniqueId: '222', name: `projects/demo-project/serviceAccounts/${runtime}`, projectId: 'demo-project' });
    if (url.includes('storage.googleapis.com') && url.includes('/o?') && found.bucket) return Response.json({ items: found.objects });
    if (url.includes('storage.googleapis.com') && found.bucket) return Response.json(found.bucket);
    if (url.includes('artifactregistry.googleapis.com') && url.includes('/packages') && found.repository) return Response.json({ packages: found.packages });
    if (url.includes('artifactregistry.googleapis.com') && found.repository) return Response.json(found.repository);
    return new Response('', { status: 404 });
  }));
}
const review = () => reviewGcpPreparationAdoption({ project, target, token: 'admin-token', contributionId: 'preparation', configuration: { files: {}, resources: {} } });

describe('repairing an earlier Google preparation', () => {
  it('lets setup create build resources an earlier preparation never made, when nothing was released', async () => {
    google({});
    await expect(review()).resolves.toMatchObject({ allowImportAddresses: [], existingResourceAddresses: [] });
  });

  it('refuses to adopt build resources that hold content without release evidence', async () => {
    google({ bucket, objects: [{ name: 'source.tgz' }] });
    await expect(review()).rejects.toThrow('holds content but has no exact prior Hypervibe release evidence');
    google({ repository, packages: [{ name: `${repositoryName}/packages/web` }] });
    await expect(review()).rejects.toThrow('holds content but has no exact prior Hypervibe release evidence');
  });

  it('adopts empty build resources an earlier preparation made before any release', async () => {
    google({ bucket, repository });
    await expect(review()).resolves.toMatchObject({
      allowImportAddresses: ['google_storage_bucket.build_source', expect.stringContaining('google_artifact_registry_repository')],
    });
  });
});
