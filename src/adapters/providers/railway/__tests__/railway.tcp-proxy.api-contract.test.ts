import { execute, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import { schema } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Synthetic state through real graphql-request serialization and the pinned
// official SDL: Query.tcpProxies is non-null, and TCPProxySyncStatus distinguishes
// DELETING from DELETED. No live proxy activation or deletion is certified here.
const proxy = (syncStatus = 'ACTIVE') => ({ id: 'owned-proxy', domain: 'synthetic.proxy.rlwy.net',
  proxyPort: 23456, applicationPort: 5432, environmentId: 'environment-production',
  serviceId: 'service-postgres', syncStatus, deletedAt: null });

async function fixture(options: { states?: string[]; malformed?: unknown; malformedAfterDelete?: boolean } = {}) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let reads = 0, deletes = 0, creates = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document)).toEqual([]);
    if (Object.hasOwn(options, 'malformed') && (!options.malformedAfterDelete || deletes)) {
      return Response.json({ data: options.malformed });
    }
    const result = await execute({ schema, document, variableValues: request.variables, rootValue: {
      tcpProxies: ({ environmentId, serviceId }: { environmentId: string; serviceId: string }) => {
        expect({ environmentId, serviceId }).toEqual({ environmentId: 'environment-production', serviceId: 'service-postgres' });
        const state = options.states?.[Math.min(reads++, (options.states?.length ?? 1) - 1)] ?? 'ACTIVE';
        return state === 'ABSENT' ? [] : [proxy(state)];
      },
      tcpProxyDelete: ({ id }: { id: string }) => { expect(id).toBe('owned-proxy'); deletes++; return true; },
      tcpProxyCreate: () => { creates++; return proxy(); },
    } });
    expect(result.errors).toBeUndefined();
    return Response.json(result);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-contract-token' });
  return { adapter, requests, counts: () => ({ reads, deletes, creates }) };
}

describe('Railway TCP proxy terminal removal contract', () => {
  it('does not equate a delete acknowledgment followed by DELETING with removal', async () => {
    vi.useFakeTimers();
    const f = await fixture({ states: ['ACTIVE', 'DELETING'] });
    const check = expect(f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy')).rejects.toThrow();
    await Promise.all([check, vi.runAllTimersAsync()]);
    expect(f.counts().deletes).toBe(1);
  });

  it('waits through DELETING until the exact proxy reaches DELETED', async () => {
    vi.useFakeTimers();
    const f = await fixture({ states: ['ACTIVE', 'DELETING', 'DELETED'] });
    const check = f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy');
    await vi.runAllTimersAsync();
    await check;
    expect(f.counts()).toEqual({ reads: 3, deletes: 1, creates: 0 });
  });

  it('resumes a pending deletion without sending a second mutation', async () => {
    const f = await fixture({ states: ['DELETING', 'DELETED'] });
    await f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy');
    expect(f.counts()).toEqual({ reads: 2, deletes: 0, creates: 0 });
  });

  it.each([{}, { tcpProxies: null }, { tcpProxies: [{}] },
    { tcpProxies: [{ ...proxy(), environmentId: 'environment-other' }] },
    { tcpProxies: [{ ...proxy(), serviceId: 'service-other' }] },
    { tcpProxies: [proxy(), proxy()] },
    { tcpProxies: [{ ...proxy(), syncStatus: 'NEW_UNKNOWN_STATUS' }] },
  ])('keeps malformed or missing inventory unknown: %j', async malformed => {
    const f = await fixture({ malformed });
    await expect(f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy')).rejects.toThrow();
    expect(f.counts().deletes).toBe(0);
    expect(f.requests.some(request => request.query.includes('mutation'))).toBe(false);
  });

  it('does not accept missing inventory after an acknowledged delete', async () => {
    const f = await fixture({ malformed: {}, malformedAfterDelete: true });
    await expect(f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy')).rejects.toThrow();
    expect(f.counts().deletes).toBe(1);
  });

  it.each(['CREATING', 'DELETING', 'UPDATING', 'UNSPECIFIED'])('does not reuse or create around an existing %s proxy', async state => {
    const f = await fixture({ states: [state] });
    await expect(f.adapter.ensureTcpProxy('environment-production', 'service-postgres', 5432)).rejects.toThrow();
    expect(f.counts().creates).toBe(0);
  });

  it('accepts actual absence and a terminal DELETED record without mutations', async () => {
    const f = await fixture({ states: ['ABSENT', 'DELETED'] });
    await f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy');
    await f.adapter.deleteTcpProxy('environment-production', 'service-postgres', 'owned-proxy');
    expect(f.counts()).toEqual({ reads: 2, deletes: 0, creates: 0 });
  });

  it('exposes complete validated transitional inventory for independent cleanup observation', async () => {
    const f = await fixture({ states: ['DELETING', 'DELETED'] });
    expect(await f.adapter.observeTcpProxies('environment-production', 'service-postgres')).toEqual([proxy('DELETING')]);
    expect(await f.adapter.observeTcpProxies('environment-production', 'service-postgres')).toEqual([proxy('DELETED')]);
    expect(f.counts()).toEqual({ reads: 2, deletes: 0, creates: 0 });
  });
});
