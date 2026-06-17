/**
 * Single response envelope for all MCP tools.
 *
 * Every tool returns this envelope as structuredContent so clients can rely on
 * one contract: `ok` to branch on, `error.code` to classify failures,
 * `hint`/`next` to self-recover. The visible text content is formatted for
 * humans so the MCP transcript is readable.
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
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function titleForKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusIcon(status?: string): string {
  const normalized = status?.toLowerCase();
  if (!normalized) return '•';
  if (['ok', 'success', 'succeeded', 'complete', 'completed', 'verified', 'active', 'running', 'in_sync'].includes(normalized)) {
    return '✅';
  }
  if (['failed', 'failure', 'error', 'errored', 'rejected', 'missing', 'unverified', 'blocked'].includes(normalized)) {
    return '❌';
  }
  if (['warning', 'warn', 'skipped', 'noop', 'pending', 'queued', 'unknown'].includes(normalized)) {
    return '⚠️';
  }
  return '•';
}

function actionIcon(type?: string): string {
  switch (type?.toLowerCase()) {
    case 'create':
      return '➕';
    case 'update':
      return '🔧';
    case 'destroy':
    case 'delete':
      return '🧨';
    case 'replace':
      return '♻️';
    case 'noop':
      return '✅';
    default:
      return '•';
  }
}

function emphasizeLabel(line: string): string {
  const match = /^([A-Za-z][A-Za-z0-9 _/-]{0,47}):\s*(.*)$/.exec(line);
  if (!match) return line;
  return `**${match[1]}**: ${match[2]}`;
}

function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 140 ? `${value.slice(0, 137)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function summarizeProject(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name : undefined;
  const id = typeof value.id === 'string' ? value.id : undefined;
  const gitRemoteUrl = typeof value.gitRemoteUrl === 'string' ? value.gitRemoteUrl : undefined;
  const parts = [
    name ?? id,
    id && name ? `id ${id}` : undefined,
    gitRemoteUrl ? `git ${gitRemoteUrl}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function summarizeSpec(value: unknown): string[] {
  if (!isRecord(value)) return [summarizeValue(value)];
  const project = typeof value.project === 'string' ? value.project : 'project';
  const lines = [`${project}${typeof value.version === 'number' ? ` (v${value.version})` : ''}`];
  const environments = isRecord(value.environments) ? value.environments : {};
  for (const [name, env] of Object.entries(environments).slice(0, 8)) {
    if (!isRecord(env)) {
      lines.push(`${name}: ${summarizeValue(env)}`);
      continue;
    }
    const hosting = isRecord(env.hosting) && typeof env.hosting.provider === 'string'
      ? env.hosting.provider
      : 'unknown hosting';
    const services = isRecord(env.services) ? Object.keys(env.services) : [];
    const database = isRecord(env.database) && typeof env.database.provider === 'string'
      ? `${env.database.provider}${typeof env.database.engine === 'string' ? `/${env.database.engine}` : ''}`
      : undefined;
    const deploy = isRecord(env.deploy)
      ? `${typeof env.deploy.strategy === 'string' ? env.deploy.strategy : 'deploy'}${typeof env.deploy.trigger === 'string' ? `/${env.deploy.trigger}` : ''}${typeof env.deploy.branch === 'string' ? `@${env.deploy.branch}` : ''}`
      : undefined;
    const parts = [
      `hosting ${hosting}`,
      services.length > 0 ? `services ${services.join(', ')}` : undefined,
      database ? `database ${database}` : undefined,
      typeof env.domain === 'string' ? `domain ${env.domain}` : undefined,
      isRecord(env.email) && env.email.enabled === true ? 'email enabled' : undefined,
      deploy ? `deploy ${deploy}` : undefined,
    ].filter(Boolean);
    lines.push(`${name}: ${parts.join('; ')}`);
  }
  const total = Object.keys(environments).length;
  if (total > 8) lines.push(`... ${total - 8} more environment(s)`);
  return lines;
}

function summarizeAction(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const id = typeof value.id === 'string' ? value.id : undefined;
  const type = typeof value.type === 'string' ? value.type : undefined;
  const resource = isRecord(value.resource) ? value.resource : undefined;
  const resourceName = resource
    ? [
      typeof resource.kind === 'string' ? resource.kind : undefined,
      typeof resource.name === 'string' ? resource.name : undefined,
    ].filter(Boolean).join(':')
    : undefined;
  const provider = resource && typeof resource.provider === 'string' ? `on ${resource.provider}` : undefined;
  const reason = typeof value.reason === 'string' ? `- ${value.reason}` : undefined;
  const actionName = id ?? resourceName ?? 'action';
  return [actionIcon(type), `\`${actionName}\``, type, provider, reason].filter(Boolean).join(' ');
}

function summarizeReceipt(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const actionId = typeof value.actionId === 'string' ? value.actionId : undefined;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const error = typeof value.error === 'string' ? `error: ${value.error}` : undefined;
  return [statusIcon(status), actionId ? `\`${actionId}\`` : 'receipt', status, message, error].filter(Boolean).join(' - ');
}

function summarizeConnection(value: unknown): string {
  if (!isRecord(value)) return summarizeValue(value);
  const provider = typeof value.provider === 'string' ? value.provider : 'connection';
  const status = typeof value.status === 'string' ? value.status : undefined;
  const scope = typeof value.scope === 'string' ? `for ${value.scope}` : undefined;
  const reasons = Array.isArray(value.reasons) ? `(${value.reasons.join(', ')})` : undefined;
  return [statusIcon(status), `**${provider}**`, scope, status, reasons].filter(Boolean).join(' ');
}

function summarizeValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return scalarText(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value instanceof Date) return value.toISOString();
  const record = value as Record<string, unknown>;
  const preferred = [
    'name',
    'id',
    'status',
    'provider',
    'environment',
    'url',
    'message',
    'reason',
    'path',
    'count',
  ];
  const parts = preferred
    .filter((key) => record[key] !== undefined && (record[key] === null || typeof record[key] !== 'object'))
    .map((key) => `${key}: ${scalarText(record[key])}`);
  if (parts.length > 0) return parts.slice(0, 4).join(', ');
  return `${Object.keys(record).length} field(s)`;
}

function formatArray(key: string, values: unknown[]): string[] {
  if (values.length === 0) return [`${titleForKey(key)}: none`];
  const lines = [`${titleForKey(key)}: ${values.length}`];
  const formatter =
    ['actions', 'drift', 'unmanaged', 'blocked', 'actionScopedBlocked'].includes(key)
      ? summarizeAction
      : key === 'receipts'
        ? summarizeReceipt
        : ['required', 'missing', 'connections'].includes(key)
          ? summarizeConnection
          : summarizeValue;
  for (const item of values.slice(0, 12)) {
    lines.push(`  - ${formatter(item)}`);
  }
  if (values.length > 12) lines.push(`  - ... ${values.length - 12} more`);
  return lines;
}

function formatConnections(value: unknown): string[] {
  if (!isRecord(value)) return [`Connections: ${summarizeValue(value)}`];
  const required = Array.isArray(value.required) ? value.required : [];
  const missing = Array.isArray(value.missing) ? value.missing : [];
  const lines = [`Connections: ${required.length} required, ${missing.length} missing`];
  for (const item of missing.slice(0, 12)) {
    lines.push(`  - ${summarizeConnection(item)}`);
  }
  if (missing.length > 12) lines.push(`  - ... ${missing.length - 12} more missing`);
  return lines;
}

function formatRecordLines(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const priority = [
    'project',
    'revision',
    'specRevision',
    'specSource',
    'environment',
    'verified',
    'inSync',
    'summary',
    'connections',
    'deploySource',
    'spec',
    'actions',
    'drift',
    'unmanaged',
    'blocked',
    'actionScopedBlocked',
    'receipts',
  ];
  const keys = [
    ...priority.filter((key) => Object.prototype.hasOwnProperty.call(record, key)),
    ...Object.keys(record).filter((key) => !priority.includes(key)),
  ];

  for (const key of keys) {
    const value = record[key];
    if (key === 'project') {
      lines.push(`${titleForKey(key)}: ${summarizeProject(value) ?? summarizeValue(value)}`);
    } else if (key === 'spec') {
      const specLines = summarizeSpec(value);
      lines.push(`Spec: ${specLines[0]}`);
      specLines.slice(1).forEach((line) => lines.push(`  - ${line}`));
    } else if (key === 'connections') {
      lines.push(...formatConnections(value));
    } else if (Array.isArray(value)) {
      lines.push(...formatArray(key, value));
    } else if (isRecord(value)) {
      lines.push(`${titleForKey(key)}: ${summarizeValue(value)}`);
      const simpleEntries = Object.entries(value)
        .filter(([, entry]) => entry === null || typeof entry !== 'object')
        .slice(0, 8);
      for (const [entryKey, entryValue] of simpleEntries) {
        lines.push(`  - ${entryKey}: ${scalarText(entryValue)}`);
      }
    } else {
      lines.push(`${titleForKey(key)}: ${scalarText(value)}`);
    }
    if (lines.length >= 80) {
      lines.push('... output truncated; structuredContent contains the full redacted envelope.');
      break;
    }
  }
  return lines;
}

function formatEnvelope(payload: ToolEnvelope): string {
  const lines: string[] = [];
  const appendListLines = (entries: string[]) => {
    entries.forEach((line) => {
      if (line.startsWith('  - ')) {
        lines.push(`  • ${emphasizeLabel(line.slice(4))}`);
      } else {
        lines.push(`▸ ${emphasizeLabel(line)}`);
      }
    });
  };
  if (payload.ok) {
    lines.push('🟢 **Hypervibe OK**');
  } else {
    lines.push(`🔴 **${payload.error?.code ?? 'UNKNOWN'}**`);
    lines.push(payload.error?.message ?? 'Unknown error');
  }

  if (payload.data !== undefined) {
    lines.push('', '📦 **Data**');
    const dataLines = isRecord(payload.data)
      ? formatRecordLines(payload.data)
      : [summarizeValue(payload.data)];
    appendListLines(dataLines);
  }

  if (!payload.ok && payload.error?.details !== undefined) {
    lines.push('', '🔎 **Details**');
    const detailLines = isRecord(payload.error.details)
      ? formatRecordLines(payload.error.details)
      : Array.isArray(payload.error.details)
        ? formatArray('details', payload.error.details)
        : [summarizeValue(payload.error.details)];
    appendListLines(detailLines);
  }

  if (payload.warnings?.length) {
    lines.push('', '🟡 **Warnings**');
    payload.warnings.forEach((warning) => lines.push(`• ${warning}`));
  }

  if (payload.hint) {
    lines.push('', '💡 **Hint**', payload.hint);
  }

  if (payload.next?.length) {
    lines.push('', '➡️ **Next**', payload.next.map((step) => `\`${step}\``).join(' → '));
  }

  return lines.join('\n');
}

function envelope(payload: ToolEnvelope): ToolResponse {
  const safePayload = redactForResponse(payload) as ToolEnvelope;
  return {
    content: [{ type: 'text' as const, text: formatEnvelope(safePayload) }],
    structuredContent: safePayload as unknown as Record<string, unknown>,
    _meta: { hypervibeEnvelope: safePayload },
    ...(safePayload.ok ? {} : { isError: true }),
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
