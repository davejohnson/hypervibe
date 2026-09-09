import { createHash } from 'crypto';

// Binding metadata is useful for stale-plan checks, but connection material
// must never enter a persisted plan — not even as a guessable password hash.
// Normalize key spelling before applying the same broad secret categories used
// by repository binding exports, plus URL/URI/DSN credentials.
const SENSITIVE_BINDING_KEY_PATTERN = /(?:secret|token|password|passphrase|privatekey|apikey|accesskey|credential|connectionstring|connectionurl|databaseurl|databaseprivateurl|privateurl|pooledurl|directurl|dsn$|uri$|url$)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Compare a live provider scope with durable local identity metadata while
 * remaining compatible with bindings written before providerScope existed.
 *
 * Legacy component bindings sometimes stored provider scope fields at the
 * top level and relied on the environment's exact hosting scope for the rest.
 * Explicit component scope always wins, and every live scope field must still
 * be proven. A different environment can therefore never complete a match.
 */
export function providerIdentityScopeMatches(params: {
  componentBindings?: Record<string, unknown>;
  environmentBindings?: Record<string, unknown>;
  provider?: string;
  liveScope?: Record<string, string>;
}): boolean {
  const explicitScope = asRecord(params.componentBindings?.providerScope);
  const explicitEntries = Object.entries(explicitScope ?? {});
  const liveEntries = Object.entries(params.liveScope ?? {});

  if (liveEntries.length === 0) {
    return explicitEntries.length === 0;
  }

  const environmentScope = params.provider
    && params.environmentBindings?.provider === params.provider
    ? params.environmentBindings
    : undefined;
  const ownValue = (record: Record<string, unknown> | null | undefined, key: string): {
    found: boolean;
    value?: unknown;
  } => record && Object.prototype.hasOwnProperty.call(record, key)
    ? { found: true, value: record[key] }
    : { found: false };
  const localValue = (key: string): unknown => {
    const explicit = ownValue(explicitScope, key);
    if (explicit.found) return explicit.value;
    const flattened = ownValue(params.componentBindings, key);
    if (flattened.found) return flattened.value;
    return ownValue(environmentScope, key).value;
  };

  return liveEntries.every(([key, value]) => (
    typeof value === 'string'
    && value.length > 0
    && localValue(key) === value
  )) && explicitEntries.every(([key, value]) => (
    typeof value === 'string'
    && value.length > 0
    && params.liveScope?.[key] === value
  ));
}

function canonicalSanitizedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map(canonicalSanitizedValue)
      .filter((item) => item !== undefined);
  }
  const record = asRecord(value);
  if (!record) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '');
    if (SENSITIVE_BINDING_KEY_PATTERN.test(normalizedKey)) continue;
    const sanitizedChild = canonicalSanitizedValue(child);
    if (sanitizedChild !== undefined) sanitized[key] = sanitizedChild;
  }
  return sanitized;
}

/**
 * Stable, secret-free fingerprint of all provider binding metadata that an
 * adapter may use while destroying a resource. This intentionally includes
 * secondary ids and ownership flags (for example volumeId or
 * securityGroupManagedByHypervibe), while omitting credentials and URLs.
 */
export function bindingIdentityFingerprint(bindings: unknown): string {
  const sanitized = canonicalSanitizedValue(bindings) ?? {};
  return createHash('sha256').update(JSON.stringify(sanitized), 'utf8').digest('hex');
}
