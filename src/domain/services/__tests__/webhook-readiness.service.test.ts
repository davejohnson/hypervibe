import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import type { ObservedState, ObservedService } from '../../ports/observe.port.js';
import type { Environment } from '../../entities/environment.entity.js';
import { inspectWebhookReadiness } from '../webhook-readiness.service.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const service = (name = 'web', keys: string[] = [], hashes: Record<string, string> = {}): ObservedService => ({
  name, externalId: name, workloadKind: 'web', customDomains: [], config: {}, envVarKeys: keys, envVarHashes: hashes, status: 'running',
});
const observation = (services: ObservedService[], partial = false): ObservedState => ({
  provider: 'railway', observedAt: '2026-09-23T00:00:00Z', projectExists: true, services, databases: [], warnings: [], partial,
});
const spec = (extra: Record<string, unknown> = {}) => environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} }, ...extra });
const bound = (url: string): Environment => ({ id: 'env-1', projectId: 'project-1', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { services: { web: { url } } } });

// Product policy requires HTTPS and verification inputs. Provider distinctions are
// sourced from Stripe webhooks/signature and Twilio webhook-security/SendGrid docs.
// These are configuration tests, not provider transport or live signature tests.
describe('webhook readiness', () => {
  it('does not infer inbound webhooks from API credentials alone and makes no requests', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(inspectWebhookReadiness({ environmentSpec: spec({ envVars: { STRIPE_SECRET_KEY: 'private-api-key' } }), environment: null, observed: null })).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it.each(['http://example.com/hook', 'not-a-url', 'https://user:password@example.com/hook', 'https://example.com/hook#fragment'])('flags unsafe URL configuration without returning it: %s', url => {
    const result = inspectWebhookReadiness({ environmentSpec: spec({ envVars: { STRIPE_WEBHOOK_URL: url, STRIPE_WEBHOOK_SECRET: 'private-signing-value' } }), environment: null, observed: null });
    expect(result).toMatchObject({ status: 'needs_attention', applicationVerification: 'not_verified' });
    expect(JSON.stringify(result)).not.toContain(url);
    expect(JSON.stringify(result)).not.toContain('private-signing-value');
  });
  it('labels desired values as configuration, not evidence of deployed signature verification', () => {
    const result = inspectWebhookReadiness({ environmentSpec: spec(), environment: null, observed: null,
      runtimeValues: { STRIPE_WEBHOOK_URL: 'https://example.com/hook?private=value', STRIPE_WEBHOOK_SECRET: 'local-value' } });
    expect(result).toMatchObject({ status: 'configured', basis: 'configuration-only', applicationVerification: 'not_verified',
      webhooks: [{ urlEvidence: 'declared', signingMaterial: { status: 'present', evidence: 'desired' } }] });
    expect(JSON.stringify(result)).not.toContain('private=value');
  });
  it.each<{ keys: string[]; hashes: Record<string, string>; partial: boolean; status: string }>([
    { keys: [], hashes: {}, partial: false, status: 'missing' },
    { keys: ['STRIPE_WEBHOOK_SECRET'], hashes: {}, partial: false, status: 'unknown' },
    { keys: ['STRIPE_WEBHOOK_SECRET'], hashes: { STRIPE_WEBHOOK_SECRET: digest('') }, partial: false, status: 'missing' },
    { keys: ['STRIPE_WEBHOOK_SECRET'], hashes: { STRIPE_WEBHOOK_SECRET: digest('signer') }, partial: false, status: 'present' },
    { keys: [], hashes: {}, partial: true, status: 'unknown' },
  ])('preserves observed signing evidence: $status/$partial', ({ keys, hashes, partial, status }) => {
    const result = inspectWebhookReadiness({ environmentSpec: spec({ envVars: { STRIPE_WEBHOOK_URL: 'https://example.com/hook' } }), environment: null,
      observed: observation([service('web', keys, hashes)], partial) });
    expect(result?.webhooks[0].signingMaterial.status).toBe(status);
  });
  it('does not borrow credentials from another service or interpret a missing service as a known env read', () => {
    const environmentSpec = spec({ envVars: { STRIPE_WEBHOOK_URL: 'https://example.com/hook' } });
    const worker = service('worker', ['STRIPE_WEBHOOK_SECRET'], { STRIPE_WEBHOOK_SECRET: digest('worker-secret') });
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: observation([service(), worker]) })?.webhooks[0].signingMaterial.status).toBe('missing');
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: observation([worker]) })?.webhooks[0].signingMaterial.status).toBe('unknown');
  });
  it('keeps environments isolated and blank desired inputs missing', () => {
    const environmentSpec = spec({ envVars: { STRIPE_WEBHOOK_URL: 'https://example.com/hook' } });
    const production = observation([service('web', ['STRIPE_WEBHOOK_SECRET'], { STRIPE_WEBHOOK_SECRET: digest('production') })]);
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: production })?.status).toBe('configured');
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: observation([service()]) })?.status).toBe('needs_attention');
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: production, runtimeValues: { ...environmentSpec.envVars, STRIPE_WEBHOOK_SECRET: '  ' } })?.status).toBe('needs_attention');
  });
  it('uses the declared Stripe destination key without assuming the API credential is a signing secret', () => {
    const environmentSpec = spec({ payments: { stripe: { webhooks: { orders: { url: 'https://example.com/hook', service: 'web', envVar: 'ORDER_SIGNER' } } } } });
    const result = inspectWebhookReadiness({ environmentSpec, environment: null, observed: observation([service('web', ['STRIPE_SECRET_KEY'], { STRIPE_SECRET_KEY: digest('api-key') })]) });
    expect(result?.webhooks).toHaveLength(1);
    expect(result?.webhooks[0].signingMaterial).toMatchObject({ key: 'ORDER_SIGNER', status: 'missing' });
  });
  it('does not hide an env-configured endpoint behind a separately managed endpoint', () => {
    const environmentSpec = spec({ envVars: { STRIPE_WEBHOOK_URL: 'http://example.com/legacy' },
      payments: { stripe: { webhooks: { orders: { url: 'https://example.com/orders', service: 'web', envVar: 'ORDER_SIGNER' } } } } });
    const result = inspectWebhookReadiness({ environmentSpec, environment: null, observed: null });
    expect(result?.webhooks).toHaveLength(2);
    expect(result?.status).toBe('needs_attention');
  });

  it('reports Twilio auth-token wiring and the durable callback URL', () => {
    const environmentSpec = spec({ messaging: { services: ['web'], service: { name: 'messages', inbound: { service: 'web' }, deliveryStatus: { service: 'web' } } } });
    const result = inspectWebhookReadiness({ environmentSpec, environment: bound('http://example.com'), observed: observation([service('web', ['TWILIO_API_KEY_SECRET'], { TWILIO_API_KEY_SECRET: digest('api-secret') })]) });
    expect(result?.webhooks).toHaveLength(2);
    expect(result?.webhooks[0]).toMatchObject({ https: 'insecure', urlEvidence: 'binding', signingMaterial: { key: 'TWILIO_AUTH_TOKEN', status: 'missing' } });
    expect(inspectWebhookReadiness({ environmentSpec, environment: null, observed: null })?.status).toBe('unknown');
  });
  it('does not mistake SendGrid API credentials for public-key verification', () => {
    const environmentSpec = spec({ email: { enabled: true, deliveryEvents: { service: 'web' } } });
    const result = inspectWebhookReadiness({ environmentSpec, environment: bound('https://example.com'), observed: observation([service('web', ['SENDGRID_API_KEY'], { SENDGRID_API_KEY: digest('private-api') })]) });
    expect(result).toMatchObject({ status: 'unknown', webhooks: [{ provider: 'sendgrid', https: 'configured', signingMaterial: { status: 'not_managed' } }] });
    expect(JSON.stringify(result)).not.toContain('private-api');
  });
});
