import { describe, expect, it, vi } from 'vitest';
import {
  postgresDumpArguments,
  postgresMajorVersion,
  postgresProcessEnvironment,
  transferPostgresDatabase,
  type TransferDependencies,
} from '../postgres-transfer.service.js';

type Table = { schema: string; table: string; rows: string };

function clientFor(params: {
  tables: Table[];
  version?: string;
  extensions?: string[];
  snapshot?: string;
}) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
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
    expect(source.queries[0]).toContain('REPEATABLE READ READ ONLY');
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
});
