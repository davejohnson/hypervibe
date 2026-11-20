import { createHash } from 'node:crypto';
import { z } from 'zod';
import { railwayExportPrefix } from '../../../domain/services/railway-export-prefix.js';
import { TransferEvidenceError, type DestroyedProbeVersion } from './gcp-transfer-slot-evidence.js';
import type { TransferIsolationScope } from './tofu/transfer-isolation.js';
import { findAuditedProbeVersion, probeVersionReason } from './gcp-transfer-probe-audit.js';
import { transferSlot } from './tofu/transfer-slot.js';

const numberId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const timestamp = z.iso.datetime({ offset: true });
const storedObject = z.object({ bucket: z.string(), name: z.string(), generation: numberId });
const storedVersion = z.object({
  name: z.string(), createTime: timestamp, state: z.enum(['ENABLED', 'DISABLED', 'DESTROYED']),
  etag: z.string().min(1).max(256),
});
export type ProbeObject = z.infer<typeof storedObject>;
export type ProbeVersion = Omit<DestroyedProbeVersion, 'state'> & { etag: string };

function reject(message: string): never { throw new TransferEvidenceError(message); }

/** Only a documented rejection of the create POST releases a pending write without reconciliation. */
export class ProbeCreateRejected extends TransferEvidenceError {
  constructor(readonly resource: 'object' | 'version') { super('Google rejected creation of the test ' + resource + '.'); }
}
async function rejectedCreate(resource: 'object' | 'version', response: Response) {
  const status = response.status;
  if (![400, 401, 403, 404, 412].includes(status)) return false;
  const data = z.object({ error: z.object({ code: z.literal(status), status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string() })).optional() }) }).safeParse(await metadata(response));
  if (!data.success) return false;
  if (resource === 'version') {
    const expected: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND' };
    return !!expected[status] && data.data.error.status === expected[status];
  }
  const reasons: Record<number, string[]> = { 401: ['authError', 'required'], 403: ['forbidden', 'insufficientPermissions'],
    404: ['notFound'], 412: ['conditionNotMet'] };
  const errors = data.data.error.errors;
  return !!errors?.length && errors.every(item => reasons[status]?.includes(item.reason));
}

function requireMarker(value: string) {
  if (value.length !== 64 || !/^[a-f0-9]+$/.test(value)) reject('The probe requires a generated test marker.');
}

function checkSignedUrl(value: string, object: ProbeObject) {
  const encode = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  const path = '/' + object.bucket + '/' + object.name.split('/').map(encode).join('/');
  const invalid = () => reject('The signed probe URL must select the reviewed test generation for at most 15 minutes.');
  if (value.length > 8192 || !value.startsWith('https://storage.googleapis.com' + path + '?') || value.includes('#')) invalid();
  const query = new URL(value).searchParams;
  const fields = ['X-Goog-Algorithm', 'X-Goog-Credential', 'X-Goog-Date', 'X-Goog-Expires', 'X-Goog-SignedHeaders', 'X-Goog-Signature', 'generation'];
  const expires = query.get('X-Goog-Expires') ?? '';
  if (query.size !== fields.length || fields.some(key => query.getAll(key).length !== 1)
      || query.get('X-Goog-Algorithm') !== 'GOOG4-RSA-SHA256' || query.get('X-Goog-SignedHeaders') !== 'host'
      || !/^\d{8}T\d{6}Z$/.test(query.get('X-Goog-Date') ?? '') || !query.get('X-Goog-Credential')
      || !/^[a-f0-9]+$/.test(query.get('X-Goog-Signature') ?? '') || query.get('generation') !== object.generation
      || !/^[1-9]\d{0,2}$/.test(expires) || Number(expires) > 900) invalid();
}

async function bytes(response: Response, limit: number): Promise<Buffer> {
  try {
    if (!response.body) throw Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw Error(); }
      chunks.push(chunk.value);
    }
  } catch { reject('Google did not return a bounded probe response.'); }
}

async function metadata(response: Response): Promise<unknown> {
  const raw = await bytes(response, 16_384);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { reject('Google returned unreadable probe metadata.'); }
}

/** Disposable data-plane operations inside the caller's exact approved scope. Writes are attempted once. */
export function transferProbeFixtures(token: string, scope: TransferIsolationScope, probeId: string) {
  const { target, bucket, projectNumber, secretCreateTime } = scope;
  if (!token.trim() || !z.uuidv4().safeParse(probeId).success || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target.projectId)
      || bucket !== target.projectId + '-hv-build-source' || !numberId.safeParse(projectNumber).success
      || !timestamp.safeParse(secretCreateTime).success || !timestamp.safeParse(scope.bucketTimeCreated).success) reject('The probe needs the reviewed migration resources and its unique test ID.');
  const objectName = railwayExportPrefix(scope.targetEnvironmentName) + 'hypervibe-access-probe-' + probeId;
  if (Buffer.byteLength(objectName) > 1024) reject('The generated probe object exceeds the Cloud Storage name limit.');
  const secretName = 'projects/' + projectNumber + '/secrets/' + transferSlot(target).secretId;
  const storage = 'https://storage.googleapis.com';
  const objectPath = '/storage/v1/b/' + bucket + '/o/' + encodeURIComponent(objectName);
  const secretBase = 'https://secretmanager.googleapis.com/v1/';
  const versionFields = '?fields=name,createTime,state,etag';

  async function request(url: string | URL, operation: string, init: RequestInit = {},
    mode?: 'allowMissing' | 'object' | 'version', beforeDispatch?: () => void) {
    const timeout = AbortSignal.timeout(15_000);
    const options: RequestInit = { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + token },
      redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
    let result: Response;
    beforeDispatch?.();
    try {
      result = await fetch(url, options);
    } catch { reject('Google could not confirm ' + operation + '.'); }
    if (!result.ok && !(mode === 'allowMissing' && result.status === 404)) {
      if ((mode === 'object' || mode === 'version') && await rejectedCreate(mode, result)) throw new ProbeCreateRejected(mode);
      reject('Google could not confirm ' + operation + ' (HTTP ' + result.status + ').');
    }
    return result;
  }

  function requireObject(value: unknown): ProbeObject {
    const parsed = storedObject.safeParse(value);
    if (!parsed.success || parsed.data.bucket !== bucket || parsed.data.name !== objectName) {
      reject('The test object identity does not match the reviewed probe.');
    }
    return parsed.data;
  }

  function objectUrl(input: ProbeObject, download: boolean) {
    const object = requireObject(input);
    const url = new URL(storage + (download ? '/download' : '') + objectPath);
    url.searchParams.set('generation', object.generation);
    url.searchParams.set('ifGenerationMatch', object.generation);
    if (download) url.searchParams.set('alt', 'media');
    return url;
  }

  function nativeVersionName(name: string) {
    const prefix = secretName + '/versions/';
    return name.startsWith(prefix) && numberId.safeParse(name.slice(prefix.length)).success;
  }

  async function verifyParent() {
    const response = await request(secretBase + secretName + '?fields=name,createTime,versionDestroyTtl', 'the probe secret identity');
    const parent = z.object({ name: z.literal(secretName), createTime: z.literal(secretCreateTime),
      versionDestroyTtl: z.literal('0s').optional() }).safeParse(await metadata(response));
    if (!parent.success) reject('The original transfer secret must be present with immediate version destruction.');
  }

  async function versionMetadata(response: Response) {
    const result = storedVersion.safeParse(await metadata(response));
    if (!result.success || !nativeVersionName(result.data.name)) reject('Google did not confirm a native numbered probe version in the reviewed secret.');
    return result.data;
  }

  async function verifyBucket() {
    const response = await request(storage + '/storage/v1/b/' + bucket + '?fields=name,projectNumber,timeCreated', 'the original probe bucket');
    const identity = z.object({ name: z.literal(bucket), projectNumber: z.literal(projectNumber), timeCreated: z.literal(scope.bucketTimeCreated) });
    if (!identity.safeParse(await metadata(response)).success) reject('The original test bucket no longer matches the reviewed migration.');
  }

  function liveObjectMetadata() {
    return request(storage + objectPath + '?fields=bucket,name,generation,size,md5Hash', 'the exact test object identity', {}, 'allowMissing');
  }

  async function readObject(object: ProbeObject, marker: string): Promise<void> {
    requireMarker(marker);
    const response = await request(objectUrl(object, true), 'the test object contents');
    if (response.status !== 200 || !(await bytes(response, 64)).equals(Buffer.from(marker))) reject('Google returned different test object contents.');
  }

  return {
    objectName, secretName,
    async assertReady(): Promise<void> {
      await Promise.all([verifyBucket(), verifyParent()]);
      if ((await liveObjectMetadata()).status !== 404) reject('The planned test object name is already in use.');
    },
    // After a lost insert response, verify the secret random marker against the live
    // object checksum and immutable generation bytes before granting cleanup authority.
    async recoverObject(marker: string): Promise<ProbeObject | null> {
      requireMarker(marker);
      await verifyBucket();
      const observed = await liveObjectMetadata();
      if (observed.status === 404) return null;
      const raw = await metadata(observed);
      const object = requireObject(raw);
      const checksum = createHash('md5').update(marker).digest('base64');
      if (!z.object({ size: z.literal('64'), md5Hash: z.literal(checksum) }).safeParse(raw).success) {
        reject('The object occupying the test name does not match the saved probe marker.');
      }
      await readObject(object, marker);
      return object;
    },
    async createObject(marker: string, beforeDispatch?: () => void): Promise<ProbeObject> {
      requireMarker(marker);
      await verifyBucket();
      const url = new URL(storage + '/upload/storage/v1/b/' + bucket + '/o');
      url.search = new URLSearchParams({ uploadType: 'media', name: objectName, ifGenerationMatch: '0', fields: 'bucket,name,generation' }).toString();
      const response = await request(url, 'creation of the new test object', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: marker,
      }, 'object', beforeDispatch);
      return requireObject(await metadata(response));
    },
    readObject,
    async deleteObject(object: ProbeObject): Promise<void> {
      const url = objectUrl(object, false);
      await verifyBucket();
      const deletion = await request(url, 'deletion of the test generation', { method: 'DELETE' }, 'allowMissing');
      if (![204, 404].includes(deletion.status)) reject('Google did not confirm deletion of the recorded test generation.');
      url.searchParams.set('fields', 'bucket,name,generation');
      const after = await request(url, 'absence of the recorded test generation', {}, 'allowMissing');
      if (after.status !== 404) reject('The recorded test generation remains present after deletion.');
    },
    async addVersion(marker: string, url: string, object: ProbeObject, beforeDispatch?: () => void): Promise<ProbeVersion> {
      requireMarker(marker);
      checkSignedUrl(url, requireObject(object));
      await verifyParent();
      const data = Buffer.from(JSON.stringify({ marker, url })).toString('base64');
      const response = await request(secretBase + secretName + ':addVersion' + versionFields, 'creation of the test secret version', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Request-Reason': probeVersionReason(probeId, marker) },
        body: JSON.stringify({ payload: { data } }),
      }, 'version', beforeDispatch);
      const version = await versionMetadata(response);
      if (version.state !== 'ENABLED') reject('Google returned a test version in an unexpected state.');
      return { name: version.name, createTime: version.createTime, etag: version.etag, projectNumber, secretCreateTime };
    },
    async recoverVersion(marker: string, since = secretCreateTime): Promise<ProbeVersion> {
      requireMarker(marker);
      await verifyParent();
      if (!timestamp.safeParse(since).success || Date.parse(since) < Date.parse(secretCreateTime)) reject('The probe recovery time does not match the original secret.');
      const found = await findAuditedProbeVersion(target.projectId, secretName, probeVersionReason(probeId, marker), since,
        async (url, init) => metadata(await request(url, 'the creation audit record and native test version', init)));
      const current = await versionMetadata(await request(secretBase + found.name + versionFields, 'the audited probe version metadata'));
      if (current.name !== found.name || current.createTime !== found.createTime || current.state === 'DISABLED') {
        reject('The audited version no longer matches its immutable probe identity.');
      }
      return { name: current.name, createTime: current.createTime, etag: current.etag, projectNumber, secretCreateTime };
    },
    async destroyVersion(version: ProbeVersion): Promise<DestroyedProbeVersion> {
      if (version.projectNumber !== projectNumber || version.secretCreateTime !== secretCreateTime || !nativeVersionName(version.name)
          || !timestamp.safeParse(version.createTime).success || !version.etag) reject('The saved test version does not match the original transfer secret.');
      await verifyParent();
      const url = secretBase + version.name;
      const read = async () => {
        const observed = await versionMetadata(await request(url + versionFields, 'the recorded probe version identity'));
        if (observed.name !== version.name || observed.createTime !== version.createTime) reject('The recorded probe version identity has changed.');
        return observed;
      };
      const state = await read();
      if (state.state !== 'DESTROYED') {
        if (state.state !== 'ENABLED' || state.etag !== version.etag) reject('The recorded test version has changed since creation.');
        const response = await request(url + ':destroy' + versionFields, 'destruction of the recorded test version', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ etag: version.etag }),
        });
        const destroyed = await versionMetadata(response);
        if (destroyed.name !== version.name || destroyed.createTime !== version.createTime || destroyed.state !== 'DESTROYED'
            || (await read()).state !== 'DESTROYED') reject('Google did not confirm permanent destruction of the exact test version.');
      }
      return { name: version.name, createTime: version.createTime, projectNumber, secretCreateTime, state: 'DESTROYED' };
    },
  };
}
