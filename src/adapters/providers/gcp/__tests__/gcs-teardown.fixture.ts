import { expect } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { GcsStorageAdapter } from '../gcs.adapter.js';
import type { StorageDeletionSnapshot } from '../../../../domain/ports/storage.port.js';

// Reconstructed native JSON API behavior, not a live provider observation.
// Official contract: objects.list defaults to live only; versions=true includes
// noncurrent generations. DELETE without generation does not remove that history.
// Soft-delete inventory is a separate query, and bucket deletion can retain data.
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete
// https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/delete
type ObjectMetadata = { name: string; generation: string; metageneration: string; size: string;
  softDeleteTime?: string; hardDeleteTime?: string; restoreToken?: string };
export const deletedAt = '2026-11-03T12:00:00.000Z';
export const expiresAt = '2026-11-10T12:00:00.000Z';
export const bucketPath = '/storage/v1/b/managed';
const originalBucket = { kind: 'storage#bucket', name: 'managed', generation: '101', metageneration: '3',
  projectNumber: '123456789', timeCreated: '2026-10-31T12:00:00.000Z', location: 'US-CENTRAL1',
  softDeletePolicy: { retentionDurationSeconds: '604800' },
  labels: { hypervibe_environment_id: 'environment-1', hypervibe_storage_name: 'documents' } };
const env: Environment = { id: 'environment-1', projectId: 'project-1', name: 'production', platformBindings: {},
  createdAt: new Date('2026-10-31'), updatedAt: new Date('2026-10-31') };
const context = { projectId: 'cloud-project', environmentId: env.id };

export async function gcsTeardownFixture(options: {
  versions?: ObjectMetadata[]; retained?: ObjectMetadata[]; environmentId?: string;
  fault?: 'versions-denied' | 'versions-malformed' | 'versions-token-loop' | 'retention-denied'
    | 'versions-second-page-denied' | 'retention-second-page-denied' | 'retention-after-delete-denied'
    | 'retention-malformed' | 'retention-unavailable' | 'changed-bucket' | 'changed-object'
    | 'concurrent-write' | 'bucket-delete-denied' | 'bucket-retention-denied' | 'bucket-retention-malformed'
    | 'bucket-delete-uncertain' | 'wrong-project';
  objectDeleteUncertain?: boolean;
  objectResponseLostBeforeCommit?: boolean;
  objectRejectOnce?: 403 | 412;
} = {}) {
  const scopedBucket = { ...originalBucket, labels: { ...originalBucket.labels, hypervibe_environment_id: options.environmentId ?? env.id } };
  const calls: Array<{ url: URL; method: string }> = [];
  const versions = structuredClone(options.versions ?? [
    { name: 'folder/backup #1.gz', generation: '10', metageneration: '1', size: '3' },
    { name: 'folder/backup #1.gz', generation: '20', metageneration: '2', size: '4' },
  ]);
  const retained = structuredClone(options.retained ?? (options.fault === 'retention-second-page-denied'
    ? [{ name: 'old-a', generation: '1', metageneration: '1', size: '1', softDeleteTime: deletedAt, hardDeleteTime: expiresAt },
      { name: 'old-b', generation: '2', metageneration: '1', size: '1', softDeleteTime: deletedAt, hardDeleteTime: expiresAt }] : []));
  let bucketActive = true;
  let replacement = false;
  let objectResponseLost = false;
  let bucketReads = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push({ url, method });
    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    const fail = (status: number, reason: string) => Response.json({ error: { code: status,
      errors: [{ domain: 'global', reason }], message: reason } }, { status });
    if (url.pathname === '/storage/v1/b' && method === 'GET') {
      expect(url.searchParams.get('project')).toBe(context.projectId);
      const items = options.fault === 'wrong-project' ? [] : [scopedBucket];
      return Response.json({ kind: 'storage#buckets', items: bucketActive ? items : [] });
    }
    if (url.pathname === bucketPath && method === 'GET') {
      if (url.searchParams.get('softDeleted') === 'true') {
        expect(url.searchParams.get('generation')).toBe(originalBucket.generation);
        if (options.fault === 'bucket-retention-denied') return fail(403, 'forbidden');
        if (options.fault === 'bucket-retention-malformed') return Response.json({ name: 'managed' });
        return !bucketActive ? Response.json({ ...scopedBucket, softDeleteTime: deletedAt, hardDeleteTime: expiresAt }) : fail(404, 'notFound');
      }
      bucketReads += 1;
      return bucketActive ? Response.json({ ...scopedBucket,
        ...(replacement || options.fault === 'changed-bucket' && bucketReads > 1 ? { generation: '102' } : {}) }) : fail(404, 'notFound');
    }
    if (url.pathname === `${bucketPath}/o` && method === 'GET') {
      const soft = url.searchParams.get('softDeleted') === 'true';
      const all = url.searchParams.get('versions') === 'true';
      expect(!(soft && all)).toBe(true);
      if (all && options.fault === 'versions-denied' || soft && options.fault === 'retention-denied') return fail(403, 'forbidden');
      if (url.searchParams.has('pageToken') && (all && options.fault === 'versions-second-page-denied'
        || soft && options.fault === 'retention-second-page-denied')) return fail(403, 'forbidden');
      if (soft && options.fault === 'retention-after-delete-denied' && versions.length === 0) return fail(403, 'forbidden');
      if (soft && options.fault === 'retention-unavailable') return fail(400, 'invalidArgument');
      if (all && options.fault === 'versions-malformed') return Response.json({ kind: 'storage#objects', items: [{ name: 'bad', size: '1' }] });
      if (soft && options.fault === 'retention-malformed') return Response.json({ kind: 'storage#objects', items: [{ ...versions[0], softDeleteTime: deletedAt }] });
      if (all && options.fault === 'versions-token-loop') return Response.json({ kind: 'storage#objects', nextPageToken: 'same-page' });
      const values = soft ? retained : all ? versions : versions.filter((item, i) => !versions.slice(i + 1).some(other => other.name === item.name));
      // Deliberately small native pages: the client must retain each generation.
      const offset = Number(url.searchParams.get('pageToken') ?? '0');
      return Response.json({ kind: 'storage#objects', items: values.slice(offset, offset + 1),
        ...(offset + 1 < values.length ? { nextPageToken: String(offset + 1) } : {}) });
    }
    if (url.pathname.startsWith(`${bucketPath}/o/`) && method === 'DELETE') {
      if (!objectResponseLost && (options.objectResponseLostBeforeCommit || options.objectRejectOnce)) {
        objectResponseLost = true;
        if (options.objectRejectOnce) {
          if (options.objectRejectOnce === 412) versions[0].metageneration = '7';
          return fail(options.objectRejectOnce, options.objectRejectOnce === 403 ? 'forbidden' : 'conditionNotMet');
        }
        throw new Error('synthetic response lost before commit');
      }
      const name = decodeURIComponent(url.pathname.slice(`${bucketPath}/o/`.length));
      const generation = url.searchParams.get('generation');
      let index = generation ? versions.findIndex(item => item.name === name && item.generation === generation) : -1;
      if (!generation) for (let i = 0; i < versions.length; i++) if (versions[i].name === name) index = i;
      if (index < 0) return fail(404, 'notFound');
      const object = versions[index];
      if (options.fault === 'changed-object') return fail(412, 'conditionNotMet');
      if (generation) {
        if (url.searchParams.get('ifGenerationMatch') !== generation
          || url.searchParams.get('ifMetagenerationMatch') !== object.metageneration) return fail(412, 'conditionNotMet');
        versions.splice(index, 1);
        retained.push({ ...object, softDeleteTime: deletedAt, hardDeleteTime: expiresAt });
      }
      // Without generation, native object versioning retains the old generation.
      if (options.fault === 'concurrent-write' && !versions.some(item => item.generation === '99')) {
        versions.push({ name: 'new-unreviewed-write', generation: '99', metageneration: '1', size: '5' });
      }
      if (options.objectDeleteUncertain && !objectResponseLost) {
        objectResponseLost = true; throw new Error('synthetic object response lost after commit');
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith(`${bucketPath}/o/`) && method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice(`${bucketPath}/o/`.length));
      const values = url.searchParams.get('softDeleted') === 'true' ? retained : versions;
      const object = values.find(item => item.name === name && item.generation === url.searchParams.get('generation'));
      return object ? Response.json({ kind: 'storage#object', ...object }) : fail(404, 'notFound');
    }
    if (url.pathname === bucketPath && method === 'DELETE') {
      if (options.fault === 'bucket-delete-denied') return fail(403, 'forbidden');
      if (versions.length) return fail(409, 'conflict');
      if (url.searchParams.get('ifMetagenerationMatch') !== originalBucket.metageneration) return fail(412, 'conditionNotMet');
      bucketActive = false;
      if (options.fault === 'bucket-delete-uncertain') throw new Error('synthetic response lost after commit');
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected synthetic request: ${method} ${url.pathname}`);
  };
  const createAdapter = async () => {
    const adapter = new GcsStorageAdapter({ fetch: request,
      tokenProvider: async () => ({ token: 'synthetic-token', email: 'operator@example.test' }) });
    await adapter.connect({ authMode: 'default', projectId: context.projectId });
    return adapter;
  };
  const adapter = await createAdapter();
  let recovery: StorageDeletionSnapshot | undefined;
  return { adapter, createAdapter, calls, versions, retained, env, context,
    replaceActiveBucket: () => { bucketActive = true; replacement = true; },
    destroy: () => adapter.destroyBucket(env, context, originalBucket.name, {
      recovery, allowMutation: !recovery, persistRecovery: async value => { recovery = value; },
    }) };
}
