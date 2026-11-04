import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../spec.schema.js';

function environment(overrides: Record<string, unknown> = {}) {
  return {
    hosting: { provider: 'railway' },
    services: {
      api: { workloadKind: 'web', public: true },
      worker: { workloadKind: 'worker', public: false },
    },
    ...overrides,
  };
}

describe('declared webhooks schema', () => {
  it('accepts a vendor-neutral webhook with an optional signing-secret variable', () => {
    const parsed = environmentSpecSchema.parse(environment({ webhooks: {
      'twilio-inbound': { vendor: 'twilio', service: 'api', path: '/webhooks/twilio/messages', signingSecretEnvVar: 'TWILIO_AUTH_TOKEN' },
      'slack-events': { vendor: 'slack', service: 'api', path: '/webhooks/slack' },
    } }));
    expect(parsed.webhooks?.['twilio-inbound']).toEqual({
      vendor: 'twilio', service: 'api', path: '/webhooks/twilio/messages', signingSecretEnvVar: 'TWILIO_AUTH_TOKEN',
    });
  });

  it.each([
    ['unknown service', { vendor: 'twilio', service: 'missing', path: '/hook' }, /unknown service/],
    ['non-public service', { vendor: 'twilio', service: 'worker', path: '/hook' }, /public web service/],
    ['query in path', { vendor: 'twilio', service: 'api', path: '/hook?token=x' }, /query or fragment/],
  ])('rejects a webhook with an %s', (_label, webhook, message) => {
    const result = environmentSpecSchema.safeParse(environment({ webhooks: { inbound: webhook } }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(message);
  });

  it('explains the replacement when a removed Twilio messaging block is still present', () => {
    const result = environmentSpecSchema.safeParse(environment({ messaging: { services: ['api'], service: { name: 'old' } } }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['messaging'], message: expect.stringContaining('webhooks') });
  });
});
