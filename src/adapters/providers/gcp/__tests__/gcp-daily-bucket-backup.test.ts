import { describe, expect, it, vi } from 'vitest';
import { runDailyBucketBackup } from '../../../../domain/services/daily-bucket-backup.service.js';
import { runCloudBucketBackupWorker } from '../../../../ci/cloud-bucket-backup.js';
import { openGcsDailyBucketBackup, readGcsDailyBucketBackups } from '../gcp-daily-bucket-backup.js';

const config = { version: 1, provider: 'gcs', projectId: 'example-project', projectNumber: '7654321',
  sourceBucket: 'workload-files', sourceTimeCreated: '2026-01-01T00:00:00Z', archiveBucket: 'workload-archive',
  archiveTimeCreated: '2026-02-01T00:00:00.120Z', serviceAccountEmail: 'backup@example-project.iam.gserviceaccount.com' };
const userKey = '2026/customer file.pdf';
const original = Buffer.from('unchanged original document');
type ObjectMeta = {
  name: string; size: string; generation: string; metageneration: string; contentType: string; metadata?: Record<string, string>;
};

/** Google Cloud Run metadata and Cloud Storage JSON API. No control-plane
 * credentials, source writes, or unconditioned overwrites are accepted. */
function google() {
  const objects = new Map<string, { bytes: Buffer; meta: ObjectMeta }>();
  objects.set(config.sourceBucket + '/' + userKey, { bytes: original, meta: { name: userKey, size: String(original.length),
    generation: '42', metageneration: '1', contentType: 'application/pdf', metadata: { label: 'original' } } });
  const bucketMetadata = new Map([[config.sourceBucket, { name: config.sourceBucket, projectNumber: config.projectNumber, timeCreated: '2026-01-01T00:00:00.000Z' }],
    [config.archiveBucket, { name: config.archiveBucket, projectNumber: config.projectNumber, timeCreated: '2026-02-01T00:00:00.12Z' }]]);
  let generation = 100;
  const instance = new Map([['project/project-id', config.projectId], ['project/numeric-project-id', config.projectNumber],
    ['instance/service-accounts/default/email', config.serviceAccountEmail], ['instance/service-accounts/default/token',
      JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-workload-token', expires_in: 3500 })]]);
  const request = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input)), headers = new Headers(init.headers), method = init.method ?? 'GET';
    if (url.hostname === 'metadata.google.internal') {
      expect(headers.get('Metadata-Flavor')).toBe('Google'); expect(init.redirect).toBe('error');
      const value = instance.get(url.pathname.slice('/computeMetadata/v1/'.length));
      return new Response(value, { status: value ? 200 : 404, headers: { 'Metadata-Flavor': 'Google' } });
    }
    expect(headers.get('Authorization')).toMatch(/^Bearer synthetic-(?:workload|observer)-token$/);
    expect(url.origin).toBe('https://storage.googleapis.com');
    const match = url.pathname.match(/^\/(upload\/)?storage\/v1\/b\/([^/]+)(?:\/(o)(?:\/(.+))?)?$/)!;
    const bucket = match[2], name = decodeURIComponent(match[4] ?? url.searchParams.get('name') ?? '');
    if (!match[3]) return Response.json(bucketMetadata.get(bucket));
    const key = bucket + '/' + name;
    if (method !== 'GET') expect(bucket).toBe(config.archiveBucket);
    if (method === 'POST' && match[1]) {
      expect(url.searchParams.get('ifGenerationMatch')).toBe('0');
      if (objects.has(key)) return new Response(null, { status: 412 });
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      const meta = { name, size: String(bytes.length), contentType: headers.get('content-type') ?? 'application/octet-stream',
        generation: String(++generation), metageneration: '1' };
      objects.set(key, { bytes, meta }); return Response.json(meta);
    }
    if (!name && method === 'GET') return Response.json({ items: [...objects.entries()]
      .filter(([key, object]) => key.startsWith(bucket + '/') && object.meta.name.startsWith(url.searchParams.get('prefix') ?? ''))
      .map(([, object]) => object.meta) });
    const stored = objects.get(key);
    if (!stored) return new Response(null, { status: 404 });
    for (const [query, actual] of [['ifGenerationMatch', stored.meta.generation], ['ifMetagenerationMatch', stored.meta.metageneration]]) {
      if (url.searchParams.has(query) && url.searchParams.get(query) !== actual) return new Response(null, { status: 412 });
    }
    if (method === 'PATCH') {
      expect(url.searchParams.get('ifGenerationMatch')).toBe(stored.meta.generation);
      Object.assign(stored.meta, JSON.parse(String(init.body))); stored.meta.metageneration = String(Number(stored.meta.metageneration) + 1);
      return Response.json(stored.meta);
    }
    expect(method).toBe('GET');
    if (url.searchParams.get('alt') !== 'media') return Response.json(stored.meta);
    expect(url.searchParams.get('ifGenerationMatch')).toBe(stored.meta.generation);
    expect(url.searchParams.get('ifMetagenerationMatch')).toBe(stored.meta.metageneration);
    return new Response(new Uint8Array(stored.bytes), { headers: { 'content-length': stored.meta.size,
      'x-goog-generation': stored.meta.generation, 'x-goog-metageneration': stored.meta.metageneration } });
  });
  return { request, objects, instance, bucketMetadata };
}

describe('GCP daily bucket backup worker and on-demand observer', () => {
  it('copies the exact bucket through the configured workload identity and exposes only validated, data-free points to the observer', async () => {
    const cloud = google();
    const result = await runCloudBucketBackupWorker(raw => openGcsDailyBucketBackup(raw, { fetch: cloud.request }),
      { HYPERVIBE_BUCKET_BACKUP_CONFIG: JSON.stringify(config), GOOGLE_APPLICATION_CREDENTIALS: '/unused/customer-admin-key' });
    expect(result.point.objectCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('customer');
    const manifest = JSON.parse(cloud.objects.get(config.archiveBucket + '/' + result.point.manifestKey)!.bytes.toString());
    expect(manifest.sourceIdentity).toMatchObject({ provider: 'gcs', externalId: config.sourceBucket,
      instanceScope: { projectId: config.projectId, projectNumber: config.projectNumber, timeCreated: '2026-01-01T00:00:00Z' } });
    expect(manifest.entries[0]).toMatchObject({ key: userKey, http: { contentType: 'application/pdf' }, metadata: { label: 'original' } });
    expect(cloud.objects.get(config.archiveBucket + '/' + manifest.entries[0].backupKey)?.bytes).toEqual(original);
    cloud.request.mockClear();
    const history = await readGcsDailyBucketBackups(config, async () => 'synthetic-observer-token', { fetch: cloud.request });
    expect(history.points).toEqual([result.point]);
    expect(cloud.request.mock.calls.every(([url, init]) => !String(url).includes('metadata.google.internal') && (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('rechecks both native bucket incarnations before retention when a bucket is replaced during a long copy', async () => {
    const cloud = google();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const response = await cloud.request(url, init);
      if (init?.method === 'POST' && new URL(String(url)).searchParams.get('name')?.endsWith('/points/2026-11-08.json')) {
        cloud.bucketMetadata.get(config.archiveBucket)!.timeCreated = '2026-11-08T02:00:00Z';
      }
      return response;
    });
    const clients = await openGcsDailyBucketBackup(config, { fetch: request });
    for (let n = 1; n <= 7; n++) await runDailyBucketBackup({ ...clients, now: new Date(Date.UTC(2026, 10, n, 3)) });
    await expect(runDailyBucketBackup({ ...clients, now: new Date(Date.UTC(2026, 10, 8, 3)) })).rejects.toThrow(/different bucket/);
    expect(request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each(['service account', 'project number', 'source birth time', 'archive owner', 'aliased destination'])('rejects mismatched %s before any data operation', async reason => {
    const cloud = google();
    let input = config;
    if (reason === 'service account') cloud.instance.set('instance/service-accounts/default/email', 'admin@example-project.iam.gserviceaccount.com');
    if (reason === 'project number') cloud.instance.set('project/numeric-project-id', '732');
    if (reason === 'source birth time') cloud.bucketMetadata.get(config.sourceBucket)!.timeCreated = '2026-01-01T00:00:00.000000001Z';
    if (reason === 'archive owner') cloud.bucketMetadata.get(config.archiveBucket)!.projectNumber = '732';
    if (reason === 'aliased destination') input = { ...config, archiveBucket: config.sourceBucket };
    await expect(openGcsDailyBucketBackup(input, { fetch: cloud.request })).rejects.toThrow();
    expect(cloud.request.mock.calls.every(([url]) => !String(url).includes('/o?') && !String(url).includes('/o/'))).toBe(true);
  });
});
