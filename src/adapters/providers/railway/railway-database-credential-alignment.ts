import type { CredentialAlignmentComparison, DatabaseCredentialAlignment } from '../../../domain/ports/observe.port.js';

type UnknownReason = Extract<CredentialAlignmentComparison, { result: 'unknown' }>['reason'];
type Evidence<T> = { value: T } | { reason: UnknownReason };
export type DatabaseVariableEvidence = { variables: Record<string, string> } | { reason: 'read_failed' | 'scope_unverified' };
export interface DatabaseCredentialConsumer {
  name: string;
  externalId: string;
  evidence: DatabaseVariableEvidence;
  aliases?: Record<string, 'DATABASE_URL' | 'DIRECT_URL'>;
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

function hasVariable(evidence: DatabaseVariableEvidence, key: string): boolean {
  return 'variables' in evidence && Object.hasOwn(evidence.variables, key);
}

/** Private inputs are discarded; configured equality does not prove raw references or authentication. */
export function compareDatabaseCredentials(
  issuer: DatabaseVariableEvidence,
  consumers: DatabaseCredentialConsumer[]
): DatabaseCredentialAlignment {
  const password = variable(issuer, 'POSTGRES_PASSWORD');
  const directSource = ['DIRECT_URL', 'DATABASE_PRIVATE_URL'].find(key => hasVariable(issuer, key)) ?? 'DATABASE_URL';
  return {
    basis: 'configured-variable-values', authentication: 'unverified',
    rawReferences: 'unchecked', deployedConfiguration: 'unchecked', applicationOperation: 'unchecked',
    issuer: {
      comparisons: ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'PGPASSWORD', 'DIRECT_URL']
        .filter(source => source === 'DATABASE_URL' || hasVariable(issuer, source)).map(source => ({
          source, against: 'POSTGRES_PASSWORD',
          comparison: source === 'PGPASSWORD'
            ? compare(variable(issuer, source), password, (alias, secret) => alias === secret)
            : compare(databaseUrl(issuer, source), password, (url, secret) => url.password === secret),
        })),
    },
    consumers: consumers.flatMap(consumer => [...new Set(['DATABASE_URL', 'DIRECT_URL', ...Object.keys(consumer.aliases ?? {})])]
      .filter(source => source === 'DATABASE_URL' || Object.hasOwn(consumer.aliases ?? {}, source) || hasVariable(consumer.evidence, source)).map(source => {
        const issuerSource = (consumer.aliases?.[source] ?? source) === 'DIRECT_URL' ? directSource : 'DATABASE_URL';
        const issuerUrl = databaseUrl(issuer, issuerSource);
        const url = databaseUrl(consumer.evidence, source);
        return {
          name: consumer.name, externalId: consumer.externalId,
          source, issuerSource,
          credentialComparison: compare(url, issuerUrl, (app, database) => (
            app.username === database.username && app.password === database.password
          )),
          target: compare(url, issuerUrl, (app, database) => (
            app.hostname === database.hostname && app.port === database.port && app.database === database.database
          )),
        };
      })).sort((a, b) => a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId)),
  };
}
