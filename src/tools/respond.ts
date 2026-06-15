/**
 * Single response envelope for all MCP tools.
 *
 * Every tool returns JSON with this shape so the calling agent can rely on
 * one contract: `ok` to branch on, `error.code` to classify failures,
 * `hint`/`next` to self-recover.
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_PROJECT'
  | 'VALIDATION'
  | 'CONFIRM_REQUIRED'
  | 'MISSING_CONNECTION'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  /** What the agent should do next to make progress. */
  hint?: string;
  warnings?: string[];
  /** Suggested follow-up tool calls, e.g. ["hv_plan"]. */
  next?: string[];
}

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

export interface ResponseExtras {
  hint?: string;
  warnings?: string[];
  next?: string[];
}

const REDACTED = '[redacted]';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'apitoken',
  'authorization',
  'authtoken',
  'clientsecret',
  'connectionstring',
  'connectionurl',
  'credentials',
  'credentialsencrypted',
  'databasepassword',
  'databaseurl',
  'dbpassword',
  'directurl',
  'password',
  'passphrase',
  'pgpassword',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'signingsecret',
  'token',
  'webhooksecret',
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  if (/^(database|db|pg).*(url|password)$/.test(normalized)) {
    return true;
  }
  if (/^(access|refresh|admin|api|auth).*token$/.test(normalized)) {
    return true;
  }
  return false;
}

function redactSensitiveString(value: string): string {
  if (value.includes(REDACTED) || value.includes('***')) {
    return value;
  }

  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+:[^@\s/]+)@/gi, `$1${REDACTED}@`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\bgh[oprsu]_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\brk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bsbp_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bsb_secret_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{16,}/g, REDACTED);
}

function redactForResponse(value: unknown, keyHint?: string, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    if (keyHint && isSensitiveKey(keyHint)) {
      return value.includes(REDACTED) || value.includes('***') ? value : REDACTED;
    }
    return redactSensitiveString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((entry) => redactForResponse(entry, keyHint, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) && entry && typeof entry === 'object'
      ? REDACTED
      : redactForResponse(entry, key, seen);
  }
  seen.delete(value);
  return output;
}

function envelope(payload: ToolEnvelope): ToolResponse {
  const safePayload = redactForResponse(payload) as ToolEnvelope;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(safePayload) }],
  };
}

export function toolSuccess(data?: unknown, extras?: ResponseExtras): ToolResponse {
  return envelope({
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

export function toolError(
  code: ErrorCode,
  message: string,
  extras?: ResponseExtras & { details?: unknown }
): ToolResponse {
  return envelope({
    ok: false,
    error: {
      code,
      message,
      ...(extras?.details !== undefined ? { details: extras.details } : {}),
    },
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

/**
 * Typed error a handler can throw to short-circuit into a structured
 * toolError response (caught by wrapHandler).
 */
export class HvError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly extras?: ResponseExtras & { details?: unknown }
  ) {
    super(message);
    this.name = 'HvError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a tool handler so thrown errors become structured envelopes instead
 * of MCP protocol errors. HvError keeps its code; anything else is INTERNAL.
 */
export function wrapHandler<Args>(
  fn: (args: Args) => Promise<ToolResponse> | ToolResponse
): (args: Args) => Promise<ToolResponse> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error) {
      if (error instanceof HvError) {
        return toolError(error.code, error.message, error.extras);
      }
      return toolError('INTERNAL', describeError(error));
    }
  };
}
