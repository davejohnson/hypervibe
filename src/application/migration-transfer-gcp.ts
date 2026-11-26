import crypto from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROBE_IMAGE, probeCommand, probeEnvironment, parseAccessProbeFileEvidence, type AccessProbeFileEvidence, type AccessProbeJobInput } from '../adapters/providers/gcp/gcp-transfer-probe-workload.js';
export { parseAccessProbeFileEvidence, type AccessProbeFileEvidence, type AccessProbeJobInput } from '../adapters/providers/gcp/gcp-transfer-probe-workload.js';
import { POSTGRES_DATABASE_IDENTITY_PATTERN, POSTGRES_DATABASE_IDENTITY_SQL } from '../domain/services/postgres-database-identity.js';
import { addSecretVersion, createTemporarySecret, deleteSecret, readSecretContainer } from '../adapters/providers/gcp/gcp-secret-manager.client.js';
import { cloudRunJobRequest, readCloudRunOperation } from '../adapters/providers/gcp/gcp-cloud-run.client.js';
import { listLogEntries, readGcpProject } from '../adapters/providers/gcp/gcp-data.client.js';
import type { TransferResources } from '../adapters/providers/gcp/gcp-data.client.js';
export { signedObjectUrl, type TransferResources } from '../adapters/providers/gcp/gcp-data.client.js';
import { observeSecret } from './infrastructure-engine.js';

/**
 * Data transfer that runs inside the target cloud, next to the target data.
 *
 * A temporary Cloud Run job does the copy, so nothing depends on the user's
 * machine, its installed PostgreSQL tools or its internet connection. The job
 * runs as the app's runtime identity (which already reaches the target
 * database and bucket). Cloud Run receives Secret Manager references only.
 * The job emits transfer evidence and is removed after its execution.
 *
 * What the job needs of the source and must not be seen (a signed link to a
 * database export, a source database URL, a source bucket's access keys) is
 * held in one temporary secret per value, in the target project: written just
 * before the job, mounted by reference at one pinned version, and deleted with
 * the job. While it exists the target app's own identity can read it, as it
 * can every secret of the project. That is accepted (owner's decision,
 * 2026-11-26): one owner holds both sides of a migration. The isolated route
 * (a copy account of its own and a container the app is denied, #747) is not
 * used here.
 */
export interface TransferContext {
  token: () => Promise<string>;
  gcpProjectId: string;
  region: string;
  runtimeServiceAccountEmail: string;
  environmentLabel: string;
  recordTransferResources?: (resources: TransferResources | null) => void | Promise<void>;
}

type TransferScope = Pick<TransferContext, 'gcpProjectId' | 'region' | 'token'> & Partial<Pick<TransferContext, 'runtimeServiceAccountEmail' | 'recordTransferResources'>>;

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
  comparison?: 'download';
  source?: { count: number; bytes: number };
  target?: { count: number; bytes: number };
  differences?: number;
  error?: string;
}

export const RESULT_MARKER = 'HV_TRANSFER_RESULT ';

/**
 * The whole manifest as one JSON object, `{"tables":{"schema.table":"rows:checksum"},"totalRows":"n","version":"n"}`,
 * from a single psql query. The server writes the JSON and quotes each name the
 * way SQL does (`public."a|b"`), so no character in a name can be mistaken for
 * a separator and no two tables share a key. The checksum sums a hash of every
 * row's text, so it is independent of row order and needs constant memory on
 * large tables. A row is hashed as `ROW(alias.*)`: a bare alias would be read
 * as a column of that name where a table has one. Run with PGTZ=UTC so
 * timestamps render the same on both sides.
 */
const MANIFEST_SQL = `SELECT json_build_object('tables', coalesce(json_object_agg(m.k, m.c), '{}'::json), 'totalRows', coalesce(sum(split_part(m.c, ':', 1)::numeric), 0)::text, 'version', current_setting('server_version_num'))::text FROM (SELECT format('%I.%I', table_schema, table_name) AS k, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) || '':'' || coalesce(sum((''x'' || substr(md5(ROW(hv_migrate_row.*)::text), 1, 15))::bit(60)::bigint::numeric), 0) AS c FROM %I.%I hv_migrate_row', table_schema, table_name), false, true, '')))[1]::text AS c FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%') m`;

const MANIFEST_FUNCTIONS = [
  'set -o pipefail',
  // A failed read, or anything but the one object asked for, must fail the task, never report an empty manifest.
  `manifest() { M=$(PGTZ=UTC psql "$1" -At -v ON_ERROR_STOP=1 -c "${MANIFEST_SQL}") && case "$M" in '{"tables"'*'}') printf '%s' "$M" ;; *) return 1 ;; esac; }`,
];

/**
 * Verify-only database manifest (no copy): reports the manifest of
 * $SOURCE_DATABASE_URL and/or $DATABASE_URL, whichever this task can reach.
 */
export function databaseManifestScript(): string {
  return [
    'set -eu',
    ...MANIFEST_FUNCTIONS,
    'emit() { E=$(manifest "$2") && printf \'"%s":%s\' "$1" "$E"; }',
    'OUT=""',
    'if [ -n "${SOURCE_DATABASE_URL:-}" ]; then OUT=$(emit source "$SOURCE_DATABASE_URL"); fi',
    'if [ -n "${DATABASE_URL:-}" ]; then T=$(emit target "$DATABASE_URL"); OUT="${OUT:+$OUT,}$T"; fi',
    `printf '${RESULT_MARKER}{"ok":true,%s}\\n' "$OUT"`,
  ].join('\n');
}

/** rclone --download compares bytes even when the two stores have no common hash. */
export function storageCheckScript(): string {
  return [
    'set -eu',
    'reports=$(mktemp -d)',
    'trap \'rm -rf "$reports"\' EXIT',
    'differences=0',
    'if ! rclone check "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --download --differ "$reports/changed" --missing-on-src "$reports/extra" --missing-on-dst "$reports/missing" --error "$reports/errors" 2>"$reports/log"; then',
    // Only rclone's difference reports establish a mismatch. An interrupted or failed check is unknown.
    '  differences=$(cat "$reports/changed" "$reports/extra" "$reports/missing" | wc -l)',
    '  if [ -s "$reports/errors" ] || [ "$differences" -eq 0 ]; then',
    `    printf '${RESULT_MARKER}{"ok":false,"error":"The file comparison did not finish."}\\n'`,
    '    exit 0',
    '  fi',
    'fi',
    'S=$(rclone size --json "src:$SOURCE_BUCKET")',
    'T=$(rclone size --json "dst:$TARGET_BUCKET")',
    `printf '${RESULT_MARKER}{"ok":true,"comparison":"download","source":%s,"target":%s,"differences":%d}\\n' "$S" "$T" "$differences"`,
  ].join('\n');
}

/** Actual connection identity must be known and distinct before replacing data. */
export const DATABASE_IDENTITY_FUNCTIONS = [
  'identity() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "' + POSTGRES_DATABASE_IDENTITY_SQL + '" 2>/dev/null; }',
  'valid_identity() { case "$1" in ""|*[!0-9a-f:]*) return 1 ;; esac; printf "%s" "$1" | LC_ALL=C grep -Eq "' + POSTGRES_DATABASE_IDENTITY_PATTERN + '"; }',
  // A refusal still exits 0: the runner reads the result line only of a task that did not fail.
  'blocked() { printf \'' + RESULT_MARKER + '{"ok":false,"error":"%s"}\\n\' "$1"; exit 0; }',
];
export const READ_SOURCE_IDENTITY = [
  'if ! SOURCE_IDENTITY=$(identity "$SOURCE_DATABASE_URL") || ! valid_identity "$SOURCE_IDENTITY"; then',
  '  blocked "The source database identity could not be verified; no data was replaced."',
  'fi',
];
export const READ_TARGET_IDENTITY = [
  'if ! TARGET_IDENTITY=$(identity "$DATABASE_URL") || ! valid_identity "$TARGET_IDENTITY"; then',
  '  blocked "The target database identity could not be verified; no data was replaced."',
  'fi',
  'if [ "$SOURCE_IDENTITY" = "$TARGET_IDENTITY" ]; then',
  '  blocked "The source and target reach the same database; no data was replaced."',
  'fi',
];
/** Recheck on the connection that clears the target; errors roll back all writes. */
export function guardedTargetReset(restorePublicOwner = false): string[] {
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
    'SRC=$(manifest "$SOURCE_DATABASE_URL")',
    'pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" > /tmp/source.dump',
    'curl -sf -X PUT -H "Content-Type: application/octet-stream" --upload-file /tmp/source.dump "$UPLOAD_URL"',
    `printf '${RESULT_MARKER}{"ok":true,"sourceIdentity":"%s","source":%s,"bytes":%s}\\n' "$SOURCE_IDENTITY" "$SRC" "$(wc -c < /tmp/source.dump)"`,
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
    '  blocked "The copy could not be written to the new database (pg_restore exit $RESTORE). The new database had already been cleared and may hold part of the copy."',
    'fi',
    'DST=$(manifest "$DATABASE_URL")',
    `printf '${RESULT_MARKER}{"ok":true,"target":%s,"restoreWarnings":%s}\\n' "$DST" "\${WARNINGS:-0}"`,
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
    'SRC=$(manifest "$SOURCE_DATABASE_URL")',
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
    '  blocked "The copy could not be written to the new database (pg_restore exit $RESTORE). The new database had already been cleared and may hold part of the copy."',
    'fi',
    'DST=$(manifest "$DATABASE_URL")',
    `printf '${RESULT_MARKER}{"ok":true,"source":%s,"target":%s,"restoreWarnings":%s}\\n' "$SRC" "$DST" "\${WARNINGS:-0}"`,
  ].join('\n');
}

/** Replace every file, then independently compare both inventories and their bytes. */
export function storageTransferScript(): string {
  return [
    'set -eu',
    'rclone sync "src:$SOURCE_BUCKET" "dst:$TARGET_BUCKET" --ignore-times --transfers 16 --checkers 16 --s3-no-check-bucket --stats-one-line --stats 30s',
    storageCheckScript(),
  ].join('\n');
}

export interface TransferJob {
  purpose: 'database' | 'storage';
  image: string;
  script: string;
  env: Record<string, string>;
  /** env name -> private source value. Each travels in a temporary secret of its own and never in the job definition. */
  sourceSecrets: Record<string, string>;
  /** env name -> existing secret reference (for example the target DATABASE_URL). */
  secretRefs?: Record<string, { secretId: string; version: string }>;
  cloudSqlConnectionName?: string;
  /** A second database server the job reaches, mounted beside the first. Only a copy between two servers of one project sets it. */
  sourceCloudSqlConnectionName?: string;
  timeoutSeconds: number;
}

/** Said wherever a copy is put to the user for approval. */
export const TRANSFER_SECRET_NOTICE = 'While a copy job runs, the access it needs to the source is held in a temporary secret in the Google Cloud project, which the app there could read; Hypervibe deletes that secret when the job ends.';

const handoffSecretId = (jobId: string, name: string) => `${jobId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * Stores each private source value in a secret of its own and returns the references the job mounts.
 * The ids were journalled before this runs, so whatever it leaves behind is found and deleted.
 * No message here may carry a value.
 */
async function writeHandoffSecrets(context: TransferContext, resources: TransferResources, values: Record<string, string>, ttlSeconds: number): Promise<Array<Record<string, unknown>>> {
  const references: Array<Record<string, unknown>> = [];
  const labels = { 'managed-by': 'hypervibe', 'hv-temporary': 'true', 'hv-transfer': resources.ownershipToken! };
  for (const [name, value] of Object.entries(values)) {
    const secretId = handoffSecretId(resources.jobId, name);
    let version: string | undefined;
    try {
      const created = await createTemporarySecret(await context.token(), context.gcpProjectId, secretId, labels, ttlSeconds);
      if (!created.ok) throw new Error(`The temporary secret for the copy could not be created (HTTP ${created.status}).`);
      const added = await addSecretVersion(await context.token(), context.gcpProjectId, secretId, value);
      if (!added.ok) throw new Error(`The temporary secret for the copy could not be filled (HTTP ${added.status}).`);
      const stored = await added.json().catch(() => undefined) as { name?: unknown } | undefined;
      version = /\/versions\/([1-9][0-9]*)$/.exec(typeof stored?.name === 'string' ? stored.name : '')?.[1];
    } catch (error) {
      // A transport error is not repeated here: it may describe the request.
      throw new Error(error instanceof Error && error.message.startsWith('The temporary secret for the copy') ? error.message : 'The temporary secret for the copy could not be written.');
    }
    if (!version) throw new Error('The temporary secret for the copy could not be pinned to one version.');
    references.push({ name, valueSource: { secretKeyRef: { secret: secretId, version } } });
  }
  return references;
}

/** Deletes the journalled secrets that carry this transfer's own mark. One that does not is left alone and keeps the cleanup unfinished. */
async function removeHandoffSecrets(context: TransferScope, resources: TransferResources): Promise<boolean> {
  let gone = true;
  for (const id of resources.secretIds) {
    try {
      const seen = await readSecretContainer(await context.token(), context.gcpProjectId, id);
      if (seen.state === 'absent') continue;
      if (seen.state !== 'present' || !resources.ownershipToken || seen.value.labels['managed-by'] !== 'hypervibe'
          || seen.value.labels['hv-temporary'] !== 'true' || seen.value.labels['hv-transfer'] !== resources.ownershipToken) { gone = false; continue; }
      const deleted = await deleteSecret(await context.token(), context.gcpProjectId, id);
      if (!deleted.ok && deleted.status !== 404) gone = false;
    } catch { gone = false; }
  }
  return gone;
}

type TemporaryJob = TransferJob | (Omit<TransferJob, 'purpose' | 'script'> & { purpose: 'access' });
type JobResult = { ok: boolean; error?: string };
export type AccessProbeJobResult = JobResult & { fileEvidence?: AccessProbeFileEvidence; accessPassed?: true };
// Only the native job runner can attach an execution result to a cleanup failure.
const executionBeforeCleanup = Symbol('access probe execution before cleanup');
type RawProbeResult = JobResult & { check?: unknown; fileEvidence?: unknown; [executionBeforeCleanup]?: RawProbeResult };

/** Runs the existing copy workers with their existing execution contract. */
export function runTransferJob<T extends JobResult>(context: TransferContext, job: TransferJob): Promise<T> {
  return runTemporaryJob<T>(context, job);
}

/** Only the synthetic challenge and its scoped references can enter the probe job. */
export async function runAccessProbeJob(context: TransferContext, input: AccessProbeJobInput): Promise<AccessProbeJobResult> {
  try {
    const env = probeEnvironment(input, context.environmentLabel, context.gcpProjectId, context.runtimeServiceAccountEmail);
    if (!env || !context.recordTransferResources) return { ok: false, error: 'The test job scope or cleanup journal is incomplete.' };
    const job = await runTemporaryJob<RawProbeResult>(context, { purpose: 'access', image: PROBE_IMAGE, env, sourceSecrets: {}, timeoutSeconds: 90 });
    const result = job[executionBeforeCleanup] ?? job;
    const fileEvidence = input.role === 'copy' ? undefined : parseAccessProbeFileEvidence(result.fileEvidence);
    const passedFile = result.ok === true && fileEvidence?.outcome === 'denied' && Object.keys(result).length === 2;
    if (job[executionBeforeCleanup]) return {
      ok: false, error: 'Cleanup of the temporary test job could not be verified.',
      ...(fileEvidence ? { fileEvidence } : {}), ...(input.role === 'file-app' && passedFile ? { accessPassed: true } : {}),
    };
    if (result.ok === true) {
      if (input.role === 'copy' && Object.keys(result).length === 1) return { ok: true };
      if (passedFile) return { ok: true, fileEvidence };
    }
    const errors: Record<string, string> = {
      identity: 'The test workload could not confirm its attached service account, project and token.',
      'secret-denial': 'The app workload could not confirm denial of access to the test secret version.',
      'object-denial': fileEvidence?.outcome === 'readable'
        ? 'The app could directly read the test file generation.'
        : 'The app workload could not confirm denial of direct access to the test object generation.',
      'secret-read': 'The copy workload could not verify the challenge in the test secret version.',
      'signed-object': 'The copy workload could not verify the signed download of the test object generation.',
    };
    if (result.ok === false && typeof result.check === 'string' && Object.hasOwn(errors, result.check)) {
      return { ok: false, error: errors[result.check], ...(fileEvidence ? { fileEvidence } : {}) };
    }
  } catch { /* Provider errors and workload logs may contain private values. */ }
  return { ok: false, error: 'The temporary test job did not verify the requested access and cleanup.' };
}

/** Runs one owned job to completion and returns its parsed result line. */
async function runTemporaryJob<T extends JobResult>(context: TransferContext, job: TemporaryJob): Promise<T> {
  const id = `hv-migrate-${job.purpose}-${crypto.randomBytes(8).toString('hex')}`;
  const ownershipToken = crypto.randomUUID();
  const secretIds = Object.keys(job.sourceSecrets).map((name) => handoffSecretId(id, name));
  if (new Set(secretIds).size !== secretIds.length) return { ok: false, error: 'Two source values of this copy would share one temporary secret.' } as T;
  // Journalled before anything is written, so a secret this run leaves behind is always found again.
  if (secretIds.length && !context.recordTransferResources) return { ok: false, error: 'This copy has nowhere to record its temporary secret, so it was not started.' } as T;
  let resources: TransferResources = { gcpProjectId: context.gcpProjectId, region: context.region, jobId: id, secretIds, ownershipToken };
  if (job.purpose === 'access') resources.probe = { stage: 'before-run', serviceAccount: context.runtimeServiceAccountEmail };
  if (!await verifyTransferResourcesAbsent(context, resources)) {
    return { ok: false, error: 'The temporary transfer job name could not be confirmed unused in the target project and region.' } as T;
  }
  await context.recordTransferResources?.(resources);
  let outcome: T | undefined;
  let thrown: unknown;
  let executionMayBeRunning = false;
  let creationMayHaveStarted = false;
  try {
    const secretEnv: Array<Record<string, unknown>> = [];
    for (const [name, ref] of Object.entries(job.secretRefs ?? {})) {
      secretEnv.push({ name, valueSource: { secretKeyRef: { secret: ref.secretId, version: ref.version } } });
    }
    // Secret Manager deletes each of them by itself an hour after the job could last, should Hypervibe never return.
    secretEnv.push(...await writeHandoffSecrets(context, resources, job.sourceSecrets, job.timeoutSeconds + 3600));
    const container: Record<string, unknown> = {
      image: job.image,
      ...(job.purpose === 'access' ? probeCommand : { command: ['/bin/sh'], args: ['-c', job.script] }),
      env: [...Object.entries(job.env).map(([name, value]) => ({ name, value })), ...secretEnv],
      resources: { limits: job.purpose === 'access' ? { cpu: '1', memory: '512Mi' } : { cpu: '2', memory: '4Gi' } },
      ...(job.cloudSqlConnectionName ? { volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }] } : {}),
    };
    const createToken = await context.token();
    creationMayHaveStarted = true;
    const created = await cloudRunJobRequest(createToken, context, `?jobId=${id}`, {
      method: 'POST',
      body: JSON.stringify({
        labels: { 'managed-by': 'hypervibe', 'hv-temporary': 'true', 'hv-transfer': ownershipToken },
        template: { template: {
          serviceAccount: context.runtimeServiceAccountEmail,
          maxRetries: 0,
          timeout: `${job.timeoutSeconds}s`,
          containers: [container],
          ...(job.cloudSqlConnectionName ? { volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [job.cloudSqlConnectionName,
            ...(job.sourceCloudSqlConnectionName && job.sourceCloudSqlConnectionName !== job.cloudSqlConnectionName ? [job.sourceCloudSqlConnectionName] : [])] } }] } : {}),
        } },
      }),
    });
    if (!created.ok) {
      if ([400, 401, 403, 404, 412].includes(created.status)) creationMayHaveStarted = false;
      throw new Error(`Creating the ${job.purpose} copy job failed (HTTP ${created.status}).`);
    }
    const creation = await waitOperation(context, await created.json());
    if (creation.error) throw new Error('The transfer job could not be created.');
    const createdJob = creation.response as { name?: string; uid?: string } | undefined;
    if (typeof createdJob?.uid !== 'string' || !createdJob.uid || !await scopedCloudRunName(context, createdJob.name, new RegExp(`^jobs/${id}$`))) {
      throw new Error('The created transfer job could not be identified.');
    }
    resources = { ...resources, jobUid: createdJob.uid, ...(job.purpose === 'access' ? {} : { runRequested: false }) };
    await context.recordTransferResources?.(resources);
    const observedJob = await ownedJob(context, resources);
    if (!observedJob) throw new Error('The created job identity could not be verified.');
    if (job.purpose === 'access' && !observedProbeMatches(observedJob, container, context.runtimeServiceAccountEmail)) {
      throw new Error('The observed test job differs from the requested workload.');
    }
    const runToken = await context.token();
    if (resources.probe) {
      resources = { ...resources, probe: { ...resources.probe, stage: 'run-may-be-submitted', etag: observedJob.etag } };
      await context.recordTransferResources?.(resources);
    } else {
      // Recorded before the request, so a job found later with no run asked of it is known never to have started.
      resources = { ...resources, runRequested: true };
      await context.recordTransferResources?.(resources);
    }
    executionMayBeRunning = true;
    const started = await cloudRunJobRequest(runToken, context, `/${id}:run`, { method: 'POST', body: JSON.stringify({ etag: observedJob.etag }) });
    if (!started.ok) {
      if ([400, 401, 403, 404, 412].includes(started.status)) executionMayBeRunning = false;
      throw new Error(`Starting the ${job.purpose} copy failed (HTTP ${started.status}).`);
    }
    const operation = await waitOperation(context, await started.json(), job.timeoutSeconds + 300);
    const executionPath = new RegExp(`^jobs/${id}/executions/[a-z0-9][a-z0-9-]*$`);
    if (operation.error) {
      const status = operation.error as { code?: number };
      const metadata = operation.metadata as ExecutionInventoryEntry | undefined;
      // A terminal Google RPC error for the submitted operation ends the run.
      // A contradictory execution identity still prevents cleanup.
      if (typeof status.code === 'number' && Number.isInteger(status.code) && status.code > 0 && status.code <= 16
          && !metadata?.reconciling && (metadata?.runningCount ?? 0) === 0
          && (!metadata?.name || await scopedCloudRunName(context, metadata.name, executionPath))) {
        executionMayBeRunning = false;
      }
      throw new Error('The transfer execution failed.');
    }
    const execution = operation.response as ExecutionInventoryEntry | undefined;
    const executionName = execution?.name;
    if (!executionName || !executionCompleted(execution) || !await scopedCloudRunName(context, executionName, executionPath)) {
      throw new Error('A completed transfer execution could not be verified for this job.');
    }
    executionMayBeRunning = false;
    if (job.purpose === 'access' && (execution.succeededCount !== 1 || (execution.failedCount ?? 0) !== 0 || (execution.cancelledCount ?? 0) !== 0)) {
      throw new Error('The test job did not complete its single task successfully.');
    }
    const result = await readResultLine(context, id, executionName, job.purpose === 'access');
    outcome = result ? result as T : { ok: false, error: `The ${job.purpose} copy finished without a result. Check hv_logs for job ${id}.` } as T;
  } catch (error) {
    thrown = error ?? new Error('The copy failed.');
  }
  if (executionMayBeRunning) {
    return { ok: false, error: `Completion of transfer job ${id} in ${context.gcpProjectId}/${context.region} is unverified. Its job identity is retained for recovery.` } as T;
  }
  let removed: boolean;
  if (resources.probe?.stage === 'before-run') {
    removed = creationMayHaveStarted ? await recoverTerminalTransferResources(context, resources) : await verifyTransferResourcesAbsent(context, resources);
  } else {
    removed = await removeTransferLeftovers(context, resources);
  }
  if (removed) {
    try { await context.recordTransferResources?.(null); }
    catch (error) {
      if (job.purpose !== 'access') throw error;
      removed = false;
    }
  }
  if (!removed) {
    if (job.purpose === 'access' && outcome && 'fileEvidence' in outcome)
      return { ...outcome, ok: false, [executionBeforeCleanup]: outcome };
    return { ok: false, error: `Cleanup of transfer job ${id} in ${context.gcpProjectId}/${context.region} is unverified. Its recorded identity must be resolved before another copy.` } as T;
  }
  if (thrown) throw thrown;
  return outcome!;
}

function validTransferScope(context: TransferScope, resources: TransferResources): boolean {
  return !!resources && resources.gcpProjectId === context.gcpProjectId && resources.region === context.region
    && /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/.test(resources.gcpProjectId)
    && /^[a-z]+(?:-[a-z0-9]+)+$/.test(resources.region)
    && /^hv-migrate-(?:(?:database|storage)-(?:[a-f0-9]{6}|[a-f0-9]{16})|access-[a-f0-9]{16})$/.test(resources.jobId)
    && Array.isArray(resources.secretIds) && resources.secretIds.every(id => typeof id === 'string'
      && id.startsWith(`${resources.jobId}-`) && /^[a-z0-9][a-z0-9-]*$/.test(id.slice(resources.jobId.length + 1)));
}

/** Read-only recovery. An access failure, malformed receipt or existing resource cannot certify absence. */
export async function verifyTransferResourcesAbsent(context: TransferScope, resources: TransferResources): Promise<boolean> {
  if (!validTransferScope(context, resources)) return false;
  try {
    const job = await cloudRunJobRequest(await context.token(), context, `/${resources.jobId}`);
    if (job.status !== 404) return false;
    for (const id of resources.secretIds) {
      if ((await readSecretContainer(await context.token(), context.gcpProjectId, id)).state !== 'absent') return false;
    }
    return true;
  } catch { return false; }
}

/** Resource names can use either the project ID or its Google-assigned project number. */
async function scopedCloudRunName(context: TransferScope, name: unknown, resource: RegExp): Promise<boolean> {
  if (typeof name !== 'string') return false;
  const [, project, region, tail] = /^projects\/([^/]+)\/locations\/([^/]+)\/(.+)$/.exec(name) ?? [];
  if (!project || region !== context.region || !tail || !resource.test(tail)) return false;
  if (project === context.gcpProjectId) return true;
  if (!/^[0-9]+$/.test(project)) return false;
  const response = await readGcpProject(await context.token(), context.gcpProjectId);
  if (!response.ok) return false;
  const identity = await response.json() as { name?: string; projectId?: string };
  return identity.projectId === context.gcpProjectId && identity.name === `projects/${project}`;
}

interface NativeJob {
  name: string; uid: string; etag: string; labels?: Record<string, string>;
  template?: { taskCount?: number; parallelism?: number; template?: { serviceAccount?: string; containers?: Record<string, unknown>[]; volumes?: unknown[] } };
  executionCount?: number; latestCreatedExecution?: { name?: string }; reconciling?: boolean;
}

/** The etag on :run binds these observations to the revision that will execute. */
function observedProbeMatches(job: NativeJob, expected: Record<string, unknown>, email: string): boolean {
  const task = job.template?.template;
  const containers = task?.containers;
  if (task?.serviceAccount !== email || (job.template?.taskCount ?? 1) !== 1 || (job.template?.parallelism ?? 1) !== 1
      || task.volumes?.length || !Array.isArray(containers) || containers.length !== 1) return false;
  const [observed] = containers;
  return !!observed && observed.image === expected.image && (observed.volumeMounts == null || isDeepStrictEqual(observed.volumeMounts, [])) && !observed.workingDir
    && isDeepStrictEqual(observed.command, expected.command) && isDeepStrictEqual(observed.args, expected.args)
    && isDeepStrictEqual(observed.env, expected.env);
}

async function ownedJob(context: TransferScope, resources: TransferResources): Promise<NativeJob | undefined> {
  const observed = await cloudRunJobRequest(await context.token(), context, `/${resources.jobId}`);
  if (observed.status === 404) return undefined;
  if (!observed.ok) throw new Error('The temporary job identity could not be read.');
  const job = await observed.json() as NativeJob;
  if (!await scopedCloudRunName(context, job.name, new RegExp(`^jobs/${resources.jobId}$`))
      || typeof job.uid !== 'string' || !job.uid || (resources.jobUid !== undefined && job.uid !== resources.jobUid)
      || typeof job.etag !== 'string' || !job.etag || !resources.ownershipToken
      || (resources.probe && job.template?.template?.serviceAccount !== resources.probe.serviceAccount)
      || job.labels?.['managed-by'] !== 'hypervibe' || job.labels['hv-temporary'] !== 'true'
      || job.labels['hv-transfer'] !== resources.ownershipToken) throw new Error('The temporary job belongs to a different transfer.');
  return job;
}

/** jobs.delete cancels its executions and returns a long-running operation. Fence the delete to the observed revision. */
async function removeTransferLeftovers(context: TransferScope, resources: TransferResources, terminalJob?: NativeJob): Promise<boolean> {
  // Nothing is running that could still read them. Whether they are gone is part of every verdict below.
  await removeHandoffSecrets(context, resources);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 2000));
      const job = await ownedJob(context, resources);
      if (!job) return verifyTransferResourcesAbsent(context, resources);
      if (terminalJob && (job.etag !== terminalJob.etag || job.executionCount !== terminalJob.executionCount
          || job.latestCreatedExecution?.name !== terminalJob.latestCreatedExecution?.name || job.reconciling)) return false;
      const response = await cloudRunJobRequest(await context.token(), context, `/${resources.jobId}?etag=${encodeURIComponent(job.etag)}`, { method: 'DELETE' }).catch(() => undefined);
      if (response?.ok) {
        const deletion = await waitOperation(context, await response.json());
        if (deletion.error) return false;
        return verifyTransferResourcesAbsent(context, resources);
      }
      if (response?.status === 404) return verifyTransferResourcesAbsent(context, resources);
      if (response && response.status < 500 && ![409, 412, 429].includes(response.status)) return false;
      // A network failure can follow an accepted delete. Observe the precise
      // resource and test its revision again before any repeat request.
    }
    return verifyTransferResourcesAbsent(context, resources);
  } catch { return false; }
}

interface ExecutionInventoryEntry {
  name?: string; uid?: string; job?: string; completionTime?: string; runningCount?: number; reconciling?: boolean;
  succeededCount?: number; failedCount?: number; cancelledCount?: number;
}

function executionCompleted(execution: ExecutionInventoryEntry): boolean {
  return !execution.reconciling && (execution.runningCount ?? 0) === 0
    && typeof execution.completionTime === 'string' && Number.isFinite(Date.parse(execution.completionTime));
}

/** ProtoJSON omits empty repeated fields. Require an empty, single-page inventory including deleted executions. */
async function recoverUnsubmittedProbe(context: TransferScope, resources: TransferResources, job: NativeJob): Promise<boolean> {
  if (job.reconciling || (job.executionCount ?? 0) !== 0 || job.latestCreatedExecution != null
      || (resources.probe?.etag !== undefined && job.etag !== resources.probe.etag)) return false;
  const page = await cloudRunJobRequest(await context.token(), context, `/${resources.jobId}/executions?pageSize=1&showDeleted=true`);
  if (!page.ok) return false;
  const inventory = await page.json() as { executions?: unknown; nextPageToken?: unknown };
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)
      || Object.keys(inventory).some(key => !['executions', 'nextPageToken'].includes(key))
      || (inventory.executions !== undefined && !isDeepStrictEqual(inventory.executions, []))
      || (inventory.nextPageToken !== undefined && inventory.nextPageToken !== '')) return false;
  // A second interruption can follow a successful delete. Persist the recovered UID before removing its only native evidence.
  if (!resources.jobUid) {
    if (!resources.probe || !context.recordTransferResources) return false;
    resources = { ...resources, jobUid: job.uid, probe: { ...resources.probe, etag: job.etag } };
    await context.recordTransferResources(resources);
  }
  return removeTransferLeftovers(context, resources, job);
}

/** Explicit refresh only. Never terminate an unobserved or unfinished execution to recover a copy. */
export async function recoverTerminalTransferResources(context: TransferScope, resources: TransferResources): Promise<boolean> {
  if (!validTransferScope(context, resources) || !resources.ownershipToken) return false;
  const probe = resources.probe;
  if (resources.jobId.startsWith('hv-migrate-access-')) {
    if (!probe || !['before-run', 'run-may-be-submitted'].includes(probe.stage) || resources.secretIds.length
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(resources.ownershipToken)
        || !context.runtimeServiceAccountEmail || probe.serviceAccount !== context.runtimeServiceAccountEmail
        || !probe.serviceAccount.endsWith(`@${context.gcpProjectId}.iam.gserviceaccount.com`)
        || (probe.stage === 'run-may-be-submitted' && (!resources.jobUid || !probe.etag))) return false;
  } else if (probe) return false;
  try {
    const job = await ownedJob(context, resources);
    // A create can still arrive after its response was lost. Without a UID, a 404 does not settle that request for a test job.
    // A copy job that never appeared leaves only its temporary secrets, which are removed here.
    if (!job) return (!!resources.jobUid || !probe) && removeTransferLeftovers(context, resources);
    if (probe?.stage === 'before-run') return await recoverUnsubmittedProbe(context, resources, job);
    // The UID is recorded before the first :run request, and so is the intent to run. A copy job without either was created and never started.
    if (!resources.jobUid || resources.runRequested === false) return !job.reconciling && !job.executionCount && job.latestCreatedExecution == null && removeTransferLeftovers(context, resources, job);
    if (job.reconciling || !Number.isSafeInteger(job.executionCount) || !job.executionCount
        || !job.latestCreatedExecution?.name) return false;
    // Until at least one execution materializes a previously unacknowledged
    // :run could still be starting. A missing inventory is never terminal.
    const names = new Set<string>();
    const uids = new Set<string>();
    const tokens = new Set<string>();
    let token = '';
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ pageSize: '100', showDeleted: 'true' });
      if (token) query.set('pageToken', token);
      const response = await cloudRunJobRequest(await context.token(), context, `/${resources.jobId}/executions?${query}`);
      if (!response.ok) return false;
      const inventory = await response.json() as { executions?: ExecutionInventoryEntry[]; nextPageToken?: string };
      if (!Array.isArray(inventory.executions)) return false;
      for (const execution of inventory.executions) {
        const prefix = job.name + '/executions/';
        if (!execution.name?.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(execution.name.slice(prefix.length))
            || (execution.job !== job.name && execution.job !== resources.jobId) || !execution.uid
            || names.has(execution.name) || uids.has(execution.uid) || !executionCompleted(execution)) return false;
        names.add(execution.name);
        uids.add(execution.uid);
      }
      if (inventory.nextPageToken === undefined || inventory.nextPageToken === '') {
        const latest = job.latestCreatedExecution.name;
        if (names.size !== job.executionCount || !(names.has(latest) || names.has(job.name + '/executions/' + latest))) return false;
        return removeTransferLeftovers(context, resources, job);
      }
      if (typeof inventory.nextPageToken !== 'string' || tokens.has(inventory.nextPageToken)) return false;
      token = inventory.nextPageToken;
      tokens.add(token);
    }
    return false;
  } catch { return false; }
}

interface TransferOperation { name?: string; done?: boolean; response?: unknown; metadata?: unknown; error?: unknown }
async function waitOperation(context: TransferScope, value: unknown, timeoutSeconds = 300): Promise<TransferOperation> {
  const operation = value as TransferOperation | null;
  const name = operation?.name;
  if (!operation || !name || !await scopedCloudRunName(context, name, /^operations\/[a-zA-Z0-9_-]+$/)) throw new Error('The transfer operation scope could not be verified.');
  const deadline = Date.now() + timeoutSeconds * 1000;
  let current = operation;
  while (!current.done && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Only the read is retried. A transport interruption gives no evidence
    // that the submitted job has finished or that another run is needed.
    const polled = await readCloudRunOperation(await context.token(), name, AbortSignal.timeout(remaining)).catch(() => undefined);
    if (!polled || polled.status === 408 || polled.status === 429 || polled.status >= 500) continue;
    if (!polled.ok) throw new Error(`The transfer operation could not be observed (HTTP ${polled.status}).`);
    const next = await polled.json().catch(() => undefined) as TransferOperation | undefined;
    if (!next) continue;
    if (next.name !== name) throw new Error('The transfer operation identity changed.');
    current = next;
  }
  if (current.done !== true) throw new Error('Completion of the transfer operation could not be verified.');
  return current;
}

/** Reads the single result line the job printed; logs can lag the execution by a few seconds. */
async function readResultLine(context: TransferContext, jobName: string, executionName: string, probe: boolean): Promise<Record<string, unknown> | undefined> {
  const filter = [
    'resource.type="cloud_run_job"',
    ...(probe ? [`logName="projects/${context.gcpProjectId}/logs/run.googleapis.com%2Fstdout"`] : []),
    `resource.labels.job_name="${jobName}"`,
    `resource.labels.location="${context.region}"`,
    `labels."run.googleapis.com/execution_name"="${executionName.split('/').pop()}"`,
    `textPayload:"${RESULT_MARKER.trim()}"`,
  ].join(' AND ');
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await listLogEntries(await context.token(), { resourceNames: [`projects/${context.gcpProjectId}`], filter, orderBy: 'timestamp desc', pageSize: 5 }, probe ? context.gcpProjectId : undefined);
    if (response.ok) {
      const entries = (await response.json() as { entries?: Array<{ textPayload?: string }> }).entries ?? [];
      const line = entries.map((entry) => entry.textPayload ?? '').find((text) => text.includes(RESULT_MARKER));
      if (line) {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length)); } catch { return undefined; }
        if (probe) return line.startsWith(RESULT_MARKER) ? parsed : undefined;
        const errors = await listLogEntries(await context.token(), { resourceNames: [`projects/${context.gcpProjectId}`], filter: filter.replace(`textPayload:"${RESULT_MARKER.trim()}"`, 'textPayload:"HV_RESTORE_ERROR"'), pageSize: 5 }).then((response) => response.ok ? response.json() as Promise<{ entries?: Array<{ textPayload?: string }> }> : { entries: [] }).catch(() => ({ entries: [] }));
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
