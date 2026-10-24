import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGcpSecretContainerSetup } from '../../src/adapters/providers/gcp/gcp-secret-container.js';
import { secretContainerScopeDigest } from '../../src/domain/ports/secret-destination-lifecycle.port.js';

// Synthetic real REST boundary, reconstructed from projects.secrets.create and
// Secret: create has no versions, labels correlate intent, createTime pins lifetime.
const destination = { provider: 'gcp-secret-manager' as const, projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'staging-api' };
const owner = { repository: 'github.com/acme/app', environment: 'staging', key: 'API_TOKEN' };
const intent = { destination, owner, attemptId: '11111111-1111-4111-8111-111111111111' };
const resource = 'projects/123456789012/secrets/staging-api';
const environment = { platformBindings: { provider: 'cloudrun', projectId: 'synthetic-project' } } as any;
function fixture(options: { existing?: any; unknown?: boolean; foreignProject?: boolean; lost?: boolean; populated?: boolean } = {}) {
  let live = options.existing;
  const writes: any[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET', path = String(url);
    if (path === 'https://cloudresourcemanager.googleapis.com/v3/projects/123456789012') return Response.json({ name: 'projects/123456789012', projectId: options.foreignProject ? 'foreign-project' : 'synthetic-project', state: 'ACTIVE' });
    if (path === 'https://secretmanager.googleapis.com/v1/' + resource && method === 'GET') return options.unknown
      ? new Response('denied', { status: 403 }) : live ? Response.json(live) : new Response('missing', { status: 404 });
    if (path.startsWith('https://secretmanager.googleapis.com/v1/' + resource + '/versions?')) return Response.json(options.populated ? { versions: [{ name: resource + '/versions/1' }] } : {});
    if (path === 'https://secretmanager.googleapis.com/v1/projects/123456789012/secrets?secretId=staging-api' && method === 'POST') {
      const body = JSON.parse(String(init?.body)); writes.push(body);
      live = { name: resource, createTime: '2026-10-24T12:00:00.123456789Z', etag: 'native-etag', ...body };
      if (options.lost) throw new Error('synthetic lost response');
      return Response.json(live);
    }
    throw new Error('Unexpected provider operation');
  });
  const driver = createGcpSecretContainerSetup({ projectId: 'synthetic-project', getAccessToken: async () => 'synthetic-token' }, { fetch: request as typeof fetch });
  return { driver, request, writes };
}
afterEach(() => vi.restoreAllMocks());
describe('empty secret container setup at the GCP REST boundary', () => {
  it('discovers verified numeric scope and stable distinct destinations through read-only CRM', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://cloudresourcemanager.googleapis.com/v1/projects/synthetic-project');
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json({ projectNumber: '123456789012', projectId: 'synthetic-project', lifecycleState: 'ACTIVE' });
    });
    const driver = createGcpSecretContainerSetup({ projectId: 'synthetic-project', getAccessToken: async () => 'synthetic-token' }, { fetch: request as typeof fetch });
    const input = { repository: owner.repository, environment: owner.environment, keys: ['API_TOKEN', 'FLOW_KEY', 'api_key', '_TOKEN'] };
    const first = await driver.discover(environment, input);
    expect(first).toMatchObject({ state: 'known', destinations: { API_TOKEN: { provider: 'gcp-secret-manager', projectId: 'synthetic-project', projectNumber: '123456789012' } } });
    expect(await driver.discover(environment, input)).toEqual(first);
    if (first.state !== 'known') throw new Error('Expected verified scope');
    const ids = Object.values(first.destinations).map(value => (value as typeof destination).secretId);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(value => /^[a-z][a-z0-9-]{0,62}$/.test(value))).toBe(true);
    const other = await driver.discover(environment, { ...input, environment: 'production' });
    expect(other).not.toEqual(first);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each([
    { projectNumber: '123456789012', projectId: 'other-project', lifecycleState: 'ACTIVE' },
    { projectNumber: 'synthetic-project', projectId: 'synthetic-project', lifecycleState: 'ACTIVE' },
    { projectNumber: '123456789012', projectId: 'synthetic-project', lifecycleState: 'DELETE_REQUESTED' },
  ])('does not propose destinations for unverified project metadata %j', async metadata => {
    const request = vi.fn(async () => Response.json(metadata));
    const driver = createGcpSecretContainerSetup({ projectId: 'synthetic-project', getAccessToken: async () => 'synthetic-token' }, { fetch: request as typeof fetch });
    expect(await driver.discover(environment, { repository: owner.repository, environment: owner.environment, keys: ['API_TOKEN'] })).toMatchObject({ state: 'unknown' });
  });
  it('creates only an absent empty container after durable claim, then verifies lifetime and ownership', async () => {
    const f = fixture(); let claimed = false;
    const result = await f.driver.create(environment, intent, { beforeCreate: async () => { claimed = true; expect(f.writes).toEqual([]); } });
    expect(claimed).toBe(true);
    expect(result).toMatchObject({ state: 'present', resource, hasVersions: false, createTime: '2026-10-24T12:00:00.123456789Z', attemptId: intent.attemptId, scopeDigest: secretContainerScopeDigest(intent) });
    expect(f.writes).toEqual([{ replication: { automatic: {} }, labels: { 'hv-secret-scope': secretContainerScopeDigest(intent), 'hv-secret-attempt': intent.attemptId } }]);
    expect(f.request.mock.calls.some(([url]) => String(url).includes(':addVersion') || String(url).includes(':access'))).toBe(false);
  });
  it.each([{ unknown: true }, { foreignProject: true }, { existing: { name: resource, createTime: '2026-10-24T00:00:00Z' } }])('never creates over uncertain or already-present state: %j', async options => {
    const f = fixture(options); const claim = vi.fn();
    expect(await f.driver.create(environment, intent, { beforeCreate: claim })).toMatchObject({ state: 'unknown' });
    expect(f.writes).toEqual([]); expect(claim).not.toHaveBeenCalled();
  });
  it('retains uncertain creation for metadata-only correlated recovery without a second POST', async () => {
    const f = fixture({ lost: true });
    expect(await f.driver.create(environment, intent, { beforeCreate: async () => {} })).toMatchObject({ state: 'unknown' });
    expect(await f.driver.observe(environment, destination)).toMatchObject({ state: 'present', attemptId: intent.attemptId, scopeDigest: secretContainerScopeDigest(intent), hasVersions: false });
    expect(f.writes).toHaveLength(1);
  });
  it('reports populated metadata without reading, changing, or deleting any version', async () => {
    const f = fixture({ populated: true, existing: { name: resource, createTime: '2026-10-24T00:00:00Z' } });
    expect(await f.driver.observe(environment, destination)).toMatchObject({ state: 'present', hasVersions: true });
    expect(f.writes).toEqual([]);
  });
  it('rejects another hosting project before authentication or provider access', async () => {
    const f = fixture();
    expect(await f.driver.observe({ platformBindings: { provider: 'cloudrun', projectId: 'other-project' } } as any, destination)).toMatchObject({ state: 'unknown' });
    expect(f.request).not.toHaveBeenCalled();
  });
});
