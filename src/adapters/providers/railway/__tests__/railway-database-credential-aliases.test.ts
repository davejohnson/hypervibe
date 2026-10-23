import { describe, expect, it } from 'vitest';
import { parse } from 'pg-connection-string';
import {
  prepareRailwayDatabaseCredentialAliases,
  railwayDatabaseCredentialAliasFingerprintInput,
  verifyRailwayDatabaseCredentialAliases,
} from '../railway-database-credential-aliases.js';

// Synthetic private values. Independent semantics: Railway documents same-service
// ${{ VARIABLE_NAME }} references and unrendered reads at
// https://docs.railway.com/variables#referencing-variables-in-the-same-service and
// https://docs.railway.com/integrations/api/manage-variables . PostgreSQL's URI
// grammar/encoding/query overrides are documented at
// https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNSTRING-URIS .
// This pure parser coverage is not provider transport or live rendering evidence.
const source = 'canonical_new-123';
const old = 'former_password';
const ref = '${{POSTGRES_PASSWORD}}';
const original = {
  POSTGRES_PASSWORD: source,
  PGPASSWORD: old,
  DATABASE_URL: `postgresql://postgres:${old}@${old}.example:5432/${old}?application_name=${old}&connect_timeout=10`,
  DATABASE_PRIVATE_URL: `postgres://postgres:${old}@db.railway.internal:5432/postgres`,
  UNRELATED: 'keep-this',
};
const repaired = {
  ...original,
  PGPASSWORD: ref,
  DATABASE_URL: `postgresql://postgres:${ref}@${old}.example:5432/${old}?application_name=${old}&connect_timeout=10`,
  DATABASE_PRIVATE_URL: `postgres://postgres:${ref}@db.railway.internal:5432/postgres`,
};
const rendered = {
  ...original,
  PGPASSWORD: source,
  DATABASE_URL: `postgresql://postgres:${source}@${old}.example:5432/${old}?application_name=${old}&connect_timeout=10`,
  DATABASE_PRIVATE_URL: `postgres://postgres:${source}@db.railway.internal:5432/postgres`,
};

function prepare(raw: Record<string, string> = original, resolved = raw) {
  const result = prepareRailwayDatabaseCredentialAliases(raw, resolved);
  expect(result.status).toBe('supported');
  if (result.status !== 'supported') throw new Error('Expected supported synthetic fixture');
  return result;
}

describe('Railway database password alias preparation', () => {
  it('replaces only existing alias password segments, preserving source and target bytes', () => {
    const result = prepare();
    expect(result.changes).toEqual({
      PGPASSWORD: repaired.PGPASSWORD,
      DATABASE_URL: repaired.DATABASE_URL,
      DATABASE_PRIVATE_URL: repaired.DATABASE_PRIVATE_URL,
    });
    expect(result.expected).toEqual(result.changes);
    expect(result.sourcePassword).toBe(source);
    expect(original.POSTGRES_PASSWORD).toBe(source);
    expect(result.changes).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(result.changes).not.toHaveProperty('UNRELATED');
    // Execute the actual pg parser to show that the preserved safe options do
    // not replace credentials/target, independently of the helper's parser.
    expect(parse(rendered.DATABASE_URL)).toMatchObject({
      user: 'postgres', password: source, host: `${old}.example`, port: '5432',
      database: old, application_name: old, connect_timeout: '10',
    });
  });

  it('is a no-op for references already using the canonical source, including whitespace', () => {
    const spaced = {
      ...repaired,
      PGPASSWORD: '${{ POSTGRES_PASSWORD }}',
      DATABASE_URL: repaired.DATABASE_URL.replace(ref, '${{ POSTGRES_PASSWORD }}'),
    };
    expect(prepare(spaced, rendered)).toMatchObject({ changes: {}, expected: {
      PGPASSWORD: spaced.PGPASSWORD,
      DATABASE_URL: spaced.DATABASE_URL,
      DATABASE_PRIVATE_URL: spaced.DATABASE_PRIVATE_URL,
    } });
  });

  it('normalizes a same-service PGPASSWORD password segment without flattening the URL', () => {
    const raw = { ...original, DATABASE_URL: original.DATABASE_URL.replace(`:${old}@`, ':${{ PGPASSWORD }}@') };
    expect(prepare(raw, original).changes.DATABASE_URL).toBe(repaired.DATABASE_URL);
  });

  it('preserves encoded credentials, IPv6 target, database and safe option bytes', () => {
    const uri = 'postgresql://encoded%40user:p%40ss%3Aword@[2001:db8::1]:5433/name%2Fpart?sslmode=verify-full&application_name=a%2Bb';
    const result = prepare({ POSTGRES_PASSWORD: source, DATABASE_URL: uri });
    expect(result.changes).toEqual({ DATABASE_URL: uri.replace('p%40ss%3Aword', ref) });
    expect(parse(uri)).toMatchObject({ user: 'encoded@user', password: 'p@ss:word', host: '[2001:db8::1]' });
  });

  it('never adds absent aliases and explicitly leaves unreviewed public aliases unmanaged', () => {
    const raw = { POSTGRES_PASSWORD: source, PGPASSWORD: old, DATABASE_PUBLIC_URL: 'do-not-touch' };
    expect(prepare(raw)).toMatchObject({ changes: { PGPASSWORD: ref }, expected: { PGPASSWORD: ref }, unmanagedKeys: ['DATABASE_PUBLIC_URL'] });
    const { DATABASE_PUBLIC_URL: _unused, ...withoutPublic } = raw;
    expect(prepare(withoutPublic, raw).unmanagedKeys).toEqual(['DATABASE_PUBLIC_URL']);
  });

  it('accepts a password needing URI encoding when there are no URL aliases to interpolate', () => {
    expect(prepare({ POSTGRES_PASSWORD: 'not@URI:safe', PGPASSWORD: old }).changes).toEqual({ PGPASSWORD: ref });
  });

  it.each([
    ['missing source', { ...original, POSTGRES_PASSWORD: '' }, 'source_missing'],
    ['source reference', { ...original, POSTGRES_PASSWORD: '${{PGPASSWORD}}' }, 'source_reference'],
    ['non URI-safe source', { ...original, POSTGRES_PASSWORD: 'must@encode' }, 'unsafe_url_password'],
    ['whole URL reference', { ...original, DATABASE_URL: '${{DATABASE_PRIVATE_URL}}' }, 'unsupported_reference'],
    ['foreign password reference', { ...original, DATABASE_URL: original.DATABASE_URL.replace(`:${old}@`, ':${{other.POSTGRES_PASSWORD}}@') }, 'unsupported_reference'],
    ['mixed password template', { ...original, DATABASE_URL: original.DATABASE_URL.replace(`:${old}@`, ':prefix${{POSTGRES_PASSWORD}}@') }, 'unsupported_reference'],
    ['cyclic alias', { ...original, PGPASSWORD: '${{PGPASSWORD}}' }, 'unsupported_reference'],
    ['foreign alias', { ...original, PGPASSWORD: '${{other.POSTGRES_PASSWORD}}' }, 'unsupported_reference'],
    ['host template', { ...original, DATABASE_URL: `postgres://postgres:${old}@\${{PGHOST}}/postgres` }, 'unsupported_reference'],
    ['canonical username template with placeholder password', { ...original, DATABASE_URL: 'postgres://${{POSTGRES_PASSWORD}}:credential_placeholder@host/postgres' }, 'unsupported_reference'],
    ['canonical host template with placeholder password', { ...original, DATABASE_URL: 'postgres://postgres:credential_placeholder@${{POSTGRES_PASSWORD}}/postgres' }, 'unsupported_reference'],
    ['canonical path template with placeholder password', { ...original, DATABASE_URL: 'postgres://postgres:credential_placeholder@host/${{POSTGRES_PASSWORD}}' }, 'unsupported_reference'],
    ['canonical option template with placeholder password', { ...original, DATABASE_URL: 'postgres://postgres:credential_placeholder@host/postgres?application_name=${{POSTGRES_PASSWORD}}' }, 'unsupported_reference'],
    ['invalid escape', { ...original, DATABASE_URL: 'postgres://postgres:bad%xx@host/postgres' }, 'malformed_url'],
    ['multiple at signs', { ...original, DATABASE_URL: 'postgres://postgres:a@b@host/postgres' }, 'malformed_url'],
    ['missing password', { ...original, DATABASE_URL: 'postgres://postgres@host/postgres' }, 'malformed_url'],
    ['multi-host', { ...original, DATABASE_URL: 'postgres://postgres:old@host,other/postgres' }, 'malformed_url'],
    ['fragment', { ...original, DATABASE_URL: 'postgres://postgres:old@host/postgres#other' }, 'malformed_url'],
    ['socket', { ...original, DATABASE_URL: 'postgres://postgres:old@%2Ftmp/postgres' }, 'malformed_url'],
    ['missing alias evidence', { POSTGRES_PASSWORD: source }, 'no_aliases'],
  ])('rejects %s without returning private inputs', (_name, raw, reason) => {
    const result = prepareRailwayDatabaseCredentialAliases(raw, raw);
    expect(result).toMatchObject({ status: 'unsupported', reason });
    expect(Object.keys(result).every(key => ['status', 'reason', 'key'].includes(key))).toBe(true);
    for (const value of [source, old, 'postgres://', 'postgresql://']) expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each(['password=override', 'user=other', 'host=other', 'hostaddr=127.0.0.1', 'port=6543', 'dbname=other', 'database=other', 'service=other', 'options=-c%20role%3Dother', 'unknown=value', 'sslmode=require&sslmode=disable', '%70assword=override'])('rejects unsafe or unsupported query options: %s', query => {
    const uri = `postgresql://postgres:${old}@host/postgres?${query}`;
    expect(prepareRailwayDatabaseCredentialAliases({ POSTGRES_PASSWORD: source, DATABASE_URL: uri }, { POSTGRES_PASSWORD: source, DATABASE_URL: uri }))
      .toEqual({ status: 'unsupported', reason: 'unsupported_url_options', key: 'DATABASE_URL' });
  });

  it('does not trust missing or inconsistent rendered evidence', () => {
    expect(prepareRailwayDatabaseCredentialAliases(original, { ...original, POSTGRES_PASSWORD: 'different' }))
      .toMatchObject({ status: 'unsupported', reason: 'source_mismatch' });
    expect(prepareRailwayDatabaseCredentialAliases(original, { POSTGRES_PASSWORD: source }))
      .toMatchObject({ status: 'unsupported', reason: 'inconsistent_resolution', key: 'PGPASSWORD' });
    expect(prepareRailwayDatabaseCredentialAliases(repaired, original))
      .toMatchObject({ status: 'unsupported', reason: 'inconsistent_resolution', key: 'PGPASSWORD' });
    expect(prepareRailwayDatabaseCredentialAliases({ POSTGRES_PASSWORD: source, PGPASSWORD: old }, original))
      .toMatchObject({ status: 'unsupported', reason: 'inconsistent_resolution', key: 'DATABASE_URL' });
  });

  it('never changes a non-password reference even when its resolved value equals an internal parser marker', () => {
    const raw = { POSTGRES_PASSWORD: 'credential_placeholder', DATABASE_URL: 'postgres://${{POSTGRES_PASSWORD}}:credential_placeholder@host/postgres' };
    const resolved = { ...raw, DATABASE_URL: 'postgres://credential_placeholder:credential_placeholder@host/postgres' };
    expect(prepareRailwayDatabaseCredentialAliases(raw, resolved))
      .toEqual({ status: 'unsupported', reason: 'unsupported_reference', key: 'DATABASE_URL' });
  });
});

describe('Railway database password alias verification', () => {
  it('requires both expected reference definitions and resolved values', () => {
    const planned = prepare();
    expect(verifyRailwayDatabaseCredentialAliases(planned, repaired, rendered)).toEqual({ status: 'verified' });
    expect(verifyRailwayDatabaseCredentialAliases(planned, rendered, rendered))
      .toEqual({ status: 'unverified', reason: 'alias_definition_mismatch', key: 'PGPASSWORD' });
    expect(verifyRailwayDatabaseCredentialAliases(planned, repaired, original))
      .toEqual({ status: 'unverified', reason: 'alias_resolution_mismatch', key: 'PGPASSWORD' });
  });

  it('rejects source changes, target changes and newly appearing aliases', () => {
    expect(verifyRailwayDatabaseCredentialAliases(prepare(), { ...repaired, POSTGRES_PASSWORD: 'changed' }, rendered))
      .toEqual({ status: 'unverified', reason: 'canonical_source_changed', key: 'POSTGRES_PASSWORD' });
    expect(verifyRailwayDatabaseCredentialAliases(prepare(), { ...repaired, DATABASE_URL: repaired.DATABASE_URL.replace('.example', '.elsewhere') }, rendered))
      .toEqual({ status: 'unverified', reason: 'alias_definition_mismatch', key: 'DATABASE_URL' });
    const minimal = prepare({ POSTGRES_PASSWORD: source, PGPASSWORD: old });
    expect(verifyRailwayDatabaseCredentialAliases(minimal, repaired, rendered))
      .toMatchObject({ status: 'unverified', reason: 'alias_set_changed' });
  });

  it('permits canonical reference whitespace readback without permitting target normalization', () => {
    const raw = { ...repaired, PGPASSWORD: '${{ POSTGRES_PASSWORD }}', DATABASE_PRIVATE_URL: repaired.DATABASE_PRIVATE_URL.replace(ref, '${{ POSTGRES_PASSWORD }}') };
    expect(verifyRailwayDatabaseCredentialAliases(prepare(), raw, rendered)).toEqual({ status: 'verified' });
  });

  it('treats dollar replacement syntax as literal password bytes for a PGPASSWORD-only repair', () => {
    const raw = { POSTGRES_PASSWORD: '$&', PGPASSWORD: old };
    const planned = prepare(raw);
    const definitions = { ...raw, PGPASSWORD: ref };
    expect(verifyRailwayDatabaseCredentialAliases(planned, definitions, { ...raw, PGPASSWORD: '$&' })).toEqual({ status: 'verified' });
    expect(verifyRailwayDatabaseCredentialAliases(planned, definitions, definitions))
      .toEqual({ status: 'unverified', reason: 'alias_resolution_mismatch', key: 'PGPASSWORD' });
  });
});

describe('private alias fingerprint input', () => {
  it('is deterministic, scope-limited and preserves presence versus empty', () => {
    const first = railwayDatabaseCredentialAliasFingerprintInput(original, original);
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect(railwayDatabaseCredentialAliasFingerprintInput(reversed, reversed)).toBe(first);
    expect(railwayDatabaseCredentialAliasFingerprintInput({ ...original, UNRELATED: 'changed' }, original)).toBe(first);
    expect(railwayDatabaseCredentialAliasFingerprintInput(original, { ...original, PGPASSWORD: source })).not.toBe(first);
    expect(railwayDatabaseCredentialAliasFingerprintInput({ POSTGRES_PASSWORD: source }, {}))
      .not.toBe(railwayDatabaseCredentialAliasFingerprintInput({ POSTGRES_PASSWORD: source, PGPASSWORD: '' }, {}));
    // This is deliberately sensitive material for a PRIVATE stale-plan digest,
    // not a public hash, response, error, or persisted cleartext receipt.
    expect(first).toContain(source);
  });
});
