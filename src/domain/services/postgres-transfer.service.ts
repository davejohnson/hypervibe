import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { userInfo } from 'node:os';
import { Client } from 'pg';
import {
  assertDistinctPostgresDatabaseIdentities,
  POSTGRES_DATABASE_IDENTITY_SQL,
  PostgresDatabaseIdentityError,
} from './postgres-database-identity.js';

export interface PostgresTableCount {
  schema: string;
  table: string;
  rows: string;
}

export interface PostgresTransferManifest {
  sourceVersion: string;
  extensions: string[];
  tables: PostgresTableCount[];
  totalRows: string;
  dumpBytes: number;
}

export interface PostgresTransferResult {
  manifest: PostgresTransferManifest;
  targetVersion: string;
}

interface QueryResultLike<T = Record<string, unknown>> {
  rows: T[];
}

export interface SnapshotClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<QueryResultLike>;
}

export interface PostgresToolTransferInput {
  sourceUrl: string;
  targetUrl: string;
  snapshotId: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  targetEnvironment: NodeJS.ProcessEnv;
}

export interface TransferDependencies {
  createClient?: (connectionString: string) => SnapshotClient;
  spawn?: typeof spawn;
  runTools?: (input: PostgresToolTransferInput) => Promise<number>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function postgresProcessEnvironment(connectionUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(connectionUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Data migration requires a PostgreSQL connection URL.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) {
    throw new Error('PostgreSQL connection URL is missing a host or database name.');
  }
  const sslMode = parsed.searchParams.get('sslmode');
  const environment = { ...process.env };
  // These libpq-only settings can redirect tools without redirecting pg.Client.
  delete environment.PGHOSTADDR;
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  return {
    ...environment,
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGDATABASE: database,
    PGUSER: parsed.username ? decodeURIComponent(parsed.username) : environment.PGUSER || userInfo().username,
    PGPASSWORD: parsed.password ? decodeURIComponent(parsed.password) : environment.PGPASSWORD || '',
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
  };
}

function preparePostgresConnection(connectionUrl: string): { url: string; environment: NodeJS.ProcessEnv } {
  try {
    const parsed = new URL(connectionUrl);
    // node-postgres accepts query overrides that our CLI environment mapping
    // does not. Never probe one database and then restore into another.
    const sslModes = parsed.searchParams.getAll('sslmode');
    if ([...parsed.searchParams.keys()].some((key) => key !== 'sslmode')
      || sslModes.length > 1
      || sslModes.some((mode) => !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode))) {
      throw new Error('Unsupported PostgreSQL URL options.');
    }
    const environment = postgresProcessEnvironment(connectionUrl);
    // pg uses decodeURI for database names, whereas libpq's database argument
    // also recognizes connection strings. Reject names with different meanings.
    if (decodeURI(parsed.pathname) !== decodeURIComponent(parsed.pathname)
      || environment.PGDATABASE!.includes('=')
      || /^postgres(?:ql)?:\/\//i.test(environment.PGDATABASE!)) throw new Error('Ambiguous database name.');
    if (environment.PGSSLMODE && !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(environment.PGSSLMODE)) {
      throw new Error('Unsupported PostgreSQL SSL mode.');
    }
    parsed.port = environment.PGPORT!;
    parsed.username = encodeURIComponent(environment.PGUSER!);
    if (environment.PGPASSWORD) parsed.password = encodeURIComponent(environment.PGPASSWORD);
    if (environment.PGSSLMODE) parsed.searchParams.set('sslmode', environment.PGSSLMODE);
    return { url: parsed.toString(), environment };
  } catch {
    throw new PostgresDatabaseIdentityError('The connection URL cannot establish a consistent database identity. Use its host, port, database and login fields with only a supported sslmode option; no copy was started.');
  }
}

export function postgresMajorVersion(versionNumber: string): number | null {
  const parsed = Number.parseInt(versionNumber, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 10_000) : null;
}

export function postgresDumpArguments(snapshotId: string): string[] {
  return [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--snapshot=${snapshotId}`,
  ];
}

export async function databaseManifest(client: SnapshotClient): Promise<Omit<PostgresTransferManifest, 'dumpBytes'>> {
  const version = await client.query('SELECT current_setting(\'server_version_num\') AS version') as QueryResultLike<{ version: string }>;
  const extensions = await client.query('SELECT extname FROM pg_extension ORDER BY extname') as QueryResultLike<{ extname: string }>;
  const tables = await client.query(
    `SELECT schemaname AS schema, tablename AS table
       FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND schemaname NOT LIKE 'pg_toast%'
      ORDER BY schemaname, tablename`
  ) as QueryResultLike<{ schema: string; table: string }>;
  const counts: PostgresTableCount[] = [];
  let totalRows = 0n;
  for (const item of tables.rows) {
    const count = await client.query(
      `SELECT COUNT(*)::text AS rows FROM ${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`
    ) as QueryResultLike<{ rows: string }>;
    const rows = count.rows[0]?.rows ?? '0';
    totalRows += BigInt(rows);
    counts.push({ ...item, rows });
  }
  return {
    sourceVersion: version.rows[0]?.version ?? 'unknown',
    extensions: extensions.rows.map((item) => item.extname),
    tables: counts,
    totalRows: totalRows.toString(),
  };
}

function boundedStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
  let value = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    value = `${value}${chunk}`.slice(-8192);
  });
  return { text: () => value };
}

async function exitCode(child: ChildProcessWithoutNullStreams): Promise<number> {
  const [code] = await once(child, 'close') as [number | null];
  return code ?? 1;
}

export function postgresTableCountsMatch(source: PostgresTableCount[], target: PostgresTableCount[]): boolean {
  // Source and target collations may order names differently. Compare complete
  // identities and counts in one locale-independent order without changing the
  // existing manifest representation stored by migration callers.
  const ordered = (tables: PostgresTableCount[]) => tables.map(({ schema, table, rows }) => [schema, table, rows])
    .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0);
  return JSON.stringify(ordered(source)) === JSON.stringify(ordered(target));
}

async function runPostgresTools(
  input: PostgresToolTransferInput,
  spawnProcess: typeof spawn
): Promise<number> {
  const dump = spawnProcess('pg_dump', postgresDumpArguments(input.snapshotId), {
    env: input.sourceEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  const targetEnvironment = input.targetEnvironment;
  const restore = spawnProcess('pg_restore', [
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    `--dbname=${targetEnvironment.PGDATABASE}`,
  ], {
    env: targetEnvironment,
    stdio: ['pipe', 'ignore', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  const dumpError = boundedStderr(dump);
  const restoreError = boundedStderr(restore);
  let dumpBytes = 0;
  dump.stdout.on('data', (chunk: Buffer) => { dumpBytes += chunk.byteLength; });
  dump.stdout.pipe(restore.stdin);

  const [dumpCode, restoreCode] = await Promise.all([exitCode(dump), exitCode(restore)]);
  if (dumpCode !== 0 || restoreCode !== 0) {
    // Provider/pg diagnostics can contain hostnames and user names. Keep the
    // model-visible result generic while retaining only process exit codes.
    void dumpError.text();
    void restoreError.text();
    throw new Error(`PostgreSQL transfer failed (pg_dump=${dumpCode}, pg_restore=${restoreCode}).`);
  }
  return dumpBytes;
}

/**
 * Streams one consistent PostgreSQL snapshot directly into a fresh target.
 * Credentials are provided only through child-process environment variables,
 * never argv or returned receipts.
 */
export async function transferPostgresDatabase(
  sourceUrl: string,
  targetUrl: string,
  dependencies: TransferDependencies = {}
): Promise<PostgresTransferResult> {
  const sourceConnection = preparePostgresConnection(sourceUrl);
  const targetConnection = preparePostgresConnection(targetUrl);
  const createClient = dependencies.createClient ?? ((connectionString: string): SnapshotClient => {
    const client = new Client({ connectionString });
    return {
      connect: async () => { await client.connect(); },
      end: () => client.end(),
      query: async (sql: string) => {
        const result = await client.query(sql);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };
  });
  const spawnProcess = dependencies.spawn ?? spawn;
  const runTools = dependencies.runTools ?? ((input: PostgresToolTransferInput) => runPostgresTools(input, spawnProcess));
  let source: SnapshotClient | undefined;
  let target: SnapshotClient | undefined;
  let snapshotOpen = false;
  try {
    try {
      source = createClient(sourceConnection.url);
      target = createClient(targetConnection.url);
      await source.connect();
      await target.connect();
      const sourceIdentity = await source.query(POSTGRES_DATABASE_IDENTITY_SQL);
      const targetIdentity = await target.query(POSTGRES_DATABASE_IDENTITY_SQL);
      assertDistinctPostgresDatabaseIdentities(
        sourceIdentity.rows.length === 1 ? sourceIdentity.rows[0]?.identity : undefined,
        targetIdentity.rows.length === 1 ? targetIdentity.rows[0]?.identity : undefined,
      );
    } catch (error) {
      // Connection/query diagnostics may contain credentials. An unverified
      // identity must also stop callers from deleting this target as cleanup.
      throw error instanceof PostgresDatabaseIdentityError ? error : new PostgresDatabaseIdentityError();
    }
    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    snapshotOpen = true;
    const snapshot = await source.query('SELECT pg_export_snapshot() AS snapshot') as QueryResultLike<{ snapshot: string }>;
    const snapshotId = snapshot.rows[0]?.snapshot;
    if (!snapshotId) throw new Error('PostgreSQL did not return an exported snapshot.');
    const sourceManifest = await databaseManifest(source);

    const dumpBytes = await runTools({ sourceUrl: sourceConnection.url, targetUrl: targetConnection.url, snapshotId,
      sourceEnvironment: sourceConnection.environment, targetEnvironment: targetConnection.environment });
    await source.query('COMMIT');
    snapshotOpen = false;

    const targetManifest = await databaseManifest(target);
    const sourceMajor = postgresMajorVersion(sourceManifest.sourceVersion);
    const targetMajor = postgresMajorVersion(targetManifest.sourceVersion);
    if (sourceMajor && targetMajor && targetMajor < sourceMajor) {
      throw new Error(`PostgreSQL transfer verification failed: target major version ${targetMajor} is older than source ${sourceMajor}.`);
    }
    if (!postgresTableCountsMatch(sourceManifest.tables, targetManifest.tables)) {
      throw new Error('PostgreSQL transfer verification failed: target table row counts differ from the source snapshot.');
    }
    const missingExtensions = sourceManifest.extensions.filter((name) => !targetManifest.extensions.includes(name));
    if (missingExtensions.length > 0) {
      throw new Error(`PostgreSQL transfer verification failed: target is missing ${missingExtensions.length} required extension(s).`);
    }

    return {
      manifest: { ...sourceManifest, dumpBytes },
      targetVersion: targetManifest.sourceVersion,
    };
  } finally {
    if (snapshotOpen && source) await source.query('ROLLBACK').catch(() => undefined);
    await Promise.allSettled([source?.end(), target?.end()]);
  }
}
