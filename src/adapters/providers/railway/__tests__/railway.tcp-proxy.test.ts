import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

function stubClient(adapter: RailwayAdapter, request: ReturnType<typeof vi.fn>): void {
  (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
}

describe('RailwayAdapter TCP proxy', () => {
  it('creates a TCP proxy when none exists for the application port', async () => {
    const request = vi.fn()
      // tcpProxies lookup — nothing yet
      .mockResolvedValueOnce({ tcpProxies: [] })
      // tcpProxyCreate
      .mockResolvedValueOnce({
        tcpProxyCreate: { id: 'proxy-1', domain: 'tramway.proxy.rlwy.net', proxyPort: 12345, applicationPort: 5432 },
      });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const result = await adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(result).toEqual({ domain: 'tramway.proxy.rlwy.net', proxyPort: 12345, created: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: { environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1', applicationPort: 5432 },
    });
  });

  it('reuses an existing proxy for the same application port without mutating', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      tcpProxies: [
        { id: 'proxy-other', domain: 'other.proxy.rlwy.net', proxyPort: 11111, applicationPort: 6379 },
        { id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 22222, applicationPort: 5432 },
      ],
    });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const result = await adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(result).toEqual({ domain: 'db.proxy.rlwy.net', proxyPort: 22222, created: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('surfaces Railway errors when proxy creation fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ tcpProxies: [] })
      .mockRejectedValueOnce(new Error('Not Authorized'));

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await expect(adapter.ensureTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).rejects.toThrow('Not Authorized');
  });

  it('getTcpProxy returns the matching proxy and never mutates', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
    });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const proxy = await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(proxy).toEqual({ id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('getTcpProxy returns null when no proxy matches the port or the query fails', async () => {
    const adapter = new RailwayAdapter();
    stubClient(adapter, vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ id: 'proxy-other', domain: 'other.proxy.rlwy.net', proxyPort: 11111, applicationPort: 6379 }],
    }));
    expect(await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).toBeNull();

    const failing = new RailwayAdapter();
    stubClient(failing, vi.fn().mockRejectedValueOnce(new Error('boom')));
    expect(await failing.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).toBeNull();
  });
});
