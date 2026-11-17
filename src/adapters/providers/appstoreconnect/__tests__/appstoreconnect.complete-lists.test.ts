import { describe, expect, it, vi } from 'vitest';
import { AppStoreConnectAdapter } from '../appstoreconnect.adapter.js';

// #291: App Store Connect pages its lists and returns links.next. An app, tester or
// capability on a later page exists; a first page alone cannot prove it is missing.
const ASC_API = 'https://api.appstoreconnect.apple.com/v1';
function paged(pages: Record<string, unknown>) {
  const adapter = new AppStoreConnectAdapter();
  const apiRequest = vi.fn(async (_method: string, path: string) => {
    const key = Object.keys(pages).find((candidate) => path === candidate || path === `${ASC_API}${candidate}` || path.startsWith(candidate.endsWith('?') ? candidate : `${candidate}\u0000`));
    if (!key) throw new Error(`unexpected ${path}`);
    return pages[key];
  });
  (adapter as unknown as { apiRequest: typeof apiRequest }).apiRequest = apiRequest;
  return { adapter, apiRequest };
}

describe('complete App Store Connect inventories', () => {
  it('finds an app that is on the second page', async () => {
    const first = '/apps?limit=200&fields[apps]=bundleId,name'; const second = `${ASC_API}/apps?cursor=p2&limit=200`;
    const { adapter } = paged({
      [first]: { data: [{ id: '1', attributes: { bundleId: 'com.example.one', name: 'One' } }], links: { next: second } },
      [second]: { data: [{ id: '2', attributes: { bundleId: 'com.example.two', name: 'Two' } }], links: {} },
    });
    expect(await adapter.findAppByBundleId('com.example.two')).toMatchObject({ id: '2' });
  });

  it('sees a capability that is on the second page', async () => {
    const first = '/bundleIds/B1/bundleIdCapabilities?limit=200'; const second = `${ASC_API}/bundleIds/B1/bundleIdCapabilities?cursor=p2&limit=200`;
    const { adapter } = paged({
      [first]: { data: [{ id: 'c1', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' } }], links: { next: second } },
      [second]: { data: [{ id: 'c2', attributes: { capabilityType: 'ASSOCIATED_DOMAINS' } }] },
    });
    expect((await adapter.getBundleIdCapabilities('B1')).map((capability) => capability.type)).toEqual(['PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS']);
  });

  it('finds a group member on the second page when the whole membership is asked for, and keeps display lists to one page', async () => {
    const pages = () => vi.fn(async (_method: string, path: string) => path.includes('cursor=p2')
      ? { data: [{ id: 't2', attributes: { email: 'late@example.com' } }] }
      : { data: [{ id: 't1', attributes: { email: 'early@example.com' } }], links: { next: `${ASC_API}/betaGroups/G1/betaTesters?cursor=p2&limit=200` } });
    const adapter = new AppStoreConnectAdapter(); const apiRequest = pages();
    (adapter as unknown as { apiRequest: typeof apiRequest }).apiRequest = apiRequest;
    expect((await adapter.listBetaTesters({ groupId: 'G1', complete: true })).map((tester) => tester.email)).toEqual(['early@example.com', 'late@example.com']);
    apiRequest.mockClear();
    expect(await adapter.listBetaTesters({ groupId: 'G1', limit: 200 })).toHaveLength(1);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses a next link that leaves the collection instead of following it', async () => {
    const { adapter } = paged({ '/apps?limit=200&fields[apps]=bundleId,name': { data: [], links: { next: `${ASC_API}/users?limit=200` } } });
    await expect(adapter.listApps()).rejects.toThrow(/pagination|unknown/i);
  });
});
