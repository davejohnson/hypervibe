import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { PlanService } from '../../domain/plan/plan.service.js';

import { sendGridOperatorFixture, SENDGRID_RUNTIME_TOKEN, SENDGRID_TEST_TOKEN } from '../../adapters/providers/sendgrid/__tests__/sendgrid-operator.fixture.js';
import { GcpLocalDefaultAuthentication } from '../../adapters/providers/gcp/gcp-local-default-authentication.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { OperatorCredentialCustody } from '../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';

describe('operator SendGrid runtime key desired state', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-sendgrid-operator-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  it('admits reviewed send-only issuance through the existing provider and requires verified origin', async () => {
    const f = await localHoldingApplicationFixture(), desired: any = structuredClone(f.desired);
    delete desired.environments.staging.hosting.preparation;
    desired.environments.staging.operatorApplications = { mail: { provider: 'sendgrid', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
      nativeScope: { connectionId: '11111111-1111-4111-8111-111111111111', accountId: '12345', sender: 'operator@example.test', recipient: 'consenting@example.test' },
      outputs: { 'api-key': 'SENDGRID_API_KEY' } } };
    f.store.replace(f.project, desired);
    expect(f.store.get(f.project)!.spec.environments.staging.operatorApplications).toEqual(desired.environments.staging.operatorApplications);
    expect(await new PlanService().plan(f.project, 'staging')).toMatchObject({ error: expect.stringMatching(/operator application.*origin/i) });
    expect(f.native.writes).toEqual([]);
  });
  it('uses actual SQLite, reviewed native issuance and immutable delivery without deploying management access', async () => {
    const f = await localHoldingApplicationFixture();
    for (let step = 0; step < 2; step++) {
      const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
      expect(await f.apply(plan.planRunId, plan.actions.filter(a => a.requiresConfirm).map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    }
    const native = sendGridOperatorFixture(), connection = f.ctx.repos.connections.create({ provider: 'sendgrid', scope: 'github.com/acme/operator#environment=staging', credentialsEncrypted: getSecretStore().encryptObject({ apiKey: SENDGRID_TEST_TOKEN }) });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'token').mockResolvedValue('synthetic-transient-google-token');
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'request').mockImplementation((input, init) => fetch(input, init));
    const resource = 'projects/123456789012/secrets/mail-private', containerWrites: string[] = []; let container: any, written = false;
    vi.stubGlobal('fetch', (input: any, init: any) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET';
      if (url.hostname === 'api.sendgrid.com') return native.request(input, init);
      if (url.hostname === 'secretmanager.googleapis.com') {
        if (method === 'POST' && url.pathname === '/v1/projects/123456789012/secrets') {
          const body = JSON.parse(String(init.body)); containerWrites.push('container'); container = { name: resource, createTime: new Date().toISOString(), labels: body.labels }; return Promise.resolve(Response.json(container));
        }
        if (method === 'POST' && url.pathname === `/v1/${resource}:addVersion`) {
          expect(JSON.parse(String(init.body))).toEqual({ payload: { data: Buffer.from(SENDGRID_RUNTIME_TOKEN).toString('base64') } });
          expect(String(init.body)).not.toContain(Buffer.from(SENDGRID_TEST_TOKEN).toString('base64'));
          containerWrites.push('version'); written = true; return Promise.resolve(Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' }));
        }
        if (url.pathname === `/v1/${resource}/versions/1`) return Promise.resolve(Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' }));
        if (url.pathname === `/v1/${resource}/versions`) return Promise.resolve(Response.json(written ? { versions: [{ name: `${resource}/versions/1` }] } : {}));
        if (url.pathname === `/v1/${resource}`) return Promise.resolve(container ? Response.json(container) : new Response(null, { status: 404 }));
        throw new Error('Unexpected reconstructed secret endpoint');
      }
      return f.native.request(input, init);
    });
    const adapter = new CloudRunAdapter(); await adapter.connect({ authMode: 'default', projectId: f.native.scope.projectId, region: f.native.scope.region });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter }); const deploy = vi.spyOn(adapter, 'deploy');
    const desired: any = structuredClone(f.desired);
    desired.environments.staging.operatorApplications = { mail: { provider: 'sendgrid', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
      nativeScope: { connectionId: connection.id, accountId: native.accountId, sender: 'operator@example.test', recipient: 'consenting@example.test' }, outputs: { 'api-key': 'SENDGRID_API_KEY' } } };
    desired.secrets.SENDGRID_API_KEY = { ownership: 'delegated', principal: 'email:operator@example.test', environments: ['staging'], required: true };
    desired.environments.staging.secretDestinations = { SENDGRID_API_KEY: { destination: { provider: 'gcp-secret-manager', projectId: f.native.scope.projectId,
      projectNumber: f.native.scope.projectNumber, secretId: 'mail-private' } } };
    f.store.replace(f.project, desired);
    const prerequisite = await f.plan(); if ('error' in prerequisite) throw new Error(prerequisite.error);
    expect(prerequisite.scope).toBe('secret-destinations'); expect(native.writes).toEqual([]);
    expect(await f.apply(prerequisite.planRunId, prerequisite.actions.filter(a => a.requiresConfirm).map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
    const first = await f.plan(); if ('error' in first) throw new Error(first.error); expect(first.scope).toBe('operator-applications'); expect(first.actions).toHaveLength(2);
    await f.apply(first.planRunId, []); expect(native.writes).toEqual([]);
    const reviewed = await f.plan(); if ('error' in reviewed) throw new Error(reviewed.error);
    const applied = await f.apply(reviewed.planRunId, reviewed.actions.filter(a => a.requiresConfirm).map(a => a.id));
    expect(applied).toMatchObject({ kind: 'executed', result: { success: true } }); expect(JSON.stringify(applied)).not.toMatch(/synthetic-private/);
    expect(native.writes).toHaveLength(2); expect(containerWrites).toEqual(['container', 'version']); expect(deploy).not.toHaveBeenCalled();
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); await f.plan();
    expect(native.writes).toHaveLength(2); expect(containerWrites).toEqual(['container', 'version']);
    const rows = f.ctx.repos.runs.findByProjectId(f.project.id).filter(r => r.type === 'operator-applications:mail'); expect(rows).toHaveLength(1);
    const record = rows[0].plan as any, custody = new OperatorCredentialCustody({ projectId: f.project.id, environmentId: f.environment.id, installationId: record.installationId,
      intentDigest: canonicalJsonSha256(record.intent), provider: 'sendgrid' });
    expect(custody.read()?.state).toMatchObject({ phase: 'delivered', deliveries: { SENDGRID_API_KEY: { reference: { version: '1' } } } });
    expect(custody.read()?.state).not.toHaveProperty('credentials'); expect(JSON.stringify(rows)).not.toMatch(/synthetic-private/);
    expect(f.ctx.repos.connections.findById(connection.id)?.credentialsEncrypted).toBe(connection.credentialsEncrypted);
  });
});
