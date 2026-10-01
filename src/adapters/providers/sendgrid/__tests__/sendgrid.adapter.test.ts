import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter, SENDGRID_SCOPE_REQUIREMENTS, assessSendGridScopes, missingSendGridScopes } from '../sendgrid.adapter.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function connectedAdapter(): SendGridAdapter {
  const adapter = new SendGridAdapter();
  adapter.connect({ apiKey: 'SG.test.key' });
  return adapter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SendGridAdapter observations', () => {
  it('returns absence only for a provider-confirmed not-found domain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ errors: [{ message: 'not found' }] }, 404)
    );

    await expect(connectedAdapter().getDomainAuthentication(42)).resolves.toBeNull();
  });

  it('preserves a non-not-found domain observation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ errors: [{ message: 'forbidden' }] }, 403)
    );

    await expect(connectedAdapter().getDomainAuthentication(42))
      .rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['domain authentications', '/whitelabel/domains', (adapter: SendGridAdapter) => adapter.listDomainAuthentications()],
    ['verified senders', '/verified_senders', (adapter: SendGridAdapter) => adapter.listVerifiedSenders()],
    ['Inbound Parse routes', '/user/webhooks/parse/settings', (adapter: SendGridAdapter) => adapter.listInboundParseWebhooks()],
  ])('does not interpret an incomplete %s payload as an empty list', async (_label, path, observe) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}));

    await expect(observe(connectedAdapter())).rejects.toThrow(/invalid list/);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.sendgrid.com/v3${path}`,
      expect.objectContaining({ method: 'GET' })
    );
  });
});

// Official scope names: https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions
// Wildcards exercise Hypervibe's existing scope matcher, not a live provider grant.
describe('SendGrid Inbound Parse update permissions', () => {
  const read = 'user.webhooks.parse.settings.read';
  const update = 'user.webhooks.parse.settings.update';
  it('permits a read-only adoption audit without granting update authority', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ scopes: [read] }));
    const scopes = await connectedAdapter().getScopes();
    expect(SENDGRID_SCOPE_REQUIREMENTS.inboundParseRead).toEqual([read]);
    expect(missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.inboundParseRead)).toEqual([]);
    expect(missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([update]);
    expect(assessSendGridScopes(scopes).canConfigureInboundParse).toBe(false);
  });
  it('permits the real read/update scope observation without requesting create/delete', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ scopes: [read, update] }));
    const scopes = await connectedAdapter().getScopes();
    expect(SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate).toEqual([read, update]);
    expect(missingSendGridScopes(scopes, SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([]);
    expect(assessSendGridScopes(scopes).canConfigureInboundParse).toBe(false);
    expect(assessSendGridScopes(scopes).missingScopes.inboundParse).toEqual([
      'user.webhooks.parse.settings.create', 'user.webhooks.parse.settings.delete',
    ]);
    expect(String(transport.mock.calls[0][0])).toBe('https://api.sendgrid.com/v3/scopes');
  });
  it.each(['user.webhooks.parse.settings.*', 'user.webhooks.parse.*', 'user.webhooks.*', 'user.*', '*'])('reuses the existing wildcard matcher for %s', scope => {
    expect(missingSendGridScopes([scope], SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([]);
  });
  it('does not allow read or create/delete scopes to stand in for update', () => {
    expect(missingSendGridScopes([read, 'user.webhooks.parse.settings.create', 'user.webhooks.parse.settings.delete'], SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([update]);
    expect(missingSendGridScopes([update], SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([read]);
    expect(missingSendGridScopes(['user.webhooks.event.*'], SENDGRID_SCOPE_REQUIREMENTS.inboundParseUpdate)).toEqual([read, update]);
  });
});
