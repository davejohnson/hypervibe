import { z } from 'zod';
import { redactSensitiveString } from '../../../utils/redact-sensitive-string.js';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const messageIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.=-]+$/)
  .refine((value) => value !== '.' && value !== '..' && redactSensitiveString(value) === value);
const statusSchema = z.enum(['processed', 'delivered', 'deferred', 'dropped', 'bounced', 'blocked']);
const inputSchema = z.object({
  messageId: messageIdSchema.optional(),
  recipient: z.string().max(254).email().refine((value) => !/['"\\\s]/.test(value)).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  errorsOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

export type SendGridEmailLogsInput = z.infer<typeof inputSchema>;
export type SendGridLogsErrorCategory = 'invalid_input' | 'access_denied' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'budget_exhausted';
export interface SendGridLogsValidation {
  stage: 'response' | 'search-results' | 'message' | 'events';
  reason: 'schema' | 'json' | 'identity_mismatch' | 'filter_mismatch' | 'unsafe_identity';
  fields: string[];
}
const safeErrors: Record<SendGridLogsErrorCategory, string> = {
  invalid_input: 'SendGrid logs require a valid bounded search within the last 30 days, or an exact messageId without search filters. Recipient addresses containing quotes, backslashes or whitespace are unsupported.',
  access_denied: 'SendGrid Email Logs access is unavailable with this connection. Check the API key permissions and account or subuser scope; this response does not establish a billing requirement.',
  not_found: 'SendGrid did not find that message in the selected account history. It may be outside retention; this does not prove that no send was attempted.',
  rate_limited: 'SendGrid Email Logs rate limited this read. Wait before retrying the same bounded request.',
  unavailable: 'SendGrid Email Logs could not be read. Check provider availability and connectivity before retrying.',
  invalid_response: 'SendGrid returned incomplete or invalid email-log evidence. Delivery state remains unknown.',
  budget_exhausted: 'SendGrid Email Logs exceeded the bounded read budget. Narrow the time window or reduce the limit.',
};

/** Fixed messages only: upstream errors can echo recipients, credentials and email contents. */
export class SendGridLogsError extends Error {
  constructor(readonly category: SendGridLogsErrorCategory, readonly status?: number, readonly validation?: SendGridLogsValidation) {
    super(safeErrors[category]);
    this.name = 'SendGridLogsError';
  }
}

export interface SendGridEmailLogEvent {
  event: string;
  occurredAt: string | null;
  smtpStatus?: string;
  bounceClassification?: string;
}
export interface SendGridEmailLogMessage {
  messageId: string;
  status: z.infer<typeof statusSchema> | 'unknown';
  createdAt: string | null;
  events?: SendGridEmailLogEvent[];
  eventsCoverage?: 'returned' | 'limited' | 'unknown';
}
export interface SendGridEmailLogs {
  observedAt: string;
  window: { since: string; until: string; field: 'message-created-at' } | null;
  recipientFiltered: boolean;
  errorsOnly: boolean;
  messages: SendGridEmailLogMessage[];
  truncated: boolean;
}

const messageSchema = z.object({
  sg_message_id: messageIdSchema,
  status: statusSchema.optional(),
  sg_message_id_created_at: z.string().datetime({ offset: true }).optional(),
  to_email: z.string().optional(),
});
const eventSchema = z.object({
  // Email Logs has its own published union, including received; do not derive it
  // from Event Webhook names or the message-status summary's legacy spellings.
  event: z.enum(['received', 'processed', 'delivered', 'deferred', 'bounce', 'dropped', 'cancel_drop', 'open', 'click', 'spamreport', 'unsubscribe', 'group_unsubscribe', 'group_resubscribe']).optional(),
  timestamp: z.number().int().min(0).max(253402300799).optional(),
  sg_message_id: messageIdSchema.optional(),
  // Email Logs docs show a narrower pattern, but RFC 3463 §2 and Twilio's
  // documented 5.7.26 rejection establish multi-digit enhanced status codes.
  status: z.string().regex(/^(?:[245]\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})|[1-5][0-9][0-9])$/).optional(),
  bounce_classification: z.enum(['Content', 'Frequency or Volume Too High', 'Invalid Address', 'Mailbox Unavailable', 'Reputation', 'Technical', 'Unclassified']).optional(),
});

const diagnosticFields = new Set(['messages', 'sg_message_id', 'status', 'sg_message_id_created_at', 'to_email', 'events', 'event', 'timestamp', 'bounce_classification']);
function parseEvidence<S extends z.ZodTypeAny>(schema: S, value: unknown, stage: SendGridLogsValidation['stage']): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Never return Zod messages, received values or arbitrary provider property names.
  const fields = [...new Set(result.error.issues.slice(0, 5).map((issue) => issue.path
    .map((part) => typeof part === 'number' ? '*' : diagnosticFields.has(part) ? part : 'field')
    .join('.') || 'response'))];
  throw new SendGridLogsError('invalid_response', undefined, { stage, reason: 'schema', fields });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SendGridLogsError('budget_exhausted'));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function requestLogs(apiKey: string, endpoint: string, body?: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await abortable(fetch(`https://api.sendgrid.com/v3${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: controller.signal,
    }), controller.signal);
    reader = response.body?.getReader();
    if (!response.ok) {
      const category = response.status === 401 || response.status === 403 ? 'access_denied'
        : response.status === 404 && !body ? 'not_found'
          : response.status === 429 ? 'rate_limited' : 'unavailable';
      throw new SendGridLogsError(category, response.status);
    }
    if (response.status !== 200 || !reader) throw new SendGridLogsError('invalid_response', undefined, { stage: 'response', reason: 'schema', fields: [] });
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new SendGridLogsError('budget_exhausted');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await abortable(reader.read(), controller.signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new SendGridLogsError('budget_exhausted');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new SendGridLogsError('invalid_response', undefined, { stage: 'response', reason: 'json', fields: [] }); }
  } catch (error) {
    if (error instanceof SendGridLogsError) throw error;
    throw new SendGridLogsError(controller.signal.aborted ? 'budget_exhausted' : 'unavailable');
  } finally {
    clearTimeout(timeout);
    // Do not await an unresponsive upstream cancellation.
    void reader?.cancel().catch(() => undefined);
  }
}

/** Email Logs is a read API even though the search endpoint uses POST. No legacy paid API fallback. */
export async function readSendGridEmailLogs(apiKey: string, input: SendGridEmailLogsInput): Promise<SendGridEmailLogs> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SendGridLogsError('invalid_input');
  const options = parsed.data;
  const limit = options.limit ?? 50;
  const now = Date.now();
  if (options.messageId && (options.recipient !== undefined || options.since !== undefined || options.until !== undefined || options.errorsOnly !== undefined)) {
    throw new SendGridLogsError('invalid_input');
  }
  const until = options.until ? Date.parse(options.until) : now;
  const since = options.since ? Date.parse(options.since) : until - DAY_MS;
  if (!options.messageId && (since >= until || since < now - 30 * DAY_MS || until > now)) throw new SendGridLogsError('invalid_input');
  const window = options.messageId ? null : { since: new Date(since).toISOString(), until: new Date(until).toISOString(), field: 'message-created-at' as const };
  const conditions = window ? [
    `sg_message_id_created_at >= TIMESTAMP "${window.since}"`,
    `sg_message_id_created_at <= TIMESTAMP "${window.until}"`,
    ...(options.errorsOnly ? ["status IN ('deferred', 'dropped', 'bounced', 'blocked')"] : []),
    ...(options.recipient ? [`to_email = '${options.recipient}'`] : []),
  ] : [];
  const data = await requestLogs(apiKey, options.messageId ? `/logs/${encodeURIComponent(options.messageId)}` : '/logs',
    options.messageId ? undefined : { query: conditions.join(' AND '), limit });
  try {
    const rows = options.messageId ? [data] : parseEvidence(z.object({ messages: z.array(z.unknown()).max(1000) }), data, 'search-results').messages;
    const messages = rows.slice(0, limit).map((row): SendGridEmailLogMessage => {
      const message = parseEvidence(messageSchema, row, 'message');
      if (message.sg_message_id.includes(apiKey)) throw new SendGridLogsError('invalid_response', undefined, { stage: 'message', reason: 'unsafe_identity', fields: ['sg_message_id'] });
      if (options.messageId && message.sg_message_id !== options.messageId) throw new SendGridLogsError('invalid_response', undefined, { stage: 'message', reason: 'identity_mismatch', fields: ['sg_message_id'] });
      if (options.recipient && message.to_email !== undefined && message.to_email !== options.recipient) throw new SendGridLogsError('invalid_response', undefined, { stage: 'message', reason: 'filter_mismatch', fields: ['to_email'] });
      if (options.errorsOnly && !['deferred', 'dropped', 'bounced', 'blocked'].includes(message.status ?? '')) throw new SendGridLogsError('invalid_response', undefined, { stage: 'message', reason: 'filter_mismatch', fields: ['status'] });
      const createdAt = message.sg_message_id_created_at ? new Date(message.sg_message_id_created_at).toISOString() : null;
      if (window && createdAt && (Date.parse(createdAt) < since || Date.parse(createdAt) > until)) throw new SendGridLogsError('invalid_response', undefined, { stage: 'message', reason: 'filter_mismatch', fields: ['sg_message_id_created_at'] });
      const result: SendGridEmailLogMessage = { messageId: message.sg_message_id, status: message.status ?? 'unknown', createdAt };
      if (options.messageId) {
        const events = parseEvidence(z.object({ events: z.array(eventSchema).max(100).optional() }), row, 'events').events;
        result.eventsCoverage = events === undefined ? 'unknown' : events.length >= Math.min(limit, 100) ? 'limited' : 'returned';
        result.events = events?.slice(0, limit).map((event) => {
          if (event.sg_message_id && event.sg_message_id !== message.sg_message_id) throw new SendGridLogsError('invalid_response', undefined, { stage: 'events', reason: 'identity_mismatch', fields: ['events.*.sg_message_id'] });
          return {
            event: event.event ?? 'unknown',
            occurredAt: event.timestamp === undefined ? null : new Date(event.timestamp * 1000).toISOString(),
            ...(event.status ? { smtpStatus: event.status } : {}),
            ...(event.bounce_classification ? { bounceClassification: event.bounce_classification } : {}),
          };
        });
      }
      return result;
    });
    return { observedAt: new Date().toISOString(), window, recipientFiltered: options.recipient !== undefined,
      errorsOnly: options.errorsOnly ?? false, messages,
      truncated: options.messageId ? messages[0]?.eventsCoverage === 'limited' : rows.length >= limit };
  } catch (error) {
    if (error instanceof SendGridLogsError) throw error;
    throw new SendGridLogsError('invalid_response', undefined, { stage: 'response', reason: 'schema', fields: [] });
  }
}
