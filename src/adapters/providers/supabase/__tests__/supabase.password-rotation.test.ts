import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseAdapter } from '../supabase.adapter.js';
import type { Component } from '../../../../domain/entities/component.entity.js';

const ref = 'abcdefghijklmnopqrst';
const host = `db.${ref}.supabase.co`;
const previous = 'previous-password-value-1234567890';
const candidate = 'candidate-password-value-1234567890';
const base = 'test/provider-contracts/supabase/';
const pin = JSON.parse(readFileSync(base + 'password-rotation.source.json', 'utf8'));
const raw = readFileSync(base + pin.schemaFile, 'utf8');
const contract = JSON.parse(raw);
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'rotation');
function valid(path: string, value: unknown) {
  const check = ajv.compile({ $ref: `rotation#${path}` });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}
const project = { id: ref, ref, organization_id: 'org-id', organization_slug: 'org-slug', name: 'app',
  region: 'us-east-1', created_at: '2026-10-21T00:00:00Z', status: 'ACTIVE_HEALTHY',
  database: { host, version: '17', postgres_engine: 'postgres', release_channel: 'ga' } };
function component(): Component {
  return { id: 'local-database', environmentId: 'staging-id', externalId: ref, type: 'postgres',
    bindings: { provider: 'supabase', instanceId: ref, providerScope: { organizationId: 'org-id', region: 'us-east-1' },
      host, port: 5432, username: 'postgres', password: previous, database: 'postgres',
      connectionString: `postgresql://postgres:${previous}@${host}:5432/postgres`,
      pooledUrl: `postgresql://postgres:${previous}@${host}:6543/postgres?pgbouncer=true` },
    createdAt: new Date(), updatedAt: new Date() };
}
async function fixture(options: { response?: unknown; status?: number; lost?: boolean; otherRef?: boolean; poolHost?: string; poolers?: unknown } = {}) {
  const writes: unknown[] = [];
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.supabase.com');
    if (init?.method === 'PATCH') {
      expect(url.pathname).toBe(`/v1/projects/${ref}/database/password`);
      const body = JSON.parse(String(init.body));
      valid('/paths/~1v1~1projects~1{ref}~1database~1password/patch/requestBody/content/application~1json/schema', body);
      writes.push(body);
      if (options.lost) throw new Error('uncertain provider echo ' + candidate);
      return Response.json(options.response ?? { message: 'updated ' + candidate }, { status: options.status ?? 200 });
    }
    reads.push(url.pathname);
    if (url.pathname === '/v1/organizations') return Response.json([{ id: 'org-id', slug: 'org-slug', name: 'organization' }]);
    if (url.pathname === `/v1/projects/${ref}`) return Response.json({ ...project, ...(options.otherRef ? { ref: 'zyxwvutsrqponmlkjihgf' } : {}) });
    if (url.pathname === `/v1/projects/${ref}/config/database/pgbouncer`) return Response.json({
      connection_string: `postgresql://postgres:[YOUR-PASSWORD]@${options.poolHost ?? host}:6543/postgres` });
    if (url.pathname === `/v1/projects/${ref}/config/database/pooler`) return Response.json(options.poolers);
    throw new Error('unexpected transport path');
  }));
  const adapter = new SupabaseAdapter();
  await adapter.connect({ accessToken: 'synthetic-token', organizationId: 'org-id' });
  return { adapter, writes, reads };
}
afterEach(() => vi.unstubAllGlobals());

describe('Supabase native password rotation', () => {
  it('exposes an issuer password replacement capability rather than treating env writes as rotation', () => {
    const adapter = new SupabaseAdapter();
    expect(adapter).toHaveProperty('passwordRotation.strategy', 'replace-in-place');
  });

  it('pins official request/response schemas and requires both bound direct and pooler identities', async () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(pin.schemaSha256);
    valid('/paths/~1v1~1projects~1{ref}/get/responses/200/content/application~1json/schema', project);
    valid('/paths/~1v1~1projects~1{ref}~1database~1password/patch/responses/200/content/application~1json/schema', { message: 'updated' });
    const { adapter, writes, reads } = await fixture();
    const target = await adapter.passwordRotation.observeTarget(component());
    expect(target).toEqual({ provider: 'supabase', resourceId: ref, providerScope: { organizationId: 'org-id', region: 'us-east-1' },
      username: 'postgres', database: 'postgres', endpoints: [
        { kind: 'direct', host, port: 5432, username: 'postgres', database: 'postgres', expectedRole: 'postgres' },
        { kind: 'pooled', host, port: 6543, username: 'postgres', database: 'postgres', expectedRole: 'postgres' },
      ] });
    expect(reads).toContain(`/v1/projects/${ref}/config/database/pgbouncer`);
    expect(writes).toEqual([]);
    expect(JSON.stringify(target)).not.toContain(previous);
  });

  it('performs exactly one scoped issuer PATCH and returns only acknowledgement', async () => {
    const { adapter, writes } = await fixture();
    const bound = component();
    const before = JSON.stringify(bound);
    const target = await adapter.passwordRotation.observeTarget(bound);
    const result = await adapter.passwordRotation.replacePassword({ component: bound, target, replacementPassword: candidate });
    expect(writes).toEqual([{ password: candidate }]);
    expect(result).toEqual({ status: 'acknowledged', mutationAttempted: true });
    expect(JSON.stringify(result)).not.toContain(candidate);
    expect(JSON.stringify(bound)).toBe(before);
  });

  it.each([
    { options: { lost: true }, status: 'unknown' },
    { options: { response: { unexpected: 'echo ' + candidate } }, status: 'unknown' },
    { options: { status: 500 }, status: 'unknown' },
    { options: { status: 403 }, status: 'rejected' },
  ])('does not retry or leak a $status issuer outcome', async ({ options, status }) => {
    const { adapter, writes } = await fixture(options);
    const bound = component();
    const target = await adapter.passwordRotation.observeTarget(bound);
    const result = await adapter.passwordRotation.replacePassword({ component: bound, target, replacementPassword: candidate });
    expect(result).toMatchObject({ status, mutationAttempted: true });
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(candidate);
  });

  it.each([{ otherRef: true }, { poolHost: 'wrong-project.supabase.co' }])('blocks mismatched native identity without writes', async options => {
    const { adapter, writes } = await fixture(options);
    await expect(adapter.passwordRotation.observeTarget(component())).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('re-observes the exact approved target before mutation and authentication recovery', async () => {
    const { adapter, writes } = await fixture();
    const bound = component();
    const target = await adapter.passwordRotation.observeTarget(bound);
    target.providerScope.region = 'eu-west-1';
    expect(await adapter.passwordRotation.replacePassword({ component: bound, target, replacementPassword: candidate }))
      .toEqual({ status: 'rejected', mutationAttempted: false, reason: 'identity_changed' });
    expect(await adapter.passwordRotation.verifyPassword({ component: bound, target, password: candidate }))
      .toMatchObject({ status: 'unknown', existingSessions: 'unchecked' });
    expect(writes).toEqual([]);
  });

  it('matches a native primary Supavisor endpoint without treating replica endpoints as the same login', async () => {
    const poolHost = 'aws-0-us-east-1.pooler.supabase.com';
    const url = `postgresql://postgres.${ref}:[YOUR-PASSWORD]@${poolHost}:6543/postgres`;
    const primary = { identifier: ref, database_type: 'PRIMARY', is_using_scram_auth: true,
      db_user: 'postgres', db_host: host, db_port: 5432, db_name: 'postgres',
      connection_string: url, connectionString: url, default_pool_size: null, max_client_conn: null, pool_mode: 'transaction' };
    const pools = [primary, { ...primary, database_type: 'READ_REPLICA', identifier: 'replica' }];
    valid('/paths/~1v1~1projects~1{ref}~1config~1database~1pooler/get/responses/200/content/application~1json/schema', pools);
    const { adapter, writes } = await fixture({ poolers: pools });
    const bound = component();
    bound.bindings.pooledUrl = url.replace('[YOUR-PASSWORD]', previous);
    const target = await adapter.passwordRotation.observeTarget(bound);
    expect(target.endpoints[1]).toEqual({ kind: 'pooled', host: poolHost, port: 6543,
      username: `postgres.${ref}`, database: 'postgres', expectedRole: 'postgres' });
    expect(writes).toEqual([]);
    await fixture({ poolers: [primary, primary] });
    await expect(adapter.passwordRotation.observeTarget(bound)).rejects.toThrow();
    await fixture({ poolers: [{ ...primary, database_type: 'READ_REPLICA' }] });
    await expect(adapter.passwordRotation.observeTarget(bound)).rejects.toThrow();
  });

  it('blocks another environment, unverified host, custom login and malformed successful provider reads before issuance', async () => {
    const { adapter, writes } = await fixture();
    for (const patch of [
      { username: 'application_role' }, { host: 'other.example' }, { instanceId: 'wrong' },
      { providerScope: { organizationId: 'other-org', region: 'us-east-1' } },
      { connectionUrl: `postgresql://postgres:${previous}@wrong.example:5432/postgres` },
    ]) {
      const bound = component(); bound.bindings = { ...bound.bindings, ...patch };
      await expect(adapter.passwordRotation.observeTarget(bound)).rejects.toThrow();
    }
    expect(writes).toEqual([]);
  });
});
