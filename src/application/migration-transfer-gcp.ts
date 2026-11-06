import crypto from 'crypto';
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

/** One row per table, "schema.table|rows", from a single psql query. */
const MANIFEST_SQL = `SELECT table_schema || '.' || table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' ORDER BY 1`;

/**
 * Database copy script (runs in the official postgres image). The target is
 * the Hypervibe-created database; its contents are replaced, so the caller
 * must have that replacement approved.
 */
export function databaseTransferScript(): string {
  return [
    'set -eu',
    `manifest() { psql "$1" -At -v ON_ERROR_STOP=1 -c "${MANIFEST_SQL.replace(/"/g, '\\"')}"; }`,
    'version() { psql "$1" -At -c "SHOW server_version_num"; }',
    'json_manifest() { awk -F"|" \'BEGIN{printf "{"} NR>1{printf ","} {printf "\\"%s\\":\\"%s\\"", $1, $2; total+=$2} END{printf "}|%d", total}\'; }',
    'SRC_VERSION=$(version "$SOURCE_DATABASE_URL")',
    'SRC=$(manifest "$SOURCE_DATABASE_URL" | json_manifest)',
    // Replace the target schema; objects are recreated owned by the app's owner role.
    'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"',
    'set +e',
    'pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" > /tmp/source.dump',
    'DUMP=$?',
    // Without --exit-on-error: harmless ownership/comment errors must not abort the copy;
    // the manifest comparison below decides whether the data arrived.
    'pg_restore --no-owner --no-privileges -d "$DATABASE_URL" /tmp/source.dump 2> /tmp/restore.log',
    'RESTORE=$?',
    'WARNINGS=$(grep -c "error:" /tmp/restore.log || true)',
    'set -e',
    'if [ "$DUMP" -ne 0 ]; then',
    `  echo '${RESULT_MARKER}{"ok":false,"error":"The source database could not be read (pg_dump exit '"$DUMP"')."}'`,
    '  exit 1',
    'fi',
    'if [ "$RESTORE" -ne 0 ] && [ "${WARNINGS:-0}" -eq 0 ]; then',
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
    'rclone check "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --one-way --size-only 2> /tmp/check.log',
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
        try { return JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length)); } catch { return undefined; }
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
  for (const [table, rows] of Object.entries(source.tables)) {
    if (target.tables[table] !== rows) differences.push(`${table}: ${rows} → ${target.tables[table] ?? 'missing'}`);
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
