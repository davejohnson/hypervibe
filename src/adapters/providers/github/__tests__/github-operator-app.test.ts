import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { Crc32c } from '@aws-sdk/checksums/crc';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { createCommandContext } from '../../../../application/context.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { OperatorCredentialCustody } from '../../../../domain/services/operator-credential-custody.js';
import { CloudScopePreparationRepository } from '../../../db/repositories/cloud-scope-preparation.repository.js';
import { applyCloudInstallationV1, parseCloudInstallationRecordV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../../../domain/services/cloud-installation-runtime.js';
import { createGithubOperatorApplicationDriver } from '../github-operator-app.js';
import { closeOperatorAppCallbacks } from '../../../browser/operator-app-callback.js';
import type { OperatorApplicationIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { SpecStore } from '../../../../domain/spec/spec.store.js';
import { assertReadySecretContainers } from '../../../../domain/services/secret-container-setup.js';
import { createGcpOperatorOutputClient } from '../../gcp/gcp-operator-output.js';
vi.mock('../../../../domain/services/secret-container-setup.js', () => ({ assertReadySecretContainers: vi.fn() }));
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const permissions = { actions: 'read', administration: 'read', checks: 'read', contents: 'read', metadata: 'read' };
describe('GitHub operator manifest transport and custody', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-github-operator-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(async () => { await closeOperatorAppCallbacks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture(options: { lost?: boolean; wrongOwner?: boolean; outputs?: boolean; conversionStatus?: number } = {}) {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun' } });
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id, environment: 'test',
      source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) }, provider: 'github-app', applicationProvider: 'github-app',
      mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' },
      nativeScope: { name: 'github', origin: 'https://operator.example.test', ownerType: 'User', ownerLogin: 'operator-test', ownerId: '1234' } };
    const delivered = new Map<string, string>(); let privateReads = 0;
    if (options.outputs) {
      const pairs = [['private-key', 'GITHUB_APP_PRIVATE_KEY_BASE64'], ['client-secret', 'GITHUB_APP_CLIENT_SECRET'], ['webhook-secret', 'GITHUB_APP_WEBHOOK_SECRET']];
      intent.outputs = { hostingProvider: 'cloudrun', destinations: pairs.map(([role, key]) => ({ role, key,
        ...(role === 'private-key' ? { encoding: 'base64' as const, verificationPurpose: 'github-app-signing-key' as const } : {}),
        binding: { state: 'ready', attemptId: randomUUID(), owner: { repository: intent.source.repository, environment: 'test', key },
          destination: { provider: 'gcp-secret-manager', projectId: 'operator-test', projectNumber: '123456789012', secretId: `operator-${role}` },
          resource: `projects/123456789012/secrets/operator-${role}`, createTime: '2026-10-27T00:00:00Z' } })) };
      vi.spyOn(SpecStore.prototype, 'getForInspection').mockReturnValue({ spec: { environments: { test: { hosting: { provider: 'cloudrun' } } } } } as any);
      vi.mocked(assertReadySecretContainers).mockResolvedValue(Object.fromEntries(intent.outputs.destinations.map(item => [item.key, item.binding])));
      const gcp: typeof fetch = async (input, init) => {
        const url = new URL(String(input)), resource = url.pathname.replace(/^\/v1\//, '').split('/versions')[0].replace(/:addVersion$/, '');
        if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/123456789012', projectId: 'operator-test', state: 'ACTIVE' });
        if (url.pathname.endsWith(':addVersion')) {
          expect(delivered.has(resource)).toBe(false); delivered.set(resource, Buffer.from(JSON.parse(String(init?.body)).payload.data, 'base64').toString('utf8'));
          return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
        }
        if (url.pathname.endsWith(':access')) {
          expect(resource).toBe('projects/123456789012/secrets/operator-private-key'); privateReads++;
          const value = delivered.get(resource)!, crc = new Crc32c(); crc.update(Buffer.from(value));
          return Response.json({ name: `${resource}/versions/1`, payload: { data: Buffer.from(value).toString('base64'), dataCrc32c: String(Buffer.from(await crc.digest()).readUInt32BE()) } });
        }
        if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
        if (url.pathname.endsWith('/versions')) return Response.json(delivered.has(resource) ? { versions: [{ name: `${resource}/versions/1` }] } : {});
        return Response.json({ name: resource, createTime: '2026-10-27T00:00:00Z' });
      };
      vi.spyOn(providerRegistry, 'getOperatorOutputDelivery').mockReturnValue({ schemaVersion: 1, providers: ['gcp-secret-manager'],
        review: (_binding, purpose) => ({ permissions: ['secretmanager.versions.add', ...(purpose ? ['secretmanager.versions.access'] : [])], cost: 'Synthetic reviewed cost', pricingUrl: 'https://cloud.google.com/secret-manager/pricing' }),
        create: async binding => createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-transient-token', request: gcp }),
      });
    }
    let authority = true;
    const local = { projectId: project.id, environmentId: environment.id, installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent), authorizeCurrent: async () => authority };
    const custody = new OperatorCredentialCustody({ ...local, provider: 'github-app' });
    let manifest: any, app: any, conversions = 0;
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.github.com');
      expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2026-03-10');
      if (url.pathname === '/users/operator-test') return Response.json({ id: 1234, login: 'operator-test', type: 'User' });
      if (url.pathname === '/app-manifests/synthetic-code/conversions') {
        conversions++; expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).has('authorization')).toBe(false);
        app = { id: 5678, slug: manifest.name.toLowerCase().replaceAll(' ', '-'), name: manifest.name, client_id: 'Iv1.synthetic',
          owner: { id: options.wrongOwner ? 9999 : 1234, login: 'operator-test', type: 'User' }, external_url: intent.nativeScope.origin,
          html_url: `https://github.com/apps/${manifest.name.toLowerCase().replaceAll(' ', '-')}`, created_at: new Date().toISOString(), permissions, events: ['check_run', 'check_suite', 'workflow_run'] };
        if (options.lost) throw new Error('synthetic lost conversion response');
        return Response.json({ ...app, pem, client_secret: 'synthetic-client-secret', webhook_secret: 'synthetic-webhook-secret' }, { status: options.conversionStatus ?? 201 });
      }
      if (url.pathname === '/app') {
        const token = new Headers(init?.headers).get('authorization')!.replace(/^Bearer /, ''), [header, payload, signature] = token.split('.');
        expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(pem), Buffer.from(signature, 'base64url'))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); expect(claims.iss).toBe('Iv1.synthetic'); expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
        return Response.json(app);
      }
      if (url.pathname === '/app/hook/config') return Response.json({ url: `${intent.nativeScope.origin}/api/v1/code-host-events`, content_type: 'json', insecure_ssl: '0', secret: '********' });
      if (url.pathname.startsWith('/apps/')) return Response.json(app);
      throw new Error('Unexpected synthetic GitHub request');
    };
    const driver = createGithubOperatorApplicationDriver({ fetch: request, local });
    const journal = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: 'test' }, value => parseCloudInstallationRecordV1(value, driver), { recordType: 'operator-applications:github' });
    const context = { driver, store: journal, authentication: { kind: 'operator-application' as const }, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...context, intent });
    const target = { ...context, installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(item => item.id) };
    async function callback() {
      const pending = await applyCloudInstallationV1(target), handoff = pending.attempts[0].externalUrl!;
      expect(handoff).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const response = await fetch(handoff); expect(response.status).toBe(200);
      const html = await response.text(), encoded = html.match(/name="manifest" value="([^"]+)"/)![1];
      manifest = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
      expect(manifest.callback_urls).toEqual([`${intent.nativeScope.origin}/app/code-host-authorizations/github-user`, `${intent.nativeScope.origin}/credential-authorizations/github`]);
      expect(manifest.default_permissions).toEqual(permissions); expect(manifest.public).toBe(true); expect(manifest.name.length).toBeLessThanOrEqual(34);
      const state = html.match(/name="state" value="([^"]+)"/)![1], url = new URL(manifest.redirect_url); url.search = new URLSearchParams({ state, code: 'synthetic-code' }).toString();
      expect((await fetch(url, { redirect: 'manual' })).status).toBe(303);
      const inspected = await reconcileCloudInstallationV1(target); expect(conversions).toBe(0); return inspected;
    }
    return { context, target, callback, custody, delivered, revoke: () => { authority = false; }, privateReads: () => privateReads,
      changePermissions: () => { app.permissions = { ...permissions, contents: 'write' }; }, conversions: () => conversions };
  }
  it('keeps owner-approved code conversion separate from callback and stores complete credentials privately', async () => {
    const f = await fixture(); await f.callback();
    const completed = await applyCloudInstallationV1(f.target); expect(completed.status).toBe('scope-ready'); expect(f.conversions()).toBe(1);
    expect(f.custody.read()!.state).toMatchObject({ phase: 'credentials-stored', credentials: { 'private-key': pem, 'client-secret': 'synthetic-client-secret', 'webhook-secret': 'synthetic-webhook-secret' } });
    expect(JSON.stringify(completed)).not.toMatch(/synthetic-client-secret|synthetic-webhook-secret|BEGIN RSA PRIVATE KEY/);
    await applyCloudInstallationV1(f.target); expect(f.conversions()).toBe(1);
  });
  it('does not replay a conversion whose acknowledgement was lost after restart', async () => {
    const f = await fixture({ lost: true }); await f.callback(); await applyCloudInstallationV1(f.target);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    await applyCloudInstallationV1(f.target); expect(f.conversions()).toBe(1); expect(f.custody.read()!.state.phase).toBe('conversion-started');
  });
  it('retains private recovery custody but refuses a native application owned by another account', async () => {
    const f = await fixture({ wrongOwner: true }); await f.callback();
    expect((await applyCloudInstallationV1(f.target)).status).not.toBe('scope-ready'); expect(f.conversions()).toBe(1);
    expect(f.custody.read()!.state.phase).toBe('credentials-stored');
  });
  it('delivers the Hypercloud base64 key format, erases local values and verifies GitHub using only its exact native signing-key reference', async () => {
    const f = await fixture({ outputs: true }); await f.callback();
    const completed = await applyCloudInstallationV1(f.target); expect(completed.status).toBe('scope-ready');
    expect(f.custody.read()!.state.phase).toBe('delivered'); expect(f.delivered.size).toBe(3);
    const encoded = f.delivered.get('projects/123456789012/secrets/operator-private-key')!;
    expect(encoded === Buffer.from(pem).toString('base64')).toBe(true); expect(createPrivateKey(Buffer.from(encoded, 'base64')).asymmetricKeyType).toBe('rsa');
    expect(completed.plan.review.permissions.some(item => item.scope.endsWith('/operator-private-key') && item.actions.includes('secretmanager.versions.access'))).toBe(true);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    expect((await reconcileCloudInstallationV1(f.target)).status).toBe('scope-ready'); expect(f.privateReads()).toBe(1); expect(f.conversions()).toBe(1);
    expect(JSON.stringify(completed)).not.toContain(encoded); expect(JSON.stringify(completed)).not.toContain(pem);
  });
  it('does not redisplay a registration form after current source authorization changes', async () => {
    const f = await fixture(), pending = await applyCloudInstallationV1(f.target); f.revoke();
    expect((await fetch(pending.attempts[0].externalUrl!)).status).toBe(403); expect(f.conversions()).toBe(0);
  });
  it('refuses native private-key access when the reviewed operator source has changed', async () => {
    const f = await fixture({ outputs: true }); await f.callback(); await applyCloudInstallationV1(f.target); f.revoke();
    expect((await reconcileCloudInstallationV1(f.target)).status).toBe('blocked'); expect(f.privateReads()).toBe(0);
  });
  it('rejects permission drift after successful registration without repeating conversion', async () => {
    const f = await fixture(); await f.callback(); await applyCloudInstallationV1(f.target); f.changePermissions();
    expect((await reconcileCloudInstallationV1(f.target)).status).toBe('blocked'); expect(f.conversions()).toBe(1);
  });
  it('does not treat an undocumented 200 conversion response as success or reuse its code', async () => {
    const f = await fixture({ conversionStatus: 200 }); await f.callback(); await applyCloudInstallationV1(f.target); await applyCloudInstallationV1(f.target);
    expect(f.custody.read()!.state.phase).toBe('conversion-started'); expect(f.conversions()).toBe(1);
  });
  it('rejects changed native handoff URLs while retaining exact loopback recovery records', async () => {
    const f = await fixture(), pending = await applyCloudInstallationV1(f.target);
    expect(() => parseCloudInstallationRecordV1(pending, f.context.driver)).not.toThrow();
    for (const url of ['http://localhost:1234/begin/' + 'a'.repeat(43), 'https://attacker.example.test/begin/' + 'a'.repeat(43),
      pending.attempts[0].externalUrl! + '?code=synthetic-code']) {
      const altered = structuredClone(pending); altered.attempts[0].externalUrl = url;
      expect(() => parseCloudInstallationRecordV1(altered, f.context.driver)).toThrow();
    }
  });
});
