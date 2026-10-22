const ALIASES = ['PGPASSWORD', 'DATABASE_URL', 'DATABASE_PRIVATE_URL'] as const;
type AliasKey = typeof ALIASES[number];
type AliasValues = Partial<Record<AliasKey, string>>;
const SOURCE = 'POSTGRES_PASSWORD';
const REFERENCE = '${{POSTGRES_PASSWORD}}';
const CANONICAL_REFERENCE = /^\$\{\{\s*POSTGRES_PASSWORD\s*\}\}$/;
const PG_REFERENCE = /^\$\{\{\s*PGPASSWORD\s*\}\}$/;
const TEMPLATE_MARKER = /\$\{|\}\}/;
const URI_UNRESERVED = /^[A-Za-z0-9._~-]+$/;
const SAFE_QUERY_OPTIONS = new Set(['sslmode', 'application_name', 'connect_timeout']);

export type RailwayCredentialAliasUnsupportedReason =
  | 'source_missing' | 'source_reference' | 'source_mismatch' | 'unsafe_url_password'
  | 'no_aliases' | 'unsupported_reference' | 'malformed_url'
  | 'unsupported_url_options' | 'inconsistent_resolution';

/** PRIVATE preparation: contains credential material and must never enter public output or logs. */
export interface PreparedRailwayDatabaseCredentialAliases {
  status: 'supported';
  changes: AliasValues;
  expected: AliasValues;
  sourcePassword: string;
  unmanagedKeys: Array<'DATABASE_PUBLIC_URL'>;
}
export type RailwayDatabaseCredentialAliasPreparation = PreparedRailwayDatabaseCredentialAliases | {
  status: 'unsupported';
  reason: RailwayCredentialAliasUnsupportedReason;
  key?: AliasKey | typeof SOURCE;
};
export type RailwayDatabaseCredentialAliasVerification = { status: 'verified' } | {
  status: 'unverified';
  reason: 'canonical_source_changed' | 'alias_set_changed' | 'alias_definition_mismatch' | 'alias_resolution_mismatch';
  key: AliasKey | typeof SOURCE;
};

function owns(variables: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(variables, key);
}

type UriParts = { prefix: string; password: string; suffix: string };
type UriResult = UriParts | { reason: 'unsupported_reference' | 'malformed_url' | 'unsupported_url_options' };

function validEncoding(value: string): boolean {
  try {
    return !/[\u0000-\u001f\u007f]/.test(decodeURIComponent(value));
  } catch {
    return false;
  }
}

/** Parse only the supported single-host URI form. Never serialize a URL back into desired state. */
function passwordSegment(input: string): UriResult {
  // Mask the one permitted password token before checking URI syntax. Other
  // templates (including whole-URL refs) remain unsupported, never flattened.
  const tokens = input.match(/\$\{\{[^{}]*\}\}/g) ?? [];
  if (tokens.length > 1 || tokens.some(token => !CANONICAL_REFERENCE.test(token) && !PG_REFERENCE.test(token))) {
    return { reason: 'unsupported_reference' };
  }
  const token = tokens[0];
  const masked = token ? input.replace(token, 'credential_placeholder') : input;
  if (TEMPLATE_MARKER.test(masked)) return { reason: 'unsupported_reference' };
  // Require an explicit username/password, TCP host and database. Reject
  // controls, fragments, multi-host/socket forms and non-encoded whitespace.
  if (/[^\x21-\x7e]/.test(masked) || masked.includes('\\') || !validEncoding(masked)) return { reason: 'malformed_url' };
  const match = /^(postgres(?:ql)?:\/\/)([^/?#]+)(\/[^?#]+)(\?[^#]*)?$/i.exec(masked);
  if (!match) return { reason: 'malformed_url' };
  const [scheme, authority, path, query = ''] = match.slice(1);
  const at = authority.indexOf('@');
  const colon = authority.indexOf(':');
  if (at < 0 || at !== authority.lastIndexOf('@') || colon < 1 || colon >= at - 1) return { reason: 'malformed_url' };
  const user = authority.slice(0, colon);
  const password = authority.slice(colon + 1, at);
  const host = authority.slice(at + 1);
  if (!/^[A-Za-z0-9._~!$&'()*+,;=%-]+$/.test(user)
    || !/^[A-Za-z0-9._~!$&'()*+,;=:%-]+$/.test(password)
    || !/^(?:[A-Za-z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::[0-9]+)?$/.test(host)
    || path.slice(1).includes('/')) return { reason: 'malformed_url' };
  try {
    const parsed = new URL(masked);
    if (!parsed.hostname || !parsed.username || !parsed.password) return { reason: 'malformed_url' };
  } catch {
    // URL errors can include the input; never let them escape this private boundary.
    return { reason: 'malformed_url' };
  }
  if (token && password !== 'credential_placeholder') return { reason: 'unsupported_reference' };
  if (query) {
    const keys = new Set<string>();
    for (const item of query.slice(1).split('&')) {
      const separator = item.indexOf('=');
      if (separator < 1) return { reason: 'unsupported_url_options' };
      const key = decodeURIComponent(item.slice(0, separator));
      // libpq allows connection fields in the query, and pg-connection-string
      // gives several of them precedence. Admit only reviewed non-target options.
      if (!SAFE_QUERY_OPTIONS.has(key) || keys.has(key)) return { reason: 'unsupported_url_options' };
      keys.add(key);
    }
  }
  const prefix = `${scheme}${authority.slice(0, colon + 1)}`;
  const suffix = `@${host}${path}${query}`;
  // Prove that masking touched the password and nothing else, even when a
  // literal username/password happens to equal the internal parser marker.
  if (`${prefix}${token ?? password}${suffix}` !== input) return { reason: 'unsupported_reference' };
  return { prefix, password: token ?? password, suffix };
}

/**
 * Propose existing alias definitions only, using Railway same-service references.
 * Raw definitions and rendered deployment values must be independently read.
 * No SQL authentication, rotation, deployment or provider write occurs here.
 */
export function prepareRailwayDatabaseCredentialAliases(
  raw: Record<string, string>, resolved: Record<string, string>
): RailwayDatabaseCredentialAliasPreparation {
  const sourcePassword = raw[SOURCE];
  if (!owns(raw, SOURCE) || !sourcePassword) return { status: 'unsupported', reason: 'source_missing', key: SOURCE };
  if (TEMPLATE_MARKER.test(sourcePassword)) return { status: 'unsupported', reason: 'source_reference', key: SOURCE };
  if (!owns(resolved, SOURCE) || resolved[SOURCE] !== sourcePassword) return { status: 'unsupported', reason: 'source_mismatch', key: SOURCE };
  if (!ALIASES.some(key => owns(raw, key))) return { status: 'unsupported', reason: 'no_aliases' };
  if (ALIASES.slice(1).some(key => owns(raw, key)) && !URI_UNRESERVED.test(sourcePassword)) {
    return { status: 'unsupported', reason: 'unsafe_url_password', key: SOURCE };
  }
  const changes: AliasValues = {};
  const expected: AliasValues = {};
  for (const key of ALIASES) {
    if (owns(raw, key) !== owns(resolved, key)) return { status: 'unsupported', reason: 'inconsistent_resolution', key };
    if (!owns(raw, key)) continue;
    const input = raw[key];
    let currentResolved: string;
    let desired: string;
    if (key === 'PGPASSWORD') {
      if (CANONICAL_REFERENCE.test(input)) {
        currentResolved = sourcePassword;
        desired = input;
      } else {
        if (TEMPLATE_MARKER.test(input)) return { status: 'unsupported', reason: 'unsupported_reference', key };
        currentResolved = input;
        desired = REFERENCE;
      }
    } else {
      const uri = passwordSegment(input);
      if ('reason' in uri) return { status: 'unsupported', ...uri, key };
      let password = uri.password;
      if (CANONICAL_REFERENCE.test(password)) password = sourcePassword;
      else if (PG_REFERENCE.test(password)) {
        if (!owns(raw, 'PGPASSWORD') || !owns(resolved, 'PGPASSWORD')) return { status: 'unsupported', reason: 'inconsistent_resolution', key };
        password = resolved.PGPASSWORD;
        if (!URI_UNRESERVED.test(password)) return { status: 'unsupported', reason: 'unsupported_reference', key };
      }
      currentResolved = `${uri.prefix}${password}${uri.suffix}`;
      desired = `${uri.prefix}${CANONICAL_REFERENCE.test(uri.password) ? uri.password : REFERENCE}${uri.suffix}`;
    }
    if (!owns(resolved, key) || resolved[key] !== currentResolved) return { status: 'unsupported', reason: 'inconsistent_resolution', key };
    expected[key] = desired;
    if (input !== desired) changes[key] = desired;
  }
  return {
    status: 'supported', changes, expected, sourcePassword,
    // No claim that this unreviewed alias is repaired or safe for consumers.
    unmanagedKeys: owns(raw, 'DATABASE_PUBLIC_URL') || owns(resolved, 'DATABASE_PUBLIC_URL') ? ['DATABASE_PUBLIC_URL'] : [],
  };
}

function normalizeCanonicalReference(input: string): string {
  return input.replace(/\$\{\{\s*POSTGRES_PASSWORD\s*\}\}/g, REFERENCE);
}

/** Value-free readback result. Correct resolved passwords alone do not prove reference convergence. */
export function verifyRailwayDatabaseCredentialAliases(
  prepared: PreparedRailwayDatabaseCredentialAliases,
  raw: Record<string, string>, resolved: Record<string, string>
): RailwayDatabaseCredentialAliasVerification {
  if (!owns(raw, SOURCE) || !owns(resolved, SOURCE)
    || raw[SOURCE] !== prepared.sourcePassword || resolved[SOURCE] !== prepared.sourcePassword) {
    return { status: 'unverified', reason: 'canonical_source_changed', key: SOURCE };
  }
  for (const key of ALIASES) {
    if (owns(raw, key) !== owns(prepared.expected, key) || owns(resolved, key) !== owns(prepared.expected, key)) {
      return { status: 'unverified', reason: 'alias_set_changed', key };
    }
    const expected = prepared.expected[key];
    if (expected === undefined) continue;
    const normalized = normalizeCanonicalReference(expected);
    if (normalizeCanonicalReference(raw[key]) !== normalized) return { status: 'unverified', reason: 'alias_definition_mismatch', key };
    if (resolved[key] !== normalized.replace(REFERENCE, () => prepared.sourcePassword)) return { status: 'unverified', reason: 'alias_resolution_mismatch', key };
  }
  return { status: 'verified' };
}

/**
 * PRIVATE input for an internal stale-plan digest. Contains raw credentials and
 * URLs; never return, log or persist this string in cleartext or publish its hash.
 * Exact resource/environment identity must be bound by the caller separately.
 */
export function railwayDatabaseCredentialAliasFingerprintInput(
  raw: Record<string, string>, resolved: Record<string, string>
): string {
  const keys = [SOURCE, ...ALIASES, 'DATABASE_PUBLIC_URL'];
  return JSON.stringify(keys.map(key => [key,
    owns(raw, key) ? [raw[key]] : [],
    owns(resolved, key) ? [resolved[key]] : [],
  ]));
}
