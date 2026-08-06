import { afterEach, describe, expect, it, vi } from 'vitest';
import { DopplerAdapter } from '../doppler.adapter.js';
import { VaultAdapter } from '../vault.adapter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('read-only secret manager requests', () => {
  it('builds a valid Vault KV v2 read URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { data: { API_KEY: 'secret' }, metadata: { version: 2 } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new VaultAdapter();
    await adapter.connect({ address: 'https://vault.example', token: 'token' });

    const result = await adapter.getSecret('secret/apps/prod', 'API_KEY');

    expect(result).toMatchObject({ value: 'secret', version: '2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/secret/data/apps/prod',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('uses a query delimiter for a Doppler service-token read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      secret: { name: 'API_KEY', value: { raw: 'secret', computed: 'secret' } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new DopplerAdapter();
    await adapter.connect({ token: 'dp.st.token' });

    const result = await adapter.getSecret('API_KEY');

    expect(result).toEqual({ value: 'secret' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.doppler.com/v3/configs/config/secret?name=API_KEY',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
