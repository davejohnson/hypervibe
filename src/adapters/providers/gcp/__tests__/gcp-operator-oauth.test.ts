import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../../../../application/providers.js';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { SecretStore } from '../../../secrets/secret-store.js';
import { createCommandContext } from '../../../../application/context.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { CloudScopePreparationRepository } from '../../../db/repositories/cloud-scope-preparation.repository.js';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { OperatorCredentialCustody } from '../../../../domain/services/operator-credential-custody.js';
import type { OperatorApplicationIntent } from '../../../../domain/ports/cloud-installation.port.js';

// Reconstructed confidential-web JSON from Google's client-secrets format guide:
// https://googleapis.github.io/google-api-python-client/docs/client-secrets.html
// Project selection and exact single callback are our isolation policy; the JSON
// itself is not native ownership or a successful browser-exchange observation.
const secret = 'synthetic-google-client-secret-do-not-output';
const clientId = '123456789012-syntheticclient.apps.googleusercontent.com';
const origin = 'https://operator.example.test';
const body = () => ({ web: { client_id: clientId, client_secret: secret, project_id: 'operator-project',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', redirect_uris: [`${origin}/cloud-authorizations/gcp`], javascript_origins: [] } });

describe('Google operator owner-selected confidential web configuration', () => {
  let directory: string, db: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-google-owner-import-')); db = path.join(directory, 'state.db');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(db).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture(config: unknown = body()) {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test' });
    const file = path.join(directory, 'owner-selected.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const capability = providerRegistry.getOperatorApplication('google-oauth');
    expect(capability, 'Google owner JSON import must be reachable through the real registry').toBeDefined();
    const nativeScope = capability!.parseDeclaration({ name: 'google', origin, runtimeIdentity: { kind: 'gcp-service-account',
      projectId: 'operator-project', projectNumber: '123456789012', serviceAccountEmail: 'operator@operator-project.iam.gserviceaccount.com', serviceAccountUniqueId: '123456789012345678901' },
      declaration: { provider: 'google-oauth', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web',
        nativeScope: { projectId: 'operator-project', credentialsRef: `file:${file}` }, outputs: { 'client-secret': 'GOOGLE_CLIENT_SECRET' } } });
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id, environment: 'test',
      source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
      provider: 'google-oauth', applicationProvider: 'google-oauth', mode: 'connect', stage: 'scope-preparation', keys: [],
      execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope };
    const local = { projectId: project.id, environmentId: environment.id, installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent) };
    const selected = await capability!.create(nativeScope, local);
    const journal = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: 'test' },
      value => capability!.parseRecord(value), { recordType: 'operator-applications:google' });
    const context = { ...selected, store: journal, authorize: async () => true };
    const custody = new OperatorCredentialCustody({ ...local, provider: 'google-oauth' });
    return { ctx, capability: capability!, intent, context, custody, file, journal };
  }
  it('reviews the public client identity and imports privately through the persisted lifecycle without claiming native verification', async () => {
    const f = await fixture(), network = vi.spyOn(globalThis, 'fetch');
    const plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(JSON.stringify(plan)).toContain(clientId); expect(JSON.stringify(plan)).not.toContain(secret);
    expect(f.custody.read()).toBeNull();
    expect(plan.plan.actions).toMatchObject([{ requiresConfirm: true, type: 'create' }]);
    const record = await applyCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    expect(record.status).toBe('scope-ready');
    expect(f.capability.receipts(record)).toContainEqual(expect.objectContaining({ clientId, projectId: 'operator-project',
      callback: `${origin}/cloud-authorizations/gcp`, configuration: 'imported-unverified', browserExchange: 'unverified' }));
    expect(f.custody.read()!.state.credentials).toEqual({ 'client-secret': secret });
    expect(JSON.stringify(record)).not.toContain(secret); expect(readFileSync(db).includes(Buffer.from(secret))).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
  it('recovers encrypted capture after a lost local acknowledgment without reading or importing the JSON again', async () => {
    const f = await fixture(), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    const original = OperatorCredentialCustody.prototype.storeCredentials;
    const capture = vi.spyOn(OperatorCredentialCustody.prototype, 'storeCredentials').mockImplementationOnce(function (this: OperatorCredentialCustody, ...args) {
      original.apply(this, args); throw new Error('Synthetic lost private capture acknowledgment');
    });
    await applyCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
    unlinkSync(f.file); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(db).migrate();
    const recovered = await reconcileCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest });
    expect(recovered.status).toBe('scope-ready'); expect(capture).toHaveBeenCalledTimes(1); expect(JSON.stringify(recovered)).not.toContain(secret);
  });

  it('blocks a changed public client identity after review and requires exact confirmation before capture', async () => {
    const f = await fixture(), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    const request = { ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest };
    expect((await applyCloudInstallationV1({ ...request, confirmActions: [] })).reason).toBe('confirmation_required');
    expect(f.custody.read()).toBeNull();
    const changed = body(); changed.web.client_id = '123456789012-anotherclient.apps.googleusercontent.com';
    writeFileSync(f.file, JSON.stringify(changed), { mode: 0o600 });
    const result = await applyCloudInstallationV1({ ...request, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('blocked'); expect(f.custody.read()).toBeNull(); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('rejects changed private configuration under the same reviewed client identity after restart', async () => {
    const f = await fixture(), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    const changed = body(); changed.web.client_secret = 'synthetic-changed-private-value';
    writeFileSync(f.file, JSON.stringify(changed), { mode: 0o600 });
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(db).migrate();
    const result = await applyCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('blocked'); expect(f.custody.read()).toBeNull();
    expect(JSON.stringify(result)).not.toContain(changed.web.client_secret);
  });
  it('recomputes the same private configuration commitment after restart and harmless JSON formatting changes', async () => {
    const f = await fixture(), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    writeFileSync(f.file, JSON.stringify(body(), null, 2), { mode: 0o600 });
    SqliteAdapter.resetInstance(); SecretStore.resetInstance(); SqliteAdapter.getInstance(db).migrate();
    const result = await applyCloudInstallationV1({ ...f.context, installationId: plan.installationId, planDigest: plan.plan.digest,
      confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('scope-ready');
  });
  it('refuses private capture using another environment context even within the same app', async () => {
    const f = await fixture(), other = f.ctx.repos.environments.create({ projectId: f.intent.appId, name: 'other' });
    const local = { projectId: f.intent.appId, environmentId: other.id, installationId: f.intent.installationId, intentDigest: canonicalJsonSha256(f.intent) };
    const selection = await f.capability.create(f.intent.nativeScope, local), context = { ...f.context, ...selection };
    const plan = await planCloudInstallationV1({ ...context, intent: f.intent });
    const result = await applyCloudInstallationV1({ ...context, installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('blocked');
    expect(new OperatorCredentialCustody({ ...local, provider: 'google-oauth' }).read()).toBeNull(); expect(f.custody.read()).toBeNull();
  });
  it.each(['{"web":{"client_secret":"private"}}', 'https://attacker.example.test/client.json', 'file:relative/client.json'])('rejects unsafe configuration reference %s', async credentialsRef => {
    const f = await fixture();
    expect(() => f.capability.parseDeclaration({ name: 'google', origin, runtimeIdentity: {} as never,
      declaration: { provider: 'google-oauth', profile: 'hypercloud-connect-v1', originService: 'web', runtimeService: 'web', nativeScope: { projectId: 'operator-project', credentialsRef } } })).toThrow();
  });

  it('accepts the official numeric client-ID example and legacy Google token endpoint without changing its identity', async () => {
    // Google's maintained web-server and OpenID Connect guides use a numeric
    // client ID without the later hyphenated suffix.
    const config = body(); config.web.client_id = '123456789.apps.googleusercontent.com';
    config.web.token_uri = 'https://accounts.google.com/o/oauth2/token';
    const f = await fixture(config), plan = await planCloudInstallationV1({ ...f.context, intent: f.intent });
    expect(plan.plan.actions[0].metadata.native.clientId).toBe(config.web.client_id);
  });
  it.each(['project', 'callback', 'token-endpoint', 'auth-endpoint', 'desktop-client', 'extra-callback', 'private-key'])('rejects a mismatched %s configuration without private custody or native access', async fault => {
    const config: any = body();
    if (fault === 'project') config.web.project_id = 'different-project';
    if (fault === 'callback') config.web.redirect_uris = ['https://other.example.test/cloud-authorizations/gcp'];
    if (fault === 'token-endpoint') config.web.token_uri = 'https://attacker.example.test/token';
    if (fault === 'auth-endpoint') config.web.auth_uri = 'https://accounts.google.com.attacker.example.test/auth';
    if (fault === 'desktop-client') { config.installed = config.web; delete config.web; }
    if (fault === 'extra-callback') config.web.redirect_uris.push('https://other.example.test/cloud-authorizations/gcp');
    if (fault === 'private-key') config.web.private_key = secret;
    const f = await fixture(config);
    await expect(planCloudInstallationV1({ ...f.context, intent: f.intent })).rejects.toThrow();
    expect(f.custody.read()).toBeNull();
  });
});
