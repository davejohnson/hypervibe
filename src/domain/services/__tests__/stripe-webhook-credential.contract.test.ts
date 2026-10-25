import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { hashEnvValue } from '../../ports/observe.port.js';
import { applyStripeWebhookAction, parseStripeBindings, planStripeEnvironmentSync } from '../stripe-env.service.js';
import '../../../application/providers.js';

// Synthetic HTTP observations use Stripe's official /account and
// /webhook_endpoints contracts. Signature fixtures follow the documented
// timestamp + '.' + raw-body HMAC-SHA256 contract, including overlap signatures.
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-stripe-webhook-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const project = new ProjectRepository().create({ name: 'webhook-rotation', defaultPlatform: 'railway' });
  const descriptor = { role: 'stripe-events', label: 'Stripe event verification', purpose: 'Verify billing events', kind: 'stripe-webhook' as const,
    source: `file:${directory}/secret`, identity: { accountId: 'acct_expected', mode: 'test' as const, endpointId: 'we_bound' },
    stripeWebhook: { environment: 'staging', webhook: 'billing' } };
  const webhook = { url: 'https://app.example.test/billing/stripe', service: 'web', envVar: 'BILLING_SIGNATURE', events: ['checkout.session.completed'] };
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, secrets: { BILLING_SIGNATURE: { ownership: 'delegated', principal: 'user:owner', environments: ['staging'], credential: descriptor } },
    environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' }, payments: { stripe: { environment: 'stripe-sandbox', webhooks: { billing: webhook } } } } } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: { payments: { stripe: { environment: 'stripe-sandbox', catalog: { products: {} }, webhooks: { billing: { endpointId: 'we_bound', ...webhook, valueHash: hashEnvValue('old-signing-secret') } } } } } });
  new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  const connection = new ConnectionRepository().create({ provider: 'stripe', scope: 'stripe-sandbox', credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_test_management' }) });
  new ConnectionRepository().updateStatus(connection.id, 'verified');
  let account = 'acct_expected';
  const endpoint = { id: 'we_bound', object: 'webhook_endpoint', url: webhook.url, status: 'enabled', enabled_events: webhook.events, metadata: {}, created: 1, livemode: false };
  const calls: Array<{ path: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, method: init?.method ?? 'GET' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_management');
    if (url.pathname === '/v1/account') return Response.json({ id: account, object: 'account' });
    if (url.pathname === '/v1/webhook_endpoints/we_bound') return Response.json(endpoint);
    if (url.pathname === '/v1/webhook_endpoints') return Response.json({ object: 'list', data: [endpoint], has_more: false });
    throw new Error('Unexpected provider request');
  }));
  return { project, spec, descriptor: spec.secrets.BILLING_SIGNATURE.credential!, environment, endpoint, calls, setAccount: (id: string) => { account = id; } };
}

it('inspects exact account, mode and endpoint without treating GET metadata as a signing-secret check', async () => {
  const f = fixture();
  const { reviewStripeWebhookCredential } = await import('../stripe-webhook-credential.service.js');
  const result = await reviewStripeWebhookCredential({ ...f, value: 'whsec_candidate' });
  expect(result.endpoint).toMatchObject({ endpointId: 'we_bound', accountId: 'acct_expected', mode: 'test', environmentId: f.environment.id, service: 'web', envVar: 'BILLING_SIGNATURE' });
  expect(result.validation).toMatchObject({ result: 'unknown', applicationOperation: 'unknown' });
  expect(result.guidance.managementUrl).toBe('https://dashboard.stripe.com/webhooks');
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('whsec_candidate');
});

it.each(['account', 'mode', 'endpoint', 'url'])('rejects changed %s before synchronizing any signing secret', async mismatch => {
  const f = fixture();
  if (mismatch === 'account') f.setAccount('acct_another_sandbox');
  if (mismatch === 'mode') f.endpoint.livemode = true;
  if (mismatch === 'endpoint') f.endpoint.id = 'we_other';
  if (mismatch === 'url') f.endpoint.url = 'https://other.example.test/webhook';
  const { reviewStripeWebhookCredential } = await import('../stripe-webhook-credential.service.js');
  await expect(reviewStripeWebhookCredential({ ...f, value: 'whsec_candidate' })).rejects.toThrow(/identity|endpoint|account|mode/i);
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});

it('validates the exact raw delivery signature while keeping application processing unverified', async () => {
  const f = fixture();
  const body = JSON.stringify({ id: 'evt_example', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { private_customer: 'never-output-customer' } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'whsec_candidate').update(`${timestamp}.${body}`).digest('hex');
  writeFileSync(path.join(directory, 'body'), body);
  writeFileSync(path.join(directory, 'signature'), `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`);
  const descriptor = { ...f.descriptor, stripeWebhook: { ...f.descriptor.stripeWebhook!, delivery: { payloadFile: path.join(directory, 'body'), signatureRef: `file:${directory}/signature` } } };
  const { reviewStripeWebhookCredential } = await import('../stripe-webhook-credential.service.js');
  const result = await reviewStripeWebhookCredential({ ...f, descriptor, value: 'whsec_candidate' });
  expect(result.validation).toMatchObject({ result: 'passed', tested: expect.stringContaining('supplied signed delivery'), applicationOperation: 'unknown' });
  expect(JSON.stringify(result)).not.toMatch(/never-output-customer|whsec_candidate|private_customer/);
  await expect(reviewStripeWebhookCredential({ ...f, descriptor, value: 'whsec_wrong' })).rejects.toThrow(/signature/i);
});

it('accepts the new signing value into the existing endpoint binding without replacing endpoint identity', async () => {
  const f = fixture();
  const { reviewStripeWebhookCredential, acceptStripeWebhookCredential } = await import('../stripe-webhook-credential.service.js');
  const reviewed = await reviewStripeWebhookCredential({ ...f, value: 'whsec_candidate' });
  await acceptStripeWebhookCredential({ ...f, value: 'whsec_candidate', reviewed: reviewed.endpoint });
  expect(parseStripeBindings(new EnvironmentRepository().findById(f.environment.id)).webhooks.billing).toMatchObject({ endpointId: 'we_bound', url: f.endpoint.url, valueHash: hashEnvValue('whsec_candidate') });
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  expect(JSON.stringify(new EnvironmentRepository().findById(f.environment.id))).not.toContain('whsec_candidate');
});

it('does not turn hosting signature drift into deletion of a still-active endpoint', async () => {
  const f = fixture();
  const plan = await planStripeEnvironmentSync({ environmentName: 'staging', environmentSpec: f.spec.environments.staging, environment: f.environment,
    observed: { provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, databases: [], services: [{ name: 'web', externalId: 'web-id', workloadKind: 'web', customDomains: [], config: {}, status: 'running', envVarKeys: ['BILLING_SIGNATURE'], envVarHashes: { BILLING_SIGNATURE: hashEnvValue('different') } }], completeness: { services: 'complete' }, partial: false, warnings: [] } });
  expect(plan.actions).toEqual([expect.objectContaining({ type: 'update', metadata: expect.objectContaining({ blockedReason: expect.stringContaining('credential') }) })]);
  const oldReplacement = { ...plan.actions[0], type: 'replace' as const, metadata: { ...plan.actions[0].metadata, blockedReason: undefined } };
  const result = await applyStripeWebhookAction({ project: f.project, environment: f.environment, environmentSpec: f.spec.environments.staging, action: oldReplacement });
  expect(result).toMatchObject({ success: false, status: 'blocked' });
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});
