import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGcpLocalProjectAllocationCapability } from '../../src/adapters/providers/gcp/gcp-local-project-allocation.js';
import { planCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Real GoogleAuth/UserRefreshClient and shared planner; reconstructed OAuth + CRM
// transport only. Temporary ADC contains synthetic fixture data, never operator credentials.
const folders: string[] = [];
const nativeScope = { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: 'local-project', displayName: 'Local Project' };
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture(impersonated = false) {
  const folder = await mkdtemp(path.join(tmpdir(), 'hv-local-allocation-adc-')); folders.push(folder);
  const file = path.join(folder, 'adc.json');
  const user = { type: 'authorized_user', client_id: 'synthetic-client', client_secret: 'synthetic-client-secret',
    refresh_token: 'synthetic-refresh', quota_project_id: 'quota-only-project' };
  await writeFile(file, JSON.stringify(impersonated ? { type: 'impersonated_service_account',
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/administrator@other-project.iam.gserviceaccount.com:generateAccessToken',
    delegates: [], source_credentials: user } : user), { mode: 0o600 });
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', file);
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe('error');
    if (url === 'https://oauth2.googleapis.com/token') {
      expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
      return Response.json({ access_token: 'synthetic-local-token', expires_in: 3600, token_type: 'Bearer' });
    }
    expect(url).toBe('https://cloudresourcemanager.googleapis.com/v3/projects/local-project');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-local-token');
    expect(new Headers(init?.headers).get('x-goog-user-project')).toBe('quota-only-project');
    return Response.json({ error: { message: 'synthetic-local-token', status: 'PERMISSION_DENIED' } }, { status: 403 });
  });
  vi.stubGlobal('fetch', request);
  return { request };
}
describe('provider-owned local allocation ADC entrypoint', () => {
  it('loads actual local user ADC, scopes native requests to the reviewed project, and persists no credentials', async () => {
    const f = await fixture(); const capability = createGcpLocalProjectAllocationCapability();
    const execution = await capability.create(nativeScope);
    let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
    const plan = await planCloudInstallationV1({ ...execution, authorize: async () => true,
      store: { read: async () => saved, compareAndSwap: async (_id, _revision, next) => { saved = next; return true; } },
      intent: { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'local-project', appId: 'local-project',
        environment: 'test', provider: 'gcp', hostingProvider: 'cloudrun', mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope,
        execution: { kind: 'local-administrator', authentication: 'google-user-adc' },
        source: { kind: 'local-spec', repository: 'github.com/example/app', specRevision: 1, specDigest: 'a'.repeat(64) } } });
    expect(plan.status).toBe('review-required'); expect(f.request).toHaveBeenCalledTimes(2);
    expect(capability.parseRecord(plan)).toEqual(plan);
    for (const text of ['synthetic-local-token', 'synthetic-refresh', 'synthetic-client-secret', 'quota-only-project']) expect(JSON.stringify(plan)).not.toContain(text);
    await expect(execution.authentication.administrator.getAccessToken('arbitrary-scope', new AbortController().signal)).rejects.toMatchObject({ reason: 'identity_mismatch' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('rejects an impersonated ADC source before any native or token HTTP request', async () => {
    const f = await fixture(true);
    await expect(createGcpLocalProjectAllocationCapability().create(nativeScope)).rejects.toMatchObject({ reason: 'authorization_expired' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not initialize credentials for a billing scope or an already cancelled request', async () => {
    const f = await fixture(); const capability = createGcpLocalProjectAllocationCapability();
    await expect(capability.create({ ...nativeScope, billingAccountName: 'billingAccounts/ABCDEF-123456-789ABC' })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(capability.create(nativeScope, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not start an OAuth refresh when the exact token request is already cancelled', async () => {
    const f = await fixture(); const execution = await createGcpLocalProjectAllocationCapability().create(nativeScope);
    const controller = new AbortController(); controller.abort();
    await expect(execution.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.request).not.toHaveBeenCalled();
  });
});
