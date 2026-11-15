import crypto from 'crypto';
import { POSTGRES_DATABASE_IDENTITY_PATTERN, POSTGRES_DATABASE_IDENTITY_SQL } from '../domain/services/postgres-database-identity.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { observeSecret, secretManagerFetch, writeSecretVersion } from './infrastructure-engine.js';

/**
 * Data transfer that runs inside the target cloud, next to the target data.
 *
 * A temporary Cloud Run job does the copy, so nothing depends on the user's
 * machine, its installed PostgreSQL tools or its internet connection. The job
 * runs as the app's runtime identity (which already reaches the target
 * database and bucket). Source credentials travel through a short-lived
 * Secret Manager secret that is deleted with the job. The job prints one
 * result line with counts only; data and credentials never leave the cloud.
 */
export interface TransferContext {
  token: () => Promise<string>;
  gcpProjectId: string;
  region: string;
  runtimeServiceAccountEmail: string;
  environmentLabel: string;
}

export interface DatabaseManifest {
  tables: Record<string, string>;
  totalRows: string;
  version: string;
}

export interface DatabaseTransferResult {
  ok: boolean;
  source?: DatabaseManifest;
  target?: DatabaseManifest;
  restoreWarnings?: number;
  error?: string;
}

export interface StorageTransferResult {
  ok: boolean;
  source?: { count: number; bytes: number };
  target?: { count: number; bytes: number };
  differences?: number;
  error?: string;
}

const RESULT_MARKER = 'HV_TRANSFER_RESULT ';

/**
 * One row per table, "schema.table|rows:checksum", from a single psql query.
 * The checksum sums a hash of every row's text, so it is independent of row
 * order and needs constant memory on large tables. Run with PGTZ=UTC so
 * timestamps render the same on both sides.
 */
const MANIFEST_SQL = `SELECT table_schema || '.' || table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) || '':'' || coalesce(sum((''x'' || substr(md5(t::text), 1, 15))::bit(60)::bigint::numeric), 0) AS c FROM %I.%I t', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' ORDER BY 1`;

const MANIFEST_FUNCTIONS = [
  // A failed read must fail the task, never report an empty manifest.
  'set -o pipefail',
  `manifest() { PGTZ=UTC psql "$1" -At -v ON_ERROR_STOP=1 -c "${MANIFEST_SQL.replace(/"/g, '\\"')}"; }`,
  'json_manifest() { awk -F"|" \'BEGIN{printf "{"} NR>1{printf ","} {printf "\\"%s\\":\\"%s\\"", $1, $2; total+=$2} END{printf "}|%d", total}\'; }',
];

/**
 * Verify-only database manifest (no copy): reports the manifest of
 * $SOURCE_DATABASE_URL and/or $DATABASE_URL, whichever this task can reach.
 */
export function databaseManifestScript(): string {
  return [
    'set -eu',
    ...MANIFEST_FUNCTIONS,
    'emit() { M=$(manifest "$2" | json_manifest); printf \'"%s":{"tables":%s,"totalRows":"%s"}\' "$1" "${M%|*}" "${M##*|}"; }',
    'OUT=""',
    'if [ -n "${SOURCE_DATABASE_URL:-}" ]; then OUT=$(emit source "$SOURCE_DATABASE_URL"); fi',
    'if [ -n "${DATABASE_URL:-}" ]; then T=$(emit target "$DATABASE_URL"); OUT="${OUT:+$OUT,}$T"; fi',
    `printf '${RESULT_MARKER}{"ok":true,%s}\\n' "$OUT"`,
  ].join('\n');
}

/** Verify-only file check (no copy): compares every object, by hash where both stores provide one. */
export function storageCheckScript(): string {
  return [
    'set -eu',
    'set +e',
    'rclone check "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --one-way 2> /tmp/check.log',
    'set -e',
    'DIFFS=$(grep -cE "ERROR|not in" /tmp/check.log || true)',
    'S=$(rclone size --json "src:$SOURCE_BUCKET")',
    'T=$(rclone size --json "dst:$TARGET_BUCKET")',
    `printf '${RESULT_MARKER}{"ok":true,"source":%s,"target":%s,"differences":%s}\\n' "$S" "$T" "\${DIFFS:-0}"`,
  ].join('\n');
}

/**
 * V4 signed URL for one Cloud Storage object, signed locally with the
 * deployment identity's key. It grants exactly one method on one object and
 * expires; it carries no reusable credential.
 */
export function signedObjectUrl(params: { clientEmail: string; privateKey: string; bucket: string; object: string; method: 'PUT' | 'GET'; expiresSeconds: number; now?: Date }): string {
  const now = params.now ?? new Date();
  const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = datetime.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const path = `/${params.bucket}/${params.object.split('/').map(encode).join('/')}`;
  const query = Object.entries({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${params.clientEmail}/${scope}`,
    'X-Goog-Date': datetime,
    'X-Goog-Expires': String(params.expiresSeconds),
    'X-Goog-SignedHeaders': 'host',
  }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const canonical = [params.method, path, query, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', datetime, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(toSign).sign(params.privateKey, 'hex');
  return `https://storage.googleapis.com${path}?${query}&X-Goog-Signature=${signature}`;
}

/** Actual connection identity must be known and distinct before replacing data. */
const DATABASE_IDENTITY_FUNCTIONS = [
  'identity() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "' + POSTGRES_DATABASE_IDENTITY_SQL + '" 2>/dev/null; }',
  'valid_identity() { case "$1" in ""|*[!0-9a-f:]*) return 1 ;; esac; printf "%s" "$1" | LC_ALL=C grep -Eq "' + POSTGRES_DATABASE_IDENTITY_PATTERN + '"; }',
  'blocked() { printf \'' + RESULT_MARKER + '{"ok":false,"error":"%s"}\\n\' "$1"; exit 1; }',
];
const READ_SOURCE_IDENTITY = [
  'if ! SOURCE_IDENTITY=$(identity "$SOURCE_DATABASE_URL") || ! valid_identity "$SOURCE_IDENTITY"; then',
  '  blocked "The source database identity could not be verified; no data was replaced."',
  'fi',
];
const READ_TARGET_IDENTITY = [
  'if ! TARGET_IDENTITY=$(identity "$DATABASE_URL") || ! valid_identity "$TARGET_IDENTITY"; then',
  '  blocked "The target database identity could not be verified; no data was replaced."',
  'fi',
  'if [ "$SOURCE_IDENTITY" = "$TARGET_IDENTITY" ]; then',
  '  blocked "The source and target reach the same database; no data was replaced."',
  'fi',
];
/** Recheck on the connection that clears the target; errors roll back all writes. */
function guardedTargetReset(restorePublicOwner = false): string[] {
  return [
    'if ! psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v expected_identity="$TARGET_IDENTITY" -v source_identity="$SOURCE_IDENTITY" >/dev/null 2>/tmp/identity-guard.log <<\'HV_MIGRATION_IDENTITY\'',
    'BEGIN;',
    'SELECT 1 / CASE WHEN (' + POSTGRES_DATABASE_IDENTITY_SQL + ') = :\'expected_identity\' AND (' + POSTGRES_DATABASE_IDENTITY_SQL + ') <> :\'source_identity\' THEN 1 ELSE 0 END;',
    ...(restorePublicOwner ? [
      'SELECT pg_catalog.set_config(\'hypervibe.migration_owner\', CURRENT_USER, true);',
      'SET ROLE NONE;',
      'DO $hv$ BEGIN EXECUTE pg_catalog.format(\'ALTER SCHEMA public OWNER TO %I\', pg_catalog.current_setting(\'hypervibe.migration_owner\')); EXCEPTION WHEN OTHERS THEN NULL; END $hv$;',
      'SELECT pg_catalog.format(\'SET ROLE %I\', pg_catalog.current_setting(\'hypervibe.migration_owner\')) \\gexec',
    ] : []),
    'DROP OWNED BY CURRENT_USER CASCADE; CREATE SCHEMA IF NOT EXISTS public;',
    'COMMIT;',
    'HV_MIGRATION_IDENTITY',
    'then',
    '  blocked "The target database could not be safely prepared; its identity must remain verified and different from the source."',
    'fi',
  ];
}

/**
 * Export half of a private-network copy (runs inside the source provider,
 * next to its database): records the source manifest, dumps, and uploads the
 * dump through a single-object signed URL.
 */
export function databaseExportScript(): string {
  return [
    'set -eu',
    'apk add --no-cache curl >/dev/null 2>&1 || true',
    ...MANIFEST_FUNCTIONS,
    ...DATABASE_IDENTITY_FUNCTIONS,
    ...READ_SOURCE_IDENTITY,
    'VERSION=$(psql "$SOURCE_DATABASE_URL" -At -c "SHOW server_version_num")',
    'SRC=$(manifest "$SOURCE_DATABASE_URL" | json_manifest)',
    'pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" > /tmp/source.dump',
    'curl -sf -X PUT -H "Content-Type: application/octet-stream" --upload-file /tmp/source.dump "$UPLOAD_URL"',
    `printf '${RESULT_MARKER}{"ok":true,"sourceIdentity":"%s","source":{"tables":%s,"totalRows":"%s","version":"%s"},"bytes":%s}\\n' "$SOURCE_IDENTITY" "\${SRC%|*}" "\${SRC##*|}" "$VERSION" "$(wc -c < /tmp/source.dump)"`,
  ].join('\n');
}

/** Restore half (runs in the target cloud): downloads the dump, replaces the target schema, restores, reports the target manifest. */
export function databaseRestoreScript(): string {
  return [
    'set -eu',
    'apk add --no-cache curl >/dev/null 2>&1 || true',
    ...MANIFEST_FUNCTIONS,
    ...DATABASE_IDENTITY_FUNCTIONS,
    'SOURCE_IDENTITY="${SOURCE_DATABASE_IDENTITY:-}"',
    'if ! valid_identity "$SOURCE_IDENTITY"; then blocked "The exported source database identity is missing or invalid; no data was replaced."; fi',
    ...READ_TARGET_IDENTITY,
    'curl -sf -o /tmp/source.dump "$DUMP_URL"',
    ...guardedTargetReset(true),
    'set +e',
    'pg_restore --exit-on-error --no-owner --no-privileges -d "$DATABASE_URL" /tmp/source.dump 2> /tmp/restore.log',
    'RESTORE=$?',
    'WARNINGS=$(grep -c "error:" /tmp/restore.log || true)',
    'set -e',
    // PostgreSQL diagnostics may contain SQL and data; report only the exit code.
    'if [ "$RESTORE" -ne 0 ]; then',
    `  echo '${RESULT_MARKER}{"ok":false,"error":"The copy could not be written to the new database (pg_restore exit '"$RESTORE"')."}'`,
    '  exit 1',
    'fi',
    'DST=$(manifest "$DATABASE_URL" | json_manifest)',
    `printf '${RESULT_MARKER}{"ok":true,"target":{"tables":%s,"totalRows":"%s","version":"%s"},"restoreWarnings":%s}\\n' "\${DST%|*}" "\${DST##*|}" "$(psql "$DATABASE_URL" -At -c "SHOW server_version_num")" "\${WARNINGS:-0}"`,
  ].join('\n');
}

/** Parses the single result line a transfer task printed. */
export function parseTransferResult(text: string): Record<string, unknown> | undefined {
  const line = text.split('\n').find((entry) => entry.includes(RESULT_MARKER));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length)); } catch { return undefined; }
}

/**
 * Database copy script (runs in the official postgres image). The target is
 * the Hypervibe-created database; its contents are replaced, so the caller
 * must have that replacement approved.
 */
export function databaseTransferScript(): string {
  return [
    'set -eu',
    ...MANIFEST_FUNCTIONS,
    ...DATABASE_IDENTITY_FUNCTIONS,
    ...READ_SOURCE_IDENTITY,
    ...READ_TARGET_IDENTITY,
    'version() { psql "$1" -At -c "SHOW server_version_num"; }',
    'SRC_VERSION=$(version "$SOURCE_DATABASE_URL")',
    'SRC=$(manifest "$SOURCE_DATABASE_URL" | json_manifest)',
    // A failed source dump must not destroy even a distinct target.
    'if pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" > /tmp/source.dump 2>/tmp/dump.log; then :; else',
    '  DUMP=$?; blocked "The source database could not be read (pg_dump exit $DUMP); no data was replaced."',
    'fi',
    ...guardedTargetReset(),
    'set +e',
    // Matching table contents cannot prove that schema objects were restored.
    'pg_restore --exit-on-error --no-owner --no-privileges -d "$DATABASE_URL" /tmp/source.dump 2> /tmp/restore.log',
    'RESTORE=$?',
    'WARNINGS=$(grep -c "error:" /tmp/restore.log || true)',
    'set -e',
    'if [ "$RESTORE" -ne 0 ]; then',
    `  echo '${RESULT_MARKER}{"ok":false,"error":"The copy could not be written to the new database (pg_restore exit '"$RESTORE"')."}'`,
    '  exit 1',
    'fi',
    'DST_VERSION=$(version "$DATABASE_URL")',
    'DST=$(manifest "$DATABASE_URL" | json_manifest)',
    `printf '${RESULT_MARKER}{"ok":true,"source":{"tables":%s,"totalRows":"%s","version":"%s"},"target":{"tables":%s,"totalRows":"%s","version":"%s"},"restoreWarnings":%s}\\n' "\${SRC%|*}" "\${SRC##*|}" "$SRC_VERSION" "\${DST%|*}" "\${DST##*|}" "$DST_VERSION" "\${WARNINGS:-0}"`,
  ].join('\n');
}

/** File copy script (runs in the rclone image): sync, then an independent one-way check. */
export function storageTransferScript(): string {
  return [
    'set -eu',
    'rclone sync "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --transfers 16 --checkers 16 --s3-no-check-bucket --stats-one-line --stats 30s',
    'set +e',
    'rclone check "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --one-way 2> /tmp/check.log',
    'set -e',
    'DIFFS=$(grep -cE "ERROR|not in" /tmp/check.log || true)',
    'S=$(rclone size --json "src:$SOURCE_BUCKET")',
    'T=$(rclone size --json "dst:$TARGET_BUCKET")',
    `printf '${RESULT_MARKER}{"ok":true,"source":%s,"target":%s,"differences":%s}\\n' "$S" "$T" "\${DIFFS:-0}"`,
  ].join('\n');
}

async function google(context: TransferContext, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: { Authorization: `Bearer ${await context.token()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

interface TransferJob {
  purpose: 'database' | 'storage';
  image: string;
  script: string;
  env: Record<string, string>;
  /** env name -> value, stored in one temporary secret per value. */
  sourceSecrets: Record<string, string>;
  /** env name -> existing secret reference (for example the target DATABASE_URL). */
  secretRefs?: Record<string, { secretId: string; version: string }>;
  cloudSqlConnectionName?: string;
  timeoutSeconds: number;
}

/** Runs one transfer job to completion and returns its parsed result line. */
export async function runTransferJob<T extends { ok: boolean; error?: string }>(context: TransferContext, job: TransferJob): Promise<T> {
  const id = `hv-migrate-${job.purpose}-${crypto.randomBytes(3).toString('hex')}`;
  const base = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/jobs`;
  const temporarySecrets: string[] = [];
  try {
    const secretEnv: Array<Record<string, unknown>> = [];
    for (const [name, value] of Object.entries(job.sourceSecrets)) {
      const secretId = `${id}-${name.toLowerCase().replace(/_/g, '-')}`;
      const failure = await writeSecretVersion(await context.token(), context.gcpProjectId, secretId,
        { 'managed-by': 'hypervibe', 'hv-environment': context.environmentLabel, 'hv-temporary': 'true' }, value);
      temporarySecrets.push(secretId);
      if (failure) throw new Error(failure.message);
      secretEnv.push({ name, valueSource: { secretKeyRef: { secret: secretId, version: 'latest' } } });
    }
    for (const [name, ref] of Object.entries(job.secretRefs ?? {})) {
      secretEnv.push({ name, valueSource: { secretKeyRef: { secret: ref.secretId, version: ref.version } } });
    }
    const container: Record<string, unknown> = {
      image: job.image,
      command: ['/bin/sh'],
      args: ['-c', job.script],
      env: [...Object.entries(job.env).map(([name, value]) => ({ name, value })), ...secretEnv],
      resources: { limits: { cpu: '2', memory: '4Gi' } },
      ...(job.cloudSqlConnectionName ? { volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }] } : {}),
    };
    const created = await google(context, `${base}?jobId=${id}`, {
      method: 'POST',
      body: JSON.stringify({
        labels: { 'managed-by': 'hypervibe', 'hv-temporary': 'true' },
        template: { template: {
          serviceAccount: context.runtimeServiceAccountEmail,
          maxRetries: 0,
          timeout: `${job.timeoutSeconds}s`,
          containers: [container],
          ...(job.cloudSqlConnectionName ? { volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [job.cloudSqlConnectionName] } }] } : {}),
        } },
      }),
    });
    if (!created.ok) throw new Error(`Creating the ${job.purpose} copy job failed (HTTP ${created.status}).`);
    await waitOperation(context, await created.json() as { name?: string; done?: boolean });
    const started = await google(context, `${base}/${id}:run`, { method: 'POST', body: '{}' });
    if (!started.ok) throw new Error(`Starting the ${job.purpose} copy failed (HTTP ${started.status}).`);
    const operation = await waitOperation(context, await started.json() as { name?: string; done?: boolean }, job.timeoutSeconds + 300);
    const executionName = (operation.response as { name?: string } | undefined)?.name ?? (operation.metadata as { name?: string } | undefined)?.name;
    const result = await readResultLine(context, id, executionName);
    if (result) return result as T;
    return { ok: false, error: `The ${job.purpose} copy finished without a result. Check hv_logs for job ${id}.` } as T;
  } finally {
    await google(context, `${base}/${id}`, { method: 'DELETE' }).catch(() => undefined);
    for (const secretId of temporarySecrets) {
      await secretManagerFetch(await context.token(), `https://secretmanager.googleapis.com/v1/projects/${context.gcpProjectId}/secrets/${secretId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}

async function waitOperation(context: TransferContext, operation: { name?: string; done?: boolean; response?: unknown; metadata?: unknown; error?: { message?: string } }, timeoutSeconds = 300): Promise<{ response?: unknown; metadata?: unknown }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let current = operation;
  while (!current.done && current.name && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await google(context, `https://run.googleapis.com/v2/${current.name}`);
    if (polled.ok) current = await polled.json() as typeof current;
  }
  if (!current.done) throw new Error('A copy job did not finish in time.');
  if (current.error) throw new Error(`A copy job failed: ${current.error.message ?? 'unknown error'}`);
  return current;
}

/** Reads the single result line the job printed; logs can lag the execution by a few seconds. */
async function readResultLine(context: TransferContext, jobName: string, executionName?: string): Promise<Record<string, unknown> | undefined> {
  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${jobName}"`,
    ...(executionName ? [`labels."run.googleapis.com/execution_name"="${executionName.split('/').pop()}"`] : []),
    `textPayload:"${RESULT_MARKER.trim()}"`,
  ].join(' AND ');
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await google(context, 'https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: JSON.stringify({ resourceNames: [`projects/${context.gcpProjectId}`], filter, orderBy: 'timestamp desc', pageSize: 5 }),
    });
    if (response.ok) {
      const entries = (await response.json() as { entries?: Array<{ textPayload?: string }> }).entries ?? [];
      const line = entries.map((entry) => entry.textPayload ?? '').find((text) => text.includes(RESULT_MARKER));
      if (line) {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length)); } catch { return undefined; }
        const errors = await google(context, 'https://logging.googleapis.com/v2/entries:list', {
          method: 'POST',
          body: JSON.stringify({ resourceNames: [`projects/${context.gcpProjectId}`], filter: filter.replace(`textPayload:"${RESULT_MARKER.trim()}"`, 'textPayload:"HV_RESTORE_ERROR"'), pageSize: 5 }),
        }).then((response) => response.ok ? response.json() as Promise<{ entries?: Array<{ textPayload?: string }> }> : { entries: [] }).catch(() => ({ entries: [] }));
        const sample = (errors.entries ?? []).map((entry) => (entry.textPayload ?? '').replace('HV_RESTORE_ERROR ', '').replace(/postgres(ql)?:\/\/\S+/g, '<url>').slice(0, 200));
        return sample.length ? { ...parsed, restoreErrors: sample } : parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return undefined;
}

/** Same tables, same row counts. A row-count match is evidence, not a byte-for-byte proof. */
export function manifestsMatch(source: DatabaseManifest | undefined, target: DatabaseManifest | undefined): { match: boolean; differences: string[] } {
  if (!source || !target) return { match: false, differences: ['missing manifest'] };
  const differences: string[] = [];
  if (!Object.keys(source.tables).length) differences.push('the source reported no tables');
  for (const [table, rows] of Object.entries(source.tables)) {
    if (target.tables[table] !== rows) differences.push(`${table}: ${rows} → ${target.tables[table] ?? 'missing'}`);
  }
  for (const table of Object.keys(target.tables)) {
    if (!(table in source.tables)) differences.push(`${table}: only in the target`);
  }
  return { match: differences.length === 0, differences };
}

/** rclone remote for an S3-compatible source (Railway buckets, Amazon S3, and similar). */
export function s3SourceRemote(credentials: { endpoint: string; accessKeyId: string; secretAccessKey: string; region: string; urlStyle: string }): { env: Record<string, string>; secrets: Record<string, string> } {
  return {
    env: {
      RCLONE_CONFIG_SRC_TYPE: 's3', RCLONE_CONFIG_SRC_PROVIDER: 'Other', RCLONE_CONFIG_SRC_ENDPOINT: credentials.endpoint,
      RCLONE_CONFIG_SRC_REGION: credentials.region || 'auto',
      RCLONE_CONFIG_SRC_FORCE_PATH_STYLE: String(/path/i.test(credentials.urlStyle)),
      RCLONE_CONFIG_DST_TYPE: 'google cloud storage', RCLONE_CONFIG_DST_ENV_AUTH: 'true', RCLONE_CONFIG_DST_BUCKET_POLICY_ONLY: 'true',
    },
    secrets: { RCLONE_CONFIG_SRC_ACCESS_KEY_ID: credentials.accessKeyId, RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: credentials.secretAccessKey },
  };
}

export async function secretExists(context: TransferContext, secretId: string): Promise<boolean> {
  const observed = await observeSecret(await context.token(), context.gcpProjectId, secretId);
  return observed.state === 'present' && observed.value.hasEnabledVersion;
}
