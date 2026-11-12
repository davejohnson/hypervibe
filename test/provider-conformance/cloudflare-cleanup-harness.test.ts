import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import '../../src/adapters/providers/cloudflare/cloudflare.adapter.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import type { ILoadBalancerAdapter } from '../../src/domain/ports/load-balancer.port.js';
import { applyWithCloudflareInventory, captureCloudflareFixtureInventory, cloudflareFixtureKey, newCloudflareCleanupJournal,
  readCloudflareCleanupJournal, rememberCloudflareBinding, saveCloudflareCleanupJournal,
  verifyCloudflareFixtureAbsent, type CloudflareCleanupJournal } from './cloudflare-cleanup-harness.js';

const scope = { project: 'hv-conformance-cloudflare-test', environment: 'conformance', hostname: 'hv-conformance-test.example.com' };
const binding = { provider: 'cloudflare', hostname: scope.hostname, accountId: 'account-1', zoneId: 'zone-1',
  monitorId: 'monitor-owned', poolId: 'pool-owned', loadBalancerId: 'balancer-owned' };
let directory: string;
let journal: CloudflareCleanupJournal;
let file: string;
const save = (value: CloudflareCleanupJournal) => saveCloudflareCleanupJournal(file, value);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cf-cleanup-'));
  file = path.join(directory, 'fixture.json');
  journal = newCloudflareCleanupJournal(scope.project, scope.environment, scope.hostname);
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('Cloudflare fixture cleanup authority', () => {
  it('recovers ids from durable SQLite even when the CLI result and repository export were lost', async () => {
    const databaseFile = path.join(directory, 'hypervibe.db');
    const database = new Database(databaseFile);
    database.exec('CREATE TABLE projects (id TEXT, name TEXT); CREATE TABLE environments (project_id TEXT, name TEXT, platform_bindings TEXT)');
    database.prepare('INSERT INTO projects VALUES (?, ?)').run('fixture-project', scope.project);
    database.prepare('INSERT INTO environments VALUES (?, ?, ?)').run('fixture-project', scope.environment, JSON.stringify({ loadBalancer: {
      provider: 'cloudflare', hostname: scope.hostname, accountId: 'account-1', zoneId: 'zone-1', monitor: { id: 'monitor-owned', name: 'fixture-monitor' },
    } }));
    database.close();
    await captureCloudflareFixtureInventory({ journal, databaseFile, bindingsFile: path.join(directory, 'missing-export.json'), save });
    expect(readCloudflareCleanupJournal(file, scope).resources).toEqual([{ kind: 'monitor', id: 'monitor-owned', accountId: 'account-1', zoneId: 'zone-1' }]);
    // Losing the binding during later cleanup must not erase the previously saved id.
    const later = new Database(databaseFile);
    later.prepare('UPDATE environments SET platform_bindings = ?').run('{}');
    later.close();
    await captureCloudflareFixtureInventory({ journal, databaseFile, bindingsFile: path.join(directory, 'missing-export.json'), save });
    expect(readCloudflareCleanupJournal(file, scope).resources).toHaveLength(1);
  });
  it('captures partial native ids after a failed apply and retains unresolved create authority', async () => {
    let liveBinding: Record<string, unknown> | null = null;
    await expect(applyWithCloudflareInventory({ journal, save,
      actions: [{ type: 'create', metadata: { operation: 'loadBalancerMonitorEnsure' } }, { type: 'create', metadata: { operation: 'loadBalancerPoolEnsure' } }],
      capture: async () => { rememberCloudflareBinding(journal, liveBinding); save(journal); },
      apply: async () => {
        const durableBeforeMutation = readCloudflareCleanupJournal(file, scope);
        expect(durableBeforeMutation.pendingCreates.map((entry) => entry.kind)).toEqual(['monitor', 'pool']);
        liveBinding = { ...binding, poolId: undefined, loadBalancerId: undefined };
        throw new Error('Pool apply response was lost');
      },
    })).rejects.toThrow('Pool apply response was lost');
    const recovered = readCloudflareCleanupJournal(file, scope);
    expect(recovered.resources.map((entry) => entry.id)).toEqual(['monitor-owned']);
    expect(recovered.pendingCreates.map((entry) => entry.kind)).toEqual(['pool']);
    expect(recovered.phase).toBe('cleanup-required');
    await expect(verifyCloudflareFixtureAbsent(recovered, {
      getMonitor: async () => null, getPool: async () => null, getLoadBalancer: async () => null,
    }, save)).rejects.toThrow('not fully confirmed');
    expect(readCloudflareCleanupJournal(file, scope).resources).toHaveLength(1);
  });

  it('does not treat missing bindings or an empty local plan as proof of deletion', async () => {
    rememberCloudflareBinding(journal, binding);
    rememberCloudflareBinding(journal, null);
    const getPool = vi.fn(async () => ({ id: 'pool-owned' } as Awaited<ReturnType<ILoadBalancerAdapter['getPool']>>));
    await expect(verifyCloudflareFixtureAbsent(journal, {
      getMonitor: async () => null, getPool, getLoadBalancer: async () => null,
    }, save)).rejects.toThrow('not fully confirmed');
    expect(getPool).toHaveBeenCalledWith('account-1', 'pool-owned');
    const persisted = readCloudflareCleanupJournal(file, scope);
    expect(persisted.resources).toHaveLength(3);
    expect(persisted.observations['pool:account-1:pool-owned']).toBe('present');
    expect(persisted.phase).toBe('cleanup-required');
  });

  it.each([403, 404])('accepts only exact provider-confirmed absence through the registered adapter (HTTP %s)', async (status) => {
    rememberCloudflareBinding(journal, binding);
    const requests: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      const responseStatus = url.includes('/monitors/') ? status : 404;
      return Response.json({ success: false, result: null, errors: [{ code: responseStatus === 404 ? 1000 : 1001, message: 'provider-detail-not-for-journal' }] }, { status: responseStatus });
    }));
    const adapter = await providerRegistry.createAdapter<ILoadBalancerAdapter>('cloudflare', { apiToken: 'private-fixture-token', accountId: 'account-1' });
    const promise = verifyCloudflareFixtureAbsent(journal, adapter, save);
    if (status === 404) await expect(promise).resolves.toBeUndefined();
    else await expect(promise).rejects.toThrow('not fully confirmed');
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'GET']);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/client/v4/accounts/account-1/load_balancers/monitors/monitor-owned',
      '/client/v4/accounts/account-1/load_balancers/pools/pool-owned',
      '/client/v4/zones/zone-1/load_balancers/balancer-owned',
    ]);
    const persisted = readCloudflareCleanupJournal(file, scope);
    expect(persisted.phase).toBe(status === 404 ? 'cleaned' : 'cleanup-required');
    expect(persisted.observations[cloudflareFixtureKey(persisted.resources[0]!)]).toBe(status === 404 ? 'absent' : 'unknown');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('private-fixture-token');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('provider-detail-not-for-journal');
  });

  it('preserves the complete durable inventory when teardown fails after clearing local bindings', async () => {
    rememberCloudflareBinding(journal, binding);
    save(journal);
    await expect(applyWithCloudflareInventory({ journal, save, actions: [{ type: 'destroy', metadata: { operation: 'loadBalancerDestroy' } }],
      capture: async () => { rememberCloudflareBinding(journal, null); save(journal); },
      apply: async () => { throw new Error('Cleanup interrupted'); },
    })).rejects.toThrow('Cleanup interrupted');
    const resumed = readCloudflareCleanupJournal(file, scope);
    expect(resumed.resources.map((resource) => resource.id)).toEqual(['monitor-owned', 'pool-owned', 'balancer-owned']);
    expect(resumed.phase).toBe('cleanup-required');
  });

  it('rejects foreign fixture scope and incomplete resource identities', () => {
    expect(() => rememberCloudflareBinding(journal, { ...binding, hostname: 'production.example.com' })).toThrow('ownership is unknown');
    expect(() => rememberCloudflareBinding(journal, { ...binding, zoneId: undefined })).toThrow('scope');
    save(journal);
    expect(() => readCloudflareCleanupJournal(file, { ...scope, project: 'production-app' })).toThrow('does not match');
  });
});
