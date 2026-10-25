import { afterEach, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPostgresCredentialLifecycle, replaceDatabasePassword } from '../database-credential.js';
import type { IDatabaseAdapter } from '../../../../domain/ports/database.port.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

// Synthetic database transport observations follow PostgreSQL's documented
// session_user/current_database and SQLSTATE 28P01 contracts. Native HTTP writers
// have separate serialized-client contract coverage.
afterEach(() => vi.restoreAllMocks());
const environment = { id: 'local-environment', name: 'production', projectId: 'local-project', platformBindings: {} } as Environment;
const component = { id: 'local-database', environmentId: environment.id, type: 'postgres', externalId: 'native-database', bindings: {
  provider: 'postgres-test', providerScope: { accountId: 'account-1' }, username: 'app', database: 'appdb', connectionString: 'postgresql://app:old-password@db.example/appdb?sslmode=require',
}, createdAt: new Date(), updatedAt: new Date() } as Component;
const selection = { environment: environment.name, component: component.id, username: 'app', database: 'appdb' };
const adapter = { name: 'postgres-test', capabilities: { supportedDatabases: ['postgres'] },
  observeDatabase: vi.fn(async () => ({ provider: 'postgres-test', engine: 'postgres', externalId: 'native-database', status: 'running' })),
  getConnectionUrl: vi.fn(async () => component.bindings.connectionString),
} as unknown as IDatabaseAdapter;

it('inspects exact native database scope without SQL, resource creation, or credential disclosure', async () => {
  const connect = vi.spyOn(pg.Client.prototype, 'connect');
  const port = createPostgresCredentialLifecycle(() => adapter);
  const target = await port.inspect(environment, component, selection);
  expect(target).toMatchObject({ externalId: component.externalId, providerScope: { accountId: 'account-1' }, username: 'app', inputMode: 'supplied' });
  expect(JSON.stringify(target)).not.toContain('old-password');
  expect(connect).not.toHaveBeenCalled();
  await expect(port.inspect(environment, component, { ...selection, username: 'another-user' })).rejects.toThrow(/identity/i);
});

it('changes actual PostgreSQL authentication and never embeds plaintext into SQL text', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  vi.spyOn(pg.Client.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined);
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(async function (sql: any, values?: any) {
    calls.push({ sql, values });
    return { rows: [{ username: 'app', database: 'appdb' }], rowCount: 1 } as any;
  });
  const port = createPostgresCredentialLifecycle(() => adapter);
  const target = await port.inspect(environment, component, selection);
  expect(await port.rotate(environment, component, target, "new'password")).toMatchObject({ state: 'acknowledged' });
  expect(calls.some(call => call.sql.includes('ALTER ROLE'))).toBe(true);
  expect(calls.map(call => call.sql).join('\n')).not.toContain("new'password");
  expect(calls.some(call => call.values?.includes("new'password"))).toBe(true);
});

it('distinguishes authentication rejection from an uncertain connection failure', async () => {
  vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined);
  const connect = vi.spyOn(pg.Client.prototype, 'connect').mockRejectedValue(Object.assign(new Error('secret-echo'), { code: '28P01' }));
  const port = createPostgresCredentialLifecycle(() => adapter);
  const target = await port.inspect(environment, component, selection);
  expect(await port.probe(environment, component, target, 'candidate')).toMatchObject({ state: 'rejected' });
  connect.mockRejectedValue(Object.assign(new Error('secret-echo'), { code: 'ETIMEDOUT' }));
  const result = await port.probe(environment, component, target, 'candidate');
  expect(result.state).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('secret-echo');
});

it('replaces only the password of a reviewed URL while preserving encoded options and identity', () => {
  expect(replaceDatabasePassword('postgresql://app:old@db.example:5433/appdb?sslmode=require&application_name=a%20b', 'next@password', { username: 'app', database: 'appdb' })).toBe('postgresql://app:next%40password@db.example:5433/appdb?sslmode=require&application_name=a%20b');
  expect(() => replaceDatabasePassword('postgresql://other:old@db.example/appdb', 'next', { username: 'app', database: 'appdb' })).toThrow(/identity/i);
});

it('stops before SQL when the reviewed account scope changes or the native database is deleted', async () => {
  const bound = structuredClone(component);
  const observed = vi.fn(async () => ({ provider: 'postgres-test', engine: 'postgres', externalId: 'native-database', status: 'running' } as any));
  const scopedAdapter = { ...adapter, observeDatabase: observed } as IDatabaseAdapter;
  const connect = vi.spyOn(pg.Client.prototype, 'connect');
  const port = createPostgresCredentialLifecycle(() => scopedAdapter);
  const target = await port.inspect(environment, bound, selection);
  bound.bindings.providerScope = { accountId: 'another-account' };
  expect(await port.rotate(environment, bound, target, 'replacement')).toEqual({ state: 'blocked' });
  observed.mockResolvedValue(null);
  await expect(port.inspect(environment, bound, selection)).rejects.toThrow(/absent or unknown/);
  expect(connect).not.toHaveBeenCalled();
});
