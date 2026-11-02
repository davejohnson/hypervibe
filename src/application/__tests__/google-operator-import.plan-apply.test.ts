import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { localHoldingApplicationFixture } from './local-holding-preparation.fixture.js';
import { verifiedLocalHoldingReceipt } from '../../domain/services/local-holding-preparation.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createGcpSecretContainerSetup } from '../../adapters/providers/gcp/gcp-secret-container.js';
import { createGcpOperatorOutputClient } from '../../adapters/providers/gcp/gcp-operator-output.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { OperatorCredentialCustody } from '../../domain/services/operator-credential-custody.js';
import type { CloudInstallationRecord, OperatorApplicationIntent } from '../../domain/ports/cloud-installation.port.js';
let directory: string, db: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-google-import-application-')); db = path.join(directory, 'state.db');
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(db).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

// The actual native holding/container/import/delivery programs and SQLite plans
// are composed here; only native transports and transient token acquisition are
// synthetic. This is not a live Google browser-authorization exchange.
it.each([false, true])('imports and delivers Google private configuration through the real first-installation plan, lost delivery ACK=%s', async lost => {
  const f = await localHoldingApplicationFixture();
  for (let step = 0; step < 2; step++) { const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    expect(await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id)))
      .toMatchObject({ kind: 'executed', result: { success: true } }); }
  const holding = await verifiedLocalHoldingReceipt(f.project, f.ctx.repos.environments.findById(f.environment.id)!);
  const secret = 'synthetic-private-google-client-secret', clientId = '123456789012-ownerclient.apps.googleusercontent.com';
  const source = path.join(directory, 'owner-client.json');
  writeFileSync(source, JSON.stringify({ web: { project_id: f.native.scope.projectId, client_id: clientId, client_secret: secret,
    auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth', token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: [`${holding!.origins.web}/cloud-authorizations/gcp`] } }), { mode: 0o600 });
  const key = 'CLOUD_CONNECT_GOOGLE_CLIENT_SECRET', resource = `projects/${f.native.scope.projectNumber}/secrets/operator-google-client`;
  let container: Record<string, unknown> | undefined, version = false;
  const writes: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'secretmanager.googleapis.com') return f.native.request(input, init);
    if (init?.method === 'POST' && url.pathname.endsWith('/secrets')) {
      expect(container).toBeUndefined(); const body = JSON.parse(String(init.body));
      container = { name: resource, createTime: '2026-10-27T00:00:00Z', ...body }; writes.push('empty-container'); return Response.json(container);
    }
    if (init?.method === 'POST' && url.pathname.endsWith(':addVersion')) {
      expect(JSON.parse(String(init.body))).toEqual({ payload: { data: Buffer.from(secret).toString('base64') } });
      writes.push('private-version'); version = true;
      if (lost) throw new Error('Synthetic lost addVersion acknowledgement');
      return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
    }
    if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
    if (url.pathname.endsWith('/versions')) return Response.json(version ? { versions: [{ name: `${resource}/versions/1` }] } : {});
    return container ? Response.json(container) : Response.json({}, { status: 404 });
  };
  vi.stubGlobal('fetch', request);
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { secretDestinationSetup:
    createGcpSecretContainerSetup({ projectId: f.native.scope.projectId, getAccessToken: async () => 'synthetic-transient-token' }, { fetch: request }) } } as any);
  vi.spyOn(providerRegistry.getOperatorOutputDelivery('cloudrun')!, 'create').mockImplementation(async binding =>
    createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-transient-token', request }));
  const desired: any = structuredClone(f.desired);
  desired.environments.staging.secretDestinations = { [key]: { destination: { provider: 'gcp-secret-manager', projectId: f.native.scope.projectId,
    projectNumber: f.native.scope.projectNumber, secretId: 'operator-google-client' } } };
  desired.environments.staging.operatorApplications = { google: { provider: 'google-oauth', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
    nativeScope: { projectId: f.native.scope.projectId, credentialsRef: `file:${source}` }, outputs: { 'client-secret': key } } };
  f.store.replace(f.project, desired);
  let record: CloudInstallationRecord<OperatorApplicationIntent> | undefined;
  for (let step = 0; step < 5; step++) {
    const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    expect(['secret-destinations', 'operator-applications']).toContain(plan.scope);
    expect(JSON.stringify(plan)).not.toContain(secret);
    const result = await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(JSON.stringify(result)).not.toContain(secret);
    record = f.ctx.repos.runs.findByProjectId(f.project.id).find(row => row.type === 'operator-applications:google')?.plan as unknown as typeof record;
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(db).migrate();
    if (record?.status === 'scope-ready' || lost && writes.includes('private-version')) break;
  }
  expect(writes).toEqual(['empty-container', 'private-version']); expect(record).toBeDefined();
  const custody = new OperatorCredentialCustody({ projectId: f.project.id, environmentId: f.environment.id, installationId: record!.installationId,
    intentDigest: canonicalJsonSha256(record!.intent), provider: 'google-oauth' });
  if (lost) {
    const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
    await f.apply(plan.planRunId, plan.actions.filter(action => action.requiresConfirm).map(action => action.id));
    expect(writes).toEqual(['empty-container', 'private-version']); expect(custody.read()!.state.phase).toBe('credentials-stored');
    expect(custody.read()!.state.deliveries![key].status).toBe('uncertain');
  } else {
    expect(record!.status).toBe('scope-ready');
    const receipts = providerRegistry.getOperatorApplication('google-oauth')!.receipts(record!);
    expect(receipts).toContainEqual(expect.objectContaining({ clientId, browserExchange: 'unverified', configuration: 'imported-unverified' }));
    expect(receipts).toContainEqual(expect.objectContaining({ key, reference: expect.stringContaining('"version":"1"') }));
    expect(custody.read()!.state.phase).toBe('delivered'); expect(custody.read()!.state.credentials).toBeUndefined();
  }
  expect(JSON.stringify(f.ctx.repos.runs.findByProjectId(f.project.id))).not.toContain(secret);
  expect(readFileSync(db).includes(Buffer.from(secret))).toBe(false);
});
