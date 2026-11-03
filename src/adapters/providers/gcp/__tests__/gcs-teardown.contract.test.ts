import { describe, expect, it } from 'vitest';
import { gcsTeardownFixture, bucketPath, expiresAt } from './gcs-teardown.fixture.js';

describe('GCS teardown native transport contract', () => {
  it('selects a noncurrent generation in the existing object deletion client', async () => {
    const f = await gcsTeardownFixture();
    const client = await f.adapter.openObjectTransfer(f.env, f.context, 'managed');
    await client.remove!('folder/backup #1.gz', { generation: '10', metageneration: '1' });
    expect(f.versions.map(value => value.generation)).toEqual(['20']);
    expect(f.retained.map(value => value.generation)).toEqual(['10']);
  });
  it('removes every paginated generation and records recoverable retention instead of claiming data erasure', async () => {
    const f = await gcsTeardownFixture();
    const result = await f.destroy();
    expect(result.success, result.error).toBe(true);
    expect(f.versions).toEqual([]);
    const deletes = f.calls.filter(call => call.method === 'DELETE');
    expect(deletes.filter(call => call.url.pathname.includes('/o/')).map(call => call.url.searchParams.get('generation'))).toEqual(['10', '20']);
    expect(deletes.at(-1)?.url.searchParams.get('ifMetagenerationMatch')).toBe('3');
    expect(result.message).toMatch(/recoverable|retained/i);
    expect(result.message).not.toMatch(/all objects|permanently deleted|erased/i);
    expect(result.data?.storageDeletion).toMatchObject({ provider: 'gcs', externalId: 'managed', activeState: 'absent',
      nativeIdentity: { generation: '101', projectNumber: '123456789' },
      retention: { state: 'recoverable', resources: expect.arrayContaining([
        expect.objectContaining({ kind: 'bucket', name: 'managed', generation: '101', hardDeleteTime: expiresAt }),
        expect.objectContaining({ kind: 'object', generation: '10', hardDeleteTime: expiresAt }),
        expect.objectContaining({ kind: 'object', generation: '20', hardDeleteTime: expiresAt }),
      ]) } });
    expect(f.calls.some(call => call.url.searchParams.get('alt') === 'media')).toBe(false);
  });

  it.each(['versions-denied', 'versions-malformed', 'versions-token-loop', 'retention-denied', 'retention-malformed',
    'retention-unavailable', 'changed-bucket', 'wrong-project', 'versions-second-page-denied',
    'retention-second-page-denied'] as const)('does not mutate after %s', async fault => {
    const f = await gcsTeardownFixture({ fault });
    expect((await f.destroy()).success).toBe(false);
    expect(f.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  it.each(['changed-object', 'concurrent-write', 'bucket-delete-denied', 'bucket-retention-denied',
    'bucket-retention-malformed', 'bucket-delete-uncertain', 'retention-after-delete-denied'] as const)('does not report completion after %s or replay its deletion', async fault => {
    const f = await gcsTeardownFixture({ fault });
    const result = await f.destroy();
    expect(result.success).toBe(false);
    expect(f.calls.filter(call => call.method === 'DELETE' && call.url.pathname === bucketPath).length).toBeLessThanOrEqual(1);
    expect(f.calls.some(call => call.method === 'DELETE' && call.url.searchParams.get('generation') === '99')).toBe(false);
    if (fault === 'changed-object' || fault === 'concurrent-write') {
      expect(f.calls.filter(call => call.method === 'DELETE' && call.url.pathname === bucketPath)).toEqual([]);
    }
  });
});
