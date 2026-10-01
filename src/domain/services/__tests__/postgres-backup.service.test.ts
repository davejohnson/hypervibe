import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StorageObjectClient } from '../../ports/storage.port.js';
import { backupAndVerifyPostgres } from '../postgres-backup.service.js';

const execute = promisify(execFile);
const source = {
  provider: 'railway', primaryExternalId: 'database-service',
  providerScope: { projectId: 'project', environmentId: 'staging' },
  resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'volume-instance' },
};

// These tests exercise real pg_dump, pg_restore and a fresh local PostgreSQL.
// Hosted Ubuntu runners already supply PostgreSQL; absence fails CI rather than
// silently skipping the restore boundary or downloading an unpinned toolchain.
async function toolEnvironment(): Promise<NodeJS.ProcessEnv> {
  try { await execute('initdb', ['--version']); return process.env; } catch { /* find runner install */ }
  const versions = (await readdir('/usr/lib/postgresql')).sort((a, b) => Number(b) - Number(a));
  return { ...process.env, PATH: `${join('/usr/lib/postgresql', versions[0], 'bin')}:${process.env.PATH}` };
}

function archiveStore(corrupt = false) {
  const objects = new Map<string, Buffer>();
  const client: StorageObjectClient = {
    list: async () => [...objects].map(([key, data]) => ({ key, size: data.length })),
    put: async (key, payload, options) => {
      if (options?.ifAbsent && objects.has(key)) throw new Error('object already exists');
      const chunks: Buffer[] = [];
      for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    get: async key => {
      const data = objects.get(key);
      if (!data) throw new Error('not found');
      const body = Buffer.from(data);
      if (corrupt && key.endsWith('.dump')) body[0] ^= 1;
      return { size: body.length, body: Readable.from([body]) };
    },
    destroy: () => undefined,
  };
  return { client, objects };
}

describe('retained PostgreSQL backup and isolated restore (real PostgreSQL)', () => {
  let directory: string;
  let client: Client;
  let sourceUrl: string;
  let originalPath: string | undefined;
  let sourceStarted = false;

  beforeAll(async () => {
    const env = await toolEnvironment();
    originalPath = process.env.PATH;
    process.env.PATH = env.PATH;
    directory = await mkdtemp(join(tmpdir(), 'hvb-source-'));
    await mkdir(join(directory, 'socket'));
    await execute('initdb', ['-D', join(directory, 'data'), '-U', 'source_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { env });
    await writeFile(join(directory, 'data', 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${join(directory, 'socket')}'\nunix_socket_permissions = 0700\n`);
    await execute('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-w', 'start'], { env });
    sourceStarted = true;
    client = new Client({ host: join(directory, 'socket'), database: 'postgres', user: 'source_admin' });
    await client.connect();
    await client.query('CREATE EXTENSION pgcrypto');
    sourceUrl = `postgresql://source_admin@${encodeURIComponent(join(directory, 'socket'))}/postgres`;
  }, 60_000);

  beforeEach(async () => {
    await client.query('DROP SCHEMA IF EXISTS backup_test CASCADE; CREATE SCHEMA backup_test');
    await client.query(`CREATE TYPE backup_test.condition AS ENUM ('new', 'used');
      CREATE TABLE backup_test.documents (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL, condition backup_test.condition NOT NULL);
      CREATE INDEX documents_title ON backup_test.documents(title);
      INSERT INTO backup_test.documents (title, condition) VALUES ('Retained document', 'new'), ('Second document', 'used')`);
  });

  afterAll(async () => {
    await client?.end();
    if (directory) {
      if (sourceStarted) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
      await rm(directory, { recursive: true, force: true });
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('restores retained bytes including rows, enum, index and identity schema before committing completion', async () => {
    const archive = archiveStore();
    const { evidence: result } = await backupAndVerifyPostgres({
      sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups',
      verificationQuery: `SELECT count(*) = 2
        AND bool_and(title IN ('Retained document', 'Second document'))
        AND to_regclass('backup_test.documents_title') IS NOT NULL
        AND pg_get_serial_sequence('backup_test.documents', 'id') IS NOT NULL AS ok
        FROM backup_test.documents WHERE condition IN ('new'::backup_test.condition, 'used'::backup_test.condition)`,
    });
    expect(result).toMatchObject({
      mechanism: 'postgres-logical-archive', source, restoreVerified: true,
      cleanupVerified: true, tableCount: 1, totalRows: '2', applied: 1, skipped: 0,
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBeGreaterThan(100);
    expect(Date.parse(result.dataTime)).toBeLessThanOrEqual(Date.parse(result.completedAt));
    const manifest = JSON.parse(archive.objects.get(result.manifestKey)!.toString());
    expect(manifest).toMatchObject({ ...result, formatVersion: 1 });
    expect(archive.objects.size).toBe(2);
    expect(JSON.stringify(result)).not.toContain(sourceUrl);
    expect((await client.query('SELECT count(*)::text AS count FROM backup_test.documents')).rows).toEqual([{ count: '2' }]);
  }, 60_000);

  it('verifies the frozen dump even when the source changes after its snapshot', async () => {
    const archive = archiveStore();
    const put = archive.client.put;
    archive.client.put = async (...args) => {
      await put(...args);
      if (args[0].endsWith('.dump')) await client.query("INSERT INTO backup_test.documents (title, condition) VALUES ('Later write', 'new')");
    };
    const { evidence: result } = await backupAndVerifyPostgres({ sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups' });
    expect(result.totalRows).toBe('2');
    expect((await client.query('SELECT count(*)::text AS count FROM backup_test.documents')).rows).toEqual([{ count: '3' }]);
  }, 60_000);

  it('does not certify a corrupt stored copy even if the upload succeeded', async () => {
    const archive = archiveStore(true);
    await expect(backupAndVerifyPostgres({ sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups' })).rejects.toThrow('archive-readback');
    expect([...archive.objects.keys()].some(key => key.endsWith('.json'))).toBe(false);
  }, 60_000);

  it('does not commit completion after a late restore verification failure', async () => {
    const archive = archiveStore();
    await expect(backupAndVerifyPostgres({
      sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups', verificationQuery: 'SELECT false AS ok',
    })).rejects.toThrow('restore-verification');
    expect([...archive.objects.keys()].some(key => key.endsWith('.json'))).toBe(false);
    expect((await client.query('SELECT count(*)::text AS count FROM backup_test.documents')).rows).toEqual([{ count: '2' }]);
  }, 60_000);

  it('enforces readonly verification and never leaks SQL, data or database credentials in errors', async () => {
    const archive = archiveStore();
    await expect(backupAndVerifyPostgres({
      sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups',
      verificationQuery: "INSERT INTO backup_test.documents (title, condition) VALUES ('secret-document-value', 'new') RETURNING true AS ok",
    })).rejects.toThrow(/^PostgreSQL backup failed \(restore-verification\)\.$/);
    expect([...archive.objects.keys()].some(key => key.endsWith('.json'))).toBe(false);
  }, 60_000);

  it('rejects foreign servers before producing a claimed complete database backup', async () => {
    await client.query('CREATE FOREIGN DATA WRAPPER hv_test_fdw; CREATE SERVER hv_test_server FOREIGN DATA WRAPPER hv_test_fdw');
    const archive = archiveStore();
    try {
      await expect(backupAndVerifyPostgres({ sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups' })).rejects.toThrow('source-preflight');
      expect(archive.objects.size).toBe(0);
    } finally {
      await client.query('DROP SERVER hv_test_server; DROP FOREIGN DATA WRAPPER hv_test_fdw');
    }
  }, 60_000);

  it('extracts file keys from the restored snapshot into private evidence only', async () => {
    const archive = archiveStore();
    const result = await backupAndVerifyPostgres({
      sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(),
      archive: archive.client, archivePrefix: 'test/backups',
      fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT title AS key FROM backup_test.documents' }],
    });
    expect(result.fileReferences).toEqual([{ storageName: 'documents', keys: ['Retained document', 'Second document'] }]);
    expect(JSON.stringify(result.evidence)).not.toContain('Retained document');
    expect(JSON.parse(archive.objects.get(result.evidence.manifestKey)!.toString()).fileReferences).toEqual(result.fileReferences);
  }, 60_000);

  it('rejects malformed file projections and leaves no complete manifest', async () => {
    const archive = archiveStore();
    await expect(backupAndVerifyPostgres({
      sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } }, runId: randomUUID(),
      archive: archive.client, archivePrefix: 'test/backups',
      fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT title AS key, id FROM backup_test.documents' }],
    })).rejects.toThrow('restore-verification');
    expect([...archive.objects.keys()].some(key => key.endsWith('.json'))).toBe(false);
  }, 60_000);

  it('does not overwrite a reserved run on retry', async () => {
    const archive = archiveStore();
    const input = { sourceUrl, source, destination: { provider: 's3', externalId: 'backup-bucket', instanceScope: { region: 'us-east-1' } },
      runId: randomUUID(), archive: archive.client, archivePrefix: 'test/backups' };
    const first = await backupAndVerifyPostgres(input);
    const retained = Buffer.from(archive.objects.get(first.evidence.archiveKey)!);
    await expect(backupAndVerifyPostgres(input)).rejects.toThrow('archive-upload');
    expect(archive.objects.size).toBe(2);
    expect(archive.objects.get(first.evidence.archiveKey)).toEqual(retained);
  }, 60_000);
});
