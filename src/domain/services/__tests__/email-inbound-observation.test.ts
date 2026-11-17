import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { planEmail, resolveEmailIntegrationState } from '../email-plan.service.js';

// Reconstructed responses exercise the real SendGrid HTTP client. The exact
// hostname GET is documented by retrieve-a-specific-parse-setting; the security
// guide independently documents the string association absent from that schema.
// https://www.twilio.com/docs/sendgrid/api-reference/settings-inbound-parse/retrieve-a-specific-parse-setting
// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
const hostname = 'inbound.example.com';
const listPath = '/v3/user/webhooks/parse/settings';
const exactPath = `${listPath}/${hostname}`;
const policyId = 'dd677638-a16d-4e19-95ea-20231c35511b';
const route = { hostname, url: 'https://deleted-provider.example.net/parse', spam_check: true, send_raw: false };
const publicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmgmjvPAR/Lmwn2teL2WJUDIx35PqsnLKjPhPbrKkfMg6vK4NZQB1VeFSKbV7whQbEJRFHjF8+1zJxsXRP1GbWw==';
const project: Project = { id: 'project-id', name: 'parse-observation', defaultPlatform: 'railway',
  policies: {}, createdAt: new Date(), updatedAt: new Date() };
const environment: Environment = { id: 'environment-id', projectId: project.id, name: 'staging',
  platformBindings: { provider: 'railway', projectId: 'native-project', environmentId: 'native-environment',
    services: { web: { serviceId: 'native-web', url: 'https://provider.example.net' } },
    domainDns: { name: 'example.com', serviceName: 'web', serviceId: 'native-web',
      environmentId: 'native-environment', providerDomainId: 'native-domain' } },
  createdAt: new Date(), updatedAt: new Date() };
const spec = (signed = false) => environmentSpecSchema.parse({ hosting: { provider: 'railway' },
  services: { web: {} }, domain: 'example.com', email: { enabled: true,
    inbound: { hostname, service: 'web', path: '/parse', ...(signed ? { signatureVerification: true } : {}) } } });

describe('ordinary inbound exact-host observation through SendGrid HTTP', () => {
  let dir: string;
  let requests: Array<{ method: string; pathname: string }>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hv-exact-parse-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(dir, 'test.db'));
    const connections = new ConnectionRepository();
    const connection = connections.create({ provider: 'sendgrid',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'synthetic-private-key' }) });
    connections.updateStatus(connection.id, 'verified');
    requests = [];
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });

  function transport(exact: unknown, options: { list?: unknown[]; exactStatus?: number; listStatus?: number; policyStatus?: number; policy?: unknown } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      requests.push({ method: init?.method ?? 'GET', pathname });
      if (pathname === '/v3/whitelabel/domains') return Response.json([]);
      if (pathname === listPath) return Response.json({ result: options.list ?? [route] }, { status: options.listStatus ?? 200 });
      if (pathname === exactPath) return Response.json(exact, { status: options.exactStatus ?? 200 });
      if (pathname === `/v3/user/webhooks/security/policies/${policyId}`) return Response.json(options.policy ?? { policy: {
        id: policyId, name: 'existing-policy', signature: { public_key: publicKey } } }, { status: options.policyStatus ?? 200 });
      throw new Error(`Unexpected transport request ${pathname}`);
    });
  }
  async function observe(signed = false) {
    const environmentSpec = spec(signed);
    const state = await resolveEmailIntegrationState({ project, environment, environmentSpec });
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment,
      observed: null, integrationState: state });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    return { state, action: plan.actions.find(action => action.id === `email:sendgrid:inbound:${hostname}`)! };
  }

  it('uses a positively observed association without requiring signature intent or reading policy contents', async () => {
    const exact = { ...route, url: 'https://current-provider.example.net/parse', spam_check: false, security_policy: policyId };
    transport(exact);
    const { state, action } = await observe();
    expect(requests.filter(request => request.pathname === exactPath)).toHaveLength(1);
    expect(requests.some(request => request.pathname.includes('/security/policies'))).toBe(false);
    expect(state.inboundRoutes).toEqual({ status: 'known', items: [exact] });
    expect(state.inboundSigning).toBeUndefined();
    expect(action).toMatchObject({ type: 'replace', requiresConfirm: true,
      metadata: { expectedPolicyId: policyId, observedRoute: { policyAssociation: 'known' } } });
    expect(action.metadata?.blockedReason).toBeUndefined();
  });

  it('does not fall back to a list association when the exact route omits it', async () => {
    transport(route, { list: [{ ...route, security_policy: policyId }] });
    const { state, action } = await observe();
    expect(state.inboundRoutes).toEqual({ status: 'known', items: [route] });
    expect(action.metadata?.expectedPolicyId).toBeUndefined();
    expect(action.metadata?.blockedReason).toContain('policy association is unknown');
  });

  it.each([403, 404, 429, 500])('retains unknown after exact GET HTTP %s instead of trusting the list for writes', async status => {
    transport({ error: 'synthetic-private-key' }, { exactStatus: status, list: [{ ...route, security_policy: policyId }] });
    const { state, action } = await observe();
    expect(state.inboundRoutes.status).toBe('unknown');
    expect(action.metadata?.blockedReason).toBe('email_inbound_observation_unknown');
    expect(action.requiresConfirm).not.toBe(true);
    expect(JSON.stringify({ state, action })).not.toContain('synthetic-private-key');
  });

  it.each([{}, { ...route, hostname: 'unexpected.example.com' }, [route], { ...route, security_policy: null }])
    ('rejects malformed or unexpected exact identity without falling back (%j)', async exact => {
      transport(exact, { list: [{ ...route, security_policy: policyId }] });
      const { state, action } = await observe();
      expect(state.inboundRoutes.status).toBe('unknown');
      expect(action.metadata?.blockedReason).toBe('email_inbound_observation_unknown');
      expect(action.requiresConfirm).not.toBe(true);
    });

  it('leaves duplicate list identities ambiguous without choosing an exact route', async () => {
    transport({ ...route, security_policy: policyId }, { list: [route, { ...route, hostname: hostname.toUpperCase() }] });
    const { action } = await observe();
    expect(requests.some(request => request.pathname === exactPath)).toBe(false);
    expect(action.metadata?.blockedReason).toBe('email_inbound_identity_ambiguous');
    expect(action.requiresConfirm).not.toBe(true);
  });

  it('does not turn an absent list identity into an unrelated exact lookup', async () => {
    transport({ ...route, security_policy: policyId }, { list: [] });
    const { state, action } = await observe();
    expect(state.inboundRoutes).toEqual({ status: 'known', items: [] });
    expect(requests.some(request => request.pathname === exactPath)).toBe(false);
    expect(action.type).toBe('create');
  });

  it('keeps list permission failure unknown without attempting another endpoint', async () => {
    transport(route, { listStatus: 403 });
    const { state, action } = await observe();
    expect(state.inboundRoutes.status).toBe('unknown');
    expect(requests.some(request => request.pathname === exactPath)).toBe(false);
    expect(action.metadata?.blockedReason).toBe('email_inbound_observation_unknown');
  });

  it('shares one exact route observation with the separately declared signing reader', async () => {
    transport({ ...route, security_policy: policyId });
    const { state } = await observe(true);
    expect(requests.filter(request => request.pathname === exactPath)).toHaveLength(1);
    expect(state.inboundSigning?.status).toBe('known');
    expect(state.inboundRoutes).toEqual({ status: 'known', items: [{ ...route, security_policy: policyId }] });
  });

  it('does not recover signed-route write authority from the list after an exact read fails', async () => {
    transport({}, { exactStatus: 403, list: [{ ...route, security_policy: policyId }] });
    const { state, action } = await observe(true);
    expect(state.inboundRoutes.status).toBe('unknown');
    expect(state.inboundSigning?.status).toBe('unknown');
    expect(action.metadata?.blockedReason).toBe('email_inbound_observation_unknown');
    expect(requests.some(request => request.pathname.includes('/security/policies'))).toBe(false);
  });

  it.each(['denied', 'oauth-only'])('keeps route association separate from unavailable signing evidence: %s', async kind => {
    const exact = { ...route, security_policy: policyId };
    transport(exact, kind === 'denied' ? { policyStatus: 403 } : { policy: { policy: {
      id: policyId, name: 'existing-oauth-policy', oauth: { client_id: 'private-oauth-client',
        token_url: 'https://oauth.example.com/token', scopes: ['webhooks:read'] } } } });
    const { state, action } = await observe(true);
    expect(state.inboundRoutes).toEqual({ status: 'known', items: [exact] });
    expect(state.inboundSigning?.status).toBe('unknown');
    expect(action.metadata?.expectedPolicyId).toBe(policyId);
    expect(JSON.stringify(state)).not.toContain('private-oauth-client');
  });
});
