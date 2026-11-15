const ALIASES = ['PGPASSWORD', 'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DIRECT_URL'] as const;
type AliasKey = typeof ALIASES[number];
type AliasValues = Partial<Record<AliasKey, string>>;
const SOURCE = 'POSTGRES_PASSWORD';
const REFERENCE = '${{POSTGRES_PASSWORD}}';
const CANONICAL_REFERENCE = /^\$\{\{\s*POSTGRES_PASSWORD\s*\}\}$/;
const PG_REFERENCE = /^\$\{\{\s*PGPASSWORD\s*\}\}$/;
const TEMPLATE_MARKER = /\$\{|\}\}/;
const URI_UNRESERVED = /^[A-Za-z0-9._~-]+$/;
const SAFE_QUERY_OPTIONS = new Set(['sslmode', 'application_name', 'connect_timeout']);
const COMPONENT_KEYS = ['PGUSER', 'POSTGRES_USER', 'PGHOST', 'RAILWAY_PRIVATE_DOMAIN',
  'RAILWAY_TCP_PROXY_DOMAIN', 'PGPORT', 'RAILWAY_TCP_PROXY_PORT', 'PGDATABASE', 'POSTGRES_DB'] as const;
export const RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS = [SOURCE, ...ALIASES, ...COMPONENT_KEYS, 'DATABASE_PUBLIC_URL'];
const SAME_SERVICE_REFERENCE = /^\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}$/;

export type RailwayCredentialAliasUnsupportedReason =
  | 'source_missing' | 'source_reference' | 'source_mismatch' | 'unsafe_url_password'
  | 'no_aliases' | 'unsupported_reference' | 'malformed_url'
  | 'unsupported_url_options' | 'inconsistent_resolution';

/** PRIVATE preparation: contains credential material and must never enter public output or logs. */
export interface PreparedRailwayDatabaseCredentialAliases {
  status: 'supported';
  changes: AliasValues;
  expected: AliasValues;
  expectedResolved: AliasValues;
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

type ComposedUri = UriParts & { scheme: string; user: string; host: string; port?: string; database: string; query: string };
/** Preserve provider-authored component references; never infer their rendered values. */
function composedUri(input: string): ComposedUri | Exclude<UriResult, UriParts> {
  const match = /^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@(\[[^\]]+\]|[^:/]+)(?::([^/]+))?\/([^?]+)(\?[^#]*)?$/i.exec(input);
  if (!match) return { reason: TEMPLATE_MARKER.test(input) ? 'unsupported_reference' : 'malformed_url' };
  const [, scheme, user, password, host, port, database, query = ''] = match;
  const parts = [user, password, host, port, database];
  const permitted = [['PGUSER', 'POSTGRES_USER'], [SOURCE, 'PGPASSWORD'],
    ['PGHOST', 'RAILWAY_PRIVATE_DOMAIN', 'RAILWAY_TCP_PROXY_DOMAIN'], ['PGPORT', 'RAILWAY_TCP_PROXY_PORT'],
    ['PGDATABASE', 'POSTGRES_DB']];
  const placeholders = ['reference_user', 'credential_placeholder', 'reference-host', '5432', 'reference_database'];
  const masked: Array<string | undefined> = [];
  for (const [index, part] of parts.entries()) {
    if (part === undefined || !TEMPLATE_MARKER.test(part)) { masked.push(part); continue; }
    const key = SAME_SERVICE_REFERENCE.exec(part)?.[1];
    if (!key || !permitted[index].includes(key)) return { reason: 'unsupported_reference' };
    masked.push(placeholders[index]);
  }
  if (TEMPLATE_MARKER.test(query)) return { reason: 'unsupported_reference' };
  const valid = passwordSegment(`${scheme}${masked[0]}:${masked[1]}@${masked[2]}${port === undefined ? '' : `:${masked[3]}`}/${masked[4]}${query}`);
  if ('reason' in valid) return valid;
  return { scheme, user, password, host, port, database, query,
    prefix: `${scheme}${user}:`, suffix: `@${host}${port === undefined ? '' : `:${port}`}/${database}${query}` };
}

/** Read only known same-service dependencies, with cycles/missing/uncertain rendering rejected. */
function renderedDefinition(input: string, raw: Record<string, string>, resolved: Record<string, string>, seen = new Set<string>()): string | undefined {
  let valid = true;
  const rendered = input.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (_token, key: string) => {
    if (![SOURCE, 'PGPASSWORD', ...COMPONENT_KEYS].includes(key) || seen.has(key) || !owns(resolved, key)) {
      valid = false; return '';
    }
    // Railway-provided networking variables may exist only in deployment rendering.
    const definition = owns(raw, key) ? raw[key] : key.startsWith('RAILWAY_') ? resolved[key] : undefined;
    if (definition === undefined) { valid = false; return ''; }
    const value = renderedDefinition(definition, raw, resolved, new Set([...seen, key]));
    if (value === undefined || value !== resolved[key]) { valid = false; return ''; }
    return value;
  });
  return valid && !TEMPLATE_MARKER.test(rendered) ? rendered : undefined;
}

function componentReferences(uri: ComposedUri, raw: Record<string, string>, resolved: Record<string, string>): string | undefined {
  // Existing composed URLs retain their authored structure. Convert copied
  // targets only when all independently read component variables match exactly.
  if ([uri.user, uri.host, uri.port, uri.database].some(value => value && TEMPLATE_MARKER.test(value))) return undefined;
  const components = [['PGUSER', uri.user], ['PGHOST', uri.host], ['PGPORT', uri.port], ['PGDATABASE', uri.database]];
  if (components.some(([key, value]) => value === undefined || !key
    || renderedDefinition(`\${{${key}}}`, raw, resolved) !== value)) return undefined;
  return `${uri.scheme}\${{PGUSER}}:${REFERENCE}@\${{PGHOST}}:\${{PGPORT}}/\${{PGDATABASE}}${uri.query}`;
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
  const expectedResolved: AliasValues = {};
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
      const uri = composedUri(input);
      if ('reason' in uri) return { status: 'unsupported', ...uri, key };
      const rendered = renderedDefinition(input, raw, resolved);
      if (rendered === undefined) return { status: 'unsupported', reason: 'unsupported_reference', key };
      const parsed = passwordSegment(rendered);
      if ('reason' in parsed) return { status: 'unsupported', ...parsed, key };
      currentResolved = rendered;
      desired = componentReferences(uri, raw, resolved)
        ?? `${uri.prefix}${CANONICAL_REFERENCE.test(uri.password) ? uri.password : REFERENCE}${uri.suffix}`;
    }
    if (!owns(resolved, key) || resolved[key] !== currentResolved) return { status: 'unsupported', reason: 'inconsistent_resolution', key };
    expected[key] = desired;
    const rendered = renderedDefinition(desired, raw, resolved);
    if (rendered === undefined) return { status: 'unsupported', reason: 'inconsistent_resolution', key };
    expectedResolved[key] = rendered;
    if (input !== desired) changes[key] = desired;
  }
  return {
    status: 'supported', changes, expected, expectedResolved, sourcePassword,
    // No claim that this unreviewed alias is repaired or safe for consumers.
    unmanagedKeys: owns(raw, 'DATABASE_PUBLIC_URL') || owns(resolved, 'DATABASE_PUBLIC_URL') ? ['DATABASE_PUBLIC_URL'] : [],
  };
}

function normalizeCanonicalReference(input: string): string {
  return input.replace(/\$\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (_token, key: string) => `\${{${key}}}`);
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
    if (renderedDefinition(raw[key], raw, resolved) !== prepared.expectedResolved[key]
      || resolved[key] !== prepared.expectedResolved[key]) return { status: 'unverified', reason: 'alias_resolution_mismatch', key };
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
  const keys = RAILWAY_DATABASE_ALIAS_EVIDENCE_KEYS;
  return JSON.stringify(keys.map(key => [key,
    owns(raw, key) ? [raw[key]] : [],
    owns(resolved, key) ? [resolved[key]] : [],
  ]));
}
