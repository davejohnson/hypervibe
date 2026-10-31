import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGcpLocalServicesDriver, GCP_OPERATOR_SERVICES } from '../../src/adapters/providers/gcp/gcp-local-services-installation.js';
import { GcpSecretWriterClient } from '../../src/adapters/providers/gcp/gcp-secret-writer.client.js';
import { DestinationBudget } from '../../src/adapters/providers/secret-destination-http.js';
import type { LocalCloudScopePreparationIntent, CloudInstallationProviderContext } from '../../src/domain/ports/cloud-installation.port.js';
import { largeServiceConfig, serviceUsageResponse } from './helpers/gcp-service-usage.js';

const projectId = 'operator-project', projectNumber = '123456789012';
const allocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const billingAccountName = 'billingAccounts/ABCDEF-123456-789ABC';
const intent = { schemaVersion: 1, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', customerId: 'app', appId: 'app', environment: 'test',
  source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 2, specDigest: 'b'.repeat(64) },
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun', provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: [],
  predecessor: { installationId: allocationId, planDigest: 'a'.repeat(64) }, selection: { scopeKind: 'operator-hosting-v1', billingAccountName },
  nativeScope: { scopeKind: 'project-services', projectId, projectNumber, projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
    projectInstallationId: allocationId, projectAttemptId: attemptId, billingAccountName } } as LocalCloudScopePreparationIntent;
function fixture(initialState: unknown = 'DISABLED') {
  const state = { value: initialState, omitState: false, wrongName: false, ignoreMask: false };
  const calls: { url: URL; method: string }[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET'; calls.push({ url, method });
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-operator-token');
    if (url.hostname === 'cloudresourcemanager.googleapis.com') {
      if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: ['serviceusage.services.get', 'serviceusage.services.enable'] });
      return Response.json({ name: `projects/${projectNumber}`, projectId, state: 'ACTIVE', createTime: intent.nativeScope.projectCreateTime,
        labels: { 'hv-installation': createHash('sha256').update(JSON.stringify(['app', 'app', 'test', allocationId])).digest('hex').slice(0, 63), 'hv-attempt': attemptId } });
    }
    if (url.hostname === 'cloudbilling.googleapis.com') return Response.json({ name: `projects/${projectId}/billingInfo`, projectId, billingAccountName, billingEnabled: true });
    if (url.hostname === 'serviceusage.googleapis.com' && method === 'GET') return serviceUsageResponse(url,
      state.wrongName ? 'projects/999999999999/services/compute.googleapis.com' : `projects/${projectNumber}/services/${url.pathname.split('/').at(-1)}`, state.value, state);
    throw new Error('Unexpected synthetic transport; mutations are forbidden');
  };
  const context: CloudInstallationProviderContext<LocalCloudScopePreparationIntent> = { intent, signal: new AbortController().signal,
    completed: {}, beforeMutation: async () => { throw new Error('No mutation authority'); },
    authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => 'synthetic-operator-token' } } };
  return { state, calls, request, context, driver: createGcpLocalServicesDriver({ fetch: request }) };
}

describe('GCP Service Usage response projection at the real bounded client', () => {
  it.each(['DISABLED', 'ENABLED'])('plans, observes and recovers %s with a service configuration larger than 1MiB', async state => {
    expect(Buffer.byteLength(JSON.stringify(largeServiceConfig))).toBeGreaterThan(1_048_576);
    const f = fixture(state); const plan = await f.driver.plan(f.context);
    const context = { ...f.context, action: plan.actions[0]! };
    expect(await f.driver.inspect(context)).toMatchObject({ state: state === 'ENABLED' ? 'satisfied' : 'action-required' });
    expect(await f.driver.recover({ ...context, attempt: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actionId: context.action.id, status: 'uncertain',
      startedAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' } })).toMatchObject({ state: state === 'ENABLED' ? 'satisfied' : 'pending' });
    const reads = f.calls.filter(call => call.url.hostname === 'serviceusage.googleapis.com');
    expect(reads).toHaveLength(GCP_OPERATOR_SERVICES.length * 3);
    expect(reads.every(call => call.method === 'GET' && call.url.searchParams.get('fields') === 'name,state')).toBe(true);
    expect(f.calls.filter(call => call.method !== 'GET').every(call => call.url.pathname.endsWith(':testIamPermissions'))).toBe(true);
  });
  it.each(['omitted', 'STATE_UNSPECIFIED', 'UNKNOWN', 'wrong-name', 'ignored-mask'])('keeps %s evidence unknown without enabling an API', async mode => {
    const f = fixture(); const plan = await f.driver.plan(f.context);
    if (mode === 'omitted') f.state.omitState = true;
    else if (mode === 'wrong-name') f.state.wrongName = true;
    else if (mode === 'ignored-mask') f.state.ignoreMask = true;
    else f.state.value = mode;
    const context = { ...f.context, action: plan.actions[0]! };
    expect(await f.driver.inspect(context)).toMatchObject({ state: 'unknown' });
    expect(await f.driver.recover({ ...context, attempt: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actionId: context.action.id, status: 'uncertain',
      startedAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' } })).toMatchObject({ state: 'unknown' });
    expect(await f.driver.mutate(context)).toMatchObject({ state: 'rejected' });
    expect(f.calls.some(call => call.url.pathname.endsWith(':batchEnable'))).toBe(false);
  });
  it('bounds legacy service-state reads while retaining their additional identity checks', async () => {
    const f = fixture(); const budget = new DestinationBudget();
    try {
      const client = new GcpSecretWriterClient({ token: 'synthetic-operator-token', budget, request: f.request,
        beforeWrite: async () => { throw new Error('No mutation authority'); }, sleep: async () => {} });
      // The bootstrap reader verifies numeric name, parent and config.name.
      await expect(client.bootstrap.getServiceState(projectId, 'compute.googleapis.com')).resolves.toBe('DISABLED');
      expect(f.calls.at(-1)?.url.searchParams.get('fields')).toBe('name,parent,config/name,state');
    } finally { budget.close(); }
  });
});
