import { describe, expect, it } from 'vitest';
import { environmentSpecSchema, projectSpecSchema } from '../spec.schema.js';

function environment(overrides: Record<string, unknown> = {}) {
  return {
    hosting: { provider: 'railway' },
    services: { api: { workloadKind: 'web', public: true } },
    domain: 'example.com',
    ...overrides,
  };
}

describe('declarative email schema', () => {
  it('preserves the existing enabled-only contract', () => {
    const parsed = environmentSpecSchema.parse(environment({ email: { enabled: true } }));
    expect(parsed.email).toEqual({ enabled: true });
  });

  it('declares a sender and one service-targeted inbound parse route', () => {
    const parsed = environmentSpecSchema.parse(environment({
      email: {
        enabled: true,
        sender: {
          address: 'hello@example.com',
          name: 'Example',
          replyTo: 'support@example.com',
        },
        inbound: {
          hostname: 'inbound.example.com',
          service: 'api',
          aliases: ['support', 'replies'],
        },
      },
    }));

    expect(parsed.email.inbound).toMatchObject({
      path: '/webhooks/sendgrid/inbound',
      spamCheck: true,
      sendRaw: false,
    });
  });

  it.each([
    [
      'an unknown service',
      { hostname: 'inbound.example.com', service: 'missing' },
      'targets unknown service',
    ],
    [
      'a private worker',
      { hostname: 'inbound.example.com', service: 'worker' },
      'must be a public web service',
    ],
    [
      'a hostname outside the environment domain',
      { hostname: 'inbound.other.com', service: 'api' },
      'must be a subdomain',
    ],
  ])('rejects inbound parse targeting %s', (_label, inbound, message) => {
    const result = environmentSpecSchema.safeParse(environment({
      services: {
        api: { workloadKind: 'web', public: true },
        worker: { workloadKind: 'worker' },
      },
      email: { enabled: true, inbound },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain(message);
  });

  it('rejects duplicate aliases and email-managed env var collisions', () => {
    const result = environmentSpecSchema.safeParse(environment({
      email: {
        enabled: true,
        inbound: {
          hostname: 'inbound.example.com',
          service: 'api',
          aliases: ['Support', 'support'],
        },
      },
      envVars: { SENDGRID_API_KEY: 'not-owned-here' },
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('declared more than once');
      expect(result.error.message).toContain('cannot also be declared in envVars');
    }
  });

  it('rejects sender identities outside the authenticated domain', () => {
    const result = environmentSpecSchema.safeParse(environment({
      email: { enabled: true, sender: { address: 'hello@other.com' } },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('email sender must use example.com');
  });

  it('declares delivery events and forwarding aliases with safe defaults', () => {
    const parsed = environmentSpecSchema.parse(environment({
      email: {
        enabled: true,
        deliveryEvents: { service: 'api' },
        forwarding: {
          aliases: { support: 'owner@example.net' },
        },
      },
    }));
    expect(parsed.email.deliveryEvents).toMatchObject({
      service: 'api',
      path: '/webhooks/sendgrid/events',
    });
    expect(parsed.email.deliveryEvents?.events).toContain('delivered');
    expect(parsed.email.forwarding).toEqual({
      aliases: { support: 'owner@example.net' },
      catchAll: { action: 'drop' },
    });
  });

  it('rejects forwarding without a domain and account webhook ownership in multiple environments', () => {
    expect(environmentSpecSchema.safeParse(environment({
      domain: undefined,
      email: { enabled: true, forwarding: { aliases: { support: 'owner@example.net' } } },
    })).success).toBe(false);

    const result = projectSpecSchema.safeParse({
      version: 1,
      project: 'email-app',
      environments: {
        staging: environment({ email: { enabled: true, deliveryEvents: { service: 'api' } } }),
        production: environment({ email: { enabled: true, deliveryEvents: { service: 'api' } } }),
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('one account-level delivery-event webhook');
  });
});
