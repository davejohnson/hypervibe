import { describe, expect, it } from 'vitest';
import { removeTransferLeftovers } from '../migration-transfer-gcp.js';

// #554: a copy job's temporary secrets hold source credentials. A copy is not finished,
// and nothing may build on it, while one of them could still exist.
const ok = () => new Response(null, { status: 200 });
const gone = () => new Response(null, { status: 404 });
const failing = () => new Response(null, { status: 503 });

describe('removing a copy job and its temporary source credentials', () => {
  it('reports nothing left when everything was deleted or already gone', async () => {
    expect(await removeTransferLeftovers({ deleteJob: async () => ok(), deleteSecret: async (id) => (id === 'tmp-a' ? ok() : gone()), secretIds: ['tmp-a', 'tmp-b'], retryMs: 1 })).toEqual([]);
  });
  it('retries a failed deletion before giving up', async () => {
    let attempts = 0;
    expect(await removeTransferLeftovers({ deleteJob: async () => ok(), deleteSecret: async () => (++attempts < 3 ? failing() : ok()), secretIds: ['tmp-a'], retryMs: 1 })).toEqual([]);
    expect(attempts).toBe(3);
  });
  it('names every secret and job that could not be confirmed deleted', async () => {
    const left = await removeTransferLeftovers({ deleteJob: async () => { throw new Error('network'); }, deleteSecret: async (id) => (id === 'tmp-a' ? failing() : ok()), secretIds: ['tmp-a', 'tmp-b'], retryMs: 1, jobId: 'hv-copy-1' });
    expect(left).toEqual(['secret tmp-a', 'job hv-copy-1']);
  });
});
