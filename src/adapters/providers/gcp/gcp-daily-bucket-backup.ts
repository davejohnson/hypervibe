import { z } from 'zod';
import { observeDailyBucketBackups, type DailyBucketBackupClients } from '../../../domain/services/daily-bucket-backup.service.js';
import { GcsObjectClient, rawGcsMediaFetch, STORAGE_API } from './gcs-object-client.js';

const bucketName = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/);
const project = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const projectNumber = z.string().regex(/^[1-9][0-9]{0,19}$/);
// RFC 3339 permits different zero-padding for the same instant. Preserve all
// native precision, including fractions smaller than one JS millisecond.
const creation = z.iso.datetime().transform(value => value.replace(/\.(\d+)Z$/, (_, fraction: string) => {
  const digits = fraction.replace(/0+$/, '');
  return digits ? '.' + digits + 'Z' : 'Z';
}));
const schema = z.object({
  version: z.literal(1), provider: z.literal('gcs'), projectId: project, projectNumber,
  sourceBucket: bucketName, sourceTimeCreated: creation, archiveBucket: bucketName, archiveTimeCreated: creation,
  serviceAccountEmail: z.email(),
}).strict().refine(value => value.sourceBucket !== value.archiveBucket
  && value.serviceAccountEmail.endsWith('@' + value.projectId + '.iam.gserviceaccount.com'));
export type GcsDailyBucketBackupConfig = z.infer<typeof schema>;
type Options = { fetch?: typeof fetch; mediaFetch?: typeof fetch; now?: Date };
const metadataRoot = 'http://metadata.google.internal/computeMetadata/v1/';

export function gcsBucketBackupIdentity(projectId: string, projectNumber: string, bucket: string, timeCreated: string) {
  return { provider: 'gcs', externalId: bucket, instanceScope: { projectId, projectNumber, timeCreated: creation.parse(timeCreated) } };
}

async function openBuckets(config: GcsDailyBucketBackupConfig, getToken: () => Promise<string>, options: Options) {
  const request = options.fetch ?? fetch;
  const media = options.mediaFetch ?? options.fetch ?? rawGcsMediaFetch;
  const native = z.object({ name: bucketName, projectNumber, timeCreated: creation });
  async function observeBucket(name: string, createdAt: string) {
    const url = new URL(STORAGE_API + '/storage/v1/b/' + encodeURIComponent(name));
    url.searchParams.set('fields', 'name,projectNumber,timeCreated');
    const response = await request(url.href, { headers: { Authorization: 'Bearer ' + await getToken() }, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('The selected Google Cloud bucket could not be observed.'); }
    const observed = native.parse(await response.json());
    if (observed.name !== name || observed.projectNumber !== config.projectNumber || observed.timeCreated !== createdAt) {
      throw new Error('Google Cloud returned a different bucket, project or creation time.');
    }
    return gcsBucketBackupIdentity(config.projectId, config.projectNumber, name, observed.timeCreated);
  }
  const observeBindings = async () => ({
    sourceIdentity: await observeBucket(config.sourceBucket, config.sourceTimeCreated),
    destinationIdentity: await observeBucket(config.archiveBucket, config.archiveTimeCreated),
  });
  return { ...await observeBindings(), verifyIdentity: async () => { await observeBindings(); },
    source: new GcsObjectClient(config.sourceBucket, request, getToken, media),
    archive: new GcsObjectClient(config.archiveBucket, request, getToken, media) };
}

/** Cloud Run's own metadata service is the sole source of credentials here. */
export async function openGcsDailyBucketBackup(raw: unknown, options: Options = {}): Promise<DailyBucketBackupClients> {
  const config = schema.parse(raw), request = options.fetch ?? fetch;
  async function metadata(path: string) {
    const response = await request(metadataRoot + path, {
      headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google') {
      await response.body?.cancel(); throw new Error('Google Cloud workload identity is unavailable.');
    }
    return response;
  }
  const read = async (path: string) => (await (await metadata(path)).text()).trim();
  if (await read('project/project-id') !== config.projectId || await read('project/numeric-project-id') !== config.projectNumber
    || await read('instance/service-accounts/default/email') !== config.serviceAccountEmail) {
    throw new Error('Google Cloud workload identity differs from the configured backup job.');
  }
  const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive(), token_type: z.literal('Bearer') });
  let cached: { token: string; expires: number } | undefined;
  const getToken = async () => {
    if (!cached || Date.now() + 60_000 >= cached.expires) {
      const body = tokenResponse.parse(await (await metadata('instance/service-accounts/default/token')).json());
      cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    }
    return cached.token;
  };
  return openBuckets(config, getToken, options);
}

/** A connected management identity can inspect the same evidence without launching the job. */
export async function readGcsDailyBucketBackups(raw: unknown, getAccessToken: () => Promise<string>, options: Options = {}) {
  const clients = await openBuckets(schema.parse(raw), getAccessToken, options);
  try { return await observeDailyBucketBackups({ ...clients, now: options.now }); }
  finally { clients.source.destroy(); clients.archive.destroy(); }
}
