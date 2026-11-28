import { createHash } from 'node:crypto';
import { isErrorLike } from '../../domain/services/log-severity.js';
import { redactEngineOutput } from '../engine/opentofu/runner.js';
import type { LogSeverity, RuntimeWindow } from './types.js';

/** Safe messages only. Provider response bodies and SDK exceptions can contain secrets. */
export class ReadGap extends Error {}
/** A smaller time interval may fit this limit. Access, invalid identities and malformed responses never qualify. */
export class ReadCapacity extends ReadGap {}
export function capacity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReadCapacity(message);
}
export function check(condition: unknown, message = 'The provider returned incomplete or inconsistent workload evidence.'): asserts condition {
  if (!condition) throw new ReadGap(message);
}
export function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function timestamp(value: unknown): string {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
  return new Date(value).toISOString();
}
export function inWindow(at: string, window: RuntimeWindow): boolean {
  return Date.parse(at) >= Date.parse(window.since) && Date.parse(at) < Date.parse(window.until);
}
export function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function excerpt(text: string, secrets: string[]): string {
  return redactEngineOutput(text, secrets)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_.+/~=-]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]*/gi, '[redacted]')
    .replace(/(["']?[\w.-]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|credential|signature|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, 1000);
}
// A conservative provider-side prefilter for plain console text. Keep every
// JSON object (escaped keys, numeric levels and nested messages included).
// errorEntry still makes the final classification using the original message.
export const logHints = ['err', 'exc', 'fail', 'crash', 'fatal', 'refus', 'reject', 'crit', 'alert', 'emerg'] as const;
export function errorEntry(message: string, level: unknown): { severity: LogSeverity; message: string } | undefined {
  let structured: Record<string, unknown> = {};
  if (message.trimStart().startsWith('{')) {
    try { structured = object(JSON.parse(message)); } catch { /* plain console text */ }
  }
  const text = [structured.message, structured.msg].find((v): v is string => typeof v === 'string') ?? message;
  for (const supplied of [level, structured.severity, structured.level]) {
    // Numeric values are the standard Pino/Bunyan application levels.
    const severity = String(supplied ?? '').toUpperCase();
    if (['CRITICAL', 'ALERT', 'EMERGENCY'].includes(severity)) return { severity: severity as LogSeverity, message: text };
    if (severity === 'FATAL' || severity === '60') return { severity: 'CRITICAL', message: text };
    if (['ERROR', 'ERR', '50'].includes(severity)) return { severity: 'ERROR', message: text };
  }
  if (isErrorLike({ timestamp: '', severity: '', message: text })) return { severity: 'ERROR', message: text };
  return undefined;
}
export async function pages(read: (token: string | undefined) => Promise<unknown>): Promise<void> {
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await read(token);
    if (next === undefined || next === null || next === '') return;
    check(typeof next === 'string' && next.length <= 8192 && !seen.has(next), 'The provider repeated or returned an invalid continuation token.');
    seen.add(next);
    token = next;
  }
  throw new ReadCapacity('The provider history exceeded the page limit.');
}
export async function readJson(url: string, token: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(response.ok, `Provider read returned HTTP ${response.status}.`);
  check(response.body, 'Provider read returned no response body.');
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await stream.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > 8 * 1024 * 1024) {
      await stream.cancel();
      throw new ReadCapacity('The provider response exceeded the size limit.');
    }
    chunks.push(part.value);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
