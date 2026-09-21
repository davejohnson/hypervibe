import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { planEmail } from '../email-plan.service.js';
import { inspectEmailSenderReadiness } from '../email-sender-readiness.service.js';
import { SendGridAdapter } from '../../../adapters/providers/sendgrid/sendgrid.adapter.js';

const project = { id: 'sender-check', name: 'sender-check', defaultPlatform: 'railway', policies: {}, createdAt: new Date(), updatedAt: new Date() };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(Resolver.prototype, 'resolveTxt').mockRejectedValue(Object.assign(new Error('synthetic absence'), { code: 'ENODATA' }));
  vi.spyOn(Resolver.prototype, 'resolveCname').mockRejectedValue(Object.assign(new Error('synthetic absence'), { code: 'ENODATA' }));
});

// Reconstructed from Twilio's documented response shapes, not live recordings:
// https://www.twilio.com/docs/sendgrid/api-reference/sender-verification/get-all-verified-senders
// https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/list-all-authenticated-domains
// Domain semantics: https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity
describe('SendGrid application sender readiness through the email planner', () => {
  it('checks both declarative addresses and accepts display-name env addresses', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
      ? response([{ id: 1, domain: 'example.com', valid: true }]) : response({ results: [] }));
    const result = await inspectEmailSenderReadiness({ project, observed: null,
      runtimeValues: { SENDGRID_API_KEY: 'SG.synthetic-key', MAIL_FROM: 'Orders <orders@example.com>' },
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} },
        email: { enabled: true, sender: { address: 'orders@example.com', replyTo: 'help@example.com' } } }),
    });
    expect(result).toMatchObject({ status: 'verified', senders: [{ key: 'MAIL_FROM', status: 'verified' }, { key: 'email.sender.address', status: 'verified' }], replyTo: [{ key: 'email.sender.replyTo', status: 'verified' }] });
  });

  it('cannot certify an app with no declared From address', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await planEmail({ project, environmentName: 'staging', environment: null, observed: null,
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} }, envVars: { SENDGRID_API_KEY: 'SG.synthetic-key' } }),
    });
    expect(result.senderReadiness?.status).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires Reply-To authorization even when From is authorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('whitelabel')
      ? response([{ id: 1, domain: 'example.com', valid: true }]) : response({ results: [] }));
    const result = await planEmail({ project, environmentName: 'staging', environment: null, observed: null,
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} },
        envVars: { SENDGRID_API_KEY: 'SG.synthetic-key', EMAIL_FROM: 'orders@example.com', EMAIL_REPLY_TO: 'help@other.example' } }),
    });
    expect(result.senderReadiness).toMatchObject({ status: 'unverified', senders: [{ status: 'verified', method: 'domain' }], replyTo: [{ status: 'unverified' }] });
    expect(JSON.stringify(result)).not.toContain('help@other.example');
  });
  it('checks an env-configured sender even when managed email is disabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('whitelabel')
      ? response([])
      : response({ results: [{ id: 1234, from_email: 'orders@example.com', verified: false }] }));
    const result = await planEmail({ project, environmentName: 'staging', environment: null, observed: null,
      environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} }, email: { enabled: false },
        envVars: { SENDGRID_API_KEY: 'SG.synthetic-key', TRANSACTIONAL_EMAIL_FROM: 'orders@example.com' } }),
    });
    expect(result).toMatchObject({ senderReadiness: { status: 'unverified', senders: [{ key: 'TRANSACTIONAL_EMAIL_FROM', status: 'unverified' }] } });
    expect(result.actions).toEqual([]);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SG.synthetic-key');
    expect(JSON.stringify(result)).not.toContain('orders@example.com');
  });
});

describe('SendGrid sender authorization transport contract (reconstructed official examples)', () => {
  async function check(addresses: string[]) {
    const adapter = new SendGridAdapter();
    adapter.connect({ apiKey: 'SG.synthetic-key' });
    return adapter.checkSenderIdentities(addresses);
  }

  it('does not inherit domain authentication into subdomains', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
      ? response([{ id: 1, domain: 'example.com', valid: true }]) : response({ results: [] }));
    expect(await check(['orders@example.com', 'orders@mail.example.com'])).toEqual(['verified-domain', 'unverified']);
  });

  it('accepts an individually verified sender but not its Reply-To metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
      ? response([]) : response({ results: [{ id: 1234, from_email: 'orders@example.com', reply_to: 'help@example.com', verified: true }] }));
    expect(await check(['orders@example.com', 'help@example.com'])).toEqual(['verified-sender', 'unverified']);
  });

  it('accepts complete individual evidence when domain reads are forbidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
      ? response({}, 403) : response({ results: [{ id: 1234, from_email: 'orders@example.com', verified: true }] }));
    expect(await check(['orders@example.com', 'other@example.com'])).toEqual(['verified-sender', 'unknown']);
  });

  it('preserves unknown for ambiguous matching identities', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel')
      ? response([{ id: 1, domain: 'example.com', valid: true }, { id: 2, domain: 'example.com', valid: false }]) : response({ results: [] }));
    expect(await check(['orders@example.com'])).toEqual(['unknown']);
  });

  it.each([403, 429, 500])('preserves unknown on provider error %s without echoing its body', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ errors: [{ message: 'SG.synthetic-key orders@example.com' }] }, status));
    expect(await check(['orders@example.com'])).toEqual(['unknown']);
  });

  it.each([{ id: 1234, from_email: 'orders@example.com' }, { id: 1234, from_email: 'orders@example.com', verified: null }])('does not turn incomplete evidence into absence: %j', async sender => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('whitelabel') ? response([]) : response({ results: [sender] }));
    expect(await check(['orders@example.com'])).toEqual(['unknown']);
  });

  it('reads subsequent domain and sender pages using the documented cursors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/domains')) return response(url.searchParams.get('offset') === '0'
        ? Array.from({ length: 100 }, (_, id) => ({ id, domain: `domain${id}.example`, valid: true }))
        : [{ id: 101, domain: 'example.com', valid: true }]);
      return response({ results: url.searchParams.has('lastSeenID')
        ? [{ id: 101, from_email: 'help@other.example', verified: true }]
        : Array.from({ length: 100 }, (_, id) => ({ id, from_email: `sender${id}@example.net`, verified: false })) });
    });
    expect(await check(['orders@example.com', 'help@other.example'])).toEqual(['verified-domain', 'verified-sender']);
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain('https://api.sendgrid.com/v3/verified_senders?limit=100&lastSeenID=99');
  });

  it('keeps staging and production observations scoped to their own credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const authorized = new Headers(init?.headers).get('Authorization') === 'Bearer SG.production';
      return String(url).includes('whitelabel') ? response(authorized ? [{ id: 1, domain: 'example.com', valid: true }] : []) : response({ results: [] });
    });
    for (const [name, status] of [['production', 'verified'], ['staging', 'unverified']]) {
      const result = await planEmail({ project, environmentName: name, environment: null, observed: null,
        environmentSpec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {} }, envVars: { SENDGRID_API_KEY: `SG.${name}`, EMAIL_FROM: 'orders@example.com' } }),
      });
      expect(result.senderReadiness?.status).toBe(status);
    }
  });
});
