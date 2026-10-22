import type { CredentialAlignmentComparison, DatabaseCredentialAlignment } from '../../../domain/ports/observe.port.js';

type UnknownReason = Extract<CredentialAlignmentComparison, { result: 'unknown' }>['reason'];
type Evidence<T> = { value: T } | { reason: UnknownReason };
export type DatabaseVariableEvidence = { variables: Record<string, string> } | { reason: 'read_failed' | 'scope_unverified' };
export interface DatabaseCredentialConsumer {
  name: string;
  externalId: string;
  evidence: DatabaseVariableEvidence;
}

function variable(evidence: DatabaseVariableEvidence, key: string): Evidence<string> {
  if ('reason' in evidence) return evidence;
  const value = evidence.variables[key];
  if (!value) return { reason: 'missing' };
  if (value.includes('${{')) return { reason: 'unresolved_reference' };
  return { value };
}

function databaseUrl(evidence: DatabaseVariableEvidence, key: string): Evidence<{
  username: string; password: string; hostname: string; port: string; database: string;
}> {
  const input = variable(evidence, key);
  if ('reason' in input) return input;
  try {
    const url = new URL(input.value);
    if (input.value.trim() !== input.value || !['postgres:', 'postgresql:'].includes(url.protocol)
      || !url.hostname || !url.username || !url.password || url.pathname.length < 2
      || url.hash) {
      return { reason: 'malformed' };
    }
    // URI options can override user, password or target; do not guess their client's precedence.
    if (url.search) return { reason: 'unsupported_url_options' };
    return { value: {
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      hostname: url.hostname.toLowerCase(), port: url.port || '5432',
      database: decodeURIComponent(url.pathname.slice(1)),
    } };
  } catch {
    // URL/parser errors can contain the input; only closed reason codes leave this boundary.
    return { reason: 'malformed' };
  }
}

function compare<A, B>(left: Evidence<A>, right: Evidence<B>, equal: (a: A, b: B) => boolean): CredentialAlignmentComparison {
  if ('reason' in left) return { result: 'unknown', reason: left.reason };
  if ('reason' in right) return { result: 'unknown', reason: right.reason };
  return { result: equal(left.value, right.value) ? 'match' : 'mismatch' };
}

/** Private inputs are discarded; this result contains only fixed sources and comparison outcomes. */
export function compareDatabaseCredentials(
  issuer: DatabaseVariableEvidence,
  consumers: DatabaseCredentialConsumer[]
): DatabaseCredentialAlignment {
  const password = variable(issuer, 'POSTGRES_PASSWORD');
  const issuerUrl = databaseUrl(issuer, 'DATABASE_URL');
  return {
    basis: 'configured-variable-values', authentication: 'unverified',
    issuer: {
      comparisons: ['DATABASE_URL', 'DATABASE_PRIVATE_URL'].map(source => ({
        source, against: 'POSTGRES_PASSWORD',
        comparison: compare(databaseUrl(issuer, source), password, (url, secret) => url.password === secret),
      })),
    },
    consumers: consumers.map(consumer => {
      const url = databaseUrl(consumer.evidence, 'DATABASE_URL');
      return {
        name: consumer.name, externalId: consumer.externalId,
        source: 'DATABASE_URL', issuerSource: 'DATABASE_URL',
        credentialComparison: compare(url, issuerUrl, (app, database) => (
          app.username === database.username && app.password === database.password
        )),
        target: compare(url, issuerUrl, (app, database) => (
          app.hostname === database.hostname && app.port === database.port && app.database === database.database
        )),
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId)),
  };
}
