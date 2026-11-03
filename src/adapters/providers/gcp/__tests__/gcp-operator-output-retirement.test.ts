import { describe, expect, it } from 'vitest';
import * as output from '../gcp-operator-output.js';
import { secretContainerScopeDigest } from '../../../../domain/ports/secret-destination-lifecycle.port.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { historicalInstallationEvidence } from '../../../../domain/services/cloud-installation-runtime.js';
// Reconstructed official Secret Manager v1 transport; no native deletion performed.
// DELETE removes the entire container, so every contained version must be reviewed.
const id = '00000000-0000-4000-8000-000000000001', priorId = '00000000-0000-4000-8000-000000000002';
const binding: any = { state: 'ready', destination: { provider: 'gcp-secret-manager', projectId: 'operator-test', projectNumber: '123456789012', secretId: 'app-output' },
  owner: { repository: 'github.com/acme/operator', environment: 'test', key: 'APP_SECRET' }, attemptId: id,
  resource: 'projects/123456789012/secrets/app-output', createTime: '2026-10-27T00:00:00Z' };
export function outputFixture() {
  const outputs = { hostingProvider: 'cloudrun', destinations: [{ role: 'api-key', key: 'APP_SECRET', binding }] };
  const evidence = { resources: [{ kind: 'operator-output', id: binding.resource, identity: { role: 'api-key', key: 'APP_SECRET', createTime: binding.createTime,
    reference: JSON.stringify({ destination: binding.destination, version: '1' }) } }], native: { operation: 'operator-output', installationId: priorId, attemptId: id } };
  const prior: any = { schemaVersion: 1, installationId: priorId, revision: 2, status: 'scope-ready', intent: { schemaVersion: 1, installationId: priorId,
    appId: id, customerId: id, environment: 'test', source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
    mode: 'connect', stage: 'scope-preparation', keys: [], provider: 'sendgrid', applicationProvider: 'sendgrid', outputs,
    execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope: { name: 'mail' } },
    plan: { digest: 'b'.repeat(64), actions: [{ id: 'output', type: 'create' }] }, completed: { output: evidence },
    attempts: [{ id, actionId: 'output', status: 'succeeded', evidence }] };
  const intent: any = { ...prior.intent, installationId: '00000000-0000-4000-8000-000000000003', mode: 'retire',
    predecessor: { installationId: '00000000-0000-4000-8000-000000000004', planDigest: 'c'.repeat(64) },
    retirement: { from: { installationId: priorId, planDigest: prior.plan.digest }, continueFrom: { installationId: '00000000-0000-4000-8000-000000000004', planDigest: 'c'.repeat(64) },
      resources: 'delete-owned', data: 'delete-owned', targets: [{ installationId: priorId, planDigest: prior.plan.digest, evidenceDigest: canonicalJsonSha256(historicalInstallationEvidence(prior)) }],
      outputTargets: [{ from: { installationId: priorId, planDigest: prior.plan.digest }, role: 'api-key', key: 'APP_SECRET', version: '1' }] } };
  let exists = true, denied = false, extra = false, lost = false, uid = binding.createTime, permissions = true, readers = false, retention = false, replicas = false, echo = false, looping = false, noDelete = false, projectRole: 'none' | 'reader' | 'harmless' = 'none';
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'; calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    if (denied) return Response.json({ error: { message: 'synthetic-token secret echo' } }, { status: 403 });
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && url.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: permissions ? JSON.parse(String(init?.body)).permissions : [] });
    if (url.hostname === 'cloudresourcemanager.googleapis.com' && url.pathname.endsWith(':getIamPolicy')) return Response.json({ bindings: projectRole === 'none' ? [] : [{ role: 'projects/operator-test/roles/runtime', members: ['serviceAccount:runtime@operator-test.iam.gserviceaccount.com'] }] });
    if (url.hostname === 'iam.googleapis.com') { expect(method).toBe('GET'); expect(url.pathname).toBe('/v1/projects/operator-test/roles/runtime'); expect(url.search).toBe(''); return Response.json({ name: 'projects/operator-test/roles/runtime', includedPermissions: projectRole === 'reader' ? ['secretmanager.versions.access'] : ['resourcemanager.projects.get'] }); }
    if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/123456789012', projectId: 'operator-test', state: 'ACTIVE' });
    if (url.pathname.endsWith(':getIamPolicy')) return Response.json({ bindings: readers ? [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:runtime@operator-test.iam.gserviceaccount.com'] }] : [] });
    if (url.pathname.endsWith('/versions')) { expect(url.searchParams.get('pageSize')).toBe('100'); return Response.json({ ...(looping ? { nextPageToken: 'same-page' } : {}), versions: [{ name: `${binding.resource}/versions/1`, state: 'ENABLED', createTime: '2026-10-27T01:00:00Z', etag: 'version-etag' },
      ...(extra ? [{ name: `${binding.resource}/versions/2`, state: 'ENABLED', createTime: '2026-10-27T02:00:00Z', etag: 'extra' }] : [])] }); }
    expect(url.pathname).toBe(`/v1/${binding.resource}`);
    if (method === 'DELETE') { expect(url.searchParams.get('etag')).toBe('secret-etag'); expect(init?.body).toBeUndefined(); if (!noDelete) exists = false; if (lost) throw new Error('synthetic-token secret echo'); return Response.json({}); }
    if (!exists) return Response.json({}, { status: 404 });
    return Response.json({ name: binding.resource, createTime: uid, etag: 'secret-etag', replication: replicas ? { userManaged: { replicas: [{ location: 'us-central1' }] } } : { automatic: {} },
      ...(retention ? { versionDestroyTtl: '86400s' } : {}), ...(echo ? { unselected: 'synthetic-token' } : {}),
      labels: { 'hv-secret-scope': secretContainerScopeDigest(binding), 'hv-secret-attempt': binding.attemptId } });
  };
  const driver = () => (output as any).createGcpOperatorOutputRetirementDriver({ request, token: async () => 'synthetic-token' }, [prior]);
  const context: any = { intent, signal: AbortSignal.timeout(5000), completed: {}, attempts: [], beforeMutation: async () => {} };
  return { driver, context, prior, binding, calls, deny: () => { denied = true; }, extra: () => { extra = true; }, replace: () => { uid = '2026-11-01T00:00:00Z'; },
    lackRead: () => { permissions = false; }, reader: () => { readers = true; }, lose: () => { lost = true; }, retain: () => { retention = true; }, replicate: () => { replicas = true; }, echo: () => { echo = true; }, loop: () => { looping = true; }, leavePresent: () => { noDelete = true; lost = true; }, projectReader: () => { projectRole = 'reader'; }, harmlessRole: () => { projectRole = 'harmless'; } };
}
describe('exact operator output container retirement', () => {
  it('reviews all recorded versions, deletes only the exact owned container with etag and verifies absence without values', async () => {
    const f = outputFixture(), driver = f.driver(), plan = await driver.plan(f.context); expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]; expect(action).toMatchObject({ type: 'destroy', dataBearing: true, requiresConfirm: true });
    expect(await driver.inspect({ ...f.context, action })).toMatchObject({ state: 'action-required' });
    expect(await driver.mutate({ ...f.context, action })).toMatchObject({ state: 'acknowledged' });
    expect(await driver.recover({ ...f.context, action })).toMatchObject({ state: 'satisfied', evidence: { native: { retirement: { outcome: 'removed', retained: [] } } } });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1); expect(f.calls.some(call => call.path.endsWith(':access'))).toBe(false);
  });
  it.each(['deny', 'extra', 'replace', 'lackRead', 'reader', 'retain', 'replicate', 'echo', 'loop', 'projectReader'] as const)('blocks %s without a deletion or secret echo', async fault => {
    const f = outputFixture(), driver = f.driver(), plan = await driver.plan(f.context); f[fault]();
    const result = await driver.inspect({ ...f.context, action: plan.actions[0] }); expect(result.state).toBe('unknown');
    expect(await driver.mutate({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('synthetic-token'); expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });
  it('classifies actual project role permissions rather than assuming every service-account grant is a secret reader', async () => {
    const f = outputFixture(); f.harmlessRole(); const driver = f.driver(), plan = await driver.plan(f.context);
    expect(await driver.mutate({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'acknowledged' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('leaves an uncertain still-present DELETE pending across repeated recovery without replay', async () => {
    const f = outputFixture(), driver = f.driver(), plan = await driver.plan(f.context); f.leavePresent();
    expect(await driver.mutate({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'uncertain' });
    for (let attempt = 0; attempt < 2; attempt++) expect(await f.driver().recover({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'pending' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('does not dispatch when final local authority is revoked', async () => {
    const f = outputFixture(), driver = f.driver(), plan = await driver.plan(f.context);
    expect(await driver.mutate({ ...f.context, action: plan.actions[0], beforeMutation: async () => { throw Error('revoked'); } })).toMatchObject({ state: 'rejected' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  });
  it('recovers a lost deletion acknowledgment by reads without replay', async () => {
    const f = outputFixture(), driver = f.driver(), plan = await driver.plan(f.context); f.lose();
    expect(await driver.mutate({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'uncertain' });
    expect(await f.driver().recover({ ...f.context, action: plan.actions[0] })).toMatchObject({ state: 'satisfied' });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
});
