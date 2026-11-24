import { DATABASE_IDENTITY_FUNCTIONS, READ_SOURCE_IDENTITY, READ_TARGET_IDENTITY, RESULT_MARKER, guardedTargetReset, type TransferJob } from './migration-transfer-gcp.js';

/**
 * The copy-and-verify job for moving one environment's database between two
 * servers of the same Google project (the app's shared server and a server of
 * its own, either way). It stands beside hv_migrate's copy script and changes
 * none of it.
 *
 * What it does differently, and why:
 * - Both databases are reached through secret references and their own
 *   sockets; no connection string is passed as a value.
 * - The target must be empty. It is cleared only when the caller says so
 *   (`MOVE_RESET_TARGET=1`, for a target the move itself made and no app ever
 *   wrote to), with hv_migrate's own guarded reset, and must be empty after.
 * - What is compared is read in the same snapshot the dump is taken in, so a
 *   copy made while the app is still writing (a rehearsal) verifies too.
 *   Sequences are the exception: PostgreSQL keeps them outside snapshots, so a
 *   rehearsal (`MOVE_REHEARSAL=1`) checks that every sequence arrived and
 *   leaves their values to the final copy, which is made with the app paused.
 * - The comparison is structured and complete: every table's rows, every
 *   sequence's value and whether it has been used, every large object's bytes,
 *   and the definition of every object. A database with no tables is fine.
 * - What cannot be carried over is refused before anything is touched:
 *   privileges granted or taken away (the copy does not carry privileges),
 *   objects owned by another role, and, on request, extensions.
 *
 * Nothing here decides when a move may run; that is the caller's.
 */
const WORK = '/tmp/hv-move';
const USER_SCHEMA = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;
/** Objects an extension brought are the extension's, not the app's. */
const notExtension = (catalog: string, oid: string) => `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_catalog.${catalog}'::regclass AND e.objid = ${oid} AND e.deptype = 'e')`;
const inSchema = (alias: string, column: string) => `JOIN pg_namespace n ON n.oid = ${alias}.${column}`;
const element = (name: string) => `(xpath('/row/${name}/text()', q.x))[1]::text`;

/** Session settings that make every value and definition print the same way on both servers. */
const PINNED = [
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;',
  'SET LOCAL search_path = pg_catalog;',
  'SET LOCAL timezone = \'UTC\';',
  'SET LOCAL datestyle = \'ISO\';',
  'SET LOCAL intervalstyle = \'postgres\';',
  'SET LOCAL bytea_output = \'hex\';',
  'SET LOCAL extra_float_digits = 1;',
];

/** Every definition as one JSON array per object. Names and text are JSON-encoded by the server, so no name can be mistaken for a separator. */
const DEFINITIONS = [
  `SELECT json_build_array('schema', n.nspname)::text FROM pg_namespace n WHERE ${USER_SCHEMA} AND ${notExtension('pg_namespace', 'n.oid')}`,
  `SELECT json_build_array('relation', n.nspname, c.relname, c.relkind::text, c.relpersistence::text, c.relrowsecurity, c.relforcerowsecurity, c.relispopulated, c.relispartition,
     pg_get_expr(c.relpartbound, c.oid), CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, c.reloptions::text, CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END,
     (SELECT string_agg(i.inhparent::regclass::text, ',' ORDER BY i.inhseqno) FROM pg_inherits i WHERE i.inhrelid = c.oid))::text
   FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
  `SELECT json_build_array('columns', n.nspname, c.relname, (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
       a.attidentity::text, a.attgenerated::text, CASE WHEN a.attcollation <> 0 THEN a.attcollation::regcollation::text END) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))::text
   FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
  `SELECT json_build_array('index', n.nspname, c.relname, pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisclustered, i.indisreplident)::text
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid ${inSchema('c', 'relnamespace')} WHERE ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
  `SELECT json_build_array('constraint', n.nspname, coalesce(r.relname, t.typname), o.conname, pg_get_constraintdef(o.oid, true), o.convalidated)::text
   FROM pg_constraint o ${inSchema('o', 'connamespace')} LEFT JOIN pg_class r ON r.oid = o.conrelid LEFT JOIN pg_type t ON t.oid = o.contypid WHERE ${USER_SCHEMA} AND ${notExtension('pg_constraint', 'o.oid')}`,
  `SELECT json_build_array('trigger', n.nspname, c.relname, g.tgname, pg_get_triggerdef(g.oid, true), g.tgenabled::text)::text
   FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid ${inSchema('c', 'relnamespace')} WHERE NOT g.tgisinternal AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
  `SELECT json_build_array('function', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind::text, CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END,
     (SELECT json_build_array(a.aggtransfn::text, a.aggfinalfn::text, a.agginitval, format_type(a.aggtranstype, NULL), a.aggkind::text) FROM pg_aggregate a WHERE a.aggfnoid = p.oid))::text
   FROM pg_proc p ${inSchema('p', 'pronamespace')} WHERE ${USER_SCHEMA} AND ${notExtension('pg_proc', 'p.oid')}`,
  `SELECT json_build_array('type', n.nspname, t.typname, t.typtype::text, CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END, t.typnotnull, t.typdefault,
     (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), (SELECT format_type(g.rngsubtype, NULL) FROM pg_range g WHERE g.rngtypid = t.oid))::text
   FROM pg_type t ${inSchema('t', 'typnamespace')} WHERE t.typtype IN ('e', 'd', 'r') AND ${USER_SCHEMA} AND ${notExtension('pg_type', 't.oid')}`,
  `SELECT json_build_array('policy', n.nspname, c.relname, o.polname, o.polpermissive, o.polcmd::text, (SELECT json_agg(m.rolname ORDER BY m.rolname) FROM pg_roles m WHERE m.oid = ANY (o.polroles)),
     pg_get_expr(o.polqual, o.polrelid), pg_get_expr(o.polwithcheck, o.polrelid))::text
   FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid ${inSchema('c', 'relnamespace')} WHERE ${USER_SCHEMA}`,
  `SELECT json_build_array('rule', n.nspname, c.relname, w.rulename, pg_get_ruledef(w.oid, true))::text
   FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class ${inSchema('c', 'relnamespace')} WHERE w.rulename <> '_RETURN' AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
  `SELECT json_build_array('extension', x.extname, x.extversion)::text FROM pg_extension x`,
  `SELECT json_build_array('sequence', n.nspname, c.relname, format_type(s.seqtypid, NULL), s.seqstart::text, s.seqincrement::text, s.seqmax::text, s.seqmin::text, s.seqcache::text, s.seqcycle,
     (SELECT d.refobjid::regclass::text || '.' || a.attname FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0 ORDER BY 1 LIMIT 1))::text
   FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid ${inSchema('c', 'relnamespace')} WHERE ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}`,
];

/**
 * Writes one side's inventory into four files plus a two-number summary.
 * The row checksum is hv_migrate's: a sum of a hash of every row's text, so it
 * needs constant memory and no ordering.
 */
function inventory(side: 'source' | 'target'): string[] {
  return [
    // One pass over every table: a line per table, then one last line with how many tables and rows there were.
    `\\o ${WORK}/${side}.counted`,
    `WITH counted AS MATERIALIZED (SELECT n.nspname AS s, c.relname AS t, c.relkind::text AS k, ${element('n')}::numeric AS n, ${element('s')} AS h
       FROM pg_class c ${inSchema('c', 'relnamespace')}
       CROSS JOIN LATERAL (SELECT query_to_xml(format('SELECT count(*) AS n, coalesce(sum((''x'' || substr(md5(t::text), 1, 15))::bit(60)::bigint::numeric), 0) AS s FROM ONLY %I.%I t', n.nspname, c.relname), false, true, '') AS x) q
       WHERE (c.relkind IN ('r', 'p') OR (c.relkind = 'm' AND c.relispopulated)) AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')})
     SELECT line FROM (SELECT 0 AS last, s, t, json_build_array(s, t, k, n::text, h)::text AS line FROM counted
       UNION ALL SELECT 1, '', '', count(*)::text || '|' || coalesce(sum(n), 0)::text FROM counted) x ORDER BY last, s COLLATE "C", t COLLATE "C";`,
    `\\o ${WORK}/${side}.sequences`,
    `SELECT json_build_array(n.nspname, c.relname, ${element('last_value')}, ${element('is_called')})::text FROM pg_class c ${inSchema('c', 'relnamespace')}
       CROSS JOIN LATERAL (SELECT query_to_xml(format('SELECT last_value, is_called FROM %I.%I', n.nspname, c.relname), false, true, '') AS x) q
       WHERE c.relkind = 'S' AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C";`,
    `\\o ${WORK}/${side}.sequencenames`,
    `SELECT json_build_array(n.nspname, c.relname)::text FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE c.relkind = 'S' AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C";`,
    `\\o ${WORK}/${side}.largeobjects`,
    'SELECT json_build_array(m.oid::text, md5(lo_get(m.oid)))::text FROM pg_largeobject_metadata m ORDER BY m.oid;',
    `\\o ${WORK}/${side}.definitions`,
    `SELECT d FROM (${DEFINITIONS.join('\n UNION ALL ')}) AS x(d) ORDER BY d COLLATE "C";`,
    '\\o',
  ];
}

/** `extensions|objects of another owner|privilege differences|unsupported objects`, counted on the source before anything is touched. */
const PRECHECK = `WITH me AS (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user), owned AS (
    SELECT c.relowner AS owner FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c') AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}
    UNION ALL SELECT p.proowner FROM pg_proc p ${inSchema('p', 'pronamespace')} WHERE ${USER_SCHEMA} AND ${notExtension('pg_proc', 'p.oid')}
    UNION ALL SELECT t.typowner FROM pg_type t ${inSchema('t', 'typnamespace')} WHERE t.typtype IN ('e', 'd', 'r') AND ${USER_SCHEMA} AND ${notExtension('pg_type', 't.oid')}
    UNION ALL SELECT n.nspowner FROM pg_namespace n WHERE ${USER_SCHEMA} AND ${notExtension('pg_namespace', 'n.oid')}
    UNION ALL SELECT m.lomowner FROM pg_largeobject_metadata m
  ), acls AS (
    SELECT false AS public_schema, c.relowner AS owner, c.relacl AS acl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner) AS def
      FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${USER_SCHEMA} AND ${notExtension('pg_class', 'c.oid')}
    UNION ALL SELECT false, c.relowner, a.attacl, NULL::aclitem[] FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid ${inSchema('c', 'relnamespace')} WHERE a.attacl IS NOT NULL AND ${USER_SCHEMA}
    UNION ALL SELECT false, p.proowner, p.proacl, acldefault('f', p.proowner) FROM pg_proc p ${inSchema('p', 'pronamespace')} WHERE ${USER_SCHEMA} AND ${notExtension('pg_proc', 'p.oid')}
    UNION ALL SELECT n.nspname = 'public', n.nspowner, n.nspacl, acldefault('n', n.nspowner) FROM pg_namespace n WHERE ${USER_SCHEMA} AND ${notExtension('pg_namespace', 'n.oid')}
    UNION ALL SELECT false, t.typowner, t.typacl, acldefault('T', t.typowner) FROM pg_type t ${inSchema('t', 'typnamespace')} WHERE t.typtype IN ('e', 'd', 'r') AND ${USER_SCHEMA} AND ${notExtension('pg_type', 't.oid')}
    UNION ALL SELECT false, m.lomowner, m.lomacl, acldefault('L', m.lomowner) FROM pg_largeobject_metadata m
    UNION ALL SELECT false, d.defaclrole, d.defaclacl, CASE WHEN d.defaclnamespace = 0 THEN acldefault(CASE WHEN d.defaclobjtype = 'S' THEN 's' ELSE d.defaclobjtype END, d.defaclrole) ELSE NULL::aclitem[] END FROM pg_default_acl d
  ) SELECT (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql')::text || '|' || (SELECT count(*) FROM owned, me WHERE owned.owner <> me.oid)::text || '|' ||
    (SELECT count(*) FROM acls a CROSS JOIN LATERAL (
        (SELECT x.grantee, x.privilege_type, x.is_grantable FROM aclexplode(coalesce(a.acl, a.def)) x EXCEPT SELECT y.grantee, y.privilege_type, y.is_grantable FROM aclexplode(a.def) y)
        UNION ALL (SELECT y.grantee, y.privilege_type, y.is_grantable FROM aclexplode(a.def) y EXCEPT SELECT x.grantee, x.privilege_type, x.is_grantable FROM aclexplode(coalesce(a.acl, a.def)) x)
      ) g WHERE g.grantee <> a.owner AND NOT (a.public_schema AND g.grantee = 0)
        AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = g.grantee AND r.rolname = ANY (string_to_array(:'ignored', ','))))::text || '|' ||
    ((SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_event_trigger v WHERE ${notExtension('pg_event_trigger', 'v.oid')}) + (SELECT count(*) FROM pg_foreign_server f WHERE ${notExtension('pg_foreign_server', 'f.oid')}))::text;`;

/** Anything at all in the target that a restore could collide with or that an app could have put there. */
const TARGET_CONTENTS = `SELECT ((SELECT count(*) FROM pg_namespace n WHERE ${USER_SCHEMA} AND n.nspname <> 'public') + (SELECT count(*) FROM pg_class c ${inSchema('c', 'relnamespace')} WHERE ${USER_SCHEMA})
  + (SELECT count(*) FROM pg_proc p ${inSchema('p', 'pronamespace')} WHERE ${USER_SCHEMA}) + (SELECT count(*) FROM pg_type t ${inSchema('t', 'typnamespace')} WHERE t.typtype IN ('e', 'd', 'r') AND ${USER_SCHEMA})
  + (SELECT count(*) FROM pg_largeobject_metadata) + (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'))::text;`;

/** Entries of the dump that every target already has, and that a plain owner role may not write again. */
const SKIPPED_ENTRIES = '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public|EXTENSION - plpgsql|COMMENT - EXTENSION plpgsql)( |$)';

const heredoc = (command: string, lines: string[]) => [`${command} <<'HV_MOVE_SQL'`, ...lines, 'HV_MOVE_SQL'];

export function databaseMoveCopyScript(): string {
  return [
    'set -eu',
    'set -o pipefail',
    ...DATABASE_IDENTITY_FUNCTIONS,
    // Every refusal says how far the job got and whether the target was written to, so the caller knows what a retry needs.
    'STAGE=check; CHANGED=false',
    `blocked() { printf '${RESULT_MARKER}{"ok":false,"stage":"%s","targetChanged":%s,"error":"%s"}\\n' "$STAGE" "$CHANGED" "$1"; exit 1; }`,
    'count() { case "$1" in ""|*[!0-9]*) return 1 ;; esac; }',
    `rm -rf ${WORK}; mkdir -p ${WORK}`,
    ...READ_SOURCE_IDENTITY,
    ...READ_TARGET_IDENTITY,
    'version() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "SHOW server_version_num"; }',
    'SRC_VERSION=$(version "$SOURCE_DATABASE_URL") && DST_VERSION=$(version "$DATABASE_URL") && count "$SRC_VERSION" && count "$DST_VERSION" || blocked "The PostgreSQL versions could not be read; nothing was changed."',
    // Definitions are compared as text, which is only the same text within one major version.
    'if [ "${SRC_VERSION%????}" != "${DST_VERSION%????}" ]; then blocked "The two databases run different PostgreSQL major versions; nothing was changed."; fi',

    // What the copy cannot carry is refused before the target is looked at.
    ...heredoc(`if ! FOUND=$(psql "$SOURCE_DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 -v ignored="\${MOVE_IGNORED_GRANTEES:-}" 2>${WORK}/precheck.log`, ['SET search_path = pg_catalog;', PRECHECK]),
    '); then blocked "The source database could not be inspected; nothing was changed."; fi',
    'EXTENSIONS=${FOUND%%|*}; REST=${FOUND#*|}; FOREIGN=${REST%%|*}; REST=${REST#*|}; GRANTS=${REST%%|*}; UNSUPPORTED=${REST#*|}',
    'count "$EXTENSIONS" && count "$FOREIGN" && count "$GRANTS" && count "$UNSUPPORTED" || blocked "The source database could not be inspected; nothing was changed."',
    'if [ "${MOVE_BLOCK_EXTENSIONS:-0}" = 1 ] && [ "$EXTENSIONS" -gt 0 ]; then blocked "The database uses $EXTENSIONS extension(s) that cannot be installed on the new server yet; nothing was changed."; fi',
    'if [ "$FOREIGN" -gt 0 ]; then blocked "The database holds $FOREIGN object(s) owned by a role other than the app\'s own; they cannot be carried over, so nothing was changed."; fi',
    'if [ "$GRANTS" -gt 0 ]; then blocked "The database has $GRANTS privilege(s) granted or taken away that the copy cannot carry over; nothing was changed."; fi',
    'if [ "$UNSUPPORTED" -gt 0 ]; then blocked "The database has $UNSUPPORTED publication(s), event trigger(s) or foreign server(s), which cannot be moved yet; nothing was changed."; fi',

    // The target must hold nothing. It is cleared only on request, and only while it is proven to be the target and not the source.
    ...heredoc('contents() { psql "$DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 2>/dev/null', ['SET search_path = pg_catalog;', TARGET_CONTENTS]),
    '}',
    'if ! EXISTING=$(contents) || ! count "$EXISTING"; then blocked "The new database could not be inspected; nothing was changed."; fi',
    'if [ "$EXISTING" -gt 0 ]; then',
    '  if [ "${MOVE_RESET_TARGET:-0}" != 1 ]; then blocked "The new database is not empty; nothing was changed."; fi',
    '  STAGE=reset',
    // hv_migrate's reset: one transaction that first proves this connection is the target and not the source.
    ...guardedTargetReset().map((line) => line.replace('blocked "The target database could not be safely prepared; its identity must remain verified and different from the source."',
      'blocked "The new database could not be cleared; its identity must remain verified and different from the source."')),
    '  CHANGED=true',
    '  if ! EXISTING=$(contents) || [ "$EXISTING" != 0 ]; then blocked "The new database still holds something after it was cleared."; fi',
    'fi',

    // One snapshot for the dump and for what the copy is compared against: a session holds it open while both are taken.
    'STAGE=dump',
    `mkfifo ${WORK}/hold`,
    `psql "$SOURCE_DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 < ${WORK}/hold > /dev/null 2> ${WORK}/hold.log &`,
    'HOLD=$!',
    `exec 3> ${WORK}/hold`,
    'said() { i=0; while [ ! -s "$1" ]; do i=$((i + 1)); if [ "$i" -gt "$2" ] || ! kill -0 "$HOLD" 2>/dev/null; then return 1; fi; sleep 1; done; }',
    ...heredoc('cat >&3', [...PINNED, `\\o ${WORK}/snapshot`, 'SELECT pg_export_snapshot();', '\\o']),
    `if ! said ${WORK}/snapshot 60; then blocked "The source database could not be read at one point in time; nothing was replaced."; fi`,
    `SNAPSHOT=$(cat ${WORK}/snapshot)`,
    'case "$SNAPSHOT" in ""|*[!0-9A-Fa-f-]*) blocked "The source database could not be read at one point in time; nothing was replaced." ;; esac',
    'STARTED=$(date +%s)',
    `if pg_dump --format=custom --no-owner --no-privileges --snapshot="$SNAPSHOT" "$SOURCE_DATABASE_URL" > ${WORK}/source.dump 2>${WORK}/dump.log; then :; else`,
    '  DUMP=$?; blocked "The source database could not be read (pg_dump exit $DUMP); nothing was replaced."',
    'fi',
    ...heredoc('cat >&3', [...inventory('source'), `\\o ${WORK}/source.done`, 'SELECT 1;', '\\o', 'COMMIT;']),
    'exec 3>&-',
    `if ! said ${WORK}/source.done 3600 || ! wait "$HOLD"; then blocked "The source database could not be inventoried; nothing was replaced."; fi`,
    'split_counted() { tail -n 1 "$1.counted" > "$1.summary" && sed \'$d\' "$1.counted" > "$1.tables"; }',
    `split_counted ${WORK}/source || blocked "The source database could not be inventoried; nothing was replaced."`,
    'DUMPED=$(date +%s)',

    // Restore everything except what every database already has. Any error stops it: a partial copy is never accepted.
    'STAGE=restore; CHANGED=true',
    `pg_restore -l ${WORK}/source.dump | grep -Ev '${SKIPPED_ENTRIES}' > ${WORK}/entries`,
    // PostgreSQL's messages may quote statements and data; only the exit code is reported.
    `if pg_restore --exit-on-error --no-owner --no-privileges -L ${WORK}/entries -d "$DATABASE_URL" ${WORK}/source.dump 2> ${WORK}/restore.log; then :; else`,
    '  RESTORE=$?; blocked "The copy could not be written to the new database (pg_restore exit $RESTORE)."',
    'fi',
    'RESTORED=$(date +%s)',

    'STAGE=verify',
    ...heredoc(`if ! psql "$DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 > /dev/null 2> ${WORK}/verify.log`, [...PINNED, ...inventory('target'), 'COMMIT;']),
    'then blocked "The new database could not be inventoried after the copy."; fi',
    `split_counted ${WORK}/target || blocked "The new database could not be inventoried after the copy."`,
    'DIFFERENT=',
    // A sequence's value is not part of any snapshot, so with the app still running only its presence can be compared.
    'if [ "${MOVE_REHEARSAL:-0}" = 1 ]; then REHEARSAL=true; SEQUENCES=sequencenames; else REHEARSAL=false; SEQUENCES=sequences; fi',
    `for PART in tables "$SEQUENCES" largeobjects definitions; do`,
    '  case "$PART" in sequencenames) LABEL=sequences ;; *) LABEL=$PART ;; esac',
    `  cmp -s ${WORK}/source.$PART ${WORK}/target.$PART || DIFFERENT="$DIFFERENT\${DIFFERENT:+,}\\"$LABEL\\""`,
    'done',
    `SRC=$(cat ${WORK}/source.summary); DST=$(cat ${WORK}/target.summary)`,
    'count "${SRC%|*}" && count "${SRC#*|}" && count "${DST%|*}" && count "${DST#*|}" || blocked "The copy could not be summarised."',
    'if [ -z "$DIFFERENT" ]; then MATCH=true; else MATCH=false; fi',
    `printf '${RESULT_MARKER}{"ok":true,"rehearsal":%s,"match":%s,"different":[%s],"source":{"tables":%s,"rows":"%s","version":"%s"},"target":{"tables":%s,"rows":"%s","version":"%s"},"sequences":%s,"largeObjects":%s,"dumpSeconds":%s,"restoreSeconds":%s,"dumpBytes":%s}\\n' \\`,
    `  "$REHEARSAL" "$MATCH" "$DIFFERENT" "\${SRC%|*}" "\${SRC#*|}" "$SRC_VERSION" "\${DST%|*}" "\${DST#*|}" "$DST_VERSION" "$(wc -l < ${WORK}/source.sequences | tr -d ' ')" "$(wc -l < ${WORK}/source.largeobjects | tr -d ' ')" \\`,
    `  "$((DUMPED - STARTED))" "$((RESTORED - DUMPED))" "$(wc -c < ${WORK}/source.dump | tr -d ' ')"`,
  ].join('\n');
}

export interface DatabaseMoveCopyResult {
  ok: boolean;
  /** Set on failure: how far the job got, and whether the target was written to. */
  stage?: 'check' | 'reset' | 'dump' | 'restore' | 'verify';
  targetChanged?: boolean;
  error?: string;
  /** A copy made while the app could still write: it proves the copy works and how long it takes, never that the two databases are the same now. */
  rehearsal?: boolean;
  match?: boolean;
  /** Which parts of the copy differ from the source: tables, sequences, largeobjects, definitions. */
  different?: string[];
  source?: { tables: number; rows: string; version: string };
  target?: { tables: number; rows: string; version: string };
  sequences?: number;
  largeObjects?: number;
  dumpSeconds?: number;
  restoreSeconds?: number;
  dumpBytes?: number;
}

/** True only for a finished copy, not a rehearsal, whose every part matched. Row counts alone never decide it. */
export function databaseMoveCopyVerified(result: DatabaseMoveCopyResult | undefined): boolean {
  return result?.ok === true && result.rehearsal === false && result.match === true && Array.isArray(result.different) && result.different.length === 0
    && result.source !== undefined && result.target !== undefined && result.source.tables === result.target.tables && result.source.rows === result.target.rows;
}

interface MoveSide {
  /** The secret holding this database's connection URL, pinned to one version. */
  secret: { secretId: string; version: string };
  /** `project:region:instance` of the server it is on. */
  connectionName: string;
}

/**
 * The job to run. Both URLs travel as secret references. Their secrets are
 * readable by the app's own cloud identity like every secret of the project;
 * that is accepted, and the caller must never mount either into a service.
 */
export function databaseMoveCopyJob(params: {
  /** PostgreSQL major version of both servers; the job uses that version's tools. */
  majorVersion: number;
  source: MoveSide;
  target: MoveSide;
  /** The app is still running on the source: prove the copy works and time it, without comparing sequence values. */
  rehearsal?: boolean;
  /** Clear a non-empty target first. Only for a target the move created and no app ever wrote to. */
  resetTarget?: boolean;
  /** Refuse a source with any extension beyond plpgsql (moving onto the shared server). */
  blockExtensions?: boolean;
  /** Roles whose grants Hypervibe re-creates itself after the copy (the on-demand worker's reader). */
  ignoredGrantees?: string[];
  timeoutSeconds?: number;
}): TransferJob {
  if (!Number.isInteger(params.majorVersion) || params.majorVersion < 15 || params.majorVersion > 18) throw new Error('A database move needs PostgreSQL 15 to 18 on both servers.');
  const connection = /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+(?:-[a-z0-9]+)+:[a-z][a-z0-9-]{0,96}[a-z0-9]$/;
  for (const side of [params.source, params.target]) {
    if (!connection.test(side.connectionName) || !/^[A-Za-z0-9_-]{1,255}$/.test(side.secret.secretId) || !/^[1-9][0-9]*$/.test(side.secret.version)) {
      throw new Error('A database move needs each database\'s server and one pinned secret version.');
    }
  }
  if (params.source.secret.secretId === params.target.secret.secretId) throw new Error('The two databases of a move cannot share one connection secret.');
  const ignored = params.ignoredGrantees ?? [];
  if (ignored.some((name) => !/^[A-Za-z0-9._@-]{1,63}$/.test(name))) throw new Error('A role name to ignore is not a plain role name.');
  return {
    purpose: 'database', image: `postgres:${params.majorVersion}-alpine`, script: databaseMoveCopyScript(),
    env: { PGTZ: 'UTC', ...(params.rehearsal ? { MOVE_REHEARSAL: '1' } : {}), ...(params.resetTarget ? { MOVE_RESET_TARGET: '1' } : {}), ...(params.blockExtensions ? { MOVE_BLOCK_EXTENSIONS: '1' } : {}),
      ...(ignored.length ? { MOVE_IGNORED_GRANTEES: ignored.join(',') } : {}) },
    sourceSecrets: {},
    secretRefs: { SOURCE_DATABASE_URL: params.source.secret, DATABASE_URL: params.target.secret },
    cloudSqlConnectionName: params.target.connectionName, sourceCloudSqlConnectionName: params.source.connectionName,
    timeoutSeconds: params.timeoutSeconds ?? 3600,
  };
}
