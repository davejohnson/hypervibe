import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSecretVersion, listSecretIds, readSecretContainer } from '../gcp-secret-manager.client.js';

afterEach(() => { vi.unstubAllGlobals(); });

// Reconstructed public fields of Secret Manager v1 `projects.secrets.get`,
// `projects.secrets.versions.get` and `projects.secrets.list`; only fetch is replaced.
const base = 'https://secretmanager.googleapis.com/v1/projects/demo/secrets';
function respond(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const route = routes[String(url)];
    if (!route) throw new Error(`Unexpected request ${String(url)}`);
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status });
  }));
  return calls;
}

describe('Secret Manager client', () => {
  it('keeps present, absent and unknown distinct', async () => {
    respond({ [`${base}/gone`]: { status: 404 }, [`${base}/denied`]: { status: 403 } });
    expect(await readSecretContainer('t', 'demo', 'gone')).toEqual({ state: 'absent' });
    expect(await readSecretContainer('t', 'demo', 'denied')).toEqual({ state: 'unknown', reason: 'Secret Manager returned HTTP 403 for denied.' });
  });

  it('reports a container without versions, and an enabled latest version by its exact name', async () => {
    respond({
      [`${base}/empty`]: { status: 200, body: { name: 'projects/1/secrets/empty', labels: { 'managed-by': 'hypervibe' } } },
      [`${base}/empty/versions/latest`]: { status: 404 },
      [`${base}/full`]: { status: 200, body: { name: 'projects/1/secrets/full' } },
      [`${base}/full/versions/latest`]: { status: 200, body: { name: 'projects/1/secrets/full/versions/7', state: 'ENABLED' } },
    });
    expect(await readSecretContainer('t', 'demo', 'empty')).toEqual({ state: 'present',
      value: { resourceName: 'projects/1/secrets/empty', labels: { 'managed-by': 'hypervibe' }, hasVersion: false, hasEnabledVersion: false } });
    expect(await readSecretContainer('t', 'demo', 'full')).toEqual({ state: 'present',
      value: { resourceName: 'projects/1/secrets/full', labels: {}, hasVersion: true, hasEnabledVersion: true, latestVersionName: '7' } });
  });

  it('does not accept a version that belongs to a different secret', async () => {
    respond({
      [`${base}/mine`]: { status: 200, body: { name: 'projects/1/secrets/mine' } },
      [`${base}/mine/versions/latest`]: { status: 200, body: { name: 'projects/1/secrets/other/versions/1', state: 'ENABLED' } },
    });
    expect(await readSecretContainer('t', 'demo', 'mine')).toMatchObject({ state: 'unknown' });
  });

  it('lists every page and reports an incomplete listing as unknown', async () => {
    const filter = encodeURIComponent('labels.managed-by=hypervibe');
    respond({
      [`${base}?filter=${filter}&pageSize=100`]: { status: 200, body: { secrets: [{ name: 'projects/1/secrets/b' }], nextPageToken: 'next' } },
      [`${base}?filter=${filter}&pageSize=100&pageToken=next`]: { status: 200, body: { secrets: [{ name: 'projects/1/secrets/a' }] } },
    });
    expect(await listSecretIds('t', 'demo', 'labels.managed-by=hypervibe')).toEqual({ state: 'present', value: ['a', 'b'] });
    respond({ [`${base}?filter=${filter}&pageSize=100`]: { status: 500 } });
    expect(await listSecretIds('t', 'demo', 'labels.managed-by=hypervibe')).toMatchObject({ state: 'unknown' });
  });

  it('writes a value once, base64-encoded, and never in the URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await addSecretVersion('t', 'demo', 'key', 'plain-value');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${base}/key:addVersion`);
    expect(url).not.toContain('plain-value');
    expect(JSON.parse(String(init.body))).toEqual({ payload: { data: Buffer.from('plain-value').toString('base64') } });
  });
});
