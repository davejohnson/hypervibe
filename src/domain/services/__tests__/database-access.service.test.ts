import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { IProviderAdapter, TemporaryDatabaseAccess } from '../../ports/provider.port.js';
import { DatabaseAccessLeaseCoordinator } from '../database-access.service.js';

const environment = {
  id: 'env-1',
  projectId: 'project-1',
  name: 'production',
  platformBindings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} as Environment;

const component = {
  id: 'component-1',
  environmentId: 'env-1',
  type: 'postgres',
  externalId: 'database-1',
  bindings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
} as Component;

const temporaryAccess: TemporaryDatabaseAccess = {
  connectionUrl: 'postgresql://user:secret@temporary.example.com:5432/app',
  source: 'created_proxy',
  temporary: true,
  endpoint: 'temporary.example.com:5432',
  releaseToken: 'proxy-1',
};

const coordinators: DatabaseAccessLeaseCoordinator[] = [];

function setup() {
  const coordinator = new DatabaseAccessLeaseCoordinator();
  coordinators.push(coordinator);
  const create = vi.fn().mockResolvedValue(temporaryAccess);
  const release = vi.fn().mockResolvedValue(undefined);
  const adapter = {
    capabilities: { supportsTemporaryDatabaseAccess: true },
    releaseTemporaryDatabaseAccess: release,
  } as unknown as IProviderAdapter;
  const acquire = () => coordinator.acquire({
    key: 'railway:env-1:component-1:5432',
    provider: 'railway',
    adapter,
    environment,
    component,
    create,
  });
  return { coordinator, create, release, adapter, acquire };
}

afterEach(() => {
  for (const coordinator of coordinators) coordinator.resetForTests();
  coordinators.length = 0;
  vi.useRealTimers();
});

describe('DatabaseAccessLeaseCoordinator', () => {
  it('shares one temporary provider resource across concurrent queries and cleans up after the final release', async () => {
    const { acquire, create, release } = setup();

    const [first, second] = await Promise.all([acquire(), acquire()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.id).toBe(second.id);
    expect([first.createdByInvocation, second.createdByInvocation].sort()).toEqual([false, true]);
    await expect(first.release()).resolves.toMatchObject({ status: 'deferred', safeResourceId: 'proxy-1' });
    expect(release).not.toHaveBeenCalled();
    await expect(second.release()).resolves.toMatchObject({ status: 'completed', safeResourceId: 'proxy-1' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('makes release idempotent for each query invocation', async () => {
    const { acquire, release } = setup();
    const lease = await acquire();

    const first = await lease.release();
    const second = await lease.release();

    expect(first).toEqual(second);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never exposes the temporary connection URL through lease metadata', async () => {
    const { acquire } = setup();
    const lease = await acquire();

    expect(JSON.stringify(lease)).not.toContain('temporary.example.com');
    expect(JSON.stringify(lease)).not.toContain('secret');
    await expect(lease.withConnection(async (url) => url.includes('temporary.example.com'))).resolves.toBe(true);
    await lease.release();
  });

  it('does not register or clean up access that already existed', async () => {
    const { coordinator, adapter, release } = setup();
    const lease = await coordinator.acquire({
      key: 'railway:env-1:component-1:5432',
      provider: 'railway',
      adapter,
      environment,
      component,
      create: vi.fn().mockResolvedValue({ ...temporaryAccess, source: 'existing_proxy', temporary: false }),
    });

    expect(coordinator.activeLeaseCount()).toBe(0);
    await expect(lease.release()).resolves.toEqual({ status: 'no_op' });
    expect(release).not.toHaveBeenCalled();
  });

  it('registers failed cleanup and retries it before creating access again', async () => {
    const { coordinator, acquire, create, release } = setup();
    release
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockRejectedValueOnce(new Error('cleanup failed'));
    const first = await acquire();

    await expect(first.release()).resolves.toMatchObject({ status: 'failed', safeResourceId: 'proxy-1' });
    expect(coordinator.activeLeaseCount()).toBe(1);

    const second = await acquire();
    expect(create).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(4);
    await expect(second.release()).resolves.toMatchObject({ status: 'completed' });
    expect(release).toHaveBeenCalledTimes(5);
    expect(coordinator.activeLeaseCount()).toBe(0);
  });

  it('expires an abandoned lease even when its invocation never releases it', async () => {
    vi.useFakeTimers();
    const { coordinator, adapter, create, release } = setup();
    const lease = await coordinator.acquire({
      key: 'railway:env-1:component-1:5432',
      provider: 'railway',
      adapter,
      environment,
      component,
      create,
      ttlMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(release).toHaveBeenCalledTimes(1);
    expect(coordinator.activeLeaseCount()).toBe(0);
    await expect(lease.release()).resolves.toMatchObject({ status: 'completed' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
