import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProbeCreateRejected, transferProbeFixtures } from '../gcp-transfer-probe-fixtures.js';
import { transferSlot } from '../tofu/transfer-slot.js';

// Synthetic responses from Google's documented SecretVersion resource and Storage JSON object operations.
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/destroy
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete
// https://docs.cloud.google.com/storage/docs/json_api/v1/status-codes
// https://google.aip.dev/193
// https://docs.cloud.google.com/apis/docs/system-parameters
// https://docs.cloud.google.com/secret-manager/docs/audit-logging
// https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list
// https://docs.cloud.google.com/logging/docs/view/logging-query-language
const target = { projectId: 'staging-transfer', sourceEnvironmentId: 'src', sourceRailwayProjectId: 'rp',
  sourceRailwayEnvironmentId: 're', targetRegion: 'us-central1', targetEnvironmentId: 'dst' };
const scope = { target, targetEnvironmentName: 'stage é', projectNumber: '123456789', copyUniqueId: '879',
  runtimeEmail: 'runtime@staging-transfer.iam.gserviceaccount.com', runtimeUniqueId: '988',
  bucket: 'staging-transfer-hv-build-source', bucketTimeCreated: '2026-01-01T00:00:00Z',
  secretCreateTime: '2026-03-01T00:00:00Z' };
const id = '01f3e890-3bf6-49ef-a792-acb586e43acd';
const fixtures = () => transferProbeFixtures('operator', scope, id);
const marker = 'ab'.repeat(32);
const reason = 'Hypervibe probe ' + createHash('sha256').update(JSON.stringify(['AddSecretVersion', id, marker])).digest('hex');
const logName = 'projects/' + target.projectId + '/logs/cloudaudit.googleapis.com%2Factivity';
const object = { bucket: scope.bucket, name: 'migrations/stage é/hypervibe-access-probe-' + id, generation: '1892314555000123' };
const secretName = 'projects/' + scope.projectNumber + '/secrets/' + transferSlot(target).secretId;
const version = { name: secretName + '/versions/12', createTime: '2026-03-01T02:11:43.989Z', state: 'ENABLED', etag: '"161477e6071da9"' };
const proof = { name: version.name, createTime: version.createTime, etag: version.etag, secretCreateTime: scope.secretCreateTime, projectNumber: scope.projectNumber };
const audit = { logName, timestamp: '2026-03-01T02:11:44.001Z', insertId: 'audit-event-123' };
const tombstone = { ...version, state: 'DESTROYED', etag: '"161477e6071dc3"' };
const parent = { name: secretName, createTime: scope.secretCreateTime };
const bucketPath = '/storage/v1/b/' + scope.bucket;
const bucket = { name: scope.bucket, projectNumber: scope.projectNumber, timeCreated: scope.bucketTimeCreated };
const live = { ...object, size: '64', md5Hash: createHash('md5').update(marker).digest('base64') };
const objectPath = '/storage/v1/b/' + scope.bucket + '/o/' + encodeURIComponent(object.name);
const secretPath = '/v1/' + secretName;
const versionPath = '/v1/' + version.name;
const sig = 'c0'.repeat(256);
const signed = 'https://storage.googleapis.com/' + scope.bucket + '/migrations/stage%20%C3%A9/hypervibe-access-probe-' + id
  + '?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=signer%40example.com%2F20261120%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261120T120000Z'
  + '&X-Goog-Expires=600&X-Goog-SignedHeaders=host&generation=' + object.generation + '&X-Goog-Signature=' + sig;
type Handler = (url: URL, init: RequestInit) => Response;
function transport(handle: Handler) {
  const mock = vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe(url.pathname === '/v2/entries:list' ? 'logging.googleapis.com' : url.pathname.startsWith('/v1/') ? 'secretmanager.googleapis.com' : 'storage.googleapis.com');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer operator');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return handle(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('bounded migration access probe fixtures', () => {
  it('creates only a new object, reads its exact bytes and deletes only its recorded generation', async () => {
    const mock = transport((url, init) => {
      if (url.pathname === bucketPath) return Response.json(bucket);
      if (init.method === 'POST') {
        expect(url.pathname).toBe('/upload/storage/v1/b/' + scope.bucket + '/o');
        expect(url.searchParams.get('name')).toBe(object.name);
        expect(url.searchParams.get('ifGenerationMatch')).toBe('0');
        expect(url.searchParams.get('uploadType')).toBe('media');
        expect(init.body).toBe(marker);
        return Response.json(object);
      }
      expect(url.searchParams.get('generation')).toBe(object.generation);
      expect(url.searchParams.get('ifGenerationMatch')).toBe(object.generation);
      if (url.searchParams.get('alt') === 'media') {
        expect(url.pathname).toBe('/download' + objectPath);
        return new Response(marker);
      }
      expect(url.pathname).toBe(objectPath);
      return new Response(null, { status: init.method === 'DELETE' ? 204 : 404 });
    });
    const api = fixtures();
    expect(api.objectName).toBe(object.name);
    expect(api.secretName).toBe(secretName);
    const captured = await api.createObject(marker);
    expect(captured).toEqual(object);
    await api.readObject(captured, marker);
    await api.deleteObject(captured);
    expect(mock).toHaveBeenCalledTimes(6);
  });

  it('checks the original bucket, original secret and exact unused test name during preview', async () => {
    let found = false;
    const mock = transport((url, init) => {
      expect(init.method ?? 'GET').toBe('GET');
      if (url.pathname === bucketPath) return Response.json(bucket);
      if (url.pathname === secretPath) return Response.json(parent);
      expect(url.pathname).toBe(objectPath);
      expect(url.searchParams.has('alt')).toBe(false);
      return found ? Response.json(live) : new Response(null, { status: 404 });
    });
    await fixtures().assertReady();
    expect(mock).toHaveBeenCalledTimes(3);
    found = true;
    await expect(fixtures().assertReady()).rejects.toThrow();
  });

  it('recovers a lost upload response only from the original bucket and matching pinned marker bytes', async () => {
    let observed: unknown = live;
    let payload = marker;
    const mock = transport((url, init) => {
      expect(init.method ?? 'GET').toBe('GET');
      if (url.pathname === bucketPath) return Response.json(bucket);
      if (url.searchParams.has('alt')) {
        expect(url.pathname).toBe('/download' + objectPath);
        expect(url.searchParams.get('generation')).toBe(object.generation);
        return new Response(payload);
      }
      expect(url.pathname).toBe(objectPath);
      return observed ? Response.json(observed) : new Response(null, { status: 404 });
    });
    expect(await fixtures().recoverObject(marker)).toEqual(object);
    payload = '0'.repeat(64);
    await expect(fixtures().recoverObject(marker)).rejects.toThrow();
    for (const mismatch of [{ ...live, generation: 'latest' }, { ...live, md5Hash: 'mismatch' }, { ...live, size: '9999' }]) {
      observed = mismatch;
      mock.mockClear();
      await expect(fixtures().recoverObject(marker)).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(2); // no reads of unrelated object bytes
    }
    observed = null;
    expect(await fixtures().recoverObject(marker)).toBeNull();
  });

  it('refuses to delete or recover objects in a recreated bucket', async () => {
    const mock = transport(() => Response.json({ ...bucket, timeCreated: version.createTime }));
    await expect(fixtures().recoverObject(marker)).rejects.toThrow();
    await expect(fixtures().deleteObject(object)).rejects.toThrow();
    expect(mock.mock.calls.every(([url, init]) => new URL(url).pathname === bucketPath && !init.method)).toBe(true);
  });

  it('adds one synthetic secret payload, destroys by captured etag, and independently reads back its exact identity', async () => {
    let destroyed = false;
    const mock = transport((url, init) => {
      if (url.pathname === secretPath) return Response.json(parent);
      if (url.pathname === secretPath + ':addVersion') {
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('X-Goog-Request-Reason')).toBe(reason);
        const body = JSON.parse(String(init.body));
        expect(JSON.parse(Buffer.from(body.payload.data, 'base64').toString())).toEqual({ marker, url: signed });
        return Response.json(version);
      }
      if (url.pathname === versionPath + ':destroy') {
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ etag: version.etag });
        destroyed = true;
        return Response.json(tombstone);
      }
      expect(url.pathname).toBe(versionPath);
      return Response.json(destroyed ? tombstone : version);
    });
    const api = fixtures();
    const captured = await api.addVersion(marker, signed, object);
    expect(captured).toEqual(proof);
    expect(await api.destroyVersion(captured)).toEqual({ name: version.name, createTime: version.createTime,
      state: 'DESTROYED', projectNumber: scope.projectNumber, secretCreateTime: scope.secretCreateTime });
    expect(mock.mock.calls.at(-1)?.[0].toString()).toContain(versionPath + '?');
  });

  it.each([new Response(null, { status: 412 }), Response.json({ ...object, name: 'someone-elses-object' }), Response.json({ ...object, generation: 'latest' })])
  ('does not adopt a collision or malformed creation response', async response => {
    const mock = transport(url => url.pathname === bucketPath ? Response.json(bucket) : response);
    await expect(fixtures().createObject(marker)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each([signed.replace('storage.googleapis.com', 'example.com'), signed.replace('hypervibe-access-probe', 'elsewhere'),
    signed.replace(object.generation, '1'), signed.replace('Expires=600', 'Expires=901'), signed + '&generation=2', signed + '#secret'])
  ('requires the exact short-lived signed fixture URL', async url => {
    const mock = transport(() => { throw Error('unexpected network access'); });
    await expect(fixtures().addVersion(marker, url, object)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses to read or clean up arbitrary caller-specified names and generations', async () => {
    const mock = transport(() => { throw Error('unexpected network access'); });
    await expect(fixtures().readObject({ ...object, name: 'unrelated' }, marker)).rejects.toThrow();
    await expect(fixtures().deleteObject({ ...object, bucket: 'other' })).rejects.toThrow();
    await expect(fixtures().deleteObject({ ...object, generation: 'latest' })).rejects.toThrow();
    await expect(fixtures().destroyVersion({ ...proof, name: 'projects/999/secrets/unrelated/versions/12' })).rejects.toThrow();
    await expect(fixtures().destroyVersion({ ...proof, name: secretName + '/versions/latest' })).rejects.toThrow();
    await expect(fixtures().destroyVersion({ ...proof, secretCreateTime: '2026-01-01T00:00:00Z' })).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it('fails closed on changed object contents, oversized reads and unverified cleanup', async () => {
    for (const bytes of ['0'.repeat(64), marker + 'x']) {
      transport(() => new Response(bytes));
      await expect(fixtures().readObject(object, marker)).rejects.toThrow();
    }
    transport((url, init) => url.pathname === bucketPath ? Response.json(bucket) : init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(object));
    await expect(fixtures().deleteObject(object)).rejects.toThrow();
  });

  it.each(['object', 'version'] as const)('journals only an actual %s create dispatch', async kind => {
    const events: string[] = [];
    let ready = false;
    const create = (beforeDispatch: () => void) => kind === 'object' ? fixtures().createObject(marker, beforeDispatch)
      : fixtures().addVersion(marker, signed, object, beforeDispatch);
    transport((_url, init) => {
      events.push(init.method ?? 'GET');
      if (init.method === 'POST') throw Error('connection closed');
      return ready ? Response.json(kind === 'object' ? bucket : parent) : new Response(null, { status: 503 });
    });
    await expect(create(() => events.push('journal'))).rejects.toThrow();
    expect(events).toEqual(['GET']);

    ready = true;
    events.length = 0;
    await expect(create(() => { events.push('journal'); throw Error('disk full'); })).rejects.toThrow();
    expect(events).toEqual(['GET', 'journal']);

    events.length = 0;
    const lost = await create(() => events.push('journal')).catch(error => error);
    expect(lost).toBeInstanceOf(Error);
    expect(lost).not.toBeInstanceOf(ProbeCreateRejected);
    expect(events).toEqual(['GET', 'journal', 'POST']);
  });

  it('never selects a version after an ambiguous add; errors omit payloads and provider text', async () => {
    for (const answer of [() => { throw Error(signed + marker); }, () => Response.json({ message: signed + marker }, { status: 429 }),
      () => Response.json({ ...version, name: secretName + '/versions/latest' })]) {
      const mock = transport(url => url.pathname === secretPath ? Response.json(parent) : answer());
      const error = await fixtures().addVersion(marker, signed, object).catch((e: Error) => e.message);
      expect(typeof error).toBe('string');
      expect(error).not.toContain(sig);
      expect(error).not.toContain(marker);
      expect(mock).toHaveBeenCalledTimes(2);
    }
  });

  // Google's partial response cannot traverse an Any. Filter the audit payload entirely on
  // Google's side, and return only these top-level LogEntry fields, even on recovery.
  it('recovers only a numbered native version bound by the exact provider event and private reason', async () => {
    const other = { ...version, name: secretName + '/versions/3' };
    const mock = transport((url, init) => {
      if (url.pathname === secretPath) return Response.json(parent);
      if (url.pathname === versionPath) return Response.json(version);
      if (url.pathname === secretPath + '/versions') {
        expect(url.searchParams.get('fields')).toBe('versions(name,createTime),nextPageToken');
        expect(url.searchParams.get('filter')).toContain('create_time');
        return Response.json({ versions: [version, other].map(({ name, createTime }) => ({ name, createTime })) });
      }
      expect(url.pathname).toBe('/v2/entries:list');
      expect(url.searchParams.get('fields')).toBe('entries(insertId,timestamp,logName),nextPageToken');
      expect(new Headers(init.headers).get('X-Goog-User-Project')).toBe(target.projectId);
      const body = JSON.parse(String(init.body));
      expect(body.resourceNames).toEqual(['projects/' + target.projectId]);
      expect(body.pageSize).toBe(2);
      const filter = body.filter as string;
      for (const required of [logName, reason, 'protoPayload.requestMetadata.requestAttributes.reason', secretName,
        'google.cloud.secretmanager.v1.SecretManagerService.AddSecretVersion', 'secretmanager.googleapis.com',
        'protoPayload.status.code=0']) expect(filter).toContain(required);
      expect(filter).not.toContain(marker);
      if (!filter.includes('insertId=')) return Response.json(body.pageToken ? { entries: [audit] } : { nextPageToken: 'next' });
      expect(filter).toContain(audit.insertId);
      expect(filter).toContain(audit.timestamp);
      if (filter.includes(other.name)) return Response.json({});
      for (const term of ['protoPayload.resourceName', 'protoPayload.response.name', 'protoPayload.response.createTime', version.name, version.createTime]) expect(filter).toContain(term);
      return Response.json({ entries: [audit] });
    });
    expect(await fixtures().recoverVersion(marker)).toEqual(proof);
    expect(mock.mock.calls.every(([url]) => !String(url).includes(':access'))).toBe(true);
  });

  it.each(['no event', 'duplicate event', 'repeated page', 'event too old', 'wrong log', 'no version in audit',
    'conflicting version match', 'unrelated event', 'changed version creation', 'unrelated native name', 'incomplete inventory'])
  ('refuses version recovery for %s', async scenario => {
    const candidate = { name: version.name, createTime: version.createTime };
    const mock = transport((url, init) => {
      if (url.pathname === secretPath) return Response.json(parent);
      if (url.pathname === versionPath) return Response.json({ ...version,
        ...(scenario === 'changed version creation' ? { createTime: scope.secretCreateTime } : {}) });
      if (url.pathname === secretPath + '/versions') {
        const versions = scenario === 'conflicting version match' ? [candidate, { ...candidate, name: candidate.name + '1' }]
          : [{ ...candidate, ...(scenario === 'unrelated native name' ? { name: 'projects/99/secrets/other/versions/1' } : {}) }];
        return Response.json({ versions, ...(scenario === 'incomplete inventory' ? { nextPageToken: 'more' } : {}) });
      }
      if (JSON.parse(String(init.body)).filter.includes('insertId=')) {
        if (scenario === 'no version in audit') return Response.json({});
        return Response.json({ entries: [{ ...audit, ...(scenario === 'unrelated event' ? { insertId: 'other' } : {}) }] });
      }
      if (scenario === 'no event') return Response.json({});
      if (scenario === 'repeated page') return Response.json({ nextPageToken: 'again' });
      if (scenario === 'duplicate event') return Response.json({ entries: [audit, audit] });
      return Response.json({ entries: [{ ...audit, ...(scenario === 'wrong log' ? { logName: 'wrong' } :
        scenario === 'event too old' ? { timestamp: '2025-01-01T00:00:00Z' } : {}) }] });
    });
    await expect(fixtures().recoverVersion(marker)).rejects.toThrow();
    expect(mock.mock.calls.every(([url]) => !/:(?:access|destroy|addVersion)/.test(String(url)))).toBe(true);
  });

  it.each([
    ['object', 412, { errors: [{ reason: 'conditionNotMet' }] }, true],
    ['object', 403, { errors: [{ reason: 'forbidden' }] }, true],
    ['version', 403, { status: 'PERMISSION_DENIED' }, true],
    ['version', 404, { status: 'NOT_FOUND' }, true],
    ['version', 400, { status: 'INVALID_ARGUMENT' }, true],
    ['version', 429, { status: 'RESOURCE_EXHAUSTED' }, false],
    ['object', 500, { errors: [{ reason: 'backendError' }] }, false],
    ['version', 403, {}, false],
  ] as const)('recognizes only definite synchronous %s create rejection at HTTP %s', async (resource, code, envelope, definite) => {
    transport((url, init) => init.method === 'POST'
      ? Response.json({ error: { message: marker, code, ...envelope } }, { status: code })
      : Response.json(url.pathname === secretPath ? parent : bucket));
    const api = fixtures();
    const error = await (resource === 'object' ? api.createObject(marker) : api.addVersion(marker, signed, object)).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ProbeCreateRejected).toBe(definite);
    if (definite) expect(error.resource).toBe(resource);
    expect(error.message).not.toContain(marker);
  });

  it.each([{ ...version, createTime: parent.createTime }, { ...version, etag: 'another' }, { ...version, state: 'DISABLED' },
    { ...version, name: secretName + '/versions/11' }])('does not destroy a version that changed', async observed => {
    const mock = transport(url => Response.json(url.pathname === secretPath ? parent : observed));
    await expect(fixtures().destroyVersion(proof)).rejects.toThrow();
    expect(mock.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });

  it('requires final native destruction even after Google accepted the destroy request', async () => {
    transport((url) => Response.json(url.pathname === secretPath ? parent : url.pathname.endsWith(':destroy') ? tombstone : version));
    await expect(fixtures().destroyVersion(proof)).rejects.toThrow();
  });

  it('does not add a version to a recreated secret or one with delayed destruction', async () => {
    for (const metadata of [{ ...parent, createTime: version.createTime }, { ...parent, versionDestroyTtl: '86400s' }]) {
      const mock = transport(() => Response.json(metadata));
      await expect(fixtures().addVersion(marker, signed, object)).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
});
