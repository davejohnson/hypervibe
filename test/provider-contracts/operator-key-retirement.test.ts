import '../../src/application/providers.js';
import { CommandRegistry } from '../../src/application/commands.js';
import { registerCoreTools } from '../../src/tools/core.tools.js';
import { executePlanApply } from '../../src/application/apply-plan.js';
import { SpecStore } from '../../src/domain/spec/spec.store.js';
import { providerRegistry } from '../../src/domain/registry/provider.registry.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter, getDb } from '../../src/adapters/db/sqlite.adapter.js';
import { CloudScopePreparationRepository } from '../../src/adapters/db/repositories/cloud-scope-preparation.repository.js';
import { createCommandContext } from '../../src/application/context.js';
import { OperatorCredentialCustody } from '../../src/domain/services/operator-credential-custody.js';
import { canonicalJsonSha256 } from '../../src/lib/canonical-json.js';
import { applyCloudInstallationV1, historicalInstallationEvidence, parseCloudInstallationRecordV1, planCloudInstallationV1, reconcileCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../../src/domain/services/cloud-installation-runtime.js';
import type { CloudInstallationDriver, CloudInstallationRecord, OperatorApplicationIntent } from '../../src/domain/ports/cloud-installation.port.js';
import { createSendGridOperatorDriver, createSendGridOperatorCapability, createSendGridRetirementDriver } from '../../src/adapters/providers/sendgrid/sendgrid-operator.js';
import { createGcpOperatorRecaptchaDriver, createGcpOperatorRecaptchaCapability, createGcpRecaptchaRetirementDriver } from '../../src/adapters/providers/gcp/gcp-operator-recaptcha.js';
import { sendGridOperatorFixture, SENDGRID_TEST_TOKEN } from '../../src/adapters/providers/sendgrid/__tests__/sendgrid-operator.fixture.js';
import { getSecretStore } from '../../src/adapters/secrets/secret-store.js';
import { GcpLocalDefaultAuthentication } from '../../src/adapters/providers/gcp/gcp-local-default-authentication.js';
import { recaptchaNativeFixture } from '../../src/adapters/providers/gcp/__tests__/gcp-operator-recaptcha.fixture.js';

// Reconstructed official API transport, not native deletion evidence. The real
// creation drivers and SQLite kernel supply retained ownership and attempt proof.
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-retire-key-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
const providers = ['sendgrid', 'google-recaptcha'] as const;
async function fixture(provider: typeof providers[number], capabilityPath = false) {
  const mail = sendGridOperatorFixture(), captcha = recaptchaNativeFixture(), native = provider === 'sendgrid' ? mail : captcha;
  const app = createCommandContext(), project = app.repos.projects.create({ name: randomUUID(), defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' }),
    environment = app.repos.environments.create({ projectId: project.id, name: 'test' });
  const connection = app.repos.connections.create({ provider: 'sendgrid', scope: 'github.com/acme/operator#environment=test', credentialsEncrypted: getSecretStore().encryptObject({ apiKey: SENDGRID_TEST_TOKEN }) });
  app.repos.connections.updateStatus(connection.id, 'verified');
  const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id, environment: environment.name,
    source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) }, provider, applicationProvider: provider,
    mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
    nativeScope: provider === 'sendgrid' ? { connectionId: connection.id, accountId: mail.accountId, sender: 'operator@example.test', recipient: 'consenting@example.test', name: 'mail', origin: 'https://operator.example.test' }
      : { projectId: captcha.projectId, projectNumber: captcha.projectNumber, name: 'captcha', origin: 'https://operator.example.test' } };
  const declaration = { provider, profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
    nativeScope: Object.fromEntries(Object.entries(intent.nativeScope).filter(([key]) => !['name', 'origin'].includes(key))) };
  const originalSpec = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    environments: { test: { hosting: { provider: 'cloudrun' }, services: {}, operatorApplications: { key: declaration } } } });
  intent.source.specRevision = originalSpec.revision; intent.source.specDigest = canonicalJsonSha256(originalSpec.spec);
  intent.selection = { declarationDigest: canonicalJsonSha256(declaration) };
  const custody = new OperatorCredentialCustody({ projectId: project.id, environmentId: environment.id, installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent), provider });
  let retiring = false, deleted = false, deny = false, lost = false, lostKeeps = false, deniedDelete = false, deniedAfterDelete = false, missingRead = false, wrongScope = false, malformedDelete = false;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), method = init?.method ?? 'GET';
    if (retiring) {
      requests.push({ method, path: u.pathname, body: init?.body });
      expect(u.search).toBe(''); expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${provider === 'sendgrid' ? SENDGRID_TEST_TOKEN : 'synthetic-transient-google-token'}`);
      if (wrongScope && u.pathname === '/v3/user/username') return Response.json({ user_id: 555 });
      if (wrongScope && u.hostname === 'cloudresourcemanager.googleapis.com' && method === 'GET') return Response.json({ name: 'projects/999999999999', projectId: 'another-project', state: 'ACTIVE' });
      if (u.pathname.endsWith(':testIamPermissions')) return Response.json({ permissions: missingRead ? [] : ['recaptchaenterprise.keys.get', 'recaptchaenterprise.keys.delete'] });
      if (missingRead && u.pathname === '/v3/scopes') return Response.json({ scopes: ['user.username.read', 'api_keys.delete'] });
      if (missingRead && (u.pathname === '/v3/api_keys/new-test-key-1' || u.pathname === `/v1/${captcha.keyName}`)) return new Response(null, { status: 404 });
      if (deny || deleted && deniedAfterDelete) return new Response('synthetic-private-token-echo', { status: 403 });
      if (method === 'DELETE') {
        expect(init?.body).toBeUndefined(); expect(u.pathname).toBe(provider === 'sendgrid' ? '/v3/api_keys/new-test-key-1' : `/v1/${captcha.keyName}`);
        if (malformedDelete) return Response.json({ echoed: provider === 'sendgrid' ? SENDGRID_TEST_TOKEN : 'synthetic-transient-google-token' }, { status: provider === 'sendgrid' ? 200 : 201 });
        if (deniedDelete) return new Response('synthetic-private-token-echo', { status: 403 });
        if (!lostKeeps) { deleted = true; if (provider === 'sendgrid') mail.keys.delete('new-test-key-1'); }
        if (lost) throw new Error('synthetic-private-token-echo');
        return provider === 'sendgrid' ? new Response(null, { status: 204 }) : Response.json({});
      }
      if (deleted && u.pathname === `/v1/${captcha.keyName}`) return new Response(null, { status: 404 });
    }
    return native.request(input, init);
  };
  const factory = provider === 'sendgrid' ? createSendGridOperatorDriver : createGcpOperatorRecaptchaDriver;
  let driver: CloudInstallationDriver<OperatorApplicationIntent> = factory({ fetch: request, custody });
  const store = new CloudScopePreparationRepository<CloudInstallationRecord<OperatorApplicationIntent>>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name },
    value => parseCloudInstallationRecordV1(value, driver), { recordType: 'operator-applications:key' });
  let auth = { kind: 'operator-application' as const, administrator: { getAccessToken: async () => provider === 'sendgrid' ? SENDGRID_TEST_TOKEN : 'synthetic-transient-google-token' } };
  const context = () => ({ driver, store, authentication: auth, authorize: async () => true });
  const planned = await planCloudInstallationV1({ ...context(), intent });
  const prior = await applyCloudInstallationV1({ ...context(), installationId: planned.installationId, planDigest: planned.plan.digest, confirmActions: planned.plan.actions.map(a => a.id) });
  expect(prior.status).toBe('scope-ready'); const from = { installationId: prior.installationId, planDigest: prior.plan.digest };
  const next: OperatorApplicationIntent = { ...intent, installationId: randomUUID(), mode: 'retire', predecessor: from,
    retirement: { from, resources: 'delete-owned', data: 'retain', targets: [{ ...from, evidenceDigest: canonicalJsonSha256(historicalInstallationEvidence(prior)) }] } };
  retiring = true;
  // Retirement selects validated history without invoking setup or custody.
  driver = (provider === 'sendgrid' ? createSendGridRetirementDriver : createGcpRecaptchaRetirementDriver)({ fetch: request, targets: [prior] });
  if (capabilityPath) {
    vi.stubGlobal('fetch', request);
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'token').mockResolvedValue('synthetic-transient-google-token');
    vi.spyOn(GcpLocalDefaultAuthentication.prototype, 'request').mockImplementation(request);
    const cap = provider === 'sendgrid' ? createSendGridOperatorCapability() : createGcpOperatorRecaptchaCapability();
    const created = await cap.retirement!.create(next.nativeScope, { projectId: project.id, environmentId: environment.id, installationId: next.installationId, intentDigest: canonicalJsonSha256(next) }, [prior]);
    driver = created.driver; auth = created.authentication as typeof auth;
  }
  const plan = () => planCloudInstallationV1({ ...context(), intent: next });
  const apply = (r: CloudInstallationRecord<OperatorApplicationIntent>, confirmActions = r.plan.actions.map(a => a.id)) => applyCloudInstallationV1({ ...context(), installationId: r.installationId, planDigest: r.plan.digest, confirmActions });
  const recover = (r: CloudInstallationRecord<OperatorApplicationIntent>) => reconcileCloudInstallationV1({ ...context(), installationId: r.installationId, planDigest: r.plan.digest });
  return { provider, prior, next, plan, apply, recover, context, store, requests, mail, captcha, custody, app, project, environment, originalSpec, declaration,
    controls: { deny: (v = true) => { deny = v; }, lost: (keep = false) => { lost = true; lostKeeps = keep; }, denyDelete: (v = true) => { deniedDelete = v; }, denyAfterDelete: () => { deniedAfterDelete = true; }, absent: () => { deleted = true; mail.keys.delete('new-test-key-1'); }, missingRead: () => { missingRead = true; }, wrongScope: () => { wrongScope = true; }, malformedDelete: () => { malformedDelete = true; } },
    restart: () => { SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate(); },
  };
}
describe.each(providers)('%s exact completed operator key retirement', provider => {
  it('reaches the exact retirement through registered hv_spec, saved hv_plan and hv_apply without setup custody', async () => {
    const f = await fixture(provider, true), commands = new CommandRegistry(); registerCoreTools(commands, f.app);
    const capability = providerRegistry.getOperatorApplication(provider)!;
    const setup = vi.spyOn(capability, 'create').mockRejectedValue(new Error('Setup is not retirement'));
    const declaration = { ...f.declaration, retirement: { from: { installationId: f.prior.installationId, planDigest: f.prior.plan.digest }, resources: 'delete-owned', data: 'retain' } };
    const spec = structuredClone(f.originalSpec.spec); spec.environments.test.operatorApplications = { key: declaration as any };
    const written = await commands.execute('hv_spec', { project: f.project.name, spec, replace: true }); expect(written.ok, JSON.stringify(written)).toBe(true);
    const planned: any = await commands.execute('hv_plan', { project: f.project.name, env: 'test' }); expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(planned.data.scope).toBe('operator-applications'); expect(planned.data.actions.map((a: any) => a.type)).toEqual(['destroy']);
    const current = new SpecStore().get(f.project)!;
    const result = await executePlanApply(f.app, { project: f.project, spec: current.spec, specRevision: current.revision,
      planId: planned.data.planId, confirmActions: planned.data.actions.map((a: any) => a.id) });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } }); expect(setup).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1); expect(await f.store.read(f.prior.installationId)).toEqual(f.prior);
  });
  it('uses the registered retirement capability and parses persisted records without setup custody', async () => {
    const f = await fixture(provider, true), plan = await f.plan(); const done = await f.apply(plan);
    const cap = provider === 'sendgrid' ? createSendGridOperatorCapability() : createGcpOperatorRecaptchaCapability();
    expect(cap.parseRecord(JSON.parse(JSON.stringify(done)))).toEqual(done); expect(done.status).toBe('retired');
    expect(() => cap.receipts(done)).toThrow();
  });
  it('retires only the retained key through real SQLite and serialized DELETE, preserving history and unrelated keys', async () => {
    const f = await fixture(provider), before = structuredClone(provider === 'sendgrid' ? f.mail.prior : f.captcha.prior), custody = f.custody.read();
    const plan = await f.plan(); expect(plan.plan.actions).toHaveLength(1); expect(plan.plan.actions[0]).toMatchObject({ type: 'destroy', requiresConfirm: true });
    expect(f.requests.every(r => r.method === 'GET' || r.method === 'POST' && r.path.endsWith(':testIamPermissions'))).toBe(true);
    const completed = await f.apply(plan); expect(completed.status).toBe('retired');
    expect(Object.values(completed.completed)[0].native.retirement).toEqual({ outcome: 'removed', retained: [] });
    expect(await f.store.read(f.prior.installationId)).toEqual(f.prior); expect(f.custody.read()).toEqual(custody);
    expect(provider === 'sendgrid' ? f.mail.keys.get(f.mail.prior.api_key_id) : f.captcha.prior).toEqual(before);
    expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    expect(f.requests.some(r => r.path.includes('retrieveLegacy') || r.path.includes('mail/send') || r.method === 'POST' && !r.path.endsWith(':testIamPermissions'))).toBe(false);
    f.restart(); await f.recover(completed); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    expect(JSON.stringify(getDb().prepare("SELECT plan FROM runs WHERE type LIKE 'operator-applications:%'").all())).not.toMatch(/synthetic-private|synthetic-transient/);
  });
  it('requires exact confirmation and recovers a lost DELETE response without repeating it after restart', async () => {
    const f = await fixture(provider), plan = await f.plan(); await f.apply(plan, []); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
    f.controls.lost(); const pending = await f.apply(plan); f.restart(); const done = await f.recover(pending);
    expect(done.status).toBe('retired'); await f.apply(done); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('keeps an uncertain still-present delete pending and never resubmits it', async () => {
    const f = await fixture(provider), plan = await f.plan(); f.controls.lost(true); const pending = await f.apply(plan);
    f.restart(); const result = await f.recover(pending); expect(result.status).not.toBe('retired'); await f.apply(result);
    expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('does not treat authorization loss after acknowledged deletion as absence', async () => {
    const f = await fixture(provider), plan = await f.plan(); f.controls.denyAfterDelete(); const result = await f.apply(plan);
    expect(result.status).not.toBe('retired'); expect(JSON.stringify(result)).not.toContain('synthetic-private-token-echo');
    await f.recover(result); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('requires a separate retry confirmation after a definite DELETE rejection', async () => {
    const f = await fixture(provider), plan = await f.plan(); f.controls.denyDelete(); const rejected = await f.apply(plan);
    expect(rejected.attempts.at(-1)?.status).toBe('rejected'); f.controls.denyDelete(false);
    await f.apply(rejected); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    const target = { ...f.context(), installationId: plan.installationId, planDigest: plan.plan.digest };
    const retry = await reviewCloudInstallationRetryV1(target);
    const completed = await applyCloudInstallationV1({ ...target, confirmActions: plan.plan.actions.map(a => a.id), retryActions: retry.retryActions });
    expect(completed.status).toBe('retired'); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(2);
  });
  it('preserves a same-named replacement with a different returned identity or lifetime', async () => {
    const f = await fixture(provider), plan = await f.plan();
    if (provider === 'sendgrid') f.mail.keys.get('new-test-key-1').api_key_id = 'different-native-key-id';
    else f.captcha.corrupt(key => { key.createTime = '2026-01-01T00:00:00Z'; });
    const blocked = await f.apply(plan); expect(blocked.status).not.toBe('retired'); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it('recognizes exact authenticated absence without deleting an unrelated same-named key', async () => {
    const f = await fixture(provider); f.controls.absent();
    if (provider === 'sendgrid') f.mail.keys.set('replacement-other-id', { ...f.mail.prior, api_key_id: 'replacement-other-id', name: Object.values(f.prior.completed)[0].resources[0].identity.name });
    const done = await f.apply(await f.plan()); expect(done.status).toBe('retired'); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
    if (provider === 'sendgrid') expect(f.mail.keys.has('replacement-other-id')).toBe(true);
  });
  it('rejects changed historical evidence or an unsupported data disposition before native reads', async () => {
    const f = await fixture(provider); f.next.retirement!.targets[0].evidenceDigest = 'f'.repeat(64);
    await expect(f.plan()).rejects.toThrow(); expect(f.requests).toEqual([]);
    f.next.retirement!.targets[0].evidenceDigest = canonicalJsonSha256(historicalInstallationEvidence(f.prior)); f.next.retirement!.data = 'delete-owned';
    await expect(f.plan()).rejects.toThrow(); expect(f.requests).toEqual([]);
  });
  it('does not accept a concealed 404 without current key-read authority', async () => {
    const f = await fixture(provider); f.controls.missingRead(); await expect(f.plan()).rejects.toThrow();
    expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it('blocks a different native account/project before deletion', async () => {
    const f = await fixture(provider), plan = await f.plan(); f.controls.wrongScope(); const result = await f.apply(plan);
    expect(result.status).not.toBe('retired'); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it('retains malformed DELETE acknowledgments without replay or provider secret echoes', async () => {
    const f = await fixture(provider), plan = await f.plan(); f.controls.malformedDelete(); const result = await f.apply(plan);
    expect(result.attempts.at(-1)?.status).toBe('uncertain'); expect(result.status).not.toBe('retired');
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|synthetic-transient/);
    f.restart(); await f.recover(result); await f.apply(result); expect(f.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('blocks unauthorized metadata reads without sending DELETE', async () => {
    const f = await fixture(provider); f.controls.deny(); await expect(f.plan()).rejects.toThrow(); expect(f.requests.some(r => r.method === 'DELETE')).toBe(false);
  });
});
