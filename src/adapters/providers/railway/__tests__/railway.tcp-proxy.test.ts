import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

// Complete synthetic records for fields required by the pinned official SDL.
const proxyScope = { environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1', syncStatus: 'ACTIVE', deletedAt: null };

function stubClient(adapter: RailwayAdapter, request: ReturnType<typeof vi.fn>): void {
  (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };
}

describe('RailwayAdapter existing TCP proxy observation and legacy cleanup', () => {
  const environment = {
    id: 'env-local-1',
    projectId: 'project-local-1',
    name: 'production',
    platformBindings: { projectId: 'rail-proj-1', environmentId: 'rail-env-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const component = {
    id: 'component-1',
    environmentId: 'env-local-1',
    type: 'postgres' as const,
    externalId: 'rail-svc-db-1',
    bindings: { provider: 'railway', projectId: 'rail-proj-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('getTcpProxy returns the matching proxy and never mutates', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
    });

    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    const proxy = await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432);

    expect(proxy).toEqual({ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('getTcpProxy returns null when no proxy matches the port', async () => {
    const adapter = new RailwayAdapter();
    stubClient(adapter, vi.fn().mockResolvedValueOnce({
      tcpProxies: [{ ...proxyScope, id: 'proxy-other', domain: 'other.proxy.rlwy.net', proxyPort: 11111, applicationPort: 6379 }],
    }));
    expect(await adapter.getTcpProxy('rail-env-1', 'rail-svc-db-1', 5432)).toBeNull();
  });

  it('deletes a TCP proxy and verifies that it is no longer active', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: true })
      .mockResolvedValueOnce({ tcpProxies: [] });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
    expect(request.mock.calls[1]?.[1]).toEqual({ id: 'proxy-pg' });
    expect(request.mock.calls[2]?.[1]).toEqual({ environmentId: 'rail-env-1', serviceId: 'rail-svc-db-1' });
  });

  it('treats an already absent TCP proxy as successfully deleted', async () => {
    const request = vi.fn().mockResolvedValue({ tcpProxies: [] });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');
    await adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[1]?.environmentId === 'rail-env-1')).toBe(true);
  });

  it('fails cleanup when Railway does not confirm TCP proxy deletion', async () => {
    const adapter = new RailwayAdapter();
    stubClient(adapter, vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: false })
      .mockResolvedValueOnce({
        tcpProxies: [{ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      }));

    await expect(adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg'))
      .rejects.toThrow('did not confirm deletion');
  });

  it('waits for actual absence after observing a deleting proxy', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        tcpProxies: [{ ...proxyScope, id: 'proxy-pg', domain: 'db.proxy.rlwy.net', proxyPort: 33333, applicationPort: 5432 }],
      })
      .mockResolvedValueOnce({ tcpProxyDelete: true })
      .mockResolvedValueOnce({
        tcpProxies: [{
          ...proxyScope,
          id: 'proxy-pg',
          domain: 'db.proxy.rlwy.net',
          proxyPort: 33333,
          applicationPort: 5432,
          syncStatus: 'DELETING',
        }],
      })
      .mockResolvedValueOnce({ tcpProxies: [] });
    const adapter = new RailwayAdapter();
    stubClient(adapter, request);

    await expect(adapter.deleteTcpProxy('rail-env-1', 'rail-svc-db-1', 'proxy-pg')).resolves.toBeUndefined();
  });

  it('does not advertise or expose public proxy creation', () => {
    const adapter = new RailwayAdapter();
    expect(adapter.capabilities.supportsTemporaryDatabaseAccess).toBe(false);
    expect('ensureTcpProxy' in adapter).toBe(false);
    expect('acquireTemporaryDatabaseAccess' in adapter).toBe(false);
  });

  it('retains exact cleanup for an owned lease created by an older version', async () => {
    const adapter = new RailwayAdapter();
    const remove = vi.spyOn(adapter, 'deleteTcpProxy').mockResolvedValue();
    await adapter.releaseTemporaryDatabaseAccess(environment, component, {
      connectionUrl: 'postgresql://postgres:synthetic@legacy.proxy.rlwy.net:23456/app',
      source: 'created_proxy', temporary: true, releaseToken: 'legacy-owned-proxy',
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith('rail-env-1', 'rail-svc-db-1', 'legacy-owned-proxy');
  });

  it('never deletes an existing user-owned endpoint during release', async () => {
    const adapter = new RailwayAdapter();
    const remove = vi.spyOn(adapter, 'deleteTcpProxy').mockResolvedValue();
    await adapter.releaseTemporaryDatabaseAccess(environment, component, {
      connectionUrl: 'postgresql://postgres:synthetic@existing.proxy.rlwy.net:23456/app',
      source: 'existing_proxy', temporary: false,
    });
    expect(remove).not.toHaveBeenCalled();
  });

});
