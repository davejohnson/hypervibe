import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGcpLocalHoldingCapability, gcpLocalHoldingReceipt } from '../../src/adapters/providers/gcp/gcp-local-holding-preparation.js';
import { createGcpOperatorRecaptchaCapability } from '../../src/adapters/providers/gcp/gcp-operator-recaptcha.js';
import { canonicalJsonSha256 } from '../../src/lib/canonical-json.js';
import { localHoldingBoundary } from '../../src/adapters/providers/gcp/__tests__/gcp-local-holding.fixture.js';
import { applyCloudInstallationV1, planCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent, OperatorApplicationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Independent contract: Google REST uses x-goog-user-project; a bearer token
// alone does not select the ADC/SDK quota project.
// https://docs.cloud.google.com/docs/quotas/set-quota-project#rest_request
// Native diagnostic 2026-10-29: the packaged origin verifier omitted that header
// despite GOOGLE_CLOUD_QUOTA_PROJECT. The guard stopped the read before dispatch.
// OAuth/native resources below are reconstructed, not live compatibility proof.
const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture(quotaSource: 'adc' | 'environment') {
  const native = localHoldingBoundary(randomUUID());
  let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null;
  const context = { driver: native.driver, authentication: native.authentication, authorize: async () => true,
    store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, expected: number | null, next: CloudInstallationRecord<LocalCloudScopePreparationIntent>) => {
      if (expected !== (saved?.revision ?? null)) return false; saved = structuredClone(next); return true;
    } } };
  const planned = await planCloudInstallationV1({ ...context, intent: native.intent });
  const created = await applyCloudInstallationV1({ ...context, installationId: planned.installationId,
    planDigest: planned.plan.digest, confirmActions: planned.plan.actions.map(action => action.id) });
  expect(created.status).toBe('scope-ready');
  const receipt = gcpLocalHoldingReceipt(created), writesBefore = native.writes.length;
  const folder = await mkdtemp(path.join(tmpdir(), 'hv-operator-origin-adc-')); folders.push(folder);
  const adc = path.join(folder, 'adc.json');
  await writeFile(adc, JSON.stringify({ type: 'authorized_user', client_id: 'synthetic-client', client_secret: 'synthetic-client-secret',
    refresh_token: 'synthetic-refresh', quota_project_id: 'adc-quota-project' }), { mode: 0o600 });
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adc);
  vi.stubEnv('GOOGLE_CLOUD_QUOTA_PROJECT', quotaSource === 'environment' ? 'reviewed-quota-project' : '');
  const expectedQuota = quotaSource === 'environment' ? 'reviewed-quota-project' : 'adc-quota-project';
  const calls: Array<{ host: string; method: string; quota: string | null }> = [];
  let denied = false;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-origin-token', expires_in: 3600, token_type: 'Bearer' });
    const headers = new Headers(init.headers), method = init.method ?? 'GET';
    calls.push({ host: url.hostname, method, quota: headers.get('x-goog-user-project') });
    expect(headers.get('authorization')).toBe('Bearer synthetic-origin-token');
    expect(init.redirect).toBe('error');
    if (headers.get('x-goog-user-project') !== expectedQuota) return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    if (denied) return Response.json({ error: { code: 403, message: 'synthetic-origin-token', status: 'PERMISSION_DENIED' } }, { status: 403 });
    if (method !== 'GET' && !url.pathname.endsWith(':getIamPolicy')) throw new Error('Origin verification must remain read-only');
    return native.request(input, init);
  });
  return { native, receipt, calls, expectedQuota, writesBefore, deny: () => { denied = true; } };
}

describe('operator origin verification retains local ADC request authority', () => {
  it.each(['adc', 'environment'] as const)('preserves the %s quota project through the actual GoogleAuth and native read clients', async source => {
    const f = await fixture(source), capability = createGcpLocalHoldingCapability();
    await expect(capability.verifyOperatorOrigin!(f.receipt, { service: 'web', runtimeService: 'web' }))
      .resolves.toMatchObject({ origin: f.receipt.origins.web, runtimeIdentity: f.receipt.runtimeIdentities.find(x => x.workload === 'web')!.principal });
    expect(f.calls.length).toBeGreaterThan(5);
    expect(f.calls.every(call => call.quota === f.expectedQuota)).toBe(true);
    expect(f.calls.some(call => call.host === 'cloudbilling.googleapis.com')).toBe(true);
    expect(f.native.writes).toHaveLength(f.writesBefore);
    f.calls.length = 0; f.deny();
    await expect(capability.verifyOperatorOrigin!(f.receipt, { service: 'web', runtimeService: 'web' })).rejects.not.toThrow('synthetic-origin-token');
    expect(f.calls).toHaveLength(1); // no retry with a different quota or credential
    expect(f.native.writes).toHaveLength(f.writesBefore);
  });
});


describe('CAPTCHA uses the same local ADC request authority', () => {
  it.each(['adc', 'environment'] as const)('keeps the %s quota selection during plan, inspect and recovery', async source => {
    const f = await fixture(source), calls: Array<{ host: string; quota: string | null }> = [];
    const projectId = 'operator-project', projectNumber = '123456789012';
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const u = new URL(String(input));
      if (u.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-origin-token', expires_in: 3600, token_type: 'Bearer' });
      const headers = new Headers(init.headers); calls.push({ host: u.hostname, quota: headers.get('x-goog-user-project') });
      expect(headers.get('authorization')).toBe('Bearer synthetic-origin-token');
      if (headers.get('x-goog-user-project') !== f.expectedQuota) return Response.json({}, { status: 429 });
      if (u.hostname === 'cloudresourcemanager.googleapis.com') {
        if (u.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['serviceusage.services.get', 'serviceusage.services.enable',
          'recaptchaenterprise.keys.create', 'recaptchaenterprise.keys.list', 'recaptchaenterprise.keys.get', 'recaptchaenterprise.keys.retrievelegacysecretkey'] });
        return Response.json({ name: `projects/${projectNumber}`, projectId, state: 'ACTIVE' });
      }
      if (u.hostname === 'serviceusage.googleapis.com') return Response.json({ name: `projects/${projectNumber}/services/recaptchaenterprise.googleapis.com`, state: 'ENABLED' });
      if (u.hostname === 'recaptchaenterprise.googleapis.com' && u.pathname === `/v1/projects/${projectNumber}/keys` && (init.method ?? 'GET') === 'GET') return Response.json({});
      throw new Error('No credential capture or provider mutation is allowed');
    });
    const appId = randomUUID(), environmentId = randomUUID();
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: appId, appId, environment: 'test',
      source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
      provider: 'google-recaptcha', applicationProvider: 'google-recaptcha', mode: 'connect', stage: 'scope-preparation', keys: [],
      execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope: { projectId, projectNumber, name: 'captcha', origin: 'https://operator.example.test' } };
    const execution = await createGcpOperatorRecaptchaCapability().create(intent.nativeScope, { projectId: appId, environmentId,
      installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent) });
    const context = { intent, authentication: execution.authentication, completed: {}, signal: AbortSignal.timeout(5000), beforeMutation: async () => { throw new Error('No mutation'); } };
    const plan = await execution.driver.plan(context);
    for (const action of plan.actions.slice(0, 2)) {
      const observed = await execution.driver.inspect({ ...context, action });
      expect(observed.state).toBe(action.id.endsWith(':api') ? 'satisfied' : 'action-required');
    }
    const action = plan.actions[0], observed = await execution.driver.inspect({ ...context, action });
    if (observed.state !== 'satisfied') throw new Error('API evidence expected');
    expect(await execution.driver.recover({ ...context, completed: { [action.id]: observed.evidence }, action,
      attempt: { id: randomUUID(), actionId: action.id, status: 'succeeded', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), evidence: observed.evidence } })).toMatchObject({ state: 'satisfied' });
    expect(calls.some(call => call.host === 'recaptchaenterprise.googleapis.com')).toBe(true);
    expect(calls.every(call => call.quota === f.expectedQuota)).toBe(true);
  });
});
