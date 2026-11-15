import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendGridAdapter } from '../sendgrid.adapter.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const schemaBytes = readFileSync(new URL('../../../../../test/provider-contracts/sendgrid/email-logs.openapi.json', import.meta.url));
const schemaSource = JSON.parse(readFileSync(new URL('../../../../../test/provider-contracts/sendgrid/email-logs.source.json', import.meta.url), 'utf8'));
const officialSchemas = JSON.parse(schemaBytes.toString('utf8')).components.schemas;
const documentedEvents: string[] = officialSchemas.EmailLogsEvent.oneOf.flatMap((variant: { $ref: string }) => {
  const variantSchema = officialSchemas[variant.$ref.split('/').at(-1)!];
  return officialSchemas[variantSchema.properties.event.$ref.split('/').at(-1)!].enum;
});

// Synthetic wire responses based on Twilio's Email Logs documentation, not live captures.
// See test/provider-contracts/sendgrid-email-logs.md for the evidence boundary.
const now = new Date('2026-10-14T12:00:00.000Z');
const apiKey = 'synthetic-provider-key';
const recipient = 'recipient@example.test';
const messageId = 'Xj5LmNkWSOqRbdvOpR34BA.recvd-85abf8d92c-3qfgp-2-7890E356-43C.1';
let adapter: SendGridAdapter;
let transport: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  adapter = new SendGridAdapter();
  adapter.connect({ apiKey });
  transport = vi.fn();
  vi.stubGlobal('fetch', transport);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SendGrid Email Logs serialized transport', () => {
  it('pins the independently published Email Logs event vocabulary', () => {
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(schemaSource.schemaSha256);
    expect(schemaSource.upstreamRevision).toBe('fb95a935c87b79f7f982ac34bd37adab1f697dbc');
    expect(documentedEvents.slice().sort()).toEqual(Object.keys(officialSchemas.EmailLogsEvent.discriminator.mapping).sort());
  });

  it.each(documentedEvents)('preserves the official Email Logs event %s through the real client', async (event) => {
    // These are safe event projections, not full-schema-valid lifecycle captures.
    transport.mockResolvedValue(Response.json({ sg_message_id: messageId, status: 'blocked',
      events: [{ event, timestamp: 1791975600, ...(event === 'received' ? { recv_msgid: 'synthetic-received-id' } : { sg_message_id: messageId }) }],
    }));
    await expect(adapter.readEmailLogs({ messageId })).resolves.toMatchObject({
      messages: [{ eventsCoverage: 'returned', events: [{ event, occurredAt: '2026-10-14T11:00:00.000Z' }] }],
    });
  });

  it('retains unknown evidence for an undocumented event without leaking its name', async () => {
    transport.mockResolvedValue(Response.json({ sg_message_id: messageId,
      events: [{ event: `private ${recipient}` }],
    }));
    const error = await adapter.readEmailLogs({ messageId }).catch((value: unknown) => value);
    expect(error).toMatchObject({ category: 'invalid_response', validation: {
      stage: 'events', reason: 'schema', fields: ['events.*.event'],
    } });
    expect(JSON.stringify(error)).not.toContain(recipient);
  });

  it('searches one bounded account window and returns delivery metadata without email contents', async () => {
    transport.mockResolvedValue(Response.json({ messages: [{
      sg_message_id: messageId, status: 'bounced', sg_message_id_created_at: '2026-10-14T11:00:00Z',
      to_email: recipient, from_email: 'sender@example.test', subject: 'private subject',
      reason: `550 ${recipient} ${apiKey}`, custom_args: { token: 'private-token' },
    }] }));
    const result = await adapter.readEmailLogs({ recipient, errorsOnly: true, limit: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/logs');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      limit: 1,
      query: 'sg_message_id_created_at >= TIMESTAMP "2026-10-13T12:00:00.000Z" AND sg_message_id_created_at <= TIMESTAMP "2026-10-14T12:00:00.000Z" AND status IN (\'deferred\', \'dropped\', \'bounced\', \'blocked\') AND to_email = \'recipient@example.test\'',
    });
    expect(result).toMatchObject({
      observedAt: now.toISOString(), truncated: true, recipientFiltered: true,
      window: { since: '2026-10-13T12:00:00.000Z', until: now.toISOString(), field: 'message-created-at' },
      messages: [{ messageId, status: 'bounced', createdAt: '2026-10-14T11:00:00.000Z' }],
    });
    for (const sensitive of [recipient, apiKey, 'private subject', 'private-token', 'sender@example.test']) {
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
  });

  it('reads an exact message timeline with only allowlisted event diagnostics', async () => {
    transport.mockResolvedValue(Response.json({ sg_message_id: messageId, status: 'bounced',
      to_email: recipient, subject: 'private subject', api_key_id: 'private-key-id',
      events: [{ event: 'bounce', timestamp: 1791975600, sg_message_id: messageId,
        status: '5.1.1', bounce_classification: 'Invalid Address', reason: `550 ${recipient}`,
        custom_args: { secret: apiKey }, email: recipient, ip: '192.0.2.1' }],
    }));
    const result = await adapter.readEmailLogs({ messageId });
    expect(transport.mock.calls[0][0]).toBe(`https://api.sendgrid.com/v3/logs/${messageId}`);
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(result.messages[0]).toMatchObject({ messageId, status: 'bounced', events: [{
      event: 'bounce', occurredAt: '2026-10-14T11:00:00.000Z', smtpStatus: '5.1.1', bounceClassification: 'Invalid Address',
    }] });
    expect(JSON.stringify(result)).not.toMatch(/private|recipient@|192\.0\.2\.1|synthetic-provider/);
  });

  it.each([{}, { messages: null }, { messages: [{}] }, { messages: [{ sg_message_id: messageId, status: 'unexpected' }] }])(
    'keeps incomplete or malformed list evidence unknown: %j', async (payload) => {
      transport.mockResolvedValue(Response.json(payload));
      await expect(adapter.readEmailLogs({})).rejects.toMatchObject({ category: 'invalid_response' });
    }
  );

  it('accepts a confirmed empty list without making a delivery claim', async () => {
    transport.mockResolvedValue(Response.json({ messages: [] }));
    await expect(adapter.readEmailLogs({})).resolves.toMatchObject({ messages: [], truncated: false });
  });

  it('keeps documented optional status/time fields unknown', async () => {
    transport.mockResolvedValue(Response.json({ messages: [{ sg_message_id: messageId }] }));
    await expect(adapter.readEmailLogs({})).resolves.toMatchObject({
      messages: [{ messageId, status: 'unknown', createdAt: null }],
    });
  });

  it('rejects secret-shaped message IDs even when they differ from the connected key', async () => {
    transport.mockResolvedValue(Response.json({ messages: [{ sg_message_id: `SG.${'A'.repeat(22)}.${'B'.repeat(43)}`, status: 'bounced' }] }));
    await expect(adapter.readEmailLogs({})).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('does not claim an errors-only search when the provider returns a delivered message', async () => {
    transport.mockResolvedValue(Response.json({ messages: [{ sg_message_id: messageId, status: 'delivered' }] }));
    await expect(adapter.readEmailLogs({ errorsOnly: true })).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('rejects a detail response for a different message', async () => {
    transport.mockResolvedValue(Response.json({ sg_message_id: 'different', status: 'delivered', events: [] }));
    await expect(adapter.readEmailLogs({ messageId })).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('preserves standard enhanced SMTP status codes with multi-digit subcodes', async () => {
    // RFC 3463 section 2; Twilio Help article 47454601923483 documents 5.7.26.
    transport.mockResolvedValue(Response.json({ sg_message_id: messageId, status: 'blocked',
      events: [{ event: 'bounce', status: '5.7.26' }],
    }));
    await expect(adapter.readEmailLogs({ messageId })).resolves.toMatchObject({
      messages: [{ status: 'blocked', events: [{ smtpStatus: '5.7.26' }] }],
    });
  });

  it('identifies rejected fields without echoing values or schema error messages', async () => {
    transport.mockResolvedValue(Response.json({ sg_message_id: messageId,
      events: [{ event: 'bounce', timestamp: `private ${recipient}`, status: `550 ${apiKey}` }],
    }));
    const error = await adapter.readEmailLogs({ messageId }).catch((value: unknown) => value);
    expect(error).toMatchObject({ category: 'invalid_response', validation: {
      stage: 'events', reason: 'schema', fields: ['events.*.timestamp', 'events.*.status'],
    } });
    expect(JSON.stringify(error)).not.toMatch(/private|recipient@|synthetic-provider/);
  });

  it.each([[401, 'access_denied'], [403, 'access_denied'], [404, 'not_found'], [429, 'rate_limited'], [500, 'unavailable']])(
    'reports HTTP %s safely without raw provider errors', async (status, category) => {
      transport.mockResolvedValue(Response.json({ errors: [{ message: `${apiKey} ${recipient} private subject` }] }, { status: status as number }));
      const error = await adapter.readEmailLogs({ messageId }).catch((value: unknown) => value);
      expect(error).toMatchObject({ category, status });
      expect(String(error)).not.toMatch(/private|recipient@|synthetic-provider/);
    }
  );

  it.each([
    { recipient: "a' OR status IN ('delivered')@example.test" },
    { messageId: '../secrets' },
    { messageId: '..' },
    { messageId: '.' },
    { limit: 501 },
    { since: '2026-08-01T00:00:00Z' },
    { since: '2026-10-15T00:00:00Z' },
    { messageId, recipient },
  ])('rejects unsafe or ambiguous input before fetching: %j', async (input) => {
    await expect(adapter.readEmailLogs(input)).rejects.toMatchObject({ category: 'invalid_input' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('caps a provider response while streaming, not after JSON parsing', async () => {
    transport.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(adapter.readEmailLogs({})).rejects.toMatchObject({ category: 'budget_exhausted' });
  });

  it('sanitizes network errors that echo request data', async () => {
    transport.mockRejectedValue(new Error(`${apiKey} ${recipient}`));
    await expect(adapter.readEmailLogs({ recipient })).rejects.toMatchObject({ category: 'unavailable' });
  });

  it('bounds a stalled response body with the same deadline as the request', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    transport.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = adapter.readEmailLogs({}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await result).toMatchObject({ category: 'budget_exhausted' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('records completion time independently of the source query window', async () => {
    transport.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 5000));
      return Response.json({ messages: [] });
    });
    const result = await adapter.readEmailLogs({});
    expect(result.window?.until).toBe(now.toISOString());
    expect(result.observedAt).toBe('2026-10-14T12:00:05.000Z');
  });

  it('preserves the provider 100-event ceiling and omitted timeline uncertainty', async () => {
    transport.mockResolvedValueOnce(Response.json({ sg_message_id: messageId, events: Array.from({ length: 100 }, () => ({ event: 'deferred' })) }))
      .mockResolvedValueOnce(Response.json({ sg_message_id: messageId }));
    await expect(adapter.readEmailLogs({ messageId, limit: 500 })).resolves.toMatchObject({ truncated: true, messages: [{ eventsCoverage: 'limited' }] });
    await expect(adapter.readEmailLogs({ messageId })).resolves.toMatchObject({ messages: [{ eventsCoverage: 'unknown' }] });
  });
});
