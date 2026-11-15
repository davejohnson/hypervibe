import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter } from '../sendgrid.adapter.js';
// Reconstructed official GET/PATCH shapes, documented 2026-09-24:
// https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-an-event-webhook
// https://www.twilio.com/docs/sendgrid/api-reference/webhooks/toggle-signature-verification-for-an-event-webhook
// id is optional in responses; omission must not select the account's oldest endpoint.
const source = JSON.parse(readFileSync('test/provider-contracts/sendgrid/source.json', 'utf8'));
const raw = readFileSync('test/provider-contracts/sendgrid/openapi.json', 'utf8');
const schema = JSON.parse(raw);
const ajv = new Ajv({strict: false, validateFormats: false, allErrors: true});
ajv.addSchema(schema, 'sendgrid');
function validate(operation: string, method: 'get' | 'patch', body: unknown, request = false) {
  expect(createHash('sha256').update(raw).digest('hex')).toBe(source.schemaSha256);
  const pointer = '/paths/' + operation.replaceAll('~', '~0').replaceAll('/', '~1') + '/' + method
    + (request ? '/requestBody' : '/responses/200') + '/content/application~1json/schema';
  const check = ajv.compile({$ref: 'sendgrid#' + pointer});
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
}
const id = '77d4a5da-7015-11ed-a1eb-0242ac120002';
const url = 'https://emaildelivery.example.com/events';
const adapter = () => { const a = new SendGridAdapter(); a.connect({ apiKey: 'test-private-key' }); return a; };
afterEach(() => vi.restoreAllMocks());
describe('SendGrid exact-endpoint signing transport', () => {
  it('reads signing on the specified endpoint, never the oldest default', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id, enabled: true, url })));
    validate('/v3/user/webhooks/event/settings/{id}', 'get', {id, enabled: true, url});
    const result = await adapter().getEventWebhookSigning(id);
    expect(result).toMatchObject({ id, url, signing: false });
    expect(String(transport.mock.calls[0][0])).toBe(`https://api.sendgrid.com/v3/user/webhooks/event/settings/${id}`);
  });
  it('serializes the exact signing transition and endpoint identity', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id, public_key: '' })));
    validate('/v3/user/webhooks/event/settings/signed/{id}', 'patch', {id, public_key: ''});
    await adapter().setEventWebhookSigning(id, false);
    validate('/v3/user/webhooks/event/settings/signed/{id}', 'patch', JSON.parse(String(transport.mock.calls[0][1]?.body)), true);
    expect(String(transport.mock.calls[0][0])).toBe(`https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/${id}`);
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  });
});

// Get-all has no pagination parameters; missing webhooks is valid schema but insufficient evidence.
// https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks
it('rejects duplicate URL candidates instead of choosing the oldest webhook', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ webhooks: [{id, url}, {id: 'other', url}] })));
  await expect(adapter().resolveEventWebhookSigning(url)).rejects.toThrow('unavailable or ambiguous');
});
it('discovers one exact candidate and reads that ID', async () => {
  validate('/v3/user/webhooks/event/settings/all', 'get', {webhooks: [{id, url}]});
  validate('/v3/user/webhooks/event/settings/{id}', 'get', {enabled: true, url});
  const transport = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({webhooks: [{id, url}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({enabled: true, url})));
  expect(await adapter().resolveEventWebhookSigning(url)).toMatchObject({id, signing: false});
  expect(String(transport.mock.calls[0][0])).toMatch(/\/settings\/all$/);
  expect(String(transport.mock.calls[1][0])).toBe('https://api.sendgrid.com/v3/user/webhooks/event/settings/' + id);
});

it.each([{}, {enabled: true}, {enabled: true, url, public_key: null}, {enabled: true, url, public_key: 'invalid'}, {id: 'another', enabled: true, url}])('treats incomplete or invalid signing evidence as unknown (%j)', async response => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
  await expect(adapter().getEventWebhookSigning(id)).rejects.toThrow('unavailable or invalid');
});
it.each([403, 404, 429, 500])('does not treat HTTP %s as disabled signing or expose provider echoes', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('test-private-key', {status}));
  await expect(adapter().getEventWebhookSigning(id)).rejects.toThrow('observation is unavailable');
});
it.each([{}, {webhooks: []}, {webhooks: [{url}]}, {webhooks: [{id}]}])('blocks discovery without unambiguous identity evidence (%j)', async response => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
  await expect(adapter().resolveEventWebhookSigning(url)).rejects.toThrow('unavailable or ambiguous');
});
it('uses a durable ID without selecting a same-URL candidate', async () => {
  const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({enabled: true, url})));
  expect(await adapter().resolveEventWebhookSigning(url, id)).toMatchObject({id, signing: false});
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0][0])).toBe('https://api.sendgrid.com/v3/user/webhooks/event/settings/' + id);
});
it('refuses empty and path-like IDs before transport', async () => {
  const transport = vi.spyOn(globalThis, 'fetch');
  for (const invalid of ['', '../all', 'signed/foo']) {
    await expect(adapter().getEventWebhookSigning(invalid)).rejects.toThrow();
    await expect(adapter().setEventWebhookSigning(invalid, true)).rejects.toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});

it('distinguishes valid optional omissions from malformed schema fields', () => {
  validate('/v3/user/webhooks/event/settings/{id}', 'get', {});
  validate('/v3/user/webhooks/event/settings/all', 'get', {});
  const check = ajv.compile({$ref: 'sendgrid#/paths/~1v3~1user~1webhooks~1event~1settings~1{id}/get/responses/200/content/application~1json/schema'});
  expect(check({enabled: true, url, public_key: null})).toBe(false);
});
