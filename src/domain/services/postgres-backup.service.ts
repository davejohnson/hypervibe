import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import { z } from 'zod';
import type { RecoverySourceIdentity } from '../ports/recovery-source.port.js';
import type { StorageObjectClient, StorageObjectPayload } from '../ports/storage.port.js';
import { recoverySourceIdentitySchema } from './recovery-source.js';
import { normalizeStoredObjectRevision, objectRecoveryIdentitySchema, storedObjectRevisionMatches, storedObjectRevisionSchema,
  type ObjectRecoveryIdentity } from './object-recovery-set.service.js';
import { databaseManifest, postgresDumpArguments, postgresMajorVersion, postgresProcessEnvironment, postgresTableCountsMatch } from './postgres-transfer.service.js';
import { RecoveryDiagnosticError, recoveryFailure, type RecoveryDiagnostic } from '../ports/recovery-diagnostics.port.js';

export interface PostgresBackupInput {
  sourceUrl: string;
  source: RecoverySourceIdentity;
  destination: ObjectRecoveryIdentity;
  runId: string;
  archive: StorageObjectClient;
  archivePrefix: string;
  /** One statement returning exactly one boolean `ok`; verifies the restored
   * database only. It is not application or migration compatibility evidence. */
  verificationQuery?: string;
  /** Reviewed application projection; keys stay in the private manifest. */
  fileReferenceQueries?: Array<{ storageName: string; query: string }>;
}

export const POSTGRES_BACKUP_FORMAT_VERSION = 2;
// The private on-disk manifest also carries fileReferences. Parse its evidence
// through this same schema without returning those private keys as safe evidence.
export const postgresBackupEvidenceSchema = z.object({
  formatVersion: z.literal(POSTGRES_BACKUP_FORMAT_VERSION),
  mechanism: z.literal('postgres-logical-archive'),
  source: recoverySourceIdentitySchema,
  destination: objectRecoveryIdentitySchema,
  runId: z.string().uuid(),
  archiveKey: z.string().min(1),
  archiveRevision: storedObjectRevisionSchema,
  manifestKey: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().safe(),
  dataTime: z.string().datetime(),
  completedAt: z.string().datetime(),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  tableCount: z.number().int().nonnegative().safe(),
  totalRows: z.string().regex(/^\d+$/),
  restoreVerified: z.literal(true),
  cleanupVerified: z.literal(true),
  coverage: z.literal('single-database-schema-and-data'),
  applicationCompatibility: z.literal('unverified'),
  applied: z.literal(1),
  skipped: z.literal(0),
}).strip();
export type PostgresBackupEvidence = z.infer<typeof postgresBackupEvidenceSchema>;

export interface PostgresBackupResult {
  evidence: PostgresBackupEvidence;
  /** Sensitive object keys: never log or include in job receipts. This proves
   * reference extraction, not availability or DB/files transactional consistency. */
  fileReferences: Array<{ storageName: string; keys: string[] }>;
}

// Only extension code shipped with PostgreSQL and without remote execution is
// admitted. Additional extensions need an independently reviewed helper image.
const safeExtensions = new Set(['plpgsql', 'pgcrypto', 'uuid-ossp', 'citext', 'hstore', 'btree_gin', 'btree_gist', 'pg_trgm', 'unaccent']);
class LocalCleanupUnverified extends Error {
  constructor(readonly primaryFailure?: RecoveryDiagnosticError) { super(); }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
}

function databaseEnvironment(url: string): NodeJS.ProcessEnv {
  const source = postgresProcessEnvironment(url);
  return {
    ...cleanEnvironment(), PGHOST: source.PGHOST, PGPORT: source.PGPORT,
    PGDATABASE: source.PGDATABASE, PGUSER: source.PGUSER,
    PGPASSWORD: source.PGPASSWORD, PGSSLMODE: source.PGSSLMODE,
    PGCONNECT_TIMEOUT: '15', PGOPTIONS: '-c statement_timeout=900000 -c default_transaction_read_only=on',
  };
}

/** Never forward SQL, process output or provider errors: all may contain data
 * or credentials. No child command is passed through a shell. */
async function command(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('command timeout')); }, 15 * 60_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('command unavailable')); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('command failed')); });
  });
}

function bodyStream(body: StorageObjectPayload['body']): Readable {
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body instanceof Blob ? body.stream() : body as import('node:stream/web').ReadableStream);
}

async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

async function restoreLocal(archivePath: string, directory: string, sourceManifest: Awaited<ReturnType<typeof databaseManifest>>,
  verificationQuery?: string, fileReferenceQueries: PostgresBackupInput['fileReferenceQueries'] = []): Promise<{ targetVersion: string; fileReferences: PostgresBackupResult['fileReferences'] }> {
  const data = join(directory, 'database');
  const socket = join(directory, 'socket');
  await mkdir(socket, { mode: 0o700 });
  const env = cleanEnvironment();
  let started = false;
  let admin: Client | undefined;
  let target: Client | undefined;
  let targetVersion: string | undefined;
  const fileReferences: PostgresBackupResult['fileReferences'] = [];
  let stage: RecoveryDiagnostic['stage'] = 'database-restore';
  let failure: RecoveryDiagnosticError | undefined;
  try {
    await command('initdb', ['-D', data, '-U', 'hv_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], env);
    // A unique local cluster with no TCP listener is the only possible restore
    // target. Neither a caller-supplied target URL nor a production volume is accepted.
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    await appendFile(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = ${quote(socket)}\nunix_socket_permissions = 0700\nshared_preload_libraries = ''\nstatement_timeout = 900000\n`);
    // Mark before start so an ambiguous startup is still stopped during cleanup.
    started = true;
    await command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-t', '30', 'start'], env);
    admin = new Client({ host: socket, database: 'postgres', user: 'hv_admin', connectionTimeoutMillis: 15_000 });
    await admin.connect();
    await admin.query('CREATE ROLE hv_restore LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await admin.query('CREATE DATABASE hv_restore_test OWNER hv_restore TEMPLATE template0');
    await admin.end();
    admin = undefined;
    const restoreEnv = { ...env, PGHOST: socket, PGPORT: '5432', PGUSER: 'hv_restore', PGDATABASE: 'hv_restore_test', PGCONNECT_TIMEOUT: '15' };
    // Running the archive as a non-superuser prevents COPY PROGRAM, untrusted
    // language installation and reading helper credentials through server files.
    await command('pg_restore', ['--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', '--single-transaction', '--dbname=hv_restore_test', archivePath], restoreEnv);
    target = new Client({ host: socket, database: 'hv_restore_test', user: 'hv_restore', connectionTimeoutMillis: 15_000 });
    await target.connect();
    stage = 'database-verification';
    await target.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const restored = await databaseManifest(target);
    targetVersion = restored.sourceVersion;
    const sourceMajor = postgresMajorVersion(sourceManifest.sourceVersion);
    const targetMajor = postgresMajorVersion(restored.sourceVersion);
    if (!sourceMajor || !targetMajor || targetMajor < sourceMajor
      || !postgresTableCountsMatch(restored.tables, sourceManifest.tables)
      || JSON.stringify([...restored.extensions].sort()) !== JSON.stringify([...sourceManifest.extensions].sort())) throw new Error('restored manifest differs');
    if (verificationQuery) {
      // A named extended-protocol query permits one statement only; READ ONLY
      // rejects writes even if a SELECT invokes a function with side effects.
      const check = await target.query({ name: 'hv_backup_verification', text: verificationQuery, values: [] });
      if (check.rows.length !== 1 || check.rows[0]?.ok !== true) throw new Error('verification did not return true');
    }
    let keyBytes = 0;
    stage = 'reference-verification';
    for (const [index, projection] of fileReferenceQueries.entries()) {
      // Wrapping in a subquery plus the extended protocol bounds returned rows
      // and rejects multi-statement/control SQL before it can leave READ ONLY.
      const references = await target.query({ name: `hv_backup_file_references_${index}`,
        text: `SELECT * FROM (${projection.query}) AS hv_file_references LIMIT $1`, values: [100_001] });
      if (references.fields.length !== 1 || references.fields[0]?.name !== 'key' || references.rows.length > 100_000) throw new Error('invalid file reference projection');
      const keys = new Set<string>();
      for (const row of references.rows) {
        if (typeof row.key !== 'string' || !row.key || Buffer.byteLength(row.key) > 4096) throw new Error('invalid file key');
        keyBytes += Buffer.byteLength(row.key);
        if (keyBytes > 16 * 1024 * 1024) throw new Error('file references exceed limit');
        keys.add(row.key);
      }
      fileReferences.push({ storageName: projection.storageName, keys: [...keys].sort() });
    }
    await target.query('ROLLBACK');
  } catch (error) {
    failure = recoveryFailure(stage, 'execution', error);
    throw failure;
  } finally {
    await Promise.allSettled([admin?.end(), target?.end()]);
    if (started) {
      try { await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'], env); }
      catch { throw new LocalCleanupUnverified(failure); }
    }
  }
  if (!targetVersion) throw new Error('restore not completed');
  return { targetVersion, fileReferences };
}

/** One retained, byte-verified logical backup and an isolated restore of those
 * downloaded bytes. The caller owns durable run reservation, provider scope,
 * private routing, retention, and archive client shutdown. This function never
 * retries a write or claims native snapshot/PITR/application coverage. */
export async function backupAndVerifyPostgres(input: PostgresBackupInput): Promise<PostgresBackupResult> {
  const failureStages = { 'input-validation': 'worker-input', 'source-preflight': 'database-backup',
    'source-dump': 'database-backup', 'archive-upload': 'database-backup', 'archive-readback': 'database-backup',
    'restore-verification': 'database-restore', cleanup: 'restore-cleanup', 'archive-inventory': 'database-backup',
    'completion-manifest': 'recovery-completion' } as const;
  let stage: keyof typeof failureStages = 'input-validation';
  let directory: string | undefined;
  let sourceClient: Client | undefined;
  let snapshotOpen = false;
  try {
    const source = recoverySourceIdentitySchema.parse(input.source);
    const destination = objectRecoveryIdentitySchema.parse(input.destination);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.runId)
      || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(input.archivePrefix)) throw new Error('invalid archive identity');
    if ((input.fileReferenceQueries?.length ?? 0) > 32 || input.fileReferenceQueries?.some(item => !/^[a-zA-Z0-9_-]{1,96}$/.test(item.storageName)
      || !item.query.trim() || item.query.length > 32_768)
      || new Set(input.fileReferenceQueries?.map(item => item.storageName)).size !== (input.fileReferenceQueries?.length ?? 0)) throw new Error('invalid file reference queries');
    const archiveKey = `${input.archivePrefix}/${input.runId}/database.dump`;
    const manifestKey = `${input.archivePrefix}/${input.runId}/database.complete.json`;
    directory = await mkdtemp(join(tmpdir(), 'hvb-'));
    const dumpPath = join(directory, 'source.dump');
    const downloadedPath = join(directory, 'retained.dump');
    stage = 'source-preflight';
    sourceClient = new Client({ connectionString: input.sourceUrl, connectionTimeoutMillis: 15_000, statement_timeout: 900_000 });
    await sourceClient.connect();
    await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    snapshotOpen = true;
    const exported = await sourceClient.query<{ snapshot: string; data_time: Date }>('SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS data_time');
    const snapshotId = exported.rows[0]?.snapshot;
    const dataTime = exported.rows[0]?.data_time.toISOString();
    if (!snapshotId || !dataTime) throw new Error('missing snapshot');
    const manifest = await databaseManifest(sourceClient);
    const effects = await sourceClient.query<{ unsafe: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_foreign_server)
      OR EXISTS (SELECT 1 FROM pg_subscription) AS unsafe`);
    if (effects.rows[0]?.unsafe !== false || manifest.extensions.some(extension => !safeExtensions.has(extension))) throw new Error('unsupported database side effects');
    stage = 'source-dump';
    await command('pg_dump', [...postgresDumpArguments(snapshotId), `--file=${dumpPath}`, '--lock-wait-timeout=30000'], databaseEnvironment(input.sourceUrl));
    await sourceClient.query('COMMIT');
    snapshotOpen = false;
    await sourceClient.end();
    sourceClient = undefined;
    const bytes = (await stat(dumpPath)).size;
    const sha256 = await fileHash(dumpPath);
    stage = 'archive-upload';
    await input.archive.put(archiveKey, { body: createReadStream(dumpPath), size: bytes, contentType: 'application/octet-stream' }, { ifAbsent: true });
    stage = 'archive-readback';
    const stored = await input.archive.get(archiveKey);
    if (stored.size !== bytes) { bodyStream(stored.body).destroy(); throw new Error('archive size differs'); }
    const digest = createHash('sha256');
    let received = 0;
    await pipeline(bodyStream(stored.body), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > bytes) { callback(new Error('archive exceeded expected size')); return; }
        digest.update(chunk); callback(null, chunk);
      },
    }), createWriteStream(downloadedPath, { mode: 0o600, flags: 'wx' }));
    if (received !== bytes || digest.digest('hex') !== sha256) throw new Error('archive checksum differs');
    const archiveRevision = normalizeStoredObjectRevision(stored.revision);
    stage = 'restore-verification';
    const { targetVersion, fileReferences } = await restoreLocal(downloadedPath, directory, manifest, input.verificationQuery, input.fileReferenceQueries);
    stage = 'cleanup';
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
    // Prior restore evidence applies only to the retained revision whose bytes
    // we checked. Re-observe after the potentially long isolated restore.
    stage = 'archive-inventory';
    const retained = await input.archive.list({ prefix: archiveKey, maxObjects: 2 });
    if (retained.length !== 1 || retained[0].key !== archiveKey || retained[0].size !== bytes
      || !storedObjectRevisionMatches(archiveRevision, retained[0].revision)) throw new Error('retained archive changed');
    const evidence = postgresBackupEvidenceSchema.parse({
      formatVersion: POSTGRES_BACKUP_FORMAT_VERSION, mechanism: 'postgres-logical-archive', source, destination, runId: input.runId,
      archiveKey, archiveRevision, manifestKey, sha256, bytes, dataTime, completedAt: new Date().toISOString(),
      sourceVersion: manifest.sourceVersion, targetVersion, tableCount: manifest.tables.length, totalRows: manifest.totalRows,
      restoreVerified: true, cleanupVerified: true, coverage: 'single-database-schema-and-data',
      applicationCompatibility: 'unverified', applied: 1, skipped: 0,
    });
    stage = 'completion-manifest';
    const serialized = Buffer.from(JSON.stringify({ ...evidence, fileReferences }));
    await input.archive.put(manifestKey, { body: Readable.from([serialized]), size: serialized.length, contentType: 'application/json' }, { ifAbsent: true });
    const storedManifest = await input.archive.get(manifestKey);
    const check = createHash('sha256');
    let manifestBytes = 0;
    for await (const chunk of bodyStream(storedManifest.body)) {
      manifestBytes += chunk.length;
      if (manifestBytes > serialized.length) throw new Error('manifest exceeded expected size');
      check.update(chunk);
    }
    if (manifestBytes !== serialized.length || check.digest('hex') !== createHash('sha256').update(serialized).digest('hex')) throw new Error('completion manifest differs');
    return { evidence, fileReferences };
  } catch (error) {
    // Never remove the data directory of a server whose stop was uncertain.
    // The owning helper workload must be terminally deleted by its controller.
    if (error instanceof LocalCleanupUnverified) {
      directory = undefined; stage = 'cleanup'; error = error.primaryFailure ?? error;
    }
    const message = `PostgreSQL backup failed (${stage}).`;
    const failure = recoveryFailure(failureStages[stage], stage === 'cleanup' ? 'cleanup' : stage === 'input-validation' ? 'invalid-input' : 'execution',
      error, undefined, message);
    throw stage === 'cleanup'
      ? new RecoveryDiagnosticError({ ...failure.diagnostic, localCleanupFailed: true }, message) : failure;
  } finally {
    if (snapshotOpen) await sourceClient?.query('ROLLBACK').catch(() => undefined);
    await sourceClient?.end().catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
