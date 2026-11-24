import { parsePostgresDatabaseIdentity } from '../domain/services/postgres-database-identity.js';
import { DATABASE_IDENTITY_FUNCTIONS, READ_SOURCE_IDENTITY, READ_TARGET_IDENTITY, RESULT_MARKER, guardedTargetReset, type TransferJob } from './migration-transfer-gcp.js';

/**
 * The copy-and-verify job for moving one environment's database between two
 * servers of the same Google project (the app's shared server and a server of
 * its own, either way). It stands beside hv_migrate's copy script and changes
 * none of it.
 *
 * What it does, in order, and why:
 * 1. Both connections must reach exactly the two databases the caller named
 *    (`system_identifier:dbname`). Swapped or wrong connections are refused
 *    before anything is read or cleared.
 * 2. The target must hold nothing. "Nothing" is judged by PostgreSQL's own
 *    dump of it, so every kind of object and privilege counts, not a list
 *    kept here. A target that holds something is refused unless the caller
 *    allows clearing it (`MOVE_RESET_TARGET=1`: a target the move itself made
 *    that no app ever wrote to).
 * 3. The source is dumped, and inventoried in the same snapshot, by a session
 *    that holds that snapshot open. What the copy cannot carry is refused from
 *    that same dump: privileges granted or taken away, objects of another
 *    owner, database-level settings, extensions that keep their own data, and
 *    on request any extension at all.
 * 4. Only now, with a good dump in hand, is the target cleared if that was
 *    allowed, and checked empty again immediately before the restore.
 * 5. The restore stops on any error. The target is then inventoried and its
 *    definitions dumped, and both must equal the source's: every table's rows,
 *    every sequence's value and whether it was used, every large object's
 *    bytes, and the text of every definition PostgreSQL dumps.
 *
 * Sequences are outside any snapshot, so a copy made while the app still runs
 * (`MOVE_REHEARSAL=1`) checks that every sequence arrived and leaves values to
 * the final copy, which is made with the app paused.
 *
 * Every refusal is a result line with the stage reached and whether the target
 * was written to, and the job still exits 0: a failed task would lose the line.
 * No database message is ever written to the job's output.
 *
 * Nothing here decides when a move may run; that is the caller's.
 */
const WORK = '/tmp/hv-move';
const USER_SCHEMA = `n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`;
/** Objects an extension brought are the extension's, not the app's. */
const NOT_EXTENSION = `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_catalog.pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')`;
const USER_RELATION = `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`;
const element = (name: string) => `(xpath('/row/${name}/text()', q.x))[1]::text`;
const ENTRY = '^[0-9]+; [0-9]+ [0-9]+';

/** Session settings that make every value print the same way on both servers, in one snapshot that is not timed out while the dump runs. */
const PINNED = [
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;',
  'SET LOCAL idle_in_transaction_session_timeout = 0;',
  'SET LOCAL search_path = pg_catalog;',
  'SET LOCAL timezone = \'UTC\';',
  'SET LOCAL datestyle = \'ISO\';',
  'SET LOCAL intervalstyle = \'postgres\';',
  'SET LOCAL bytea_output = \'hex\';',
  'SET LOCAL extra_float_digits = 1;',
];

/**
 * Writes one side's data inventory. Names are JSON-encoded by the server, so
 * none can be mistaken for a separator. A row is hashed as `ROW(alias.*)`: a
 * bare alias would be read as a column of that name where a table has one.
 * The checksum sums a hash of every row's text, so it needs constant memory
 * and no ordering.
 */
function inventory(side: 'source' | 'target'): string[] {
  return [
    // One pass over every table: a line per table, then one last line with how many tables and rows there were.
    `\\o ${WORK}/${side}.counted`,
    `WITH counted AS MATERIALIZED (SELECT n.nspname AS s, c.relname AS t, c.relkind::text AS k, ${element('n')}::numeric AS n, ${element('s')} AS h
       ${USER_RELATION}
       CROSS JOIN LATERAL (SELECT query_to_xml(format('SELECT count(*) AS n, coalesce(sum((''x'' || substr(md5(ROW(hv_move_row.*)::text), 1, 15))::bit(60)::bigint::numeric), 0) AS s FROM ONLY %I.%I hv_move_row', n.nspname, c.relname), false, true, '') AS x) q
       WHERE (c.relkind IN ('r', 'p') OR (c.relkind = 'm' AND c.relispopulated)) AND ${USER_SCHEMA} AND ${NOT_EXTENSION})
     SELECT line FROM (SELECT 0 AS last, s, t, json_build_array(s, t, k, n::text, h)::text AS line FROM counted
       UNION ALL SELECT 1, '', '', count(*)::text || '|' || coalesce(sum(n), 0)::text FROM counted) x ORDER BY last, s COLLATE "C", t COLLATE "C";`,
    `\\o ${WORK}/${side}.sequences`,
    `SELECT json_build_array(n.nspname, c.relname, ${element('last_value')}, ${element('is_called')})::text ${USER_RELATION}
       CROSS JOIN LATERAL (SELECT query_to_xml(format('SELECT last_value, is_called FROM %I.%I', n.nspname, c.relname), false, true, '') AS x) q
       WHERE c.relkind = 'S' AND ${USER_SCHEMA} AND ${NOT_EXTENSION} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C";`,
    `\\o ${WORK}/${side}.sequencenames`,
    `SELECT json_build_array(n.nspname, c.relname)::text ${USER_RELATION} WHERE c.relkind = 'S' AND ${USER_SCHEMA} AND ${NOT_EXTENSION} ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C";`,
    `\\o ${WORK}/${side}.largeobjects`,
    'SELECT json_build_array(m.oid::text, encode(sha256(lo_get(m.oid)), \'hex\'))::text FROM pg_largeobject_metadata m ORDER BY m.oid;',
    '\\o',
  ];
}

/**
 * What must be known before the dump, or that its listing cannot show: `extensions with their own data|database-level
 * settings|large objects of another owner or with privileges|tables and the like of another owner` (which the dump itself
 * could not even read; every other kind of object is judged from the dump's own owner statements).
 */
const FACTS = `SELECT (SELECT count(*) FROM pg_extension WHERE extconfig IS NOT NULL)::text || '|' ||
  (SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database())::text || '|' ||
  (SELECT count(*) FROM pg_largeobject_metadata m WHERE m.lomacl IS NOT NULL OR m.lomowner <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user))::text || '|' ||
  (SELECT count(*) ${USER_RELATION} WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION} AND c.relowner <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user))::text;`;

const heredoc = (command: string, lines: string[]) => [`${command} <<'HV_MOVE_SQL'`, ...lines, 'HV_MOVE_SQL'];
const quietly = (line: string) => line.replace('2>/tmp/identity-guard.log', '2>/dev/null');

export function databaseMoveCopyScript(): string {
  return [
    'set -eu',
    // A session that dies must end in a result line, never in a silent signal.
    'trap \'\' PIPE',
    ...DATABASE_IDENTITY_FUNCTIONS,
    'STAGE=check; CHANGED=false; DONE=0; HOLD=',
    // Every refusal says how far the job got and whether the target was written to, and still exits 0 so the line is read.
    `blocked() { DONE=1; printf '${RESULT_MARKER}{"ok":false,"stage":"%s","targetChanged":%s,"error":"%s"}\\n' "$STAGE" "$CHANGED" "$1"; exit 0; }`,
    `finish() { if [ -n "$HOLD" ]; then kill "$HOLD" 2>/dev/null || true; fi; if [ "$DONE" != 1 ]; then printf '${RESULT_MARKER}{"ok":false,"stage":"%s","targetChanged":%s,"error":"The copy stopped unexpectedly."}\\n' "$STAGE" "$CHANGED"; fi; exit 0; }`,
    'trap finish EXIT',
    'count() { case "$1" in ""|*[!0-9]*) return 1 ;; esac; }',
    'plain() { case "$1" in ""|*[!a-z0-9_]*) return 1 ;; esac; }',
    'lines() { wc -l < "$1" | tr -d " "; }',
    `rm -rf ${WORK}; mkdir -p ${WORK}`,

    // 1. The two connections must be exactly the two databases the caller expects, the right way round.
    'if ! valid_identity "${MOVE_SOURCE_IDENTITY:-}" || ! valid_identity "${MOVE_TARGET_IDENTITY:-}" || [ "$MOVE_SOURCE_IDENTITY" = "$MOVE_TARGET_IDENTITY" ]; then',
    '  blocked "The job was not told which two different databases to expect; nothing was changed."',
    'fi',
    ...READ_SOURCE_IDENTITY,
    ...READ_TARGET_IDENTITY,
    'if [ "$SOURCE_IDENTITY" != "$MOVE_SOURCE_IDENTITY" ] || [ "$TARGET_IDENTITY" != "$MOVE_TARGET_IDENTITY" ]; then',
    '  blocked "The two connections do not reach the two databases this move is for, in that order; nothing was changed."',
    'fi',
    'ask() { psql "$1" -X -At -q -v ON_ERROR_STOP=1 -c "$2" 2>/dev/null; }',
    'SRC_VERSION=$(ask "$SOURCE_DATABASE_URL" "SHOW server_version_num") && DST_VERSION=$(ask "$DATABASE_URL" "SHOW server_version_num") && count "$SRC_VERSION" && count "$DST_VERSION" || blocked "The PostgreSQL versions could not be read; nothing was changed."',
    // Definitions are compared as dumped text, which is only the same text within one major version.
    'if [ "${SRC_VERSION%????}" != "${DST_VERSION%????}" ]; then blocked "The two databases run different PostgreSQL major versions; nothing was changed."; fi',
    'SOURCE_OWNER=$(ask "$SOURCE_DATABASE_URL" "SELECT current_user") && TARGET_OWNER=$(ask "$DATABASE_URL" "SELECT current_user") && plain "$SOURCE_OWNER" && plain "$TARGET_OWNER" || blocked "The roles the copy runs as could not be read; nothing was changed."',

    // 2. Empty means: PostgreSQL's own dump of the target lists nothing but the public schema every database starts with.
    `standard() { printf '${ENTRY} ((SCHEMA - public|COMMENT - SCHEMA public) %s|(EXTENSION - plpgsql|COMMENT - EXTENSION plpgsql) ?)$' "$1"; }`,
    'target_extra() {',
    `  pg_dump --format=custom "$DATABASE_URL" > ${WORK}/target.before 2>/dev/null || return 1`,
    `  pg_restore -l ${WORK}/target.before > ${WORK}/target.before.list 2>/dev/null || return 1`,
    `  grep -E '${ENTRY} ' ${WORK}/target.before.list > ${WORK}/target.before.all || true`,
    `  grep -Ev "$(standard "$TARGET_OWNER")" ${WORK}/target.before.all > ${WORK}/target.before.extra || true`,
    `  lines ${WORK}/target.before.extra`,
    '}',
    'if ! EXISTING=$(target_extra) || ! count "$EXISTING"; then blocked "The new database could not be inspected; nothing was changed."; fi',
    'if [ "$EXISTING" -gt 0 ] && [ "${MOVE_RESET_TARGET:-0}" != 1 ]; then blocked "The new database is not empty; nothing was changed."; fi',

    // 3. One snapshot for the dump, for what the copy is compared against, and for what is refused: a session holds it open throughout.
    'STAGE=dump',
    `mkfifo ${WORK}/hold`,
    `psql "$SOURCE_DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 < ${WORK}/hold > /dev/null 2> /dev/null &`,
    'HOLD=$!',
    `exec 3> ${WORK}/hold`,
    'said() { i=0; while [ ! -s "$1" ]; do i=$((i + 1)); if [ "$i" -gt "$2" ] || ! kill -0 "$HOLD" 2>/dev/null; then return 1; fi; sleep 1; done; }',
    ...heredoc('if ! cat >&3 2>/dev/null', [...PINNED, `\\o ${WORK}/snapshot`, 'SELECT pg_export_snapshot();', `\\o ${WORK}/facts`, FACTS, '\\o']),
    `then blocked "The source database could not be read at one point in time; nothing was changed."; fi`,
    `if ! said ${WORK}/snapshot 60 || ! said ${WORK}/facts 60; then blocked "The source database could not be read at one point in time; nothing was changed."; fi`,
    `SNAPSHOT=$(cat ${WORK}/snapshot); FACTS=$(cat ${WORK}/facts)`,
    'case "$SNAPSHOT" in ""|*[!0-9A-Fa-f-]*) blocked "The source database could not be read at one point in time; nothing was changed." ;; esac',
    'OWNDATA=${FACTS%%|*}; REST=${FACTS#*|}; SETTINGS=${REST%%|*}; REST=${REST#*|}; LARGE=${REST%%|*}; OTHERS=${REST#*|}',
    'count "$OWNDATA" && count "$SETTINGS" && count "$LARGE" && count "$OTHERS" || blocked "The source database could not be inspected; nothing was changed."',
    'NOT_OURS="object(s) owned by a role other than the app\'s own, or large objects with privileges of their own; they cannot be carried over, so nothing was changed."',
    'if [ "$OWNDATA" -gt 0 ]; then blocked "The database uses $OWNDATA extension(s) that keep data of their own, which this copy cannot check; nothing was changed."; fi',
    'if [ "$SETTINGS" -gt 0 ]; then blocked "The database has $SETTINGS setting(s) made on the database itself, which a copy does not carry over; nothing was changed."; fi',
    'if [ "$((LARGE + OTHERS))" -gt 0 ]; then blocked "The database holds $((LARGE + OTHERS)) $NOT_OURS"; fi',
    'STARTED=$(date +%s)',
    // With owners and privileges in it, so both can be judged from the dump itself; the restore applies neither.
    `if pg_dump --format=custom --snapshot="$SNAPSHOT" "$SOURCE_DATABASE_URL" > ${WORK}/source.dump 2>/dev/null; then :; else`,
    '  DUMP=$?; blocked "The source database could not be read (pg_dump exit $DUMP); nothing was changed."',
    'fi',
    `pg_restore -l ${WORK}/source.dump > ${WORK}/source.list 2>/dev/null && pg_restore --schema-only -f ${WORK}/source.full ${WORK}/source.dump 2>/dev/null || blocked "The dump of the source database could not be read back; nothing was changed."`,
    `grep -E '${ENTRY} ' ${WORK}/source.list > ${WORK}/source.all || true`,
    // What the copy cannot carry over is refused here, from the same moment the data was read.
    `grep -E '${ENTRY} EXTENSION - ' ${WORK}/source.all | grep -Ev '${ENTRY} EXTENSION - plpgsql ?$' > ${WORK}/source.extensions || true`,
    `EXTENSIONS=$(lines ${WORK}/source.extensions)`,
    'if [ "${MOVE_BLOCK_EXTENSIONS:-0}" = 1 ] && [ "$EXTENSIONS" -gt 0 ]; then blocked "The database uses $EXTENSIONS extension(s) that cannot be installed on the new server yet; nothing was changed."; fi',
    `grep -E '${ENTRY} (PUBLICATION|SUBSCRIPTION|EVENT TRIGGER|SERVER|FOREIGN DATA WRAPPER|USER MAPPING|FOREIGN TABLE) ' ${WORK}/source.all > ${WORK}/source.unsupported || true`,
    `UNSUPPORTED=$(lines ${WORK}/source.unsupported)`,
    'if [ "$UNSUPPORTED" -gt 0 ]; then blocked "The database has $UNSUPPORTED publication(s), subscription(s), event trigger(s) or foreign data object(s), which cannot be moved yet; nothing was changed."; fi',
    `grep -E ' OWNER TO ' ${WORK}/source.full | grep -Ev " OWNER TO $SOURCE_OWNER;\\$" > ${WORK}/source.foreign || true`,
    `FOREIGN=$(lines ${WORK}/source.foreign)`,
    'if [ "$FOREIGN" -gt 0 ]; then blocked "The database holds $FOREIGN $NOT_OURS"; fi',
    // Any privilege statement at all, on any kind of object, except grants to the roles Hypervibe gives access again itself.
    `grep -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) ' ${WORK}/source.full > ${WORK}/source.grants || true`,
    'OLDIFS=$IFS; IFS=,',
    'for ROLE in ${MOVE_IGNORED_GRANTEES:-}; do',
    `  grep -v -F -e " TO $ROLE;" -e " TO \\"$ROLE\\";" ${WORK}/source.grants > ${WORK}/source.grants.kept || true`,
    `  mv ${WORK}/source.grants.kept ${WORK}/source.grants`,
    'done',
    'IFS=$OLDIFS',
    `GRANTS=$(lines ${WORK}/source.grants)`,
    'if [ "$GRANTS" -gt 0 ]; then blocked "The database has $GRANTS privilege(s) granted or taken away that the copy cannot carry over; nothing was changed."; fi',
    `grep -Ev "$(standard "$SOURCE_OWNER")" ${WORK}/source.list > ${WORK}/source.entries || true`,
    // A materialized view's refresh is data: its rows are compared with every table's, and a dump of definitions alone leaves the statement out.
    `grep -Ev '${ENTRY} MATERIALIZED VIEW DATA ' ${WORK}/source.entries > ${WORK}/source.defined || true`,
    `pg_restore --schema-only --no-owner --no-privileges -L ${WORK}/source.defined -f ${WORK}/source.sql ${WORK}/source.dump 2>/dev/null || blocked "The dump of the source database could not be read back; nothing was changed."`,
    ...heredoc('if ! cat >&3 2>/dev/null', [...inventory('source'), `\\o ${WORK}/source.done`, 'SELECT 1;', '\\o', 'COMMIT;']),
    'then blocked "The source database could not be inventoried; nothing was changed."; fi',
    'exec 3>&-',
    `if ! said ${WORK}/source.done 3600 || ! wait "$HOLD"; then HOLD=; blocked "The source database could not be inventoried; nothing was changed."; fi`,
    'HOLD=',
    'split_counted() { tail -n 1 "$1.counted" > "$1.summary" && sed \'$d\' "$1.counted" > "$1.tables"; }',
    `split_counted ${WORK}/source || blocked "The source database could not be inventoried; nothing was changed."`,
    'DUMPED=$(date +%s)',

    // 4. Nothing on the target has been touched until here. It is cleared only now, if that was allowed, and must be empty right before the restore.
    'if [ "$EXISTING" -gt 0 ]; then',
    '  STAGE=reset; CHANGED=true',
    ...guardedTargetReset().map((line) => quietly(line).replace('blocked "The target database could not be safely prepared; its identity must remain verified and different from the source."',
      'blocked "The new database could not be cleared; its identity must remain verified and different from the source."')),
    // As every new database has it, so that an emptied target reads as an empty one.
    '  ask "$DATABASE_URL" "GRANT USAGE ON SCHEMA public TO PUBLIC" >/dev/null || blocked "The new database could not be cleared."',
    'fi',
    'if ! EXISTING=$(target_extra) || [ "$EXISTING" != 0 ]; then blocked "The new database is not empty just before the copy; nothing was written to it by this step."; fi',

    // 5. Restore everything except what every database already has. Any error stops it: a partial copy is never accepted.
    'STAGE=restore; CHANGED=true',
    `if pg_restore --exit-on-error --no-owner --no-privileges -L ${WORK}/source.entries -d "$DATABASE_URL" ${WORK}/source.dump 2>/dev/null; then :; else`,
    '  RESTORE=$?; blocked "The copy could not be written to the new database (pg_restore exit $RESTORE)."',
    'fi',
    'RESTORED=$(date +%s)',

    'STAGE=verify',
    ...heredoc('if ! psql "$DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 > /dev/null 2> /dev/null', [...PINNED, ...inventory('target'), 'COMMIT;']),
    'then blocked "The new database could not be inventoried after the copy."; fi',
    `split_counted ${WORK}/target || blocked "The new database could not be inventoried after the copy."`,
    `pg_dump --format=custom --schema-only "$DATABASE_URL" > ${WORK}/target.dump 2>/dev/null && pg_restore -l ${WORK}/target.dump > ${WORK}/target.list 2>/dev/null || blocked "The new database's definitions could not be read after the copy."`,
    `grep -Ev "$(standard "$TARGET_OWNER")" ${WORK}/target.list > ${WORK}/target.entries || true`,
    `pg_restore --no-owner --no-privileges -L ${WORK}/target.entries -f ${WORK}/target.sql ${WORK}/target.dump 2>/dev/null || blocked "The new database's definitions could not be read after the copy."`,
    // Comment lines carry dump positions and times; everything else must be the same text.
    `for SIDE in source target; do grep -Ev '^(--|$)' ${WORK}/$SIDE.sql > ${WORK}/$SIDE.definitions || true; done`,
    // A sequence's value is not part of any snapshot, so with the app still running only its presence can be compared.
    'if [ "${MOVE_REHEARSAL:-0}" = 1 ]; then REHEARSAL=true; SEQUENCES=sequencenames; else REHEARSAL=false; SEQUENCES=sequences; fi',
    'DIFFERENT=',
    'for PART in tables "$SEQUENCES" largeobjects definitions; do',
    '  case "$PART" in sequencenames) LABEL=sequences ;; *) LABEL=$PART ;; esac',
    `  cmp -s ${WORK}/source.$PART ${WORK}/target.$PART || DIFFERENT="$DIFFERENT\${DIFFERENT:+,}\\"$LABEL\\""`,
    'done',
    `SRC=$(cat ${WORK}/source.summary); DST=$(cat ${WORK}/target.summary)`,
    'count "${SRC%|*}" && count "${SRC#*|}" && count "${DST%|*}" && count "${DST#*|}" || blocked "The copy could not be summarised."',
    'if [ -z "$DIFFERENT" ]; then MATCH=true; else MATCH=false; fi',
    'side() { printf \'{"tables":%s,"rows":"%s","version":"%s","sequences":%s,"largeObjects":%s}\' "${2%|*}" "${2#*|}" "$3" "$(lines "$1.sequencenames")" "$(lines "$1.largeobjects")"; }',
    'DONE=1',
    `printf '${RESULT_MARKER}{"ok":true,"rehearsal":%s,"match":%s,"different":[%s],"source":%s,"target":%s,"dumpSeconds":%s,"restoreSeconds":%s,"dumpBytes":%s}\\n' \\`,
    `  "$REHEARSAL" "$MATCH" "$DIFFERENT" "$(side ${WORK}/source "$SRC" "$SRC_VERSION")" "$(side ${WORK}/target "$DST" "$DST_VERSION")" "$((DUMPED - STARTED))" "$((RESTORED - DUMPED))" "$(wc -c < ${WORK}/source.dump | tr -d ' ')"`,
  ].join('\n');
}

interface MoveSideCounts { tables: number; rows: string; version: string; sequences: number; largeObjects: number }

export interface DatabaseMoveCopyResult {
  ok: boolean;
  /** Set on failure: how far the job got, and whether the target was written to. */
  stage?: 'check' | 'dump' | 'reset' | 'restore' | 'verify';
  targetChanged?: boolean;
  error?: string;
  /** A copy made while the app could still write: it proves the copy works and how long it takes, never that the two databases are the same now. */
  rehearsal?: boolean;
  match?: boolean;
  /** Which parts of the copy differ from the source: tables, sequences, largeobjects, definitions. */
  different?: string[];
  source?: Partial<MoveSideCounts>;
  target?: Partial<MoveSideCounts>;
  dumpSeconds?: number;
  restoreSeconds?: number;
  dumpBytes?: number;
}

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const complete = (side: Partial<MoveSideCounts> | undefined): side is MoveSideCounts => side !== undefined && whole(side.tables) && typeof side.rows === 'string' && /^[0-9]+$/.test(side.rows)
  && typeof side.version === 'string' && /^[0-9]+$/.test(side.version) && whole(side.sequences) && whole(side.largeObjects);

/**
 * True only for a finished copy, not a rehearsal, whose every part matched and
 * whose every count is present on both sides and equal. Anything missing is
 * never read as "the same".
 */
export function databaseMoveCopyVerified(result: DatabaseMoveCopyResult | undefined): boolean {
  if (!result || result.ok !== true || result.rehearsal !== false || result.match !== true || !Array.isArray(result.different) || result.different.length !== 0) return false;
  const { source, target } = result;
  return complete(source) && complete(target) && source.tables === target.tables && source.rows === target.rows && source.sequences === target.sequences && source.largeObjects === target.largeObjects;
}

interface MoveSide {
  /** `system_identifier:dbname` of the database, read by the caller beforehand. Not a secret. */
  identity: string;
  /** The secret holding this database's connection URL, pinned to one version. */
  secret: { secretId: string; version: string };
  /** `project:region:instance` of the server it is on. */
  connectionName: string;
}

/**
 * The job to run. Both URLs travel as secret references. Their secrets are
 * readable by the app's own cloud identity like every secret of the project;
 * that is accepted, and the caller must never mount either into a service.
 * The caller also names the two databases, so a job handed the wrong or
 * swapped secrets refuses instead of copying the wrong way.
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
    if (!parsePostgresDatabaseIdentity(side.identity)) throw new Error('A database move needs the identity of each database, read beforehand.');
  }
  if (params.source.identity === params.target.identity) throw new Error('The two databases of a move must be different databases.');
  if (params.source.secret.secretId === params.target.secret.secretId) throw new Error('The two databases of a move cannot share one connection secret.');
  const ignored = params.ignoredGrantees ?? [];
  if (ignored.some((name) => !/^[A-Za-z0-9._@-]{1,63}$/.test(name))) throw new Error('A role name to ignore is not a plain role name.');
  return {
    purpose: 'database', image: `postgres:${params.majorVersion}-alpine`, script: databaseMoveCopyScript(),
    env: { PGTZ: 'UTC', MOVE_SOURCE_IDENTITY: params.source.identity, MOVE_TARGET_IDENTITY: params.target.identity,
      ...(params.rehearsal ? { MOVE_REHEARSAL: '1' } : {}), ...(params.resetTarget ? { MOVE_RESET_TARGET: '1' } : {}), ...(params.blockExtensions ? { MOVE_BLOCK_EXTENSIONS: '1' } : {}),
      ...(ignored.length ? { MOVE_IGNORED_GRANTEES: ignored.join(',') } : {}) },
    sourceSecrets: {},
    secretRefs: { SOURCE_DATABASE_URL: params.source.secret, DATABASE_URL: params.target.secret },
    cloudSqlConnectionName: params.target.connectionName, sourceCloudSqlConnectionName: params.source.connectionName,
    timeoutSeconds: params.timeoutSeconds ?? 3600,
  };
}
