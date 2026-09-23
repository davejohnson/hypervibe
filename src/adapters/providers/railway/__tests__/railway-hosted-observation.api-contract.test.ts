import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { RailwayAdapter } from '../railway.adapter.js';
import { projectId, productionId, stagingId, railwayHttpFixture } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const scope = { projectId, environmentId: stagingId };
const limits = { maxRequests: 20, maxResources: 20, timeoutMs: 1000 };
const observe = (input: Record<string, unknown>) => providerRegistry.get('railway')!.hostedObservation!.observe(input as never);

describe('hosted Railway observation through the pinned official GraphQL schema', () => {
  it('strict observation rejects a replacement with the original environment name', async () => {
    const fixture = await railwayHttpFixture();
    fixture.environments.delete(stagingId);
    fixture.environments.set('replacement', { id: 'replacement', name: 'staging', config: {} });
    await expect(fixture.adapter.observe(fixture.environment, { strictScope: scope, maxResources: 20 }))
      .rejects.toThrow('scope_mismatch');
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('verifies a project token before reading exact staging beside production, without mutations', async () => {
    const fixture = await railwayHttpFixture({ projectTokenScope: scope });
    fixture.addService('staging-web', 'web', stagingId);
    const result = await observe({ environment: fixture.environment, credentials: { projectToken: 'synthetic-project-token' }, scope, limits });
    expect(result).toMatchObject({ scopeVerified: true, observed: { projectId, environmentId: stagingId, partial: false } });
    expect(result.observed!.services.map((service) => service.externalId)).toEqual(['staging-web']);
    expect(fixture.requests[0].query).toContain('projectToken');
    expect(fixture.requests.filter((request) => request.variables?.environmentId).every((request) => request.variables.environmentId === stagingId)).toBe(true);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('stops when the token belongs to production instead of the trusted staging scope', async () => {
    const fixture = await railwayHttpFixture({ projectTokenScope: { projectId, environmentId: productionId } });
    expect(await observe({ environment: fixture.environment, credentials: { projectToken: 'synthetic-project-token' }, scope, limits }))
      .toMatchObject({ observed: null, scopeVerified: false, reason: 'scope_mismatch', requests: 1 });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.mutations).toEqual([]);
  });

  it('verifies exact account-token scope without broad account discovery', async () => {
    const fixture = await railwayHttpFixture();
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits }))
      .toMatchObject({ scopeVerified: true, observed: { environmentId: stagingId } });
    expect(fixture.requests.some((request) => /\bme\s*\{/.test(request.query))).toBe(false);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('requires the account response to prove the environment belongs to the trusted project', async () => {
    const fixture = await railwayHttpFixture({ environmentProjectId: 'another-project' });
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits }))
      .toMatchObject({ observed: null, scopeVerified: false, reason: 'scope_mismatch', requests: 1 });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.contractErrors).toEqual([]);
    expect(fixture.mutations).toEqual([]);
  });

  it('refuses missing bindings before using provider access', async () => {
    const fixture = await railwayHttpFixture();
    fixture.environment.platformBindings = { projectId };
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits }))
      .toMatchObject({ observed: null, scopeVerified: false, reason: 'scope_mismatch', requests: 0 });
    expect(fixture.requests).toEqual([]);
  });

  it('does not replace a stale environment ID with a same-named environment', async () => {
    const fixture = await railwayHttpFixture({ projectTokenScope: scope });
    fixture.environments.delete(stagingId);
    fixture.environments.set('replacement', { id: 'replacement', name: 'staging', config: {} });
    const result = await observe({ environment: fixture.environment, credentials: { projectToken: 'synthetic-project-token' }, scope, limits });
    expect(result).toMatchObject({ observed: null, reason: 'scope_mismatch' });
    expect(fixture.requests.some((request) => request.variables?.environmentId === 'replacement')).toBe(false);
    expect(fixture.mutations).toEqual([]);
  });

  it('enforces a request budget and never claims unchecked services are complete', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService('staging-web', 'web', stagingId);
    const result = await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits: { ...limits, maxRequests: 2 } });
    expect(result).toMatchObject({ reason: 'budget_exhausted', requests: 2 });
    expect(result.observed === null || result.observed.partial).toBe(true);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.mutations).toEqual([]);
  });

  it('stops before per-resource reads when inventory exceeds the resource budget', async () => {
    const fixture = await railwayHttpFixture();
    for (let i = 0; i < 3; i++) fixture.addService(`staging-${i}`, `web-${i}`, stagingId);
    const result = await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits: { ...limits, maxResources: 2 } });
    expect(result).toMatchObject({ reason: 'budget_exhausted' });
    expect(fixture.requests.some((request) => request.query.includes('GetServiceInstance'))).toBe(false);
    expect(result.observed === null || result.observed.partial).toBe(true);
  });

  it('does no network work for a cancelled operation or ambiguous credentials', async () => {
    const fixture = await railwayHttpFixture();
    const controller = new AbortController(); controller.abort();
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits, signal: controller.signal }))
      .toMatchObject({ observed: null, reason: 'cancelled', requests: 0 });
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token', projectToken: 'secret' }, scope, limits }))
      .toMatchObject({ observed: null, reason: 'invalid_credentials', requests: 0 });
    expect(fixture.requests).toEqual([]);
  });

  it('retains unknown service coverage after denied variable reads without echoing errors', async () => {
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('GetVariables')
      ? Response.json({ errors: [{ message: 'denied synthetic-contract-token password=sensitive' }] }, { status: 403 }) : undefined });
    fixture.addService('staging-web', 'web', stagingId);
    const result = await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits });
    expect(result).toMatchObject({ scopeVerified: true, observed: { partial: true, completeness: { services: 'unknown' } } });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(JSON.stringify(result)).not.toContain('synthetic-contract-token');
  });

  it('keeps a streamed response body within the operation deadline', async () => {
    vi.useFakeTimers();
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    const cancelled = vi.fn();
    const fixture = await railwayHttpFixture({ responseOverride: () => new Response(new ReadableStream({
      pull() { bodyRead(); }, cancel: cancelled,
    })) });
    const pending = observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits });
    await reading;
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    expect(await pending).toMatchObject({ observed: null, reason: 'timeout', requests: 1 });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fixture.mutations).toEqual([]);
  });

  it('bounds streamed response bytes before parsing provider output', async () => {
    const fixture = await railwayHttpFixture({ responseOverride: () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
    expect(await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits }))
      .toMatchObject({ observed: null, reason: 'budget_exhausted', requests: 1 });
    expect(fixture.requests).toHaveLength(1);
  });

  it('cancels in-flight body reads and never starts the next request', async () => {
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    const fixture = await railwayHttpFixture({ responseOverride: () => new Response(new ReadableStream({ pull() { bodyRead(); } })) });
    const controller = new AbortController();
    const pending = observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits, signal: controller.signal });
    await reading;
    controller.abort();
    expect(await pending).toMatchObject({ observed: null, reason: 'cancelled', requests: 1 });
    expect(fixture.requests).toHaveLength(1);
  });

  it('forbids a serialized mutation even if an observation helper attempts one', async () => {
    const fixture = await railwayHttpFixture();
    const original = RailwayAdapter.prototype.observe;
    const mutationReceipts: unknown[] = [];
    vi.spyOn(RailwayAdapter.prototype, 'observe').mockImplementation(async function (this: RailwayAdapter, environment, options) {
      mutationReceipts.push(await this.connectServiceToRepo({ serviceId: 'staging-web', repo: 'owner/repo', branch: 'main' }));
      return original.call(this, environment, options);
    });
    const result = await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits });
    expect(result).toMatchObject({ observed: null, reason: 'provider_error', requests: 1 });
    expect(mutationReceipts).toMatchObject([{ success: false }]);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
  });

  it('does not treat a truncated service-instance page as complete observation', async () => {
    const fixture = await railwayHttpFixture({ pageSize: 1 });
    const shared = fixture.services.get('production-web')!;
    shared.instances.set(stagingId, { ...shared.instances.get(productionId)!, environmentId: stagingId });
    const result = await observe({ environment: fixture.environment, credentials: { apiToken: 'synthetic-contract-token' }, scope, limits });
    expect(result).toMatchObject({ observed: null, reason: 'budget_exhausted' });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.mutations).toEqual([]);
  });
});
