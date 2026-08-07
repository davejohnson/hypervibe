import { describe, expect, it } from 'vitest';
import { environmentSpecSchema } from '../spec.schema.js';

const PHONE_SID = `PN${'a'.repeat(32)}`;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    hosting: { provider: 'railway' },
    services: {
      api: { workloadKind: 'web', public: true },
      worker: { workloadKind: 'worker', public: false },
    },
    messaging: {
      services: ['api'],
      service: {
        name: 'example-production',
        inbound: { service: 'api' },
        deliveryStatus: { service: 'api' },
      },
      sender: { phoneNumberSid: PHONE_SID },
    },
    ...overrides,
  };
}

describe('declarative Twilio messaging schema', () => {
  it('defaults the provider and secure webhook paths', () => {
    const parsed = environmentSpecSchema.parse(environment());

    expect(parsed.messaging).toEqual({
      provider: 'twilio',
      services: ['api'],
      service: {
        name: 'example-production',
        inbound: { service: 'api', path: '/webhooks/twilio/messages' },
        deliveryStatus: { service: 'api', path: '/webhooks/twilio/status' },
      },
      sender: { phoneNumberSid: PHONE_SID },
    });
  });

  it.each([
    ['unknown runtime service', { services: ['missing'], service: { name: 'example-production' } }, 'targets unknown service'],
    ['private webhook service', { services: ['worker'], service: { name: 'example-production', inbound: { service: 'worker' } } }, 'must be a public web service'],
    ['webhook without credentials', { services: ['worker'], service: { name: 'example-production', inbound: { service: 'api' } } }, 'must also be listed in messaging.services'],
  ])('rejects %s', (_label, messaging, message) => {
    const result = environmentSpecSchema.safeParse(environment({ messaging }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain(message);
  });

  it('rejects malformed sender SIDs and managed-key collisions', () => {
    const result = environmentSpecSchema.safeParse(environment({
      messaging: {
        services: ['api'],
        service: { name: 'example-production' },
        sender: { phoneNumberSid: 'PN-not-a-sid' },
      },
      envVars: { TWILIO_AUTH_TOKEN: 'must-not-live-here' },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('phone number SID');
      expect(result.error.message).toContain('cannot also be declared in envVars');
    }
  });
});
