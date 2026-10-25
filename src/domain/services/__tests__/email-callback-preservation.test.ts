import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { applyEmailAction } from '../email-apply.service.js';
import { adapterFactory } from '../adapter.factory.js';
import { planInboundSigning } from '../email-inbound-signing.service.js';
import { planEmail } from '../email-plan.service.js';
import { inspectWebhookReadiness } from '../webhook-readiness.service.js';

// Reconstructed from Invoice Perfect's accepted inbound receipt (2026-10-23)
// and read-only staging plan d4258324-f613-4692-9d01-810bf13feda7 (2026-10-25),
// not captured HTTP traffic. The callback/hash below are independent historical
// evidence; do not derive them from the URL-selection implementation under test.
// SendGrid supports an application-selected receiving URL:
// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook
// Missing policy association does not prove absence; see the pinned contract's
// evidence boundary in test/provider-contracts/README.md. This test must not
// relax that safety gate merely to replace an unchanged, working callback.
const domain = 'staging.invoiceperfect.com';
const hostname = 'canary.staging.invoiceperfect.com';
const callback = 'https://staging.invoiceperfect.com/api/webhooks/canary-email-receipts';
const providerUrl = 'https://web-staging-27b3.up.railway.app';
const providerProjectId = '8906f7eb-99e1-43b0-b9b2-743ccc7ceaca';
const providerEnvironmentId = '61abb926-30b6-4d09-af6b-4b6e0b80f6d8';
const providerServiceId = '2cb0dbcf-e75c-47d5-90c4-af80490f43a2';
const inboundReceipt = {
  configHash: '372238fe816de1aeb71423a388d1ed23a8cab0508697082385fc161b7d7d88e3',
  hostname,
  service: 'web',
  path: '/api/webhooks/canary-email-receipts',
  url: callback,
  aliases: [],
  spamCheck: true,
  sendRaw: false,
};

describe('preserving an accepted inbound callback after provider URL refresh', () => {
  let directory: string;
  let project: ReturnType<ProjectRepository['create']>;
  let environment: ReturnType<EnvironmentRepository['create']>;
  let observed: ObservedState;
  let requests: Array<{ method: string; pathname: string }>;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-email-callback-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'test.db'));
    project = new ProjectRepository().create({ name: 'callback-preservation', defaultPlatform: 'railway' });
    environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway', projectId: providerProjectId, environmentId: providerEnvironmentId,
        services: { web: { serviceId: providerServiceId, url: providerUrl, customDomains: [domain] } },
        email: { inbound: inboundReceipt },
      },
    });
    observed = {
      provider: 'railway', projectId: providerProjectId, environmentId: providerEnvironmentId,
      observedAt: '2026-10-25T23:06:28.000Z', projectExists: true,
      services: [{
        name: 'web', externalId: providerServiceId, workloadKind: 'web', url: providerUrl,
        customDomains: [domain],
        // Native read-only Railway inspection observed this exact attachment and
        // valid certificate. Proxied DNS did not satisfy Railway's DNS comparison;
        // preserving an existing callback does not claim new DNS validation.
        customDomainStatus: { [domain]: {
          providerDomainId: '702763d0-59d6-4e5b-ad1f-4defa5ebb49c',
          providerVerified: true, certificateStatus: 'VALID', dnsConfigured: false,
        } },
        config: { public: true }, envVarKeys: [], envVarHashes: {}, status: 'running',
      }],
      databases: [], completeness: { services: 'complete' }, partial: false, warnings: [],
    };
    const connection = new ConnectionRepository().create({
      provider: 'sendgrid',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: 'synthetic-test-key' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    requests = [];
    // Real SendGrid adapter and serialization; only the HTTP transport is mocked.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const request = { method: init?.method ?? 'GET', pathname: url.pathname };
      requests.push(request);
      expect(url.origin).toBe('https://api.sendgrid.com');
      expect(request.method).toBe('GET');
      if (url.pathname === '/v3/whitelabel/domains') return Response.json([]);
      expect(url.pathname).toBe('/v3/user/webhooks/parse/settings');
      return Response.json({ result: [{ hostname, url: callback, spam_check: true, send_raw: false }] });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function desired(path = inboundReceipt.path) {
    return environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, domain,
      services: { web: { workloadKind: 'web', public: true } },
      email: { enabled: true, inbound: { hostname, service: 'web', path, aliases: [], spamCheck: true, sendRaw: false } },
    });
  }

  function acceptedReceipt() {
    return (environment.platformBindings.email as { inbound: typeof inboundReceipt }).inbound;
  }

  it('keeps the accepted callback when the same service still owns its custom domain', async () => {
    const environmentSpec = desired();
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment, observed });
    const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;

    expect(requests).toContainEqual({ method: 'GET', pathname: '/v3/user/webhooks/parse/settings' });
    expect(action).toMatchObject({ type: 'noop', verified: true, metadata: { expectedUrl: callback } });
    expect(action.metadata).not.toHaveProperty('blockedReason');
    expect(action).not.toHaveProperty('requiresConfirm', true);
    const requestsBeforeApply = requests.length;
    expect(await applyEmailAction({ project, environmentName: 'staging', environmentSpec, action })).toMatchObject({ success: true });
    expect(requests).toHaveLength(requestsBeforeApply);
  });

  it('still blocks a requested path change when the security-policy association is unknown', async () => {
    const environmentSpec = desired('/api/webhooks/new-receipts');
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment, observed });
    const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;

    expect(action).toMatchObject({ type: 'replace', requiresConfirm: true });
    expect(action.metadata?.blockedReason).toContain('Inbound policy association is unknown');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it.each(['missing', 'partial', 'unknown services', 'provider', 'project', 'missing project binding', 'environment', 'service',
    'detached', 'unverified', 'other service', 'duplicate attachment'])(
    'does not preserve a callback from %s attachment evidence', async invalid => {
      let observation: ObservedState | null = observed;
      if (invalid === 'missing') observation = null;
      if (invalid === 'partial') observed.partial = true;
      if (invalid === 'unknown services') observed.completeness = { services: 'unknown' };
      if (invalid === 'provider') observed.provider = 'fly';
      if (invalid === 'project') observed.projectId = 'another-project';
      if (invalid === 'missing project binding') delete environment.platformBindings.projectId;
      if (invalid === 'environment') observed.environmentId = 'another-environment';
      if (invalid === 'service') observed.services[0].externalId = 'another-service';
      if (invalid === 'detached') observed.services[0].customDomains = [];
      if (invalid === 'unverified') observed.services[0].customDomainStatus![domain].providerVerified = false;
      if (['other service', 'duplicate attachment'].includes(invalid)) {
        observed.services.push({ ...observed.services[0], name: 'other', externalId: 'other-service' });
        if (invalid === 'other service') observed.services[0].customDomains = [];
      }
      const environmentSpec = desired();
      const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment, observed: observation });
      const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;
      expect(action.metadata?.blockedReason).toContain('accepted inbound callback');
      expect(action.verified).toBe(false);
      const requestCount = requests.length;
      expect(await applyEmailAction({ project, environmentName: 'staging', environmentSpec, action })).toMatchObject({ success: false });
      expect(requests).toHaveLength(requestCount);
    });

  it.each([
    'http://staging.invoiceperfect.com/api/webhooks/canary-email-receipts',
    'https://user:password@staging.invoiceperfect.com/api/webhooks/canary-email-receipts',
    'https://staging.invoiceperfect.com:8443/api/webhooks/canary-email-receipts',
    'https://another.example.com/api/webhooks/canary-email-receipts',
    `${callback}?token=not-a-secret`, `${callback}#fragment`,
    'https://staging.invoiceperfect.com/another-path',
  ])('rejects an unsafe or unrelated accepted URL %s', async url => {
    acceptedReceipt().url = url;
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec: desired(), environment, observed });
    const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;
    expect(action.metadata?.blockedReason).toContain('accepted inbound callback');
    expect(action.verified).toBe(false);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('does not retain the old service callback when the receiving service is explicitly changed', async () => {
    const environmentSpec = desired();
    environmentSpec.services.other = { ...environmentSpec.services.web };
    environmentSpec.email.inbound!.service = 'other';
    (environment.platformBindings.services as Record<string, unknown>).other = {
      serviceId: 'other-service', url: 'https://other.example.com',
    };
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment, observed });
    const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;
    expect(action).toMatchObject({ type: 'replace', requiresConfirm: true });
    expect(action.metadata?.expectedUrl).toBe('https://other.example.com/api/webhooks/canary-email-receipts');
    expect(action.metadata?.blockedReason).toContain('Inbound policy association is unknown');
  });

  it.each(['same', 'replaced', 'unknown'])('rechecks %s attachment evidence before recording alias changes', async state => {
    const environmentSpec = desired();
    environmentSpec.email.inbound!.aliases = ['receipts'];
    const plan = await planEmail({ project, environmentName: 'staging', environmentSpec, environment, observed });
    const action = plan.actions.find(item => item.id === `email:sendgrid:inbound:${hostname}`)!;
    expect(action).toMatchObject({ type: 'update', metadata: { operation: 'emailInboundAdopt', expectedUrl: callback } });
    // Synthetic hosting observation at the shared boundary, not Railway API proof.
    // SendGrid continues through its actual serialized HTTP transport below.
    const fresh = structuredClone(observed);
    if (state === 'replaced') fresh.services[0].externalId = 'replaced-service';
    const hosting = new RailwayAdapter();
    const observe = vi.spyOn(hosting, 'observe');
    if (state === 'unknown') observe.mockRejectedValue(new Error('Synthetic unavailable hosting observation'));
    else observe.mockResolvedValue(fresh);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: hosting });
    const fetch = vi.mocked(globalThis.fetch);
    const transport = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/v3/scopes'
      ? Response.json({ scopes: ['user.webhooks.parse.settings.read'] }) : transport(input, init));
    const result = await applyEmailAction({ project, environmentName: 'staging', environmentSpec, action });
    expect(result.success).toBe(state === 'same');
    const saved = new EnvironmentRepository().findById(environment.id)!;
    const receipt = (saved.platformBindings.email as { inbound: typeof inboundReceipt }).inbound;
    expect(receipt.url).toBe(callback);
    expect(receipt.aliases).toEqual(state === 'same' ? ['receipts'] : []);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('uses the preserved callback in signing and marks unreadable attachment readiness unknown', () => {
    const environmentSpec = desired();
    environmentSpec.email.inbound!.signatureVerification = true;
    const signing = planInboundSigning({ spec: environmentSpec, environment, observed, routeReady: true });
    expect(signing.actions[0].metadata?.expectedUrl).toBe(callback);
    // Policy/key evidence is intentionally absent: URL preservation is not proof
    // of provider signing or authority to replace a previously bound signing hash.
    expect(signing.actions[0].metadata?.blockedReason).toBeTruthy();
    const readiness = inspectWebhookReadiness({ environmentSpec, environment, observed: null });
    expect(readiness?.webhooks.find(item => item.name === 'inbound parse')).toMatchObject({
      https: 'unknown', urlEvidence: 'unavailable',
    });
  });
});
