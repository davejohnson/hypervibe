import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter } from '../sendgrid.adapter.js';

// Reconstructed official examples, never live recordings. The pinned schema does
// not constrain security_policy: the current guide independently documents its
// exact string association. Missing fields are insufficient operational evidence.
// https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks
const source = JSON.parse(readFileSync('test/provider-contracts/sendgrid/source.json', 'utf8'));
const raw = readFileSync('test/provider-contracts/sendgrid/openapi.json', 'utf8');
const schema = JSON.parse(raw);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(schema, 'sendgrid-inbound');
function validate(path: string, method: string, body: unknown, request = false) {
  expect(createHash('sha256').update(raw).digest('hex')).toBe(source.schemaSha256);
  const operation = schema.paths[path][method];
  const container = request ? operation.requestBody : operation.responses['200'];
  const base = container.$ref ?? ('#/paths/' + path.replaceAll('~', '~0').replaceAll('/', '~1') + '/' + method + (request ? '/requestBody' : '/responses/200'));
  const check = ajv.compile({ $ref: 'sendgrid-inbound' + base + '/content/application~1json/schema' });
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
}
const id = 'dd677638-a16d-4e19-95ea-20231c35511b';
const hostname = 'mail.example.com';
const url = 'https://app.example.com/inbound';
const publicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmgmjvPAR/Lmwn2teL2WJUDIx35PqsnLKjPhPbrKkfMg6vK4NZQB1VeFSKbV7whQbEJRFHjF8+1zJxsXRP1GbWw==';
const policy = { id, name: 'hypervibe-production-inbound', signature: { public_key: publicKey } };
const parse = { hostname, url, spam_check: true, send_raw: false };
const settingsPath = '/v3/user/webhooks/parse/settings/{hostname}';
const policiesPath = '/v3/user/webhooks/security/policies';
const adapter = () => { const result = new SendGridAdapter(); result.connect({ apiKey: 'private-provider-key' }); return result; };
afterEach(() => vi.restoreAllMocks());

describe('SendGrid Inbound Parse security transport', () => {
  it('reads the exact hostname and preserves association evidence', async () => {
    const response = { ...parse, security_policy: id };
    validate(settingsPath, 'get', response);
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    expect(await adapter().getInboundParseWebhook(hostname)).toEqual(response);
    expect(String(transport.mock.calls[0][0])).toBe('https://api.sendgrid.com/v3/user/webhooks/parse/settings/' + hostname);
  });
  it('does not convert omitted association evidence into null or false', async () => {
    validate(settingsPath, 'get', parse);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(parse)));
    expect(await adapter().getInboundParseWebhook(hostname)).toEqual(parse);
  });
  it('reads public material without returning OAuth credentials', async () => {
    const response = { policy: { ...policy, oauth: { client_id: 'oauth-client', token_url: 'https://oauth.example.com/token', scopes: ['webhooks:read'] } } };
    validate(policiesPath + '/{id}', 'get', response);
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    expect(await adapter().getInboundParseSecurityPolicy(id)).toEqual({ id, name: policy.name, publicKey, hasOAuth: true });
    expect(String(transport.mock.calls[0][0])).toBe('https://api.sendgrid.com/v3/user/webhooks/security/policies/' + id);
  });
  it('attaches an exact policy preserving the observed route settings', async () => {
    const response = { ...parse, security_policy: id };
    validate(settingsPath, 'patch', response);
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    await adapter().attachInboundParseSecurityPolicy(hostname, id, parse);
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
    validate(settingsPath, 'patch', body, true);
    expect(body).toEqual({ url, spam_check: true, send_raw: false, security_policy: id });
    expect(transport.mock.calls[0][1]?.method).toBe('PATCH');
  });
  it.each([{}, { policy: {} }, { policy: { ...policy, id: 'another' } }, { policy: { ...policy, signature: {} } }, { policy: { ...policy, signature: { public_key: 'invalid' } } }, { policy: { ...policy, signature: null } }])('rejects incomplete or synthetic malformed policy evidence (%j)', async response => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(adapter().getInboundParseSecurityPolicy(id)).rejects.toThrow('observation is unavailable or invalid');
  });
  it.each([{ ...parse, hostname: 'other.example.com' }, { ...parse, security_policy: null }, { ...parse, security_policy: '' }, { ...parse, send_raw: undefined }])('rejects incomplete route or undocumented policy association evidence (%j)', async response => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(adapter().getInboundParseWebhook(hostname)).rejects.toThrow('observation is unavailable or invalid');
  });
  it.each([403, 404, 429, 500])('retains unknown on HTTP %s and scrubs provider echoes', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private-provider-key', { status }));
    await expect(adapter().getInboundParseWebhook(hostname)).rejects.toThrow('observation is unavailable or invalid');
    await expect(adapter().getInboundParseSecurityPolicy(id)).rejects.toThrow('observation is unavailable or invalid');
  });
  it('does not retry or expose provider echoes after an ambiguous association write', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-provider-key ' + publicKey));
    await expect(adapter().attachInboundParseSecurityPolicy(hostname, id, parse)).rejects.toThrow('association write was not confirmed');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects a public key containing ignored trailing bytes', async () => {
    const malformedKey = Buffer.concat([Buffer.from(publicKey, 'base64'), Buffer.from('unexpected')]).toString('base64');
    // The provider schema permits strings; this is a synthetic negative cryptographic shape.
    const response = { policy: { ...policy, signature: { public_key: malformedKey } } };
    validate(policiesPath + '/{id}', 'get', response);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(adapter().getInboundParseSecurityPolicy(id)).rejects.toThrow('observation is unavailable or invalid');
  });
  it('refuses path-like identities before any transport call', async () => {
    const transport = vi.spyOn(globalThis, 'fetch');
    await expect(adapter().getInboundParseWebhook('../settings')).rejects.toThrow();
    await expect(adapter().getInboundParseSecurityPolicy('../policies')).rejects.toThrow();
    await expect(adapter().attachInboundParseSecurityPolicy(hostname, '../policies', parse)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('labels the schema boundary: security_policy is unconstrained by the pinned ParseSetting schema', () => {
    validate(settingsPath, 'get', { ...parse, security_policy: null });
    validate(settingsPath, 'get', {});
    validate(policiesPath + '/{id}', 'get', { policy: {} });
    expect(source.semanticEvidence.coverage).toContain('does not constrain its type or semantics');
  });
});
