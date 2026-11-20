import { createHash } from 'node:crypto';
import { z } from 'zod';
import { migrationVersionSourceSchema, type MigrationVersionSource } from '../../../domain/plan/migration-version.contract.js';

/** Fixed catalog aggregate. Only the selected private database's settings and statistics are read. */
export const migrationInventorySql = "SELECT pg_catalog.json_build_object('versionNumber', pg_catalog.current_setting('server_version_num')::integer, 'tables', count(*)::integer, 'estimatedRows', coalesce(sum(n_live_tup), 0)::text) FROM pg_catalog.pg_stat_user_tables";

export function versionProgram(source: MigrationVersionSource, nonce: string): string {
  migrationVersionSourceSchema.parse(source);
  z.string().regex(/^[a-f0-9]{32}$/).parse(nonce);
  return [
    'set -eu',
    'export PATH=/usr/local/bin:/usr/bin:/bin',
    `[ "$RAILWAY_PROJECT_ID" = '${source.projectId}' ]`,
    `[ "$RAILWAY_ENVIRONMENT_ID" = '${source.environmentId}' ]`,
    `[ "$RAILWAY_SERVICE_ID" = '${source.serviceId}' ]`,
    `[ "$RAILWAY_DEPLOYMENT_ID" = '${source.deploymentId}' ]`,
    '[ -n "$RAILWAY_REPLICA_ID" ]',
    // libpq also accepts a connection string in --dbname. Permit a plain name only.
    'db=${POSTGRES_DB:-${POSTGRES_USER:-postgres}}',
    'case "$db" in ""|*[!A-Za-z0-9_-]*) exit 1 ;; esac',
    '[ "${PGDATABASE:-$db}" = "$db" ]',
    // Match the issuer's private URL inside the database container without passing it to psql.
    'case "$RAILWAY_PRIVATE_DOMAIN" in *[!A-Za-z0-9.-]*|"") exit 1 ;; *.railway.internal) ;; *) exit 1 ;; esac',
    'case "$DATABASE_URL" in postgres://*|postgresql://*) uri=${DATABASE_URL#*://} ;; *) exit 1 ;; esac',
    'authority=${uri%%/*}',
    '[ "$uri" = "$authority/$db" ]',
    'case "$authority" in *"?"*|*"#"*) exit 1 ;; ?*:?*@?*) ;; *) exit 1 ;; esac',
    'case "${authority#*@}" in "$RAILWAY_PRIVATE_DOMAIN:5432"|"$RAILWAY_PRIVATE_DOMAIN") ;; *) exit 1 ;; esac',
    `v=$(env -i PATH="$PATH" LC_ALL=C PGPASSFILE=/dev/null PGCONNECT_TIMEOUT=5 PGOPTIONS="-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=5000" psql -XAtqw --host=/var/run/postgresql --port=5432 --dbname="$db" --username="\${POSTGRES_USER:-postgres}" --command="${migrationInventorySql}" </dev/null) || exit 1`,
    `printf '{"nonce":"${nonce}","inventory":%s}\\n' "$v"`,
  ].join('\n') + '\n';
}

/** Freeze the command and stdin program. Only the random per-connection challenge changes at execution. */
export function railwayInspectionProgramHash(source: MigrationVersionSource): string {
  return createHash('sha256').update('/bin/sh -s\n' + versionProgram(source, '0'.repeat(32))).digest('hex');
}
