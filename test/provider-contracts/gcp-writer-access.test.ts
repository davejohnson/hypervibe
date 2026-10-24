import { describe, expect, it, vi } from 'vitest';
import { createGcpSecretDestinationDriver } from '../../src/adapters/providers/gcp/gcp-secret-destination.js';

// Reconstructed REST boundary: projects.secrets.testIamPermissions returns
// only the permissions the caller has; omitted repeated permissions means [].
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/testIamPermissions
const destination = { provider: 'gcp-secret-manager' as const, projectId: 'test-project',
  projectNumber: '123456789012', secretId: 'staging-flow' };
const permissions = ['secretmanager.secrets.get', 'secretmanager.versions.list', 'secretmanager.versions.add'];
describe('GCP writer access verification uses native permissions without secret values', () => {
  function fixture(response: unknown, projectId = destination.projectId) {
    const requests: { url: string; method: string; body?: unknown }[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.startsWith('https://cloudresourcemanager.googleapis.com/')) return Response.json({ name: 'projects/123456789012', projectId, state: 'ACTIVE' });
      if (url.endsWith(':testIamPermissions')) return Response.json(response);
      if (url.includes('/versions')) return Response.json({});
      return Response.json({ name: 'projects/123456789012/secrets/staging-flow' });
    });
    const driver = createGcpSecretDestinationDriver({ projectId: destination.projectId, projectNumber: destination.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    return { driver, requests };
  }
  it('checks all three exact permissions and returns ready without read or write probes', async () => {
    const { driver, requests } = fixture({ permissions });
    expect(await driver.verifyWriteAccess(destination)).toEqual({ status: 'ready' });
    expect(requests.at(-1)).toEqual({ url: 'https://secretmanager.googleapis.com/v1/projects/123456789012/secrets/staging-flow:testIamPermissions',
      method: 'POST', body: { permissions } });
    expect(requests.some(({ url }) => /:access|:addVersion/.test(url))).toBe(false);
  });
  it.each([{}, { permissions: permissions.slice(0, 2) }])('does not turn metadata access into writer authorization: %j', async response => {
    const { driver } = fixture(response);
    expect(await driver.verifyWriteAccess(destination)).toEqual({ status: 'unavailable', code: 'access_denied' });
  });
  it('rejects project ID/number substitution before any secret operation', async () => {
    const { driver, requests } = fixture({ permissions }, 'other-project');
    expect(await driver.verifyWriteAccess(destination)).toEqual({ status: 'unavailable', code: 'scope_mismatch' });
    expect(requests).toHaveLength(1);
  });
  it('bounds token acquisition and never starts provider work after cancellation', async () => {
    const request = vi.fn(); const controller = new AbortController();
    const driver = createGcpSecretDestinationDriver({ projectId: destination.projectId, projectNumber: destination.projectNumber,
      getAccessToken: async () => new Promise<string>(() => {}) }, { fetch: request });
    const pending = driver.verifyWriteAccess(destination, { signal: controller.signal }); controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', code: 'deadline_exceeded' }); expect(request).not.toHaveBeenCalled();
  });
});
