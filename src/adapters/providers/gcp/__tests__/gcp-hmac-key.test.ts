import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishNewHmacKey, retireStorageHmacKey } from '../gcp-hmac-key.js';

// #555: an HMAC key's secret is shown once. A key that was created but not fully
// stored must be deleted, or remembered until it is, never left active and unknown.
afterEach(() => vi.unstubAllGlobals());
const created = () => Response.json({ secret: 's3-secret', metadata: { accessId: 'GOOG1EXAMPLE' } });

function harness(options: { publish?: string; retire?: boolean; pending?: string[] } = {}) {
  const pending = [...(options.pending ?? [])]; const retired: string[] = []; let creates = 0;
  return { pending, retired, creates: () => creates, run: () => publishNewHmacKey({
    create: async () => { creates++; return created(); },
    publish: async () => options.publish,
    retire: async (accessId) => { retired.push(accessId); return options.retire ?? true; },
    pending: { list: () => [...pending], add: (id) => { pending.push(id); }, remove: (id) => { pending.splice(pending.indexOf(id), 1); } },
  }) };
}

describe('publishing a new storage access key', () => {
  it('leaves nothing pending when both halves are stored', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ ok: true });
    expect(h.pending).toEqual([]); expect(h.retired).toEqual([]);
  });
  it('deletes the exact new key when storing it fails', async () => {
    const h = harness({ publish: 'Secret Manager refused the write.' });
    expect(await h.run()).toMatchObject({ ok: false, message: expect.stringMatching(/new key was deleted/) });
    expect(h.retired).toEqual(['GOOG1EXAMPLE']); expect(h.pending).toEqual([]);
  });
  it('remembers the key when it cannot be deleted, and deletes it before making another', async () => {
    const failed = harness({ publish: 'Secret Manager refused the write.', retire: false });
    expect(await failed.run()).toMatchObject({ ok: false });
    expect(failed.pending).toEqual(['GOOG1EXAMPLE']);

    const stuck = harness({ pending: ['GOOG1EXAMPLE'], retire: false });
    expect(await stuck.run()).toMatchObject({ ok: false, message: expect.stringMatching(/no new key was created/) });
    expect(stuck.creates()).toBe(0);

    const retry = harness({ pending: ['GOOG1EXAMPLE'] });
    expect(await retry.run()).toEqual({ ok: true });
    expect(retry.retired).toEqual(['GOOG1EXAMPLE']); expect(retry.pending).toEqual([]);
  });
});

describe('deleting a storage access key', () => {
  // Cloud Storage refuses to delete an ACTIVE key: deactivate (PUT state INACTIVE), then DELETE.
  it('deactivates, then deletes, the exact key', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; body?: string }) => { calls.push(`${init.method} ${url} ${init.body ?? ''}`.trim()); return new Response(init.method === 'DELETE' ? null : '{}', { status: init.method === 'DELETE' ? 204 : 200 }); }));
    expect(await retireStorageHmacKey('t', 'demo', 'GOOG1EXAMPLE')).toBe(true);
    expect(calls).toEqual([
      'PUT https://storage.googleapis.com/storage/v1/projects/demo/hmacKeys/GOOG1EXAMPLE {"state":"INACTIVE"}',
      'DELETE https://storage.googleapis.com/storage/v1/projects/demo/hmacKeys/GOOG1EXAMPLE',
    ]);
  });
  it('counts an already-missing key as gone and any other failure as not deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await retireStorageHmacKey('t', 'demo', 'GOOG1EXAMPLE')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await retireStorageHmacKey('t', 'demo', 'GOOG1EXAMPLE')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await retireStorageHmacKey('t', 'demo', 'GOOG1EXAMPLE')).toBe(false);
  });
});
