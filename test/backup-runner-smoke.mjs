// Run inside the locally built helper image with --network none. This checks
// the packaged PostgreSQL tools and compiled runtime, not provider compatibility.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import pg from '/opt/hypervibe/node_modules/pg/lib/index.js';
import { createRecoverySet, recoverySetRoot } from '/opt/hypervibe/dist/domain/services/recovery-set.service.js';

const execute = promisify(execFile);
function store(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const properties = new Map();
  const revision = value => ({ etag: createHash('sha256').update(value).digest('hex') });
  const client = {
    async list(options) { return [...objects].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => ({ key, size: value.length, revision: revision(value) })); },
    async get(key, expected) {
      const value = objects.get(key); assert.ok(value, 'object absent');
      if (expected?.etag) assert.equal(expected.etag, revision(value).etag);
      return { ...properties.get(key), size: value.length, revision: revision(value), body: Readable.from([value]) };
    },
    async put(key, payload, options) {
      if (options?.ifAbsent) assert.equal(objects.has(key), false, 'immutable object already exists');
      const chunks = []; for await (const chunk of payload.body) chunks.push(Buffer.from(chunk));
      const value = Buffer.concat(chunks); assert.equal(value.length, payload.size);
      const { body, ...metadata } = payload; properties.set(key, metadata); objects.set(key, value);
    },
    destroy() {},
  };
  return { objects, client };
}

const directory = await mkdtemp(join(tmpdir(), 'hv-image-smoke-'));
let started = false, client;
try {
  const socket = join(directory, 'socket'); await mkdir(socket);
  await execute('initdb', ['-D', join(directory, 'data'), '-U', 'source_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale']);
  await writeFile(join(directory, 'data', 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\n`);
  await execute('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-w', 'start']); started = true;
  client = new pg.Client({ host: socket, database: 'postgres', user: 'source_admin' }); await client.connect();
  await client.query(`CREATE EXTENSION pgcrypto; CREATE TYPE condition AS ENUM ('new', 'used');
    CREATE TABLE documents (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, key text NOT NULL, condition condition NOT NULL);
    CREATE INDEX documents_key ON documents(key); INSERT INTO documents (key, condition) VALUES ('docs/one.pdf', 'new')`);
  const sourceUrl = `postgresql://source_admin@${encodeURIComponent(socket)}/postgres`;
  const identity = externalId => ({ provider: 's3', externalId, instanceScope: { region: 'local' } });
  const files = store({ 'docs/one.pdf': '%PDF-synthetic retained bytes' }), archive = store();
  const input = { runId: randomUUID(), project: 'smoke', environment: 'test', contractHash: 'a'.repeat(64),
    destination: identity('archive'), archive: archive.client,
    database: { sourceUrl, source: { provider: 'railway', primaryExternalId: 'synthetic-db', providerScope: { projectId: 'smoke', environmentId: 'test' }, resourceIdentity: {} },
      verificationQuery: "SELECT count(*) = 1 AND bool_and(condition = 'new'::condition) AND to_regclass('documents_key') IS NOT NULL AND pg_get_serial_sequence('documents', 'id') IS NOT NULL AS ok FROM documents" },
    fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT key FROM documents' }],
    objects: [{ name: 'documents', identity: identity('documents'), client: files.client }],
  };
  const result = await createRecoverySet(input);
  assert.equal(result.manifest.compatibility, 'references-verified');
  assert.equal(result.receipt.databaseCount, 1); assert.equal(result.receipt.objectCount, 1);
  assert.equal(result.receipt.restoreVerified, true); assert.equal(result.receipt.cleanupVerified, true);
  assert.equal([...archive.objects.keys()].at(-1), result.receipt.manifestKey);
  const sql = JSON.parse(archive.objects.get(result.manifest.database.manifestKey).toString());
  assert.equal(Math.floor(Number(sql.sourceVersion) / 10000), 16);
  assert.equal(Math.floor(Number(sql.targetVersion) / 10000), 16);
  assert.equal(sql.totalRows, '1'); assert.equal(JSON.stringify(result.receipt).includes('docs/one.pdf'), false);

  const failedRun = randomUUID(), lateArchive = store();
  await assert.rejects(createRecoverySet({ ...input, runId: failedRun, archive: lateArchive.client,
    database: { ...input.database, verificationQuery: 'SELECT false AS ok' } }), /restore-verification/);
  assert.equal(lateArchive.objects.has(`${recoverySetRoot('smoke', 'test')}${failedRun}/complete.json`), false);
  assert.equal((await client.query('SELECT count(*)::text AS count FROM documents')).rows[0].count, '1');
  process.stdout.write('Packaged PostgreSQL 16 schema, rows, retained files, isolated restores, and late-failure checks passed.\n');
} finally {
  await client?.end();
  if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
  await rm(directory, { recursive: true, force: true });
}
