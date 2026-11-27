import { createHash } from 'node:crypto';
import { z } from 'zod';
import { railwayExportPrefix } from '../../../domain/services/railway-export-prefix.js';
import { GCP_JOB_NODE_IMAGE } from './gcp-node-image.js';

interface ProbeObjectScope {
  expectedEmail: string;
  projectNumber: string;
  bucket: string;
  object: string;
  generation: string;
}

export type AccessProbeJobInput = ProbeObjectScope & (
  | { role: 'app' | 'copy'; secretId: string; version: string; marker: string }
  | { role: 'file-app'; secretId?: never; version?: never; marker?: never }
);

const fileRead = z.strictObject({
  status: z.int().min(100).max(599).nullable(),
  classification: z.enum(['permission-denied', 'non-json-forbidden', 'readable', 'inconclusive']),
}).refine(({ status, classification }) => {
  if (status === 200 || status === 206) return classification === 'readable';
  if (classification === 'inconclusive') return true;
  return status === 403 && (classification === 'permission-denied' || classification === 'non-json-forbidden');
});

const fileEvidence = z.strictObject({
  outcome: z.enum(['denied', 'readable', 'inconclusive']),
  media: fileRead,
  metadata: fileRead.optional(),
}).refine(({ media, metadata, outcome }) => {
  if ((media.classification === 'non-json-forbidden') !== !!metadata || metadata?.classification === 'non-json-forbidden') return false;
  if (media.classification === 'readable') return outcome === 'readable';
  if (media.classification === 'permission-denied' || metadata?.classification === 'permission-denied') return outcome === 'denied';
  return outcome === 'inconclusive';
});

export type AccessProbeFileEvidence = z.infer<typeof fileEvidence>;

/** Logs and saved receipts may only supply a consistent verdict and bounded observations. */
export function parseAccessProbeFileEvidence(value: unknown): AccessProbeFileEvidence | undefined {
  return fileEvidence.safeParse(value).data;
}

export const PROBE_IMAGE = GCP_JOB_NODE_IMAGE;

export function probeEnvironment(
  input: AccessProbeJobInput,
  environment: string,
  project: string,
  serviceAccount: string,
): Record<string, string> | undefined {
  if (Object.values(input).some((value) => typeof value !== 'string' || /[\r\n]/.test(value))) return undefined;
  const prefix = railwayExportPrefix(environment) + 'hypervibe-access-probe-';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (input.role === 'file-app') {
    if ('secretId' in input || 'version' in input || 'marker' in input) return undefined;
  } else if (typeof input.secretId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(input.secretId)
    || !/^[1-9][0-9]{0,19}$/.test(input.version) || !/^[a-f0-9]{64}$/.test(input.marker)) return undefined;
  if (
    !['app', 'copy', 'file-app'].includes(input.role) ||
    input.expectedEmail !== serviceAccount ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(serviceAccount) ||
    !serviceAccount.endsWith(`@${project}.iam.gserviceaccount.com`) ||
    serviceAccount.split('@').length !== 2 ||
    !/^[1-9][0-9]{0,19}$/.test(input.projectNumber) ||
    !/^[1-9][0-9]{0,19}$/.test(input.generation) ||
    !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(input.bucket) ||
    !input.object.startsWith(prefix) ||
    !uuid.test(input.object.slice(prefix.length))
  )
    return undefined;
  return {
    PROBE_ROLE: input.role,
    SERVICE_ACCOUNT: input.expectedEmail,
    PROJECT_NUMBER: input.projectNumber,
    ...(input.role === 'file-app' ? {} : { SECRET_ID: input.secretId, VERSION: input.version, MARKER: input.marker }),
    BUCKET: input.bucket,
    OBJECT: input.object,
    GENERATION: input.generation,
  };
}

// Run verbatim under Node in the pinned image. No user-controlled text becomes code or a shell argument.
const PROBE_PROGRAM = String.raw`
(async () => {
  const env = process.env;
  const signal = AbortSignal.timeout(45000);
  const get = (url, headers = {}) => fetch(url, { method: 'GET', headers, redirect: 'error', signal });
  const meta = path => get('http://metadata.google.internal/computeMetadata/v1/' + path, { 'Metadata-Flavor': 'Google' });
  const account = 'instance/service-accounts/default/';
  let check = 'identity';
  const result = (ok, fileEvidence) => console.log('HV_TRANSFER_RESULT ' + JSON.stringify({ ok, check: ok ? undefined : check, fileEvidence }));
  async function bytes(response, limit) {
    const chunks = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > limit) throw new Error();
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  }
  async function successBody(response, limit) {
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(); }
    return bytes(response, limit);
  }
  function permissionDenied(err, permission, nativeName) {
    if (err?.code !== 403) return false;
    if (err.status && err.status !== 'PERMISSION_DENIED') return false;
    if (err.errors?.some(item => item.reason !== 'forbidden')) return false;
    const grantee = typeof err.message === 'string' && /^(.+?) (?:does not|doesn't) have /.exec(err.message);
    if (grantee && grantee[1] !== env.SERVICE_ACCOUNT) return false;
    if (err.details?.length) {
      const info = err.details.filter(d => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
      return info.length === 1 && ['IAM_PERMISSION_DENIED', 'forbidden'].includes(info[0].reason)
        && info[0].metadata?.permission === permission;
    }
    // Both Google APIs also return legacy permission-specific error messages.
    // A generic PERMISSION_DENIED or forbidden can indicate disabled APIs or token scope problems.
    if (permission === 'secretmanager.versions.access' && nativeName && err.status === 'PERMISSION_DENIED'
      && err.message === "Permission 'secretmanager.versions.access' denied for resource '" + nativeName + "' (or it may not exist).") return true;
    return typeof err.message === 'string' && (err.message.startsWith("Permission '" + permission + "' denied on resource")
      || err.message.startsWith(env.SERVICE_ACCOUNT + ' does not have ' + permission + ' access to ')
      || err.message.startsWith(env.SERVICE_ACCOUNT + " doesn't have " + permission + ' access to '));
  }
  async function secretDenied(url, headers, nativeName) {
    try {
      const response = await get(url, headers);
      if (response.status !== 403) { await response.body?.cancel(); return false; }
      return permissionDenied(JSON.parse(await bytes(response, 16384)).error, 'secretmanager.versions.access', nativeName);
    } catch { return false; }
  }
  async function objectRead(url, headers, media) {
    let status = null;
    try {
      const response = await get(url, headers);
      status = response.status;
      if (status !== 403) {
        await response.body?.cancel().catch(() => {});
        return { status, classification: status === 200 || status === 206 ? 'readable' : 'inconclusive' };
      }
      const body = (await bytes(response, 16384)).toString();
      const format = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (format === 'application/json') {
        if (permissionDenied(JSON.parse(body).error, 'storage.objects.get')) return { status, classification: 'permission-denied' };
      } else if (media && (format === 'text/html' || format === 'text/plain')) {
        // Only a neutral rejection or the named principal's storage denial can be
        // corroborated. A token, perimeter, proxy or unknown error stays unknown.
        const text = body.replace(/<[^>]{1,512}>/g, ' ').replace(/\s+/g, ' ').trim();
        const grantee = /(?:^|\s)([^\s]+) (?:does not|doesn't) have storage\.objects\.get access to the Google Cloud Storage object\b/.exec(text);
        if (/^(?:403[ .:-]*)?(?:forbidden|access denied)[.!]?$/i.test(text) || grantee?.[1] === env.SERVICE_ACCOUNT
          || text === "Permission 'storage.objects.get' denied on resource (or it may not exist).")
          return { status, classification: 'non-json-forbidden' };
      }
    } catch { /* Never include provider text, exception messages or response bytes in logs. */ }
    return { status, classification: 'inconclusive' };
  }
  async function fileAccess(headers) {
    const objectUrl = 'https://storage.googleapis.com/storage/v1/b/' + env.BUCKET + '/o/' + encodeURIComponent(env.OBJECT);
    const generation = 'generation=' + env.GENERATION;
    const media = await objectRead(objectUrl + '?alt=media&' + generation, headers, true);
    // Both forms of objects.get require storage.objects.get. Never infer that the
    // media was denied from a metadata request alone, or that metadata access exposed bytes.
    const metadata = media.classification === 'non-json-forbidden'
      ? await objectRead(objectUrl + '?' + generation, headers, false) : undefined;
    const denied = media.classification === 'permission-denied' || metadata?.classification === 'permission-denied';
    const outcome = media.classification === 'readable' ? 'readable' : denied ? 'denied' : 'inconclusive';
    return { outcome, media, metadata };
  }
  function checkedUrl(value) {
    const segment = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const path = '/' + env.BUCKET + '/' + env.OBJECT.split('/').map(segment).join('/');
    const origin = 'https://storage.googleapis.com';
    if (typeof value !== 'string' || !value.startsWith(origin + path + '?') || value.includes('#')) throw new Error();
    const url = new URL(value);
    const q = url.searchParams;
    const date = q.get('X-Goog-Date');
    const credential = q.get('X-Goog-Credential');
    const expires = q.get('X-Goog-Expires');
    // Each of the seven parameters below must appear exactly once.
    if (url.origin !== origin || url.pathname !== path || q.size !== 7 || q.get('generation') !== env.GENERATION
      || q.get('X-Goog-Algorithm') !== 'GOOG4-RSA-SHA256' || q.get('X-Goog-SignedHeaders') !== 'host'
      || !/^\d{8}T\d{6}Z$/.test(date ?? '') || !/^[1-9][0-9]{0,2}$/.test(expires ?? '') || Number(expires) > 900
      || !/^[a-z0-9._-]+@[a-z0-9.-]+\.gserviceaccount\.com\//.test(credential ?? '')
      || credential.split('/').slice(1).join('/') !== date.slice(0, 8) + '/auto/storage/goog4_request'
      || !/^[0-9a-f]{512}$/.test(q.get('X-Goog-Signature') ?? '')) throw new Error();
    return url;
  }
  try {
    if ((await successBody(await meta(account + 'email'), 256)).toString().trim() !== env.SERVICE_ACCOUNT
      || (await successBody(await meta('project/numeric-project-id'), 32)).toString().trim() !== env.PROJECT_NUMBER) return result(false);
    const auth = JSON.parse(await successBody(await meta(account + 'token'), 16384));
    if (auth.token_type?.toLowerCase() !== 'bearer' || typeof auth.access_token !== 'string' || !/^\S+$/.test(auth.access_token)) return result(false);
    const headers = { Authorization: 'Bearer ' + auth.access_token };
    if (env.PROBE_ROLE === 'file-app') {
      check = 'object-denial';
      const evidence = await fileAccess(headers);
      return result(evidence.outcome === 'denied', evidence);
    }
    const name = 'projects/' + env.PROJECT_NUMBER + '/secrets/' + env.SECRET_ID + '/versions/' + env.VERSION;
    const secretUrl = 'https://secretmanager.googleapis.com/v1/' + name + ':access';
    if (env.PROBE_ROLE === 'app') {
      check = 'secret-denial';
      const denied = await secretDenied(secretUrl, headers, name);
      check = 'object-denial';
      const evidence = await fileAccess(headers);
      if (!denied) check = 'secret-denial';
      return result(denied && evidence.outcome === 'denied', evidence);
    }
    if (env.PROBE_ROLE !== 'copy') return result(false);
    check = 'secret-read';
    const version = JSON.parse(await successBody(await get(secretUrl, headers), 16384));
    if (version.name !== name || typeof version.payload?.data !== 'string') return result(false);
    const payload = JSON.parse(Buffer.from(version.payload.data, 'base64').toString());
    if (Object.keys(payload).sort().join(',') !== 'marker,url' || payload.marker !== env.MARKER) return result(false);
    check = 'signed-object';
    const stored = await successBody(await get(checkedUrl(payload.url)), 64);
    return result(stored.equals(Buffer.from(env.MARKER)));
  } catch { return result(false); }
})()
`;

export const probeCommand = { command: ['node'], args: ['-e', PROBE_PROGRAM] };

/** Bind saved approval to the pinned image, entry point and exact reviewed worker bytes. */
export const probeWorkloadDigest = createHash('sha256')
  .update(JSON.stringify([PROBE_IMAGE, ...probeCommand.command, ...probeCommand.args]))
  .digest('hex');
