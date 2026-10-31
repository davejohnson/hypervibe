import { createHash } from 'node:crypto';
import {
  MAX_DELIVERY_SECRET_BYTES, runtimeSecretReferenceSchema, secretDeliveryAttemptSchema,
  secretDestinationSchema, type SecretDeliveryAttempt, type SecretDeliveryResult,
  type SecretDestination, type SecretDestinationCallOptions, type SecretDestinationDeliveryOptions, type SecretDestinationFailureCode,
} from '../../domain/ports/secret-destination.port.js';

export class DestinationBoundaryError extends Error {
  constructor(readonly code: SecretDestinationFailureCode, readonly status?: number) { super(code); }
}

export class DestinationBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly incoming?: AbortSignal;
  private readonly abort = () => this.controller.abort();
  constructor(options: SecretDestinationCallOptions = {}) {
    const ms = options.deadlineMs ?? 15_000;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000) throw new DestinationBoundaryError('invalid_input');
    this.signal = this.controller.signal;
    this.incoming = options.signal;
    if (options.signal?.aborted) this.controller.abort();
    else options.signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(this.abort, ms);
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) { void promise.catch(() => {}); throw new DestinationBoundaryError('deadline_exceeded'); }
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new DestinationBoundaryError('deadline_exceeded'));
      this.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { this.signal.removeEventListener('abort', rejectAbort); }
  }
  close() { clearTimeout(this.timer); this.incoming?.removeEventListener('abort', this.abort); }
}

export function parseAttempt(input: SecretDeliveryAttempt, value?: string): SecretDeliveryAttempt {
  const parsed = secretDeliveryAttemptSchema.safeParse(input);
  if (!parsed.success || (arguments.length > 1 && (typeof value !== 'string' || !value.length || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_DELIVERY_SECRET_BYTES))) throw new DestinationBoundaryError('invalid_input');
  return parsed.data;
}
export function parseDestination(input: SecretDestination): SecretDestination {
  const parsed = secretDestinationSchema.safeParse(input);
  if (!parsed.success) throw new DestinationBoundaryError('invalid_input');
  return parsed.data;
}
export function delivered(destination: SecretDestination, version: string): SecretDeliveryResult {
  const reference = runtimeSecretReferenceSchema.safeParse({ destination, version });
  if (!reference.success) throw new DestinationBoundaryError('invalid_response');
  return { status: 'delivered', reference: reference.data };
}
export function failureCode(error: unknown): SecretDestinationFailureCode {
  return error instanceof DestinationBoundaryError ? error.code : 'provider_unavailable';
}
export function deliveryFailure(error: unknown, writeStarted: boolean): SecretDeliveryResult {
  if (writeStarted) {
    if (error instanceof DestinationBoundaryError && [400, 401, 403, 404, 409, 422].includes(error.status ?? 0)) {
      return { status: 'rejected', code: error.code };
    }
    return { status: 'unknown', code: 'write_uncertain' };
  }
  const code = failureCode(error);
  return { status: ['invalid_input', 'scope_mismatch', 'destination_absent', 'destination_initialized'].includes(code)
    ? 'rejected' : 'unknown', code };
}
export function attemptScopeTag(attempt: SecretDeliveryAttempt): string {
  // This hashes non-secret intent identity, never secret material.
  return createHash('sha256').update(JSON.stringify({ context: attempt.context, destination: attempt.destination })).digest('hex');
}

export async function authorizeDestinationWrite(budget: DestinationBudget, options?: SecretDestinationDeliveryOptions): Promise<void> {
  if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
  if (options?.beforeWrite !== undefined) {
    if (typeof options.beforeWrite !== 'function') throw new DestinationBoundaryError('invalid_input');
    try { await budget.wait(options.beforeWrite(budget.signal)); }
    catch (error) {
      if (error instanceof DestinationBoundaryError && error.code === 'deadline_exceeded') throw error;
      throw new DestinationBoundaryError('authorization_unconfirmed');
    }
  }
  if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
}

/** Fixed endpoint supplied by a provider driver; never accept an arbitrary caller URL. */
export async function destinationJson(request: typeof fetch, budget: DestinationBudget, url: string,
  token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new DestinationBoundaryError('access_denied');
  const response = await budget.wait(request(url, { ...init, redirect: 'error', signal: budget.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new DestinationBoundaryError(response.status === 401 || response.status === 403 ? 'access_denied'
      : response.status === 404 ? 'destination_absent' : 'provider_unavailable', response.status);
  }
  if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new DestinationBoundaryError('invalid_response'); }
  const reader = response.body?.getReader();
  if (!reader) throw new DestinationBoundaryError('invalid_response');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await budget.wait(reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) throw new DestinationBoundaryError('invalid_response');
      chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new DestinationBoundaryError('invalid_response');
    return result as Record<string, unknown>;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof DestinationBoundaryError ? error : new DestinationBoundaryError('invalid_response');
  } finally { reader.releaseLock(); }
}

export async function bounded<T>(options: SecretDestinationCallOptions | undefined,
  action: (budget: DestinationBudget) => Promise<T>, onError: (error: unknown) => T): Promise<T> {
  let budget: DestinationBudget | undefined;
  try {
    budget = new DestinationBudget(options);
    if (budget.signal.aborted) throw new DestinationBoundaryError('deadline_exceeded');
    return await action(budget);
  }
  catch (error) { return onError(error); }
  finally { budget?.close(); }
}
