import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGcpLocalQuotaApiDriver } from '../../src/adapters/providers/gcp/gcp-local-quota-api.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

const observation = JSON.parse(readFileSync(new URL('./gcp/local-quota-observation.json', import.meta.url), 'utf8'));
const service = 'cloudbilling.googleapis.com', projectId = 'example-quota-project', projectNumber = '222333444555';
const permissions = ['serviceusage.services.get', 'serviceusage.services.enable', 'serviceusage.services.use'];
const actionId = `gcp:local-scope:quota-api:${service}`;
const allocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectAttemptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const intent: LocalCloudScopePreparationIntent = {
  schemaVersion: 1, installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', customerId: 'app', appId: 'app', environment: 'test',
  source: { kind: 'local-spec', repository: 'github.com/acme/app', specRevision: 2, specDigest: 'b'.repeat(64) },
  execution: { kind: 'local-administrator', authentication: 'google-user-adc' }, hostingProvider: 'cloudrun', provider: 'gcp', mode: 'connect', stage: 'scope-preparation', keys: [],
  predecessor: { installationId: allocationId, planDigest: 'a'.repeat(64) }, selection: { scopeKind: 'project-quota-api-v1' },
  nativeScope: { scopeKind: 'project-quota-api-v1', projectId, projectNumber, projectCreateTime: '2026-10-25T00:00:00Z', projectParent: 'none',
    projectInstallationId: allocationId, projectAttemptId },
};
// Native response shapes are reconstructed from the official sources in the
// sanitized observation. The observed 429 and disabled API motivate this path;
// no successful API enablement or live compatibility is claimed by these tests.
function fixture() {
  const state = { service: 'DISABLED' as unknown, wrongService: false, wrongProject: false, permissionList: [...permissions], status: 200,
    lostAck: false, malformedAck: false, denyBoundary: false, enabledOnWrite: true };
  const calls: Array<{ url: URL; method: string; body?: unknown }> = [], writes: string[] = [];
  let saved: CloudInstallationRecord<LocalCloudScopePreparationIntent> | null = null, mutationBoundaries = 0;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    calls.push({ url, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-transient-token');
    expect(init.redirect).toBe('error');
    // The failure being repaired is inaccessible billingInfo. Planning,
    // mutation and recovery must remain independent from that API.
    if (url.hostname === service) throw new Error('Billing API must not be called to enable itself');
    if (state.status !== 200) return Response.json({}, { status: state.status });
    if (url.hostname === 'cloudresourcemanager.googleapis.com') {
      if (url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: state.permissionList });
      return Response.json({ name: `projects/${projectNumber}`, projectId, state: 'ACTIVE',
        createTime: state.wrongProject ? '2026-10-26T00:00:00Z' : intent.nativeScope.projectCreateTime,
        labels: { 'hv-installation': createHash('sha256').update(JSON.stringify(['app', 'app', 'test', allocationId])).digest('hex').slice(0, 63), 'hv-attempt': projectAttemptId } });
    }
    expect(url.hostname).toBe('serviceusage.googleapis.com');
    const name = `projects/${projectNumber}/services/${service}`;
    if (method === 'GET') {
      expect(url.pathname).toBe(`/v1/${name}`); expect(url.searchParams.get('fields')).toBe('name,state');
      return Response.json({ name: state.wrongService ? `projects/999999999999/services/${service}` : name,
        ...(state.service === undefined ? {} : { state: state.service }) });
    }
    expect(method).toBe('POST'); expect(url.pathname).toBe(`/v1/${name}:enable`); expect(init.body).toBe('{}');
    writes.push(url.pathname); if (state.enabledOnWrite) state.service = 'ENABLED';
    if (state.lostAck) throw new Error('Synthetic lost response');
    return Response.json(state.malformedAck ? { name: 'unrelated-operation' } : { name: 'operations/acf.synthetic-enable' });
  };
  const driver = createGcpLocalQuotaApiDriver({ fetch: request });
  const context = { driver, authentication: { kind: 'local-administrator' as const, administrator: { getAccessToken: async () => 'synthetic-transient-token' } },
    authorize: async ({ phase }: { phase: string }) => phase !== 'mutate' || !state.denyBoundary,
    store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, expected: number | null, next: CloudInstallationRecord<LocalCloudScopePreparationIntent>) => {
      if (expected !== (saved?.revision ?? null)) return false; saved = structuredClone(next); return true;
    } } };
  const native = { intent, authentication: context.authentication, completed: {}, signal: new AbortController().signal,
    beforeMutation: async () => { mutationBoundaries++; if (state.denyBoundary) throw new Error('Synthetic authorization revoked'); } };
  return { state, calls, writes, driver, context, native, mutationBoundaries: () => mutationBoundaries };
}

describe('GCP exact quota API prerequisite without a billing-read dependency', () => {
  it('plans the observed disabled Cloud Billing API as one separately confirmed enable action', async () => {
    expect(observation.withoutQuotaProject.status).toBe(429);
    expect(observation.withExplicitSdkQuotaProject.serviceRead).toMatchObject({ name: `projects/${projectNumber}/services/${service}`, state: 'DISABLED' });
    const f = fixture(), planned = await f.driver.plan(f.native);
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ id: actionId, type: 'update', requiresConfirm: true, resource: { name: `projects/${projectNumber}/services/${service}` } });
    expect(planned.review.permissions.flatMap(item => item.actions)).toEqual(expect.arrayContaining(permissions));
    expect(planned.review.warnings.join(' ')).toContain(`GOOGLE_CLOUD_QUOTA_PROJECT=${projectId}`);
    expect(f.writes).toEqual([]); expect(f.calls.some(call => call.url.hostname === service)).toBe(false);
  });

  it.each([false, true])('completes one exact enable with lost acknowledgment=%s through shared recovery', async lostAck => {
    const f = fixture(); f.state.lostAck = lostAck;
    let record = await planCloudInstallationV1({ ...f.context, intent });
    record = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [actionId] });
    record = await reconcileCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status).toBe('scope-ready'); expect(record.attempts).toHaveLength(1); expect(f.writes).toHaveLength(1);
    expect(record.completed[actionId].resources).toEqual([{ kind: 'service', id: `projects/${projectNumber}/services/${service}`, identity: { state: 'ENABLED' } }]);
    expect(JSON.stringify(record)).not.toContain('synthetic-transient-token');
    expect(f.calls.filter(call => call.method !== 'GET').every(call => call.url.pathname.endsWith(':testIamPermissions') || call.url.pathname.endsWith(`/${service}:enable`))).toBe(true);
  });

  it('retains an acknowledged incomplete operation across repeated apply/recovery without another POST', async () => {
    const f = fixture(); f.state.enabledOnWrite = false;
    let record = await planCloudInstallationV1({ ...f.context, intent });
    const input = { ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [actionId] };
    record = await applyCloudInstallationV1(input); expect(record.status).toBe('pending');
    record = await applyCloudInstallationV1(input); expect(record.status).toBe('pending'); expect(f.writes).toHaveLength(1);
    expect(record.attempts[0].evidence?.native.operationName).toBe('operations/acf.synthetic-enable');
    f.state.service = 'ENABLED'; record = await reconcileCloudInstallationV1(input);
    expect(record.status).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });

  it('keeps a malformed acknowledgment uncertain and recovers from exact state without replay', async () => {
    const f = fixture(); f.state.malformedAck = true; f.state.enabledOnWrite = false;
    const initial = await planCloudInstallationV1({ ...f.context, intent });
    const input = { ...f.context, installationId: initial.installationId, planDigest: initial.plan.digest, confirmActions: [actionId] };
    let record = await applyCloudInstallationV1(input); expect(record.status).not.toBe('scope-ready');
    expect(record.attempts).toHaveLength(1); expect(f.writes).toHaveLength(1);
    f.state.service = 'ENABLED'; record = await reconcileCloudInstallationV1(input);
    expect(record.status).toBe('scope-ready'); expect(f.writes).toHaveLength(1);
  });

  it('uses a true noop for an enabled API and never enables it even if it later becomes disabled', async () => {
    const f = fixture(); f.state.service = 'ENABLED';
    const record = await planCloudInstallationV1({ ...f.context, intent }); expect(record.plan.actions[0]).toMatchObject({ type: 'noop', requiresConfirm: false });
    f.state.service = 'DISABLED';
    const result = await applyCloudInstallationV1({ ...f.context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: [actionId] });
    expect(result.status).not.toBe('scope-ready'); expect(f.writes).toEqual([]);
    expect(await f.driver.mutate!({ ...f.native, action: record.plan.actions[0] })).toMatchObject({ state: 'rejected' }); expect(f.writes).toEqual([]);
  });

  it.each(['missing', 'unknown', 'wrong-service', 'replaced-project', '403', '429', 'revoked-use'])('preserves %s reads as unknown and blocks writes', async problem => {
    const f = fixture(), plan = await f.driver.plan(f.native);
    if (problem === 'missing') f.state.service = undefined;
    else if (problem === 'unknown') f.state.service = 'STATE_UNSPECIFIED';
    else if (problem === 'wrong-service') f.state.wrongService = true;
    else if (problem === 'replaced-project') f.state.wrongProject = true;
    else if (problem === 'revoked-use') f.state.permissionList = permissions.filter(x => x !== 'serviceusage.services.use');
    else f.state.status = Number(problem);
    const context = { ...f.native, action: plan.actions[0] };
    expect(await f.driver.inspect(context)).toMatchObject({ state: 'unknown' });
    expect(await f.driver.mutate!(context)).toMatchObject({ state: 'rejected' }); expect(f.writes).toEqual([]);
  });

  it('rechecks exact enable permission and calls the mutation authority once immediately before the one write', async () => {
    const f = fixture(), plan = await f.driver.plan(f.native), context = { ...f.native, action: plan.actions[0] };
    f.state.permissionList = permissions.filter(x => x !== 'serviceusage.services.enable');
    expect(await f.driver.mutate!(context)).toMatchObject({ state: 'rejected', reason: 'insufficient_permissions' }); expect(f.mutationBoundaries()).toBe(0);
    f.state.permissionList = [...permissions]; f.state.denyBoundary = true;
    expect(await f.driver.mutate!(context)).toMatchObject({ state: 'rejected' }); expect(f.mutationBoundaries()).toBe(1); expect(f.writes).toEqual([]);
    f.state.denyBoundary = false;
    expect(await f.driver.mutate!(context)).toMatchObject({ state: 'acknowledged' }); expect(f.mutationBoundaries()).toBe(2); expect(f.writes).toHaveLength(1);
  });
});
