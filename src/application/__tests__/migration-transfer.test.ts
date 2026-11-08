import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { databaseManifestScript, databaseTransferScript, manifestsMatch, storageCheckScript, storageTransferScript } from '../migration-transfer-gcp.js';

describe('transfer scripts', () => {
  it('are valid POSIX shell', () => {
    for (const script of [databaseTransferScript(), storageTransferScript(), databaseManifestScript(), storageCheckScript()]) {
      expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
    }
  });

  it('compares per-table row counts', () => {
    const source = { tables: { 'public.a': '3', 'public.b': '0' }, totalRows: '3', version: '160004' };
    expect(manifestsMatch(source, { ...source })).toEqual({ match: true, differences: [] });
    expect(manifestsMatch(source, { ...source, tables: { 'public.a': '2' } }).differences).toEqual(['public.a: 3 → 2', 'public.b: 0 → missing']);
    // A source that reported nothing never matches, and extra target tables count.
    expect(manifestsMatch({ ...source, tables: {} }, source).match).toBe(false);
    expect(manifestsMatch(source, { ...source, tables: { ...source.tables, 'public.c': '1' } }).differences).toEqual(['public.c: only in the target']);
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
      expect(result.source.tables).toEqual({ 'billing.Customers': expect.stringMatching(/^2:\d+$/), 'public.invoices': expect.stringMatching(/^250:\d+$/) });
      expect(manifestsMatch(result.source, result.target)).toEqual({ match: true, differences: [] });
      expect(psql(url(targetDb), "SELECT count(*) FROM information_schema.tables WHERE table_name = 'stale'").trim()).toBe('0');
    } finally {
      psql(admin!, `DROP DATABASE IF EXISTS ${sourceDb}`);
      psql(admin!, `DROP DATABASE IF EXISTS ${targetDb}`);
    }
  });
});

describe.skipIf(!bin || !admin)('private-network export and restore scripts (live PostgreSQL)', () => {
  it('export uploads a dump through a URL; restore replaces the target with matching counts', async () => {
    const http = await import('http');
    const { databaseExportScript, databaseRestoreScript, parseTransferResult } = await import('../migration-transfer-gcp.js');
    const { execFile } = await import('child_process');
    const run = (script: string, env: Record<string, string>) => new Promise<string>((resolve, reject) =>
      execFile('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, maxBuffer: 1 << 24 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    let stored: Buffer | undefined;
    const server = http.createServer((request, response) => {
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => { stored = Buffer.concat(chunks); response.writeHead(200).end(); });
      } else if (request.method === 'GET' && stored) response.writeHead(200).end(stored);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const psql = (url: string, sql: string) => execFileSync(`${bin}/psql`, [url, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], { encoding: 'utf8' });
    const suffix = Date.now();
    const url = (db: string) => admin!.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
    psql(admin!, `CREATE DATABASE hv_esrc_${suffix}`);
    psql(admin!, `CREATE DATABASE hv_edst_${suffix}`);
    try {
      psql(url(`hv_esrc_${suffix}`), 'CREATE TABLE "Invoices" (id serial PRIMARY KEY, total numeric); INSERT INTO "Invoices" (total) SELECT g FROM generate_series(1, 42) g;');
      psql(url(`hv_edst_${suffix}`), 'CREATE TABLE stale (id int);');
      const exported = parseTransferResult(await run(databaseExportScript(), { SOURCE_DATABASE_URL: url(`hv_esrc_${suffix}`), UPLOAD_URL: `${base}/upload` })) as any;
      expect(exported).toMatchObject({ ok: true, source: { tables: { 'public.Invoices': expect.stringMatching(/^42:\d+$/) }, totalRows: '42' } });
      expect(stored?.length).toBeGreaterThan(0);
      const restored = parseTransferResult(await run(databaseRestoreScript(), { DATABASE_URL: url(`hv_edst_${suffix}`), DUMP_URL: `${base}/dump` })) as any;
      expect(restored).toMatchObject({ ok: true, target: { tables: { 'public.Invoices': expect.stringMatching(/^42:\d+$/) } } });
      expect(manifestsMatch(exported.source, restored.target)).toEqual({ match: true, differences: [] });
      expect(psql(url(`hv_edst_${suffix}`), "SELECT count(*) FROM information_schema.tables WHERE table_name = 'stale'").trim()).toBe('0');
    } finally {
      server.close();
      psql(admin!, `DROP DATABASE IF EXISTS hv_esrc_${suffix}`);
      psql(admin!, `DROP DATABASE IF EXISTS hv_edst_${suffix}`);
    }
  });
});

describe('signed object URLs', () => {
  it('produce a GOOG4 V4 URL for exactly one object and method', async () => {
    const { signedObjectUrl } = await import('../migration-transfer-gcp.js');
    const { generateKeyPairSync, createVerify } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const url = new URL(signedObjectUrl({ clientEmail: 'deploy@p.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      bucket: 'b', object: 'migrations/db 1.dump', method: 'PUT', expiresSeconds: 3600, now: new Date('2026-11-07T00:00:00Z') }));
    expect(url.pathname).toBe('/b/migrations/db%201.dump');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Goog-Credential')).toBe('deploy@p.iam.gserviceaccount.com/20261107/auto/storage/goog4_request');
    expect(url.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]{512}$/);
    void publicKey; void createVerify;
  });
});
