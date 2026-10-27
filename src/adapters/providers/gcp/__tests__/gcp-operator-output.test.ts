import { describe, expect, it, vi } from 'vitest';
import { createGcpOperatorOutputClient } from '../gcp-operator-output.js';
import type { SecretContainerBinding } from '../../../../domain/ports/secret-destination-lifecycle.port.js';
const binding: SecretContainerBinding = { state: 'ready', destination: { provider: 'gcp-secret-manager', projectId: 'operator-test', projectNumber: '123456789012', secretId: 'app-output' },
  owner: { repository: 'github.com/acme/operator', environment: 'test', key: 'APP_SECRET' }, attemptId: '00000000-0000-4000-8000-000000000001',
  resource: 'projects/123456789012/secrets/app-output', createTime: '2026-10-27T00:00:00Z' };
describe('local operator GCP output transport', () => {
  it('verifies an immutable enabled version without accessing its payload', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (input: any) => { const url = new URL(String(input)); calls.push(url.pathname);
      if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/123456789012', projectId: 'operator-test', state: 'ACTIVE' });
      if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${binding.resource}/versions/1`, state: 'ENABLED' });
      if (url.pathname.endsWith('/versions')) return Response.json({ versions: [{ name: `${binding.resource}/versions/1`, state: 'ENABLED' }] });
      return Response.json({ name: binding.resource });
    });
    const client = createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-transient-token', request: request as typeof fetch });
    await client.verifyReference({ destination: binding.destination, version: '1' }, AbortSignal.timeout(1000));
    expect(calls).toContain(`/${'v1'}/${binding.resource}/versions/1`); expect(calls.some(value => value.includes(':access'))).toBe(false);
  });
  it('rejects a disabled or substituted version and preserves provider-error redaction', async () => {
    const request = vi.fn(async (input: any) => { const url = new URL(String(input));
      if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/123456789012', projectId: 'operator-test', state: 'ACTIVE' });
      if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${binding.resource}/versions/2`, state: 'DISABLED', secret: 'synthetic-provider-echo' });
      if (url.pathname.endsWith('/versions')) return Response.json({}); return Response.json({ name: binding.resource });
    });
    const client = createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-transient-token', request: request as typeof fetch });
    const error = await client.verifyReference({ destination: binding.destination, version: '1' }, AbortSignal.timeout(1000)).catch(value => value);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('synthetic-provider-echo');
  });
});
