import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

// Reconstructed transport responses from the pinned official Repository proto in
// test/provider-contracts/gcp/artifact-registry. No live permissions/build claim.
const repositoryName = 'projects/gcp-project/locations/us-central1/repositories/hypervibe';
const commitSha = 'a'.repeat(40);
const createdAt = new Date('2026-11-11T00:00:00Z');
const service: Service = { id: 'web', projectId: 'project-1', name: 'web', buildConfig: {}, envVarSpec: {}, createdAt, updatedAt: createdAt };
const environment: Environment = { id: 'env-1', projectId: 'project-1', name: 'staging', platformBindings: { projectId: 'gcp-project', environmentId: 'us-central1' }, createdAt, updatedAt: createdAt };

async function adapter(): Promise<CloudRunAdapter> {
  const subject = new CloudRunAdapter();
  await subject.connect({ projectId: 'gcp-project', region: 'us-central1', credentials: JSON.stringify({
    type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
  }) });
  Object.assign(subject, { accessToken: 'token', tokenExpiry: new Date(Date.now() + 60_000) });
  return subject;
}

describe('Artifact Registry release prerequisite', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['git', 'archive'] as const)('does not create infrastructure or start a %s release when the repository is absent', async (source) => {
    const subject = await adapter();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url)}`);
      if (String(url) === `https://artifactregistry.googleapis.com/v1/${repositoryName}` && method === 'GET') {
        return Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 });
      }
      // Expose a mutation attempt without authorizing it, rather than mocking
      // the helper under test or inferring absence from an arbitrary exception.
      return Response.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 });
    }));
    const result = source === 'git'
      ? await subject.buildReleaseImage(service, environment, { repoUrl: 'https://github.com/example/app.git', revision: commitSha })
      : await subject.buildReleaseImageFromArchive(service, environment, { archive: Buffer.from('archive'), commitSha, bucket: 'gcp-project-build-source' });

    expect(result.success).toBe(false);
    expect(calls).toEqual([`GET https://artifactregistry.googleapis.com/v1/${repositoryName}`]);
    expect(result.error).toMatch(/repository.*not ready|repository.*absent/i);
    expect(result.error).toMatch(/plan|setup/i);
  });

  it.each([
    { label: 'permission denied', status: 403, body: { error: { status: 'PERMISSION_DENIED' } } },
    { label: 'provider unavailable', status: 503, body: { error: { status: 'UNAVAILABLE' } } },
    { label: 'other repository identity', status: 200, body: { name: repositoryName.replace('hypervibe', 'other'), format: 'DOCKER' } },
    { label: 'other project identity', status: 200, body: { name: repositoryName.replace('gcp-project', 'other-project'), format: 'DOCKER' } },
    { label: 'other region identity', status: 200, body: { name: repositoryName.replace('us-central1', 'us-west1'), format: 'DOCKER' } },
    { label: 'unknown format', status: 200, body: { name: repositoryName } },
    { label: 'wrong format', status: 200, body: { name: repositoryName, format: 'MAVEN' } },
    { label: 'missing identity', status: 200, body: { format: 'DOCKER' } },
    { label: 'null response', status: 200, body: null },
  ])('stops before any release effects on $label', async ({ status, body }) => {
    const subject = await adapter();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return Response.json(body, { status });
    }));
    const result = await subject.buildReleaseImageFromArchive(service, environment, { archive: Buffer.from('archive'), commitSha, bucket: 'gcp-project-build-source' });
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/not ready/);
    expect(calls).toEqual([`GET https://artifactregistry.googleapis.com/v1/${repositoryName}`]);
  });

  it.each(['git', 'archive'] as const)('builds an immutable %s release with an existing exact DOCKER repository', async (source) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(createdAt);
    const subject = await adapter();
    const calls: string[] = [];
    const imageUri = source === 'git'
      ? 'us-central1-docker.pkg.dev/gcp-project/hypervibe/staging-web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-20261111000000'
      : 'us-central1-docker.pkg.dev/gcp-project/hypervibe/staging-web:aaaaaaaaaaaa-20261111000000';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const location = String(url);
      calls.push(`${method} ${location}`);
      if (location === `https://artifactregistry.googleapis.com/v1/${repositoryName}` && method === 'GET') {
        return Response.json({ name: repositoryName, format: 'DOCKER' });
      }
      if (source === 'archive' && location.startsWith('https://storage.googleapis.com/upload/storage/v1/b/gcp-project-build-source/o?') && method === 'POST') {
        return Response.json({ bucket: 'gcp-project-build-source', name: 'source-archive' });
      }
      if (location === 'https://cloudbuild.googleapis.com/v1/projects/gcp-project/builds' && method === 'POST') {
        expect(JSON.parse(String(init?.body)).images).toEqual([imageUri]);
        return Response.json({ id: 'build-1', status: 'SUCCESS', results: { images: [{ name: imageUri, digest: `sha256:${'b'.repeat(64)}` }] }, sourceProvenance: { resolvedRepoSource: { commitSha } } });
      }
      throw new Error(`Unexpected ${method} ${location}`);
    }));
    const result = source === 'git'
      ? await subject.buildReleaseImage(service, environment, { repoUrl: 'https://github.com/example/app.git', revision: commitSha })
      : await subject.buildReleaseImageFromArchive(service, environment, { archive: Buffer.from('archive'), commitSha, bucket: 'gcp-project-build-source' });
    expect(result).toMatchObject({ success: true, buildId: 'build-1', imageUri: `us-central1-docker.pkg.dev/gcp-project/hypervibe/staging-web@sha256:${'b'.repeat(64)}`, resolvedCommitSha: commitSha });
    expect(calls[0]).toBe(`GET https://artifactregistry.googleapis.com/v1/${repositoryName}`);
    expect(calls.filter((call) => call.includes('artifactregistry.googleapis.com'))).toHaveLength(1);
  });
});
