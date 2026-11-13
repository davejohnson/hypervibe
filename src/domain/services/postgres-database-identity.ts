/** Read the connected PostgreSQL database, independently of URL hosts or roles. */
export const POSTGRES_DATABASE_IDENTITY_SQL = "SELECT system_identifier::text || ':' || pg_catalog.encode(pg_catalog.convert_to(pg_catalog.current_database(), 'UTF8'), 'hex') AS identity FROM pg_catalog.pg_control_system()";

export const POSTGRES_DATABASE_IDENTITY_PATTERN = '^[1-9][0-9]{0,19}:([0-9a-f]{2}){1,63}$';
const identityPattern = new RegExp(POSTGRES_DATABASE_IDENTITY_PATTERN);

export function parsePostgresDatabaseIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 147 && value.trim() === value && identityPattern.test(value)
    ? value : undefined;
}

/** Callers must preserve the target: it may be the source or another live database. */
export class PostgresDatabaseIdentityError extends Error {
  constructor(message = 'The database identity could not be verified; no copy was started.') {
    super(message);
    this.name = 'PostgresDatabaseIdentityError';
  }
}

export function assertDistinctPostgresDatabaseIdentities(source: unknown, target: unknown): void {
  const sourceIdentity = parsePostgresDatabaseIdentity(source);
  const targetIdentity = parsePostgresDatabaseIdentity(target);
  if (!sourceIdentity || !targetIdentity) throw new PostgresDatabaseIdentityError();
  if (sourceIdentity === targetIdentity) {
    throw new PostgresDatabaseIdentityError('The source and target reach the same database; no copy was started.');
  }
}
