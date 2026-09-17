import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyClient } from '../fly.client.js';

// Synthetic transport responses reconstructed from the official Machines API
// examples: https://fly.io/docs/machines/api/volumes-resource/ (2026-09-17).
// They are not live recordings or a pinned-schema compatibility certification.
const volume = {
  id: 'vol_340088w293z35lp4', name: 'data', state: 'created', size_gb: 10,
  region: 'ord', zone: '84d3', encrypted: true, attached_machine_id: null,
  attached_alloc_id: null, created_at: '2023-11-27T21:47:06.837Z',
  blocks: 0, block_size: 0, blocks_free: 0, blocks_avail: 0, fstype: '',
  snapshot_retention: 5, auto_backup_enabled: true, host_dedication_key: '',
};

describe('Fly volume HTTP boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serializes an explicitly sized encrypted disk in the exact app scope', async () => {
    const fetchMock = vi.fn(async () => Response.json(volume));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new FlyClient('test-token', 'example-org').createVolume({
      appName: 'staging-web', name: 'data', region: 'ord', sizeGb: 10,
    });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/staging-web/volumes');
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({
      name: 'data', region: 'ord', size_gb: 10, encrypted: true,
    });
    expect(result.id).toBe(volume.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the exact returned disk id without substituting a name match', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => Response.json({ ...volume, id: 'vol_other' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new FlyClient('test-token', 'example-org').getVolume('staging-web', volume.id))
      .rejects.toThrow(/unexpected|instead|requested/i);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.machines.dev/v1/apps/staging-web/volumes/${volume.id}`
    );
  });

  it.each([403, 429, 500])('does not turn HTTP %s into absence', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unavailable' }, { status })));
    await expect(new FlyClient('test-token', 'example-org').getVolume('staging-web', volume.id))
      .rejects.toThrow(String(status));
  });

  it('returns absence only for an exact HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
    await expect(new FlyClient('test-token', 'example-org').getVolume('staging-web', volume.id))
      .resolves.toBeNull();
  });

  it.each([{}, [volume, volume], [{ ...volume, id: '' }]])(
    'rejects incomplete or duplicate list identities %#', async (body) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
      await expect(new FlyClient('test-token', 'example-org').listVolumes('staging-web'))
        .rejects.toThrow(/invalid|duplicate|identity/i);
    }
  );

  it('keeps differently scoped apps separate when disks share their logical name', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json([
      { ...volume, id: url.includes('staging-web') ? 'vol_staging' : 'vol_production' },
    ])));
    const client = new FlyClient('test-token', 'example-org');
    expect((await client.listVolumes('staging-web'))[0]?.id).toBe('vol_staging');
    expect((await client.listVolumes('production-web'))[0]?.id).toBe('vol_production');
  });

  it('retains ambiguous create failure without retrying or discovering by name', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('response lost'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new FlyClient('test-token', 'example-org').createVolume({
      appName: 'staging-web', name: 'data', region: 'ord', sizeGb: 10,
    })).rejects.toThrow('response lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not accept a create acknowledgement without a durable id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...volume, id: undefined })));
    await expect(new FlyClient('test-token', 'example-org').createVolume({
      appName: 'staging-web', name: 'data', region: 'ord', sizeGb: 10,
    })).rejects.toThrow(/durable.*ID/i);
  });
});
