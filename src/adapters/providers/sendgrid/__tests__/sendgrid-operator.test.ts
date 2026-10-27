import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { SqliteAdapter, getDb } from '../../../db/sqlite.adapter.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import { createCommandContext } from '../../../../application/context.js';
import { OperatorCredentialCustody } from '../../../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import type { OperatorApplicationIntent, CloudInstallationRecord } from '../../../../domain/ports/cloud-installation.port.js';
import { createSendGridOperatorDriver, createSendGridOperatorCapability } from '../sendgrid-operator.js';
import { sendGridOperatorFixture, SENDGRID_RUNTIME_TOKEN, SENDGRID_TEST_TOKEN } from './sendgrid-operator.fixture.js';

const raw = readFileSync('test/provider-contracts/sendgrid/api-keys.openapi.json', 'utf8'), source = JSON.parse(readFileSync('test/provider-contracts/sendgrid/api-keys.source.json', 'utf8'));
const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(JSON.parse(raw), 'sendgrid-keys');
const validCreate = ajv.compile({ $ref: 'sendgrid-keys#/paths/~1v3~1api_keys/post/requestBody/content/application~1json/schema' });
describe('SendGrid one-time send-only runtime key lifecycle', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-sendgrid-native-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  function fixture(options: Parameters<typeof sendGridOperatorFixture>[0] = {}) {
    const native = sendGridOperatorFixture(options), ctx = createCommandContext(), project = ctx.repos.projects.create({ name: randomUUID(), defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' }),
      environment = ctx.repos.environments.create({ projectId: project.id, name: 'connect-test' });
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id,
      environment: environment.name, source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
      provider: 'sendgrid', applicationProvider: 'sendgrid', mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
      nativeScope: { connectionId: randomUUID(), accountId: native.accountId, name: 'mail', sender: 'operator@example.test', recipient: 'consenting@example.test', origin: 'https://operator.example.test' } };
    const custody = new OperatorCredentialCustody({ projectId: project.id, environmentId: environment.id, installationId: intent.installationId,
      intentDigest: canonicalJsonSha256(intent), provider: 'sendgrid' }); let record: CloudInstallationRecord<OperatorApplicationIntent> | undefined;
    const context = { driver: createSendGridOperatorDriver({ fetch: native.request, custody }), authentication: { kind: 'operator-application' as const,
      administrator: { getAccessToken: async (scope: string) => { expect(scope).toBe('https://api.sendgrid.com'); return SENDGRID_TEST_TOKEN; } } }, authorize: async () => true,
      store: { read: async () => record ?? null, compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord<OperatorApplicationIntent>) => {
        if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
      } } };
    const target = async () => { const planned = await planCloudInstallationV1({ ...context, intent }); return { ...context, installationId: planned.installationId, planDigest: planned.plan.digest }; };
    const apply = async () => { const input = await target(); return applyCloudInstallationV1({ ...input, confirmActions: record!.plan.actions.map(a => a.id) }); };
    return { native, intent, context, custody, target, apply, ctx, project, environment, record: () => record! };
  }
  it.each([false, true])('allocates only mail.send, privately captures before acknowledgement and preserves all existing keys; envelope=%s', async getEnvelope => {
    const f = fixture({ getEnvelope }), target = await f.target(); expect(f.native.writes).toEqual([]);
    const record = await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(record.status).toBe('scope-ready'); expect(f.native.writes.map(w => `${w.method} ${w.path}`)).toEqual(['POST /v3/api_keys', 'POST /v3/mail/send']);
    expect(f.native.keys.get(f.native.prior.api_key_id)).toEqual(f.native.prior);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(source.schemaSha256);
    expect(validCreate(f.native.writes[0].body), JSON.stringify(validCreate.errors)).toBe(true);
    expect(f.custody.read()?.state.credentials).toEqual({ 'api-key': SENDGRID_RUNTIME_TOKEN });
    expect(JSON.stringify(record)).not.toMatch(/synthetic-private/); expect(JSON.stringify(getDb().prepare('SELECT * FROM connections').all())).not.toContain(SENDGRID_RUNTIME_TOKEN);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    await reconcileCloudInstallationV1(target); expect(f.native.writes).toHaveLength(2);
    expect(() => createSendGridOperatorCapability().receipts(f.record())).toThrow(); // capture is not delivered
  });
  it.each([{ wrongAccount: true }, { senderUnknown: true }, { deniedRead: true }])('blocks changed account, sender or permissions before effects: %o', async options => {
    const f = fixture(options); await expect(f.target()).rejects.toThrow(); expect(f.native.writes).toEqual([]);
  });
  it.each(['domain', 'single'] as const)('reviews actual read routes and existing scope evidence without requiring both sender paths: %s', async senderPath => {
    const f = fixture({ senderPath }); await f.target(); const reviewed = f.record().plan.review.permissions.flatMap(p => p.actions);
    expect(reviewed).toContain('GET /v3/scopes'); expect(reviewed).toContain('GET /v3/whitelabel/domains'); expect(reviewed).toContain('GET /v3/verified_senders');
    expect(reviewed).toContain(senderPath === 'domain' ? 'whitelabel.read' : 'user.email.read'); expect(f.native.writes).toEqual([]);
  });
  it('does not require optional names on unrelated inventory entries', async () => {
    const f = fixture(); delete f.native.keys.get(f.native.prior.api_key_id).name; await f.apply();
    expect(f.record().status).toBe('scope-ready'); expect(f.native.keys.get(f.native.prior.api_key_id)).not.toHaveProperty('name');
  });
  it('requires exact confirmation before one-time key creation or sandbox request', async () => {
    const f = fixture(), target = await f.target(); await applyCloudInstallationV1({ ...target, confirmActions: [] }); expect(f.native.writes).toEqual([]);
  });
  it.each([{ lostCreate: true }, { badResponse: true }])('does not adopt by name or replay a lost/invalid one-time create response: %o', async options => {
    const f = fixture(options), target = await f.target(), confirmActions = f.record().plan.actions.map(a => a.id);
    await applyCloudInstallationV1({ ...target, confirmActions }); await reconcileCloudInstallationV1(target); await applyCloudInstallationV1({ ...target, confirmActions });
    expect(f.record().status).not.toBe('scope-ready'); expect(f.native.writes).toHaveLength(1); expect(f.custody.read()).toBeNull();
  });
  it('rejects credential echoes masquerading as native IDs before public evidence or cleanup', async () => {
    const f = fixture({ echoedPrivateId: true }); await f.apply();
    expect(JSON.stringify(f.record())).not.toContain(SENDGRID_RUNTIME_TOKEN); expect(f.native.writes).toHaveLength(1);
    expect(f.record().attempts.at(-1)?.status).toBe('uncertain');
  });
  it('never cleans up a returned pre-existing native identity', async () => {
    const f = fixture({ returnExisting: true }); await f.apply(); expect(f.native.writes).toHaveLength(1); expect(f.native.keys.get(f.native.prior.api_key_id)).toEqual(f.native.prior);
  });
  it.each([{ sandboxStatus: 401 }, { broadCreated: true }])('cleans up only the acknowledged new ID after rejected private verification: %o', async options => {
    const f = fixture(options); await f.apply(); expect(f.record().attempts.at(-1)?.status).toBe('rejected');
    expect(f.native.writes.at(-1)).toMatchObject({ method: 'DELETE', path: '/v3/api_keys/new-test-key-1' }); expect(f.native.keys.size).toBe(1); expect(f.custody.read()).toBeNull();
  });
  it('cleans up a failed private capture but keeps a successfully committed capture after lost local acknowledgement', async () => {
    const f = fixture(), original = f.custody.storeCredentials.bind(f.custody);
    vi.spyOn(f.custody, 'storeCredentials').mockImplementation((...args) => { original(...args); throw new Error('Synthetic lost custody acknowledgement'); });
    await f.apply(); expect(f.record().status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(2); expect(f.custody.read()?.state.phase).toBe('credentials-stored');
  });
  it('retains exact incomplete cleanup and never automatically resubmits create/delete', async () => {
    const f = fixture({ deniedDelete: true }), target = await f.target(); vi.spyOn(f.custody, 'storeCredentials').mockImplementation(() => { throw new Error('Synthetic private capture failure'); });
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(f.record().attempts.at(-1)?.evidence).toMatchObject({ resources: [{ id: 'new-test-key-1' }], native: { phase: 'cleanup-required' } });
    await reconcileCloudInstallationV1(target); await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(f.native.writes.filter(w => w.method === 'DELETE')).toHaveLength(1); expect(f.native.writes.filter(w => w.path === '/v3/api_keys')).toHaveLength(1);
    expect(f.record().status).not.toBe('scope-ready'); expect(JSON.stringify(f.record())).not.toMatch(/synthetic-private/);
  });
  it('keeps failed sandbox evidence unverified when exact cleanup is incomplete', async () => {
    const f = fixture({ sandboxStatus: 401, deniedDelete: true }); await f.apply();
    expect(f.record().attempts.at(-1)?.evidence).toMatchObject({ resources: [{ identity: { sandbox: 'unverified' } }], native: { phase: 'cleanup-required' } });
  });
  it('does not widen a changed issued key or run sandbox again during read-only recovery', async () => {
    const f = fixture(), target = await f.target(); await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    f.native.keys.get('new-test-key-1').scopes.push('alerts.read'); await reconcileCloudInstallationV1(target);
    expect(f.record().status).not.toBe('scope-ready'); expect(f.native.writes).toHaveLength(2);
  });
  it('rechecks changed native authority after review before any creation', async () => {
    const options = { wrongAccount: false }, f = fixture(options), target = await f.target(); options.wrongAccount = true;
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) }); expect(f.native.writes).toEqual([]);
  });
  it('isolates another app in the same account and never cleans up its key', async () => {
    const first = fixture(); await first.apply(); const second = fixture();
    second.context.driver = createSendGridOperatorDriver({ fetch: first.native.request, custody: second.custody });
    vi.spyOn(second.custody, 'storeCredentials').mockImplementation(() => { throw new Error('Synthetic private capture failure'); });
    await second.apply(); expect(second.record().attempts.at(-1)?.status).toBe('rejected');
    expect(first.native.keys.has('new-test-key-1')).toBe(true); expect(first.native.keys.has('new-test-key-2')).toBe(false);
    expect(first.native.writes.filter(w => w.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/v3/api_keys/new-test-key-2' }]);
    expect(first.custody.read()?.state.credentials?.['api-key']).toBe(SENDGRID_RUNTIME_TOKEN); expect(second.custody.read()).toBeNull();
  });
  it.each(['another/repository', 'github.com/acme/operator#environment=production', null])('rejects an unrelated or unreviewed global management scope before private access: %s', async scope => {
    const f = fixture(), row = f.ctx.repos.connections.create({ provider: 'sendgrid', scope, credentialsEncrypted: getSecretStore().encryptObject({ apiKey: SENDGRID_TEST_TOKEN }) });
    f.ctx.repos.connections.updateStatus(row.id, 'verified');
    const created = await createSendGridOperatorCapability().create({ ...f.intent.nativeScope, connectionId: row.id }, { projectId: f.project.id, environmentId: f.environment.id,
      installationId: f.intent.installationId, intentDigest: canonicalJsonSha256(f.intent) });
    await expect(created.authentication.administrator!.getAccessToken('https://api.sendgrid.com', new AbortController().signal)).rejects.toThrow();
  });
  it('permits separately reviewed retry only after native definite rejection', async () => {
    const options = { deniedCreate: true }, f = fixture(options), target = await f.target(); await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    options.deniedCreate = false; const retry = await reviewCloudInstallationRetryV1(target);
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id), retryActions: retry.retryActions }); expect(f.record().status).toBe('scope-ready');
  });
});
