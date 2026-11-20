import { createHash } from 'node:crypto';
import { railwayExportPrefix } from '../../../domain/services/railway-export-prefix.js';

export interface AccessProbeJobInput {
  role: 'app' | 'copy';
  expectedEmail: string;
  projectNumber: string;
  secretId: string;
  version: string;
  bucket: string;
  object: string;
  generation: string;
  marker: string;
}

// Official Docker Hub library/node:24-bookworm-slim, Linux AMD64 manifest (2026-11-11).
export const PROBE_IMAGE =
  'docker.io/library/node@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e';

export function probeEnvironment(
  input: AccessProbeJobInput,
  environment: string,
  project: string,
  serviceAccount: string,
): Record<string, string> | undefined {
  if (Object.values(input).some((value) => typeof value !== 'string' || /[\r\n]/.test(value))) return undefined;
  const prefix = railwayExportPrefix(environment) + 'hypervibe-access-probe-';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (
    !['app', 'copy'].includes(input.role) ||
    input.expectedEmail !== serviceAccount ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(serviceAccount) ||
    !serviceAccount.endsWith(`@${project}.iam.gserviceaccount.com`) ||
    serviceAccount.split('@').length !== 2 ||
    !/^[1-9][0-9]{0,19}$/.test(input.projectNumber) ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(input.secretId) ||
    !/^[1-9][0-9]{0,19}$/.test(input.version) ||
    !/^[1-9][0-9]{0,19}$/.test(input.generation) ||
    !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(input.bucket) ||
    !input.object.startsWith(prefix) ||
    !uuid.test(input.object.slice(prefix.length)) ||
    !/^[a-f0-9]{64}$/.test(input.marker)
  )
    return undefined;
  return {
    PROBE_ROLE: input.role,
    SERVICE_ACCOUNT: input.expectedEmail,
    PROJECT_NUMBER: input.projectNumber,
    SECRET_ID: input.secretId,
    VERSION: input.version,
    BUCKET: input.bucket,
    OBJECT: input.object,
    GENERATION: input.generation,
    MARKER: input.marker,
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
  const result = ok => console.log('HV_TRANSFER_RESULT ' + JSON.stringify(ok ? { ok } : { ok, check }));
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
  async function denied(response, permission, nativeName) {
    if (response.status !== 403) { await response.body?.cancel(); return false; }
    const err = JSON.parse(await bytes(response, 16384)).error;
    if (err?.code !== 403) return false;
    if (err.details?.length) {
      const info = err.details.filter(d => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
      return info.length === 1 && ['IAM_PERMISSION_DENIED', 'forbidden'].includes(info[0].reason)
        && info[0].metadata?.permission === permission;
    }
    // Both Google APIs also return legacy permission-specific error messages.
    // A generic PERMISSION_DENIED or forbidden can indicate disabled APIs or token scope problems.
    if (err.status && err.status !== 'PERMISSION_DENIED') return false;
    if (err.errors?.some(item => item.reason !== 'forbidden')) return false;
    if (permission === 'secretmanager.versions.access' && nativeName && err.status === 'PERMISSION_DENIED'
      && err.message === "Permission 'secretmanager.versions.access' denied for resource '" + nativeName + "' (or it may not exist).") return true;
    return typeof err.message === 'string' && (err.message.startsWith("Permission '" + permission + "' denied on resource")
      || err.message.startsWith(env.SERVICE_ACCOUNT + ' does not have ' + permission + ' access to '));
  }
  async function deniedRead(url, headers, permission, nativeName) {
    try { return await denied(await get(url, headers), permission, nativeName); } catch { return false; }
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
    check = env.PROBE_ROLE === 'app' ? 'secret-denial' : 'secret-read';
    const headers = { Authorization: 'Bearer ' + auth.access_token };
    const name = 'projects/' + env.PROJECT_NUMBER + '/secrets/' + env.SECRET_ID + '/versions/' + env.VERSION;
    const secretUrl = 'https://secretmanager.googleapis.com/v1/' + name + ':access';
    if (env.PROBE_ROLE === 'app') {
      const secretDenied = await deniedRead(secretUrl, headers, 'secretmanager.versions.access', name);
      check = 'object-denial';
      const objectUrl = 'https://storage.googleapis.com/storage/v1/b/' + env.BUCKET + '/o/' + encodeURIComponent(env.OBJECT)
        + '?alt=media&generation=' + env.GENERATION;
      const objectDenied = await deniedRead(objectUrl, headers, 'storage.objects.get');
      if (!secretDenied) check = 'secret-denial';
      return result(secretDenied && objectDenied);
    }
    if (env.PROBE_ROLE !== 'copy') return result(false);
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
