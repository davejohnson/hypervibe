import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter, getDb } from '../../../db/sqlite.adapter.js';
import { createCommandContext } from '../../../../application/context.js';
import { OperatorCredentialCustody } from '../../../../domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import type { OperatorApplicationIntent, CloudInstallationRecord } from '../../../../domain/ports/cloud-installation.port.js';
import { createGcpOperatorRecaptchaDriver, createGcpOperatorRecaptchaCapability } from '../gcp-operator-recaptcha.js';
import { GcpLocalDefaultAuthentication } from '../gcp-local-default-authentication.js';
import { recaptchaNativeFixture } from './gcp-operator-recaptcha.fixture.js';

describe('isolated Google CAPTCHA allocation and private capture', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-captcha-native-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  function fixture(options: Parameters<typeof recaptchaNativeFixture>[0] = {}) {
    const native = recaptchaNativeFixture(options), ctx = createCommandContext(), project = ctx.repos.projects.create({ name: randomUUID(), defaultPlatform: 'cloudrun' }),
      environment = ctx.repos.environments.create({ projectId: project.id, name: 'connect-test' });
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id,
      environment: environment.name, source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
      provider: 'google-recaptcha', applicationProvider: 'google-recaptcha', mode: 'connect', stage: 'scope-preparation', keys: [],
      execution: { kind: 'operator-application', authentication: 'local-operator' },
      nativeScope: { projectId: native.projectId, projectNumber: native.projectNumber, name: 'captcha', origin: 'https://operator.example.test' } };
    const custodyContext = { projectId: project.id, environmentId: environment.id, installationId: intent.installationId,
      intentDigest: canonicalJsonSha256(intent), provider: 'google-recaptcha' as const }, custody = new OperatorCredentialCustody(custodyContext);
    let record: CloudInstallationRecord<OperatorApplicationIntent> | undefined;
    const context = { driver: createGcpOperatorRecaptchaDriver({ fetch: native.request, custody }),
      authentication: { kind: 'operator-application' as const, administrator: { getAccessToken: async (scope: string) => {
        expect(scope).toBe('https://www.googleapis.com/auth/cloud-platform'); return 'synthetic-transient-google-token'; } } }, authorize: async () => true,
      store: { read: async () => record ?? null, compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord<OperatorApplicationIntent>) => {
        if ((record?.revision ?? null) !== revision) return false; record = structuredClone(next); return true;
      } } };
    const target = async () => { const planned = await planCloudInstallationV1({ ...context, intent }); return { ...context, installationId: planned.installationId, planDigest: planned.plan.digest }; };
    return { native, intent, context, custody, custodyContext, target, record: () => record! };
  }
  it.each([false, true])('allocates exact SCORE config, preserves production and privately captures with omitted defaults=%s', async omitDefaults => {
    const f = fixture({ enabled: false, omitDefaults }), original = structuredClone(f.native.prior), target = await f.target();
    expect(f.native.writes).toEqual([]); expect(f.native.reads.some(p => p.endsWith('retrieveLegacySecretKey'))).toBe(false);
    let record = await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(record.status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(2); expect(f.native.prior).toEqual(original);
    expect(f.native.writes[1].body).toMatchObject({ webSettings: { integrationType: 'SCORE', allowedDomains: ['operator.example.test'], allowAllDomains: false, allowAmpTraffic: false } });
    expect(f.native.writes[1].body).not.toHaveProperty('testingOptions'); expect(f.native.writes[1].body).not.toHaveProperty('name');
    expect(f.custody.read()?.state.credentials).toEqual({ 'secret-key': 'synthetic-private-captcha-secret' });
    expect(JSON.stringify(record)).not.toContain('synthetic-private-captcha-secret');
    expect(JSON.stringify(getDb().prepare('SELECT * FROM connections').all())).not.toContain('synthetic-private-captcha-secret');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    record = await reconcileCloudInstallationV1(target); expect(record.status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(2);
    expect(f.native.reads.filter(p => p.endsWith('retrieveLegacySecretKey'))).toHaveLength(1);
  });
  it.each(['api', 'key'] as const)('recovers lost %s acknowledgement without resubmission or private read during reconcile', async lost => {
    const f = fixture({ enabled: false, lost }), target = await f.target();
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) }); const count = f.native.writes.length;
    await reconcileCloudInstallationV1(target); expect(f.native.writes).toHaveLength(count);
    expect(f.native.reads.some(p => p.endsWith('retrieveLegacySecretKey'))).toBe(false);
    expect(f.record().completed[`google-recaptcha:captcha:${lost}`]).toBeDefined();
  });
  it('preserves invisible uncertain creates across repeated apply and restart', async () => {
    const f = fixture({ lost: 'key', invisible: true }), target = await f.target(), confirmActions = f.record().plan.actions.map(a => a.id);
    await applyCloudInstallationV1({ ...target, confirmActions });
    await reconcileCloudInstallationV1(target); await applyCloudInstallationV1({ ...target, confirmActions });
    expect(f.native.writes).toHaveLength(1); expect(f.record().status).not.toBe('scope-ready'); expect(f.custody.read()).toBeNull();
  });
  it.each([{ createStatus: 201 }, { wrongKeyConfig: true }])('does not replay an unverified create response: %o', async options => {
    const f = fixture(options), target = await f.target(), confirmActions = f.record().plan.actions.map(a => a.id);
    await applyCloudInstallationV1({ ...target, confirmActions });
    expect(f.record().attempts.find(a => a.actionId.endsWith(':key'))?.status).toBe('uncertain');
    await reconcileCloudInstallationV1(target); expect(f.native.writes).toHaveLength(1);
    expect(f.native.reads.some(p => p.endsWith('retrieveLegacySecretKey'))).toBe(false);
  });
  it.each([{ denied: true }, { wrongProject: true }, { partial: true }])('blocks unknown project/permission/inventory evidence before writes: %o', async options => {
    const f = fixture(options); await expect(f.target()).rejects.toThrow(); expect(f.native.writes).toEqual([]);
  });
  it('requires exact confirmation before creating or retrieving credentials', async () => {
    const f = fixture(), target = await f.target(); await applyCloudInstallationV1({ ...target, confirmActions: [] });
    expect(f.native.writes).toEqual([]); expect(f.custody.read()).toBeNull();
  });
  it.each(['allowAllDomains', 'testingOptions', 'createTime', 'origin'] as const)('blocks changed %s before private capture', async field => {
    const f = fixture(), target = await f.target(), keyAction = f.record().plan.actions[1].id;
    const apiAction = f.record().plan.actions[0].id;
    await applyCloudInstallationV1({ ...target, confirmActions: [apiAction], onlyActionId: apiAction });
    await applyCloudInstallationV1({ ...target, confirmActions: [keyAction], onlyActionId: keyAction });
    f.native.corrupt(value => { if (field === 'allowAllDomains') value.webSettings.allowAllDomains = true;
      else if (field === 'testingOptions') value.testingOptions = { testingScore: 1 };
      else if (field === 'createTime') value.createTime = '2025-01-01T00:00:00Z'; else value.webSettings.allowedDomains = ['other.example.test']; });
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(f.custody.read()).toBeNull(); expect(f.native.reads.some(p => p.endsWith('retrieveLegacySecretKey'))).toBe(false);
  });
  it('can separately review a definite create rejection without repeating an uncertain request', async () => {
    const options = { deniedCreate: true }, f = fixture(options), target = await f.target();
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(f.record().attempts.at(-1)?.status).toBe('rejected'); options.deniedCreate = false;
    const retry = await reviewCloudInstallationRetryV1(target);
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id), retryActions: retry.retryActions });
    expect(f.record().status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(1);
  });
  it('retains capture after a post-commit custody failure without retrieving the secret again', async () => {
    const f = fixture(), target = await f.target(), original = f.custody.storeCredentials.bind(f.custody);
    vi.spyOn(f.custody, 'storeCredentials').mockImplementation((...args) => { original(...args); throw new Error('Synthetic lost local acknowledgment'); });
    await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    await reconcileCloudInstallationV1(target);
    expect(f.record().status).toBe('scope-ready'); expect(f.native.writes).toHaveLength(1);
    expect(f.native.reads.filter(p => p.endsWith('retrieveLegacySecretKey'))).toHaveLength(1);
  });
  it('never exposes rejected retrieval bodies or transient access tokens', async () => {
    const f = fixture({ secretFailure: true }), target = await f.target();
    const record = await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(record.status).not.toBe('scope-ready'); expect(f.custody.read()).toBeNull();
    expect(JSON.stringify(record)).not.toMatch(/synthetic-private-captcha-secret|synthetic-transient-google-token/);
  });
  it('treats the documented legacy secret string as opaque instead of inventing a token grammar', async () => {
    const secret = 'synthetic:opaque/provider+credential=value', f = fixture({ legacySecret: secret }), target = await f.target();
    const record = await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(record.status).toBe('scope-ready'); expect(f.custody.read()?.state.credentials?.['secret-key']).toBe(secret);
    expect(JSON.stringify(record)).not.toContain(secret);
  });
  it('refuses a live capability without exact private custody context before reading credentials', async () => {
    const auth = vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'initialize').mockResolvedValue();
    await expect(createGcpOperatorRecaptchaCapability().create({ projectId: 'owned-project', projectNumber: '123456789012', name: 'captcha', origin: 'https://operator.example.test' }))
      .rejects.toThrow();
    expect(auth).not.toHaveBeenCalled();
  });
  it('does not report native capture as delivered without an immutable output receipt', async () => {
    const f = fixture(), target = await f.target();
    const nativeOnly = await applyCloudInstallationV1({ ...target, confirmActions: f.record().plan.actions.map(a => a.id) });
    expect(nativeOnly.status).toBe('scope-ready');
    expect(() => createGcpOperatorRecaptchaCapability().receipts(nativeOnly)).toThrow();
  });
});
