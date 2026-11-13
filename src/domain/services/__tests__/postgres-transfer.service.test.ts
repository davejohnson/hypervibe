import { describe, expect, it, vi } from 'vitest';
import {
  postgresDumpArguments,
  postgresMajorVersion,
  postgresProcessEnvironment,
  transferPostgresDatabase,
  type TransferDependencies,
  type PostgresToolTransferInput,
} from '../postgres-transfer.service.js';
import { parsePostgresDatabaseIdentity, PostgresDatabaseIdentityError } from '../postgres-database-identity.js';
import { Client } from 'pg';

type Table = { schema: string; table: string; rows: string };
let databaseIdentity = 1000;

function clientFor(params: {
  tables: Table[];
  version?: string;
  extensions?: string[];
  snapshot?: string;
  identity?: string | null;
  identityError?: Error;
}) {
  const queries: string[] = [];
  const identity = params.identity === undefined ? `${++databaseIdentity}:617070` : params.identity;
  return {
    queries,
    client: {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_control_system')) {
          if (params.identityError) throw params.identityError;
          return { rows: [{ identity }] };
        }
        if (sql.includes('pg_export_snapshot')) return { rows: [{ snapshot: params.snapshot ?? '00000001-1' }] };
        if (sql.includes('server_version_num')) return { rows: [{ version: params.version ?? '160004' }] };
        if (sql.includes('FROM pg_extension')) return { rows: (params.extensions ?? ['plpgsql']).map((extname) => ({ extname })) };
        if (sql.includes('FROM pg_tables')) return { rows: params.tables.map(({ schema, table }) => ({ schema, table })) };
        const table = params.tables.find((item) => sql.includes(`"${item.schema}"."${item.table}"`));
        if (table) return { rows: [{ rows: table.rows }] };
        return { rows: [] };
      }),
    },
  };
}

describe('PostgreSQL transfer', () => {
  it('streams the custom archive to stdout for pg_restore', () => {
    expect(postgresDumpArguments('00000001-1')).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--snapshot=00000001-1',
    ]);
  });

  it('extracts modern PostgreSQL major versions', () => {
    expect(postgresMajorVersion('170004')).toBe(17);
    expect(postgresMajorVersion('160010')).toBe(16);
    expect(postgresMajorVersion('unknown')).toBeNull();
  });

  it('keeps credentials out of argv-compatible values', () => {
    const env = postgresProcessEnvironment('postgresql://alice:p%40ss@db.example.com:5444/app?sslmode=require');
    expect(env).toMatchObject({
      PGHOST: 'db.example.com',
      PGPORT: '5444',
      PGDATABASE: 'app',
      PGUSER: 'alice',
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'require',
    });
  });

  it('decodes PostgreSQL URI Unix-socket hosts without changing the database identity', () => {
    expect(postgresProcessEnvironment('postgresql://test_user@%2Ftmp%2Ftest-postgres/test_db')).toMatchObject({
      PGHOST: '/tmp/test-postgres', PGDATABASE: 'test_db', PGUSER: 'test_user',
    });
  });

  it('exports one repeatable-read snapshot and verifies target row counts', async () => {
    const tables = [
      { schema: 'public', table: 'Users', rows: '8' },
      { schema: 'audit', table: 'Events', rows: '42' },
    ];
    const source = clientFor({ tables, extensions: ['pgcrypto', 'plpgsql'] });
    const target = clientFor({ tables, extensions: ['pgcrypto', 'plpgsql'] });
    const clients = [source.client, target.client];
    const runTools = vi.fn(async () => 4096);
    const dependencies: TransferDependencies = {
      createClient: () => clients.shift()!,
      runTools,
    };

    const result = await transferPostgresDatabase(
      'postgresql://source:secret@source.example/app',
      'postgresql://target:secret@target.example/app',
      dependencies
    );

    expect(runTools).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: '00000001-1' }));
    expect(source.queries).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(source.queries).toContain('COMMIT');
    expect(result.manifest).toMatchObject({ totalRows: '50', dumpBytes: 4096, tables });
  });

  it('fails closed when restored data differs from the frozen source snapshot', async () => {
    const source = clientFor({ tables: [{ schema: 'public', table: 'Users', rows: '8' }] });
    const target = clientFor({ tables: [{ schema: 'public', table: 'Users', rows: '7' }] });
    const clients = [source.client, target.client];

    await expect(transferPostgresDatabase(
      'postgresql://source:secret@source.example/app',
      'postgresql://target:secret@target.example/app',
      { createClient: () => clients.shift()!, runTools: async () => 100 }
    )).rejects.toThrow('row counts differ');
  });

  it('compares the same tables independently of source and target collation order', async () => {
    const tables = [{ schema: 'public', table: 'alpha', rows: '2' }, { schema: 'public', table: 'Zulu', rows: '3' }];
    const source = clientFor({ tables });
    const target = clientFor({ tables: [...tables].reverse() });
    const clients = [source.client, target.client];
    await expect(transferPostgresDatabase(
      'postgresql://source:secret@source.example/test_db',
      'postgresql://target:secret@target.example/test_db',
      { createClient: () => clients.shift()!, runTools: async () => 100 }
    )).resolves.toMatchObject({ manifest: { totalRows: '5' } });
  });

  it.each([
    { name: 'aliases and different roles reach the same database', sourceIdentity: '7500000000000000001:617070', targetIdentity: '7500000000000000001:617070' },
    { name: 'target identity is unavailable', sourceIdentity: '7500000000000000001:617070', targetIdentity: null },
    { name: 'source identity is malformed', sourceIdentity: 'unknown', targetIdentity: '7500000000000000002:617070' },
  ])('does not start writing when $name', async ({ sourceIdentity, targetIdentity }) => {
    const tables = [{ schema: 'public', table: 'sentinel', rows: '1' }];
    const source = clientFor({ tables, identity: sourceIdentity });
    const target = clientFor({ tables, identity: targetIdentity });
    const clients = [source.client, target.client];
    const runTools = vi.fn(async () => 4096);
    await expect(transferPostgresDatabase(
      'postgresql://reader@public.example/app', 'postgresql://owner@private.example/app',
      { createClient: () => clients.shift()!, runTools }
    )).rejects.toThrow(/database identity|same database/i);
    expect(runTools).not.toHaveBeenCalled();
    expect(source.client.end).toHaveBeenCalled();
    expect(target.client.end).toHaveBeenCalled();
  });

  it('does not start writing or expose diagnostics when the identity query fails', async () => {
    const source = clientFor({ tables: [], identityError: new Error('secret URL postgres://password@host') });
    const target = clientFor({ tables: [] });
    const clients = [source.client, target.client];
    const runTools = vi.fn(async () => 1);
    await expect(transferPostgresDatabase('postgres://source/app', 'postgres://target/app', {
      createClient: () => clients.shift()!, runTools,
    })).rejects.toThrow('database identity');
    expect(runTools).not.toHaveBeenCalled();
  });

  it('allows different databases on the same cluster', async () => {
    const source = clientFor({ tables: [], identity: '7500000000000000001:736f75726365' });
    const target = clientFor({ tables: [], identity: '7500000000000000001:746172676574' });
    const clients = [source.client, target.client];
    const runTools = vi.fn(async () => 1);
    await expect(transferPostgresDatabase('postgres://host/source', 'postgres://host/target', {
      createClient: () => clients.shift()!, runTools,
    })).resolves.toMatchObject({ manifest: { dumpBytes: 1 } });
    expect(runTools).toHaveBeenCalledOnce();
  });

  it('preserves the target when its connection fails before its identity can be read', async () => {
    const source = clientFor({ tables: [] });
    const target = clientFor({ tables: [] });
    target.client.connect.mockRejectedValue(new Error('secret password'));
    const clients = [source.client, target.client];
    const runTools = vi.fn(async () => 1);
    const result = transferPostgresDatabase('postgres://source/app', 'postgres://target/app', {
      createClient: () => clients.shift()!, runTools,
    });
    await expect(result).rejects.toBeInstanceOf(PostgresDatabaseIdentityError);
    await expect(result).rejects.not.toThrow('secret');
    expect(runTools).not.toHaveBeenCalled();
  });

  it('parses complete identity strings without rounding or accepting malformed tokens', () => {
    expect(parsePostgresDatabaseIdentity('7500000000000000001:617070')).toBe('7500000000000000001:617070');
    expect(parsePostgresDatabaseIdentity('7500000000000000002:617070')).toBe('7500000000000000002:617070');
    for (const invalid of [null, 12, '', '0:61', '01:61', '1:', '1:6', '1:xx', '1:AA', '1:61\n', ' 1:61', `1:${'61'.repeat(64)}`, `${'1'.repeat(21)}:61`]) {
      expect(parsePostgresDatabaseIdentity(invalid)).toBeUndefined();
    }
  });

  it('rejects endpoint overrides before constructing clients or starting tools', async () => {
    const targetUrl = 'postgres://source.example/app?host=target.example&port=6432';
    // The installed driver contract differs from the authority-only CLI mapping.
    const driver = new Client({ connectionString: targetUrl }) as unknown as { connectionParameters: { host: string; port: number } };
    expect(driver.connectionParameters).toMatchObject({ host: 'target.example', port: 6432 });
    expect(postgresProcessEnvironment(targetUrl)).toMatchObject({ PGHOST: 'source.example', PGPORT: '5432' });
    const source = clientFor({ tables: [] });
    const target = clientFor({ tables: [] });
    const clients = [source.client, target.client];
    const createClient = vi.fn(() => clients.shift()!);
    const runTools = vi.fn(async () => 1);
    await expect(transferPostgresDatabase('postgres://source.example/app', targetUrl, { createClient, runTools }))
      .rejects.toBeInstanceOf(PostgresDatabaseIdentityError);
    expect(createClient).not.toHaveBeenCalled();
    expect(runTools).not.toHaveBeenCalled();
  });

  it('removes inherited libpq endpoint and service overrides', () => {
    vi.stubEnv('PGHOSTADDR', '192.0.2.10');
    vi.stubEnv('PGSERVICE', 'another-database');
    vi.stubEnv('PGSERVICEFILE', '/tmp/other-service.conf');
    vi.stubEnv('PGDATABASE', 'another-database');
    try {
      const environment = postgresProcessEnvironment('postgresql://owner:password@verified.example/app');
      expect(environment.PGHOSTADDR).toBeUndefined();
      expect(environment.PGSERVICE).toBeUndefined();
      expect(environment.PGSERVICEFILE).toBeUndefined();
      expect(environment.PGDATABASE).toBe('app');
    } finally { vi.unstubAllEnvs(); }
  });

  it('freezes matching probe and tool defaults before connecting', async () => {
    vi.stubEnv('PGPORT', '6432');
    vi.stubEnv('PGUSER', 'initial_owner');
    vi.stubEnv('PGPASSWORD', 'initial_password');
    vi.stubEnv('PGHOSTADDR', '192.0.2.11');
    const source = clientFor({ tables: [] });
    const target = clientFor({ tables: [] });
    source.client.connect.mockImplementation(async () => {
      process.env.PGUSER = 'changed_owner';
      process.env.PGPASSWORD = 'changed_password';
      process.env.PGHOSTADDR = '192.0.2.10';
    });
    const clients = [source.client, target.client];
    const createClient = vi.fn((_url: string) => clients.shift()!);
    const runTools = vi.fn(async (_input: PostgresToolTransferInput) => 1);
    try {
      await transferPostgresDatabase('postgres://source.example/app', 'postgres://target.example/app', { createClient, runTools });
      const probe = new Client({ connectionString: createClient.mock.calls[1]![0] }) as unknown as { connectionParameters: { user: string; port: number } };
      expect(probe.connectionParameters).toMatchObject({ user: 'initial_owner', port: 5432 });
      expect(runTools.mock.calls[0]![0]).toMatchObject({
        sourceEnvironment: { PGUSER: 'initial_owner', PGPASSWORD: 'initial_password', PGPORT: '5432' },
        targetEnvironment: { PGUSER: 'initial_owner', PGPASSWORD: 'initial_password', PGPORT: '5432' },
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    'postgres://host/db%2Fname',
    'postgres://host/host%3Dother%20dbname%3Dapp',
    'postgres://owner@target.example/postgresql://source.example/app',
    'postgres://owner@target.example/Postgres://source.example/app',
  ])('rejects ambiguous database-name parsing in %s', async (url) => {
    const clients = [clientFor({ tables: [] }).client, clientFor({ tables: [] }).client];
    const createClient = vi.fn(() => clients.shift()!);
    const runTools = vi.fn(async () => 1);
    await expect(transferPostgresDatabase('postgres://source/app', url, { createClient, runTools }))
      .rejects.toBeInstanceOf(PostgresDatabaseIdentityError);
    expect(createClient).not.toHaveBeenCalled();
    expect(runTools).not.toHaveBeenCalled();
  });

  it('keeps encoded socket hosts and ordinary escaped database names consistent', async () => {
    const clients = [clientFor({ tables: [] }).client, clientFor({ tables: [] }).client];
    const createClient = vi.fn((_url: string) => clients.shift()!);
    const runTools = vi.fn(async (_input: PostgresToolTransferInput) => 1);
    await transferPostgresDatabase('postgres://owner@%2Ftmp%2Fhv-pg:5544/source%20db?sslmode=disable',
      'postgres://owner@%2Ftmp%2Fhv-pg:5544/target%20db?sslmode=disable', { createClient, runTools });
    const probe = new Client({ connectionString: createClient.mock.calls[1]![0] }) as unknown as {
      connectionParameters: { host: string; port: number; database: string };
    };
    expect(probe.connectionParameters).toMatchObject({ host: '/tmp/hv-pg', port: 5544, database: 'target db' });
    expect(runTools.mock.calls[0]![0].targetEnvironment).toMatchObject({ PGHOST: '/tmp/hv-pg', PGPORT: '5544', PGDATABASE: 'target db', PGSSLMODE: 'disable' });
  });
});
