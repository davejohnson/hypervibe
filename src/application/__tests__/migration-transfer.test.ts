import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { databaseTransferScript, manifestsMatch, storageTransferScript } from '../migration-transfer-gcp.js';

describe('transfer scripts', () => {
  it('are valid POSIX shell', () => {
    for (const script of [databaseTransferScript(), storageTransferScript()]) {
      expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
    }
  });

  it('compares per-table row counts', () => {
    const source = { tables: { 'public.a': '3', 'public.b': '0' }, totalRows: '3', version: '160004' };
    expect(manifestsMatch(source, { ...source })).toEqual({ match: true, differences: [] });
    expect(manifestsMatch(source, { ...source, tables: { 'public.a': '2' } }).differences).toEqual(['public.a: 3 → 2', 'public.b: 0 → missing']);
  });
});

/**
 * Runs the real database copy script against two local databases. Set
 * HYPERVIBE_TEST_POSTGRES_BIN to a directory with psql/pg_dump/pg_restore that
 * match the local server, and HYPERVIBE_TEST_POSTGRES_URL to an admin URL.
 */
const bin = process.env.HYPERVIBE_TEST_POSTGRES_BIN;
const admin = process.env.HYPERVIBE_TEST_POSTGRES_URL;
describe.skipIf(!bin || !admin)('database copy script (live PostgreSQL)', () => {
  it('replaces the target with an exact copy and reports matching manifests', () => {
    const psql = (url: string, sql: string) => execFileSync(`${bin}/psql`, [url, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], { encoding: 'utf8' });
    const suffix = Date.now();
    const sourceDb = `hv_src_${suffix}`;
    const targetDb = `hv_dst_${suffix}`;
    psql(admin!, `CREATE DATABASE ${sourceDb}`);
    psql(admin!, `CREATE DATABASE ${targetDb}`);
    const url = (db: string) => admin!.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
    try {
      psql(url(sourceDb), `CREATE TABLE invoices (id serial PRIMARY KEY, total numeric); INSERT INTO invoices (total) SELECT g FROM generate_series(1, 250) g;
        CREATE SCHEMA billing; CREATE TABLE billing."Customers" (id int); INSERT INTO billing."Customers" VALUES (1), (2);`);
      // Stale rehearsal data in the target must be replaced, not merged.
      psql(url(targetDb), 'CREATE TABLE stale (id int); INSERT INTO stale VALUES (1);');
      const output = execFileSync('sh', ['-c', databaseTransferScript()], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, SOURCE_DATABASE_URL: url(sourceDb), DATABASE_URL: url(targetDb) },
      });
      const line = output.split('\n').find((entry) => entry.startsWith('HV_TRANSFER_RESULT '))!;
      const result = JSON.parse(line.slice('HV_TRANSFER_RESULT '.length));
      expect(result.ok).toBe(true);
      expect(result.source.tables).toEqual({ 'billing.Customers': '2', 'public.invoices': '250' });
      expect(manifestsMatch(result.source, result.target)).toEqual({ match: true, differences: [] });
      expect(psql(url(targetDb), "SELECT count(*) FROM information_schema.tables WHERE table_name = 'stale'").trim()).toBe('0');
    } finally {
      psql(admin!, `DROP DATABASE IF EXISTS ${sourceDb}`);
      psql(admin!, `DROP DATABASE IF EXISTS ${targetDb}`);
    }
  });
});
