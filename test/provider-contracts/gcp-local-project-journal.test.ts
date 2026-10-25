import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../src/adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../src/adapters/db/repositories/environment.repository.js';
import { CloudScopePreparationRepository } from '../../src/adapters/db/repositories/cloud-scope-preparation.repository.js';
import { createGcpLocalProjectAllocationDriver } from '../../src/adapters/providers/gcp/gcp-project-installation.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, parseCloudInstallationRecordV1 } from '../../src/application/hosted/cloud-installation.js';
import type { CloudInstallationContext, CloudInstallationRecord, LocalCloudScopePreparationIntent } from '../../src/domain/ports/cloud-installation.port.js';

// Reconstructed CRM v3 transport, not live evidence:
// https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/create
// https://docs.cloud.google.com/resource-manager/reference/rest/v3/operations/get
// Google returns an operation whose lifetime is hours. Historical completion
// must survive that expiry; current project visibility remains separate evidence.
let directory: string;
let scope: { projectId: string; environmentId: string; environmentName: string };
beforeEach(() => {
  SqliteAdapter.resetInstance(); directory = mkdtempSync(path.join(tmpdir(), 'hv-native-project-journal-'));
  initializeDatabase(path.join(directory, 'state.db'));
  const project = new ProjectRepository().create({ name: 'operator-test-app' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'connect-test' });
  scope = { projectId: project.id, environmentId: environment.id, environmentName: environment.name };
});
afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture(pending = false) {
  let project: Record<string, unknown> | null = null;
  let visibility: 'normal' | 'forbidden' | 'replaced' = 'normal';
  const calls: Array<{ path: string; method: string }> = [];
  const intent: LocalCloudScopePreparationIntent = { schemaVersion: 1, installationId: randomUUID(),
    customerId: scope.projectId, appId: scope.projectId, environment: scope.environmentName, provider: 'gcp', hostingProvider: 'cloudrun',
    mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'local-administrator', authentication: 'google-user-adc' },
    source: { kind: 'local-spec', repository: 'github.com/example/app', specRevision: 1, specDigest: 'a'.repeat(64) },
    nativeScope: { scopeKind: 'project-allocation', allocationMode: 'create-exclusive-v1', projectId: 'local-project', displayName: 'Local Project' } };
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    calls.push({ path: url.pathname, method }); expect(url.host).toBe('cloudresourcemanager.googleapis.com');
    expect(init.redirect).toBe('error');
    if (url.pathname === '/v3/projects/local-project') return project && visibility !== 'forbidden'
      ? Response.json({ ...project, ...(visibility === 'replaced' ? { createTime: '2026-10-25T12:00:00Z' } : {}) })
      : Response.json({}, { status: 403 });
    if (url.pathname === '/v3/projects' && method === 'POST') {
      const retained = await store.read(intent.installationId);
      expect(retained?.attempts.at(-1)?.status).toBe('attempted');
      const body = JSON.parse(String(init.body));
      project = { name: 'projects/123456789', projectId: 'local-project', displayName: 'Local Project', parent: '',
        state: 'ACTIVE', createTime: '2026-10-24T12:00:00Z', labels: body.labels };
      return Response.json({ name: 'operations/pc.123' });
    }
    if (url.pathname === '/v3/operations/pc.123') return Response.json(pending ? { name: 'operations/pc.123' }
      : { name: 'operations/pc.123', done: true, response: { '@type': 'type.googleapis.com/google.cloudresourcemanager.v3.Project', ...project } });
    throw new Error('Unexpected reconstructed native request');
  };
  const driver = createGcpLocalProjectAllocationDriver({ fetch: request });
  const store = new CloudScopePreparationRepository<CloudInstallationRecord<LocalCloudScopePreparationIntent>>(scope,
    value => parseCloudInstallationRecordV1(value, driver));
  const context: CloudInstallationContext<LocalCloudScopePreparationIntent> = { driver, store, authorize: async () => true,
    authentication: { kind: 'local-administrator', administrator: { getAccessToken: async () => 'synthetic-local-user-token' } } };
  return { context, store, intent, calls, drift: (value: typeof visibility) => { visibility = value; } };
}

it.each(['forbidden', 'replaced'] as const)('retains historical native success while durably invalidating current readiness after %s observation', async drift => {
  const f = fixture(); const planned = await planCloudInstallationV1({ ...f.context, intent: f.intent });
  const input = { ...f.context, installationId: f.intent.installationId, planDigest: planned.plan.digest, confirmActions: ['gcp:project'] };
  const complete = await applyCloudInstallationV1(input); expect(complete.status).toBe('scope-ready');
  const proof = complete.attempts[0].evidence; expect(proof?.native.operationName).toBe('operations/pc.123');
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db'));
  f.drift(drift);
  const blocked = await reconcileCloudInstallationV1(input);
  expect(blocked).toMatchObject({ status: 'blocked', reason: 'identity_mismatch', completed: {} });
  expect(blocked.attempts[0]).toMatchObject({ status: 'succeeded', evidence: proof });
  expect(await f.store.read(f.intent.installationId)).toEqual(blocked);
  expect((await applyCloudInstallationV1(input)).status).not.toBe('scope-ready');
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(JSON.stringify(await f.store.read(f.intent.installationId))).not.toContain('synthetic-local-user-token');
  f.drift('normal'); expect((await reconcileCloudInstallationV1(input)).status).toBe('scope-ready');
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

it.each(['succeeded', 'acknowledged'] as const)('cannot erase or substitute retained %s native evidence', async status => {
  const f = fixture(status === 'acknowledged'); const planned = await planCloudInstallationV1({ ...f.context, intent: f.intent });
  const current = await applyCloudInstallationV1({ ...f.context, installationId: f.intent.installationId,
    planDigest: planned.plan.digest, confirmActions: ['gcp:project'] });
  expect(current.attempts[0].status).toBe(status);
  for (const alteration of ['remove', 'substitute', 'regress-status'] as const) {
    const next = structuredClone(current); next.revision++;
    if (alteration === 'remove') delete next.attempts[0].evidence;
    if (alteration === 'substitute') next.attempts[0].evidence!.native.operationName = 'operations/pc.other';
    if (alteration === 'regress-status') next.attempts[0].status = 'attempted';
    await expect(f.store.compareAndSwap(current.installationId, current.revision, next)).rejects.toThrow(/journal/i);
    expect(await f.store.read(current.installationId)).toEqual(current);
  }
});
