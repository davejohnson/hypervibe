import { expect } from 'vitest';
export const SENDGRID_TEST_TOKEN = 'synthetic-private-management-token';
export const SENDGRID_RUNTIME_TOKEN = 'synthetic-private-send-only-token';
/** Reconstructed pinned SendGrid v3 create/list/delete and native direct GET projection.
 * The service echoes the opaque requested name; scopes and native identity are
 * independent fixed responses. No live account or credential is used. */
export function sendGridOperatorFixture(options: { wrongAccount?: boolean; senderUnknown?: boolean; deniedRead?: boolean; deniedCreate?: boolean;
  lostCreate?: boolean; sandboxStatus?: number; broadCreated?: boolean; badResponse?: boolean; returnExisting?: boolean; deniedDelete?: boolean; senderPath?: 'domain' | 'single'; echoedPrivateId?: boolean; getEnvelope?: boolean } = {}) {
  const accountId = '12345', writes: Array<{ method: string; path: string; body?: any }> = [], reads: string[] = [];
  const prior = { api_key_id: 'existing-production-key', name: 'Existing production key', scopes: ['mail.send', 'alerts.read'] };
  const keys = new Map<string, any>([[prior.api_key_id, structuredClone(prior)]]); let sequence = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    expect(url.origin).toBe('https://api.sendgrid.com'); expect(init?.redirect).toBe('error');
    const auth = new Headers(init?.headers).get('authorization');
    expect(auth).toBe(`Bearer ${url.pathname === '/v3/mail/send' ? SENDGRID_RUNTIME_TOKEN : SENDGRID_TEST_TOKEN}`);
    if (method === 'GET') {
      reads.push(url.pathname); if (options.deniedRead) return new Response(SENDGRID_TEST_TOKEN, { status: 403 });
      if (url.pathname === '/v3/user/username') return Response.json({ user_id: options.wrongAccount ? 555 : 12345, username: 'synthetic-owner' });
      if (url.pathname === '/v3/scopes') return Response.json({ scopes: ['api_keys.create', 'api_keys.read', 'api_keys.delete', 'user.username.read', ...(options.senderPath === 'single' ? ['user.email.read'] : options.senderPath === 'domain' ? ['whitelabel.read'] : ['whitelabel.read', 'user.email.read'])] });
      if (url.pathname === '/v3/whitelabel/domains') return options.senderPath === 'single' ? new Response(null, { status: 403 }) : Response.json([{ id: 77, domain: 'example.test', valid: !options.senderUnknown, automatic_security: true }]);
      if (url.pathname === '/v3/verified_senders') return options.senderPath === 'domain' ? new Response(null, { status: 403 }) : Response.json({ results: options.senderPath === 'single' ? [{ id: 88, from_email: 'operator@example.test', verified: !options.senderUnknown }] : [] });
      if (url.pathname === '/v3/api_keys') { expect(url.searchParams.get('limit')).toBe('100'); return Response.json({ result: [...keys.values()].map(k => ({ api_key_id: k.api_key_id, name: k.name })) }); }
      if (url.pathname.startsWith('/v3/api_keys/')) { const key = keys.get(url.pathname.split('/').at(-1)!); return key ? Response.json(options.getEnvelope ? { result: [key] } : key) : new Response(null, { status: 404 }); }
    }
    if (method === 'POST' && url.pathname === '/v3/api_keys') {
      if (options.deniedCreate) return new Response(SENDGRID_TEST_TOKEN, { status: 403 });
      expect(body.scopes).toEqual(['mail.send']); expect(Object.keys(body).sort()).toEqual(['name', 'scopes']);
      writes.push({ method, path: url.pathname, body }); const id = options.returnExisting ? prior.api_key_id : `new-test-key-${++sequence}`;
      const key = { api_key_id: id, name: body.name, scopes: options.broadCreated ? ['mail.send', 'alerts.read'] : ['mail.send'] }; if (!options.returnExisting) keys.set(id, key);
      if (options.lostCreate) throw new Error('Synthetic lost one-time response');
      return Response.json(options.badResponse ? { name: body.name } : { ...key, ...(options.echoedPrivateId ? { api_key_id: SENDGRID_RUNTIME_TOKEN } : {}), api_key: SENDGRID_RUNTIME_TOKEN }, { status: 201 });
    }
    if (method === 'POST' && url.pathname === '/v3/mail/send') {
      expect(body.mail_settings).toEqual({ sandbox_mode: { enable: true } }); expect(body.personalizations).toEqual([{ to: [{ email: 'consenting@example.test' }] }]);
      writes.push({ method, path: url.pathname, body }); return new Response(options.sandboxStatus ? SENDGRID_RUNTIME_TOKEN : null, { status: options.sandboxStatus ?? 200 });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v3/api_keys/')) {
      writes.push({ method, path: url.pathname }); if (options.deniedDelete) return new Response(null, { status: 403 });
      keys.delete(url.pathname.split('/').at(-1)!); return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected reconstructed SendGrid endpoint');
  };
  return { accountId, request, writes, reads, prior, keys };
}
