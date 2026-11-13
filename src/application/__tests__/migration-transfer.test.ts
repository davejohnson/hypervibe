import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseManifestScript, databaseRestoreScript, databaseTransferScript, manifestsMatch, parseTransferResult, storageCheckScript, storageTransferScript } from '../migration-transfer-gcp.js';
import { transferPostgresDatabase } from '../../domain/services/postgres-transfer.service.js';
import { POSTGRES_DATABASE_IDENTITY_SQL, PostgresDatabaseIdentityError } from '../../domain/services/postgres-database-identity.js';

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
 * Runs the real copy script with disposable local PostgreSQL in normal CI.
 * A dedicated local test server can also be supplied with matching
 * HYPERVIBE_TEST_POSTGRES_BIN and HYPERVIBE_TEST_POSTGRES_URL settings.
 */
let bin = process.env.HYPERVIBE_TEST_POSTGRES_BIN;
let admin = process.env.HYPERVIBE_TEST_POSTGRES_URL;
let fixtureDirectory: string | undefined;
let scriptDirectory: string;
const isolatedScript = (script: string) => script.replaceAll('/tmp/', `"${scriptDirectory}"/`);

// Alpine ash enables pipefail; Bash runs the same program on hosts whose
// /bin/sh is Dash. Match the existing backup tests: use disposable local PostgreSQL in ordinary
// acceptance, failing rather than skipping if its tools are unavailable.
beforeAll(() => {
  scriptDirectory = mkdtempSync('/tmp/hv-migration-scripts-');
  if (bin && admin) return;
  if (bin || admin) throw new Error('Supply both PostgreSQL test settings or neither.');
  const candidates: string[] = [];
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) {
    candidates.push(`/usr/lib/postgresql/${version}/bin`);
  }
  bin = candidates.find(candidate => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the migration acceptance tests.');
  fixtureDirectory = mkdtempSync('/tmp/hv-migration-');
  execFileSync(`${bin}/initdb`, ['-D', path.join(fixtureDirectory, 'data'), '-U', 'hv_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  execFileSync(`${bin}/pg_ctl`, ['-D', path.join(fixtureDirectory, 'data'), '-l', path.join(fixtureDirectory, 'server.log'),
    '-o', `-k ${fixtureDirectory} -h ""`, '-w', 'start'], { stdio: 'pipe' });
  admin = `postgresql://hv_admin@${encodeURIComponent(fixtureDirectory)}:5432/postgres`;
}, 60_000);

afterAll(() => {
  if (fixtureDirectory) {
    if (existsSync(path.join(fixtureDirectory, 'data/postmaster.pid'))) {
      execFileSync(`${bin}/pg_ctl`, ['-D', path.join(fixtureDirectory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    }
    rmSync(fixtureDirectory, { recursive: true, force: true });
    expect(existsSync(fixtureDirectory)).toBe(false);
  }
  if (scriptDirectory) rmSync(scriptDirectory, { recursive: true, force: true });
});

describe('database copy script (live PostgreSQL)', () => {
  it.each([false, true])('preserves the source when both connections reach it (different roles: %s)', async (differentRoles) => {
    const psql = (url: string, sql: string) => execFileSync(`${bin}/psql`, [url, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
    const suffix = Date.now();
    const database = `hv_self_${suffix}`, owner = `hv_owner_${suffix}`, reader = `hv_reader_${suffix}`;
    psql(admin!, `CREATE ROLE ${owner} LOGIN; CREATE ROLE ${reader} LOGIN;`);
    psql(admin!, `CREATE DATABASE ${database} OWNER ${owner}`);
    const ownerUrl = new URL(admin!.replace(/\/[^/?]*(\?|$)/, `/${database}$1`));
    ownerUrl.username = owner; ownerUrl.password = '';
    const readerUrl = new URL(ownerUrl); readerUrl.username = reader;
    try {
      psql(ownerUrl.toString(), `CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('must survive'); GRANT SELECT ON sentinel TO ${reader};`);
      const sourceUrl = (differentRoles ? readerUrl : ownerUrl).toString();
      const targetUrl = ownerUrl.toString();
      const rejected = spawnSync('bash', ['-c', isolatedScript(databaseTransferScript())], {
        encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, SOURCE_DATABASE_URL: sourceUrl, DATABASE_URL: targetUrl },
      });
      expect(rejected.status).not.toBe(0);
      expect(parseTransferResult(rejected.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('same database') });
      await expect(transferPostgresDatabase(sourceUrl, targetUrl)).rejects.toBeInstanceOf(PostgresDatabaseIdentityError);
      expect(psql(targetUrl, 'SELECT value FROM sentinel').trim()).toBe('must survive');
    } finally {
      psql(admin!, `DROP DATABASE IF EXISTS ${database}`);
      psql(admin!, `DROP ROLE ${reader}; DROP ROLE ${owner};`);
    }
  });

  it('replaces the target with an exact copy and reports matching manifests', () => {
    const psql = (url: string, sql: string) => execFileSync(`${bin}/psql`, [url, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], { encoding: 'utf8' });
    const suffix = Date.now();
    const sourceDb = `hv_src_${suffix}`;
    const targetDb = `hv_dst_${suffix}`;
    const owner = `hv_copy_owner_${suffix}`;
    psql(admin!, `CREATE ROLE ${owner} LOGIN`);
    psql(admin!, `CREATE DATABASE ${sourceDb} OWNER ${owner}`);
    psql(admin!, `CREATE DATABASE ${targetDb} OWNER ${owner}`);
    const url = (db: string) => { const value = new URL(admin!.replace(/\/[^/?]*(\?|$)/, `/${db}$1`)); value.username = owner; value.password = ''; return value.toString(); };
    try {
      psql(url(sourceDb), `CREATE TABLE invoices (id serial PRIMARY KEY, total numeric); INSERT INTO invoices (total) SELECT g FROM generate_series(1, 250) g;
        CREATE SCHEMA billing; CREATE TABLE billing."Customers" (id int); INSERT INTO billing."Customers" VALUES (1), (2);`);
      // Stale rehearsal data in the target must be replaced, not merged.
      psql(url(targetDb), 'CREATE TABLE stale (id int); INSERT INTO stale VALUES (1);');
      const output = execFileSync('bash', ['-c', isolatedScript(databaseTransferScript())], {
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
      psql(admin!, `DROP ROLE ${owner}`);
    }
  });
});

describe('private-network export and restore scripts (live PostgreSQL)', () => {
  it('preserves the configured effective owner when replacing the target', () => {
    const psql = (url: string, sql: string) => execFileSync(`${bin}/psql`, [url, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
    const suffix = Date.now(), sourceDb = `hv_owner_src_${suffix}`, targetDb = `hv_owner_dst_${suffix}`;
    const owner = `hv_app_owner_${suffix}`, login = `hv_app_login_${suffix}`;
    const directory = mkdtempSync(path.join(tmpdir(), 'hv-owner-restore-'));
    const url = (db: string) => admin!.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
    psql(admin!, `CREATE ROLE ${owner}; CREATE ROLE ${login} LOGIN IN ROLE ${owner}; ALTER ROLE ${login} SET role = '${owner}';`);
    psql(admin!, `CREATE DATABASE ${sourceDb}`);
    // Engine bootstrap gives app_owner the database as well as public.
    psql(admin!, `CREATE DATABASE ${targetDb} OWNER ${owner}`);
    const target = new URL(url(targetDb)); target.username = login; target.password = '';
    try {
      psql(url(sourceDb), "CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('copied');");
      psql(url(targetDb), `ALTER SCHEMA public OWNER TO ${owner};`);
      psql(target.toString(), 'CREATE TABLE stale(id int);');
      const dump = path.join(directory, 'dump');
      execFileSync(`${bin}/pg_dump`, ['--format=custom', '--no-owner', '--no-privileges', '-f', dump, url(sourceDb)]);
      const restored = spawnSync('bash', ['-c', databaseRestoreScript().replaceAll('/tmp/', directory + '/')], { encoding: 'utf8', env: {
        PATH: `${bin}:/usr/bin:/bin`, DATABASE_URL: target.toString(), DUMP_URL: new URL('file://' + dump).toString(),
        SOURCE_DATABASE_IDENTITY: psql(url(sourceDb), POSTGRES_DATABASE_IDENTITY_SQL).trim(),
      } });
      expect(restored.status, restored.stdout + restored.stderr + (restored.status ? readFileSync(path.join(directory, 'identity-guard.log'), 'utf8') : '')).toBe(0);
      expect(psql(target.toString(), 'SELECT value FROM sentinel').trim()).toBe('copied');
      expect(psql(target.toString(), "SELECT to_regclass('public.stale') IS NULL").trim()).toBe('t');
      expect(psql(target.toString(), "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'").trim()).toBe(owner);
    } finally {
      psql(admin!, `DROP DATABASE IF EXISTS ${sourceDb}`);
      psql(admin!, `DROP DATABASE IF EXISTS ${targetDb}`);
      psql(admin!, `DROP ROLE ${login}; DROP ROLE ${owner};`);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('export uploads a dump through a URL; restore replaces the target with matching counts', async () => {
    const http = await import('http');
    const { databaseExportScript, databaseRestoreScript, parseTransferResult } = await import('../migration-transfer-gcp.js');
    const { execFile } = await import('child_process');
    const run = (script: string, env: Record<string, string>) => new Promise<string>((resolve, reject) =>
      execFile('bash', ['-c', isolatedScript(script)], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, maxBuffer: 1 << 24 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
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
    const owner = `hv_export_owner_${suffix}`;
    const url = (db: string) => { const value = new URL(admin!.replace(/\/[^/?]*(\?|$)/, `/${db}$1`)); value.username = owner; value.password = ''; return value.toString(); };
    psql(admin!, `CREATE ROLE ${owner} LOGIN`);
    psql(admin!, `CREATE DATABASE hv_esrc_${suffix} OWNER ${owner}`);
    psql(admin!, `CREATE DATABASE hv_edst_${suffix} OWNER ${owner}`);
    try {
      psql(url(`hv_esrc_${suffix}`), 'CREATE TABLE "Invoices" (id serial PRIMARY KEY, total numeric); INSERT INTO "Invoices" (total) SELECT g FROM generate_series(1, 42) g;');
      psql(url(`hv_edst_${suffix}`), 'CREATE TABLE stale (id int);');
      const exported = parseTransferResult(await run(databaseExportScript(), { SOURCE_DATABASE_URL: url(`hv_esrc_${suffix}`), UPLOAD_URL: `${base}/upload` })) as any;
      expect(exported).toMatchObject({ ok: true, source: { tables: { 'public.Invoices': expect.stringMatching(/^42:\d+$/) }, totalRows: '42' } });
      expect(stored?.length).toBeGreaterThan(0);
      const rejected = spawnSync('bash', ['-c', isolatedScript(databaseRestoreScript())], { encoding: 'utf8', env: {
        PATH: `${bin}:/usr/bin:/bin`, DATABASE_URL: url(`hv_esrc_${suffix}`),
        DUMP_URL: `${base}/dump`, SOURCE_DATABASE_IDENTITY: exported.sourceIdentity,
      } });
      expect(rejected.status).not.toBe(0);
      expect(parseTransferResult(rejected.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('same database') });
      expect(psql(url(`hv_esrc_${suffix}`), 'SELECT count(*) FROM "Invoices"').trim()).toBe('42');
      const restored = parseTransferResult(await run(databaseRestoreScript(), { DATABASE_URL: url(`hv_edst_${suffix}`), DUMP_URL: `${base}/dump`, SOURCE_DATABASE_IDENTITY: exported.sourceIdentity })) as any;
      expect(restored).toMatchObject({ ok: true, target: { tables: { 'public.Invoices': expect.stringMatching(/^42:\d+$/) } } });
      expect(manifestsMatch(exported.source, restored.target)).toEqual({ match: true, differences: [] });
      expect(psql(url(`hv_edst_${suffix}`), "SELECT count(*) FROM information_schema.tables WHERE table_name = 'stale'").trim()).toBe('0');
    } finally {
      server.close();
      psql(admin!, `DROP DATABASE IF EXISTS hv_esrc_${suffix}`);
      psql(admin!, `DROP DATABASE IF EXISTS hv_edst_${suffix}`);
      psql(admin!, `DROP ROLE ${owner}`);
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
