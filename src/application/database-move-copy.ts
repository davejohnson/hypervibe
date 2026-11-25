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
 * Sequences are outside any snapshot, so the copy is only ever made with the
 * app paused.
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
    `\\o ${WORK}/${side}.extensions`,
    'SELECT json_build_array(x.extname, x.extversion)::text FROM pg_extension x ORDER BY x.extname COLLATE "C";',
    `\\o ${WORK}/${side}.largeobjects`,
    'SELECT json_build_array(m.oid::text, encode(sha256(lo_get(m.oid)), \'hex\'))::text FROM pg_largeobject_metadata m ORDER BY m.oid;',
    '\\o',
  ];
}

const ME = `(SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)`;
const THIS_DATABASE = `(SELECT d.oid FROM pg_database d WHERE d.datname = current_database())`;
/**
 * What a dump does not show, or that must be known before one is taken, as six counts:
 * `extensions with data of their own | settings on the database or on the app's roles, other than each login acting as
 * its owner role | large objects of another owner or with privileges | tables and the like of another owner (a dump could
 * not even read them) | subscriptions (a plain role's dump skips them silently) | other roles the database itself grants
 * access to (a dump of one database leaves the database's own privileges out)`.
 */
export const DATABASE_MOVE_FACTS = `SELECT (SELECT count(*) FROM pg_extension WHERE extconfig IS NOT NULL)::text || '|' ||
  (SELECT count(*) FROM pg_db_role_setting s WHERE s.setdatabase = ${THIS_DATABASE} OR (s.setdatabase = 0
    AND s.setrole IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN (current_user, session_user)) AND s.setconfig IS DISTINCT FROM ARRAY['role=' || current_user]))::text || '|' ||
  (SELECT count(*) FROM pg_largeobject_metadata m WHERE m.lomacl IS NOT NULL OR m.lomowner <> ${ME})::text || '|' ||
  (SELECT count(*) ${USER_RELATION} WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION} AND c.relowner <> ${ME})::text || '|' ||
  (SELECT count(*) FROM pg_subscription u WHERE u.subdbid = ${THIS_DATABASE})::text || '|' ||
  (SELECT count(DISTINCT a.grantee) FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE d.oid = ${THIS_DATABASE} AND a.grantee NOT IN (0, d.datdba, ${ME}))::text;`;

const FACTS = DATABASE_MOVE_FACTS;

/**
 * Cloud SQL gives its own administrators' group the public schema of every database, whoever creates it and from
 * whatever template: `GRANT ALL ON SCHEMA public TO cloudsqlsuperuser`. Seen on 2026-11-25 (PostgreSQL 16.15) on a
 * database made with plain SQL from template0 and on one made through Google's API alike. Nobody asked for it and
 * the new server has it too, so it is not something a copy loses.
 */
const PROVIDER_GROUP = 'cloudsqlsuperuser';
/**
 * Every access a person gave on the app's own objects, one line each, in words: `schema public: USAGE to reporting`.
 * A copy carries no privileges over, so each line is something that would silently stop working. Left out: what an
 * owner has anyway, what every database gives everyone (use of `public`, running functions), and the provider's own
 * grant above. The same statement serves the copy job and whoever asks before a move is started.
 */
export const DATABASE_MOVE_PRIVILEGES = `SELECT x.kind || ' ' || x.name || ': ' || string_agg(DISTINCT x.privilege, ', ' ORDER BY x.privilege) || ' to ' || coalesce(quote_ident(r.rolname), 'PUBLIC')
  FROM (
    SELECT 'schema' AS kind, quote_ident(n.nspname) AS name, n.nspowner AS owner, a.grantee, a.privilege_type::text AS privilege FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE ${USER_SCHEMA}
    UNION ALL SELECT 'table, view or sequence', quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.relowner, a.grantee, a.privilege_type::text ${USER_RELATION} CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION}
    UNION ALL SELECT 'function', quote_ident(n.nspname) || '.' || quote_ident(p.proname), p.proowner, a.grantee, a.privilege_type::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE ${USER_SCHEMA} AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_catalog.pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
    UNION ALL SELECT 'whatever is created later by', quote_ident(o.rolname), d.defaclrole, a.grantee, a.privilege_type::text FROM pg_default_acl d JOIN pg_roles o ON o.oid = d.defaclrole CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  ) x LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE x.grantee <> x.owner
    AND NOT (x.grantee = 0 AND ((x.kind = 'schema' AND x.name = 'public' AND x.privilege = 'USAGE') OR (x.kind = 'function' AND x.privilege = 'EXECUTE')))
    AND NOT (x.kind = 'schema' AND x.name = 'public' AND r.rolname = '${PROVIDER_GROUP}')
  GROUP BY x.kind, x.name, r.rolname ORDER BY 1;`;
const PRIVILEGES = DATABASE_MOVE_PRIVILEGES;

/**
 * The same judgement the job makes of those counts, for a caller that can read them before anything is paused.
 * Undefined when the job would not refuse on their account.
 */
export function databaseMoveFactsProblem(facts: unknown): string | undefined {
  const counts = typeof facts === 'string' ? facts.split('|') : [];
  if (counts.length !== 6 || counts.some((count) => !/^[0-9]{1,9}$/.test(count))) return 'could not be inspected';
  const [ownData, settings, large, others, subscribed, granted] = counts.map(Number) as [number, number, number, number, number, number];
  if (ownData) return `uses ${ownData} extension(s) that keep data of their own, which the copy cannot check`;
  if (settings) return `has ${settings} setting(s) made on the database or the app's role, which a copy does not carry over`;
  if (subscribed) return `has ${subscribed} subscription(s) to another database, which cannot be moved yet`;
  if (granted) return `itself grants access to ${granted} other role(s), which a copy does not carry over`;
  if (large + others) return `holds ${large + others} object(s) owned by a role other than the app's own, or large objects with privileges of their own, which cannot be carried over`;
  return undefined;
}

/** How the database itself was created: what decides how text is stored and sorted. Read as JSON so a column a version lacks is simply absent. */
const CREATED_AS = `SELECT json_build_array(pg_encoding_to_char(d.encoding), d.datcollate, d.datctype, to_jsonb(d) -> 'datlocprovider', coalesce(to_jsonb(d) -> 'datlocale', to_jsonb(d) -> 'daticulocale'), to_jsonb(d) -> 'daticurules')::text
  FROM pg_database d WHERE d.oid = ${THIS_DATABASE};`;

const heredoc = (command: string, lines: string[]) => [`${command} <<'HV_MOVE_SQL'`, ...lines, 'HV_MOVE_SQL'];
const quietly = (line: string) => line.replace('2>/tmp/identity-guard.log', '2>/dev/null');
const UNREADABLE = 'The dump of the source database could not be read back; nothing was changed.';

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
    // The first few lines of a file as one piece of a message: plain characters only, nothing that could end the result line's text early.
    'named() { head -n 5 "$1" | LC_ALL=C tr -cd \'\\n\\40-\\176\' | tr -d \'"\\\\\' | tr \'\\n\' \'|\' | sed \'s/|$//; s/|/ | /g\' | cut -c1-500; }',
    // grep's "no line matched" is an answer; anything worse (a file that cannot be read or written) is a failure and must stop the job.
    'sift() { s=0; grep "$@" || s=$?; [ "$s" -le 1 ]; }',
    // PostgreSQL 17.6 and later wrap a dump's text in one \\restrict line and one \\unrestrict line that carry a key made up for that run, so no
    // two dumps are the same text. Exactly those two lines are left out, and only where they are pg_dump's own: the \\restrict line stands
    // before the first statement, and the last line of the text is \\unrestrict with the same key. A line anywhere in the app's own
    // definitions that merely looks alike is neither, and stays.
    'unkeyed() {',
    '  FIRST=$(grep -m 1 -E \'^(SET |\\\\restrict [A-Za-z0-9]+$)\' "$1") || FIRST=',
    '  case "$FIRST" in "\\\\restrict "*) KEY=${FIRST#* } ;; *) KEY= ;; esac',
    '  LAST=$(grep -v -E \'^(--.*)?$\' "$1" | tail -n 1) || LAST=',
    '  if [ -n "$KEY" ] && [ "$LAST" = "\\\\unrestrict $KEY" ]; then sift -v -x -F -e "\\\\restrict $KEY" -e "\\\\unrestrict $KEY" "$1" > "$2"; else cp "$1" "$2"; fi',
    '}',
    `rm -rf ${WORK}; mkdir -p ${WORK}`,

    // 1. Each connection must lead to one server only, and the two must be exactly the two databases the caller expects, the right way round.
    'case "$SOURCE_DATABASE_URL$DATABASE_URL" in *,*) blocked "A connection names more than one server; nothing was changed." ;; esac',
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
    ...heredoc('created_as() { psql "$1" -X -At -q -v ON_ERROR_STOP=1 2>/dev/null', ['SET search_path = pg_catalog;', CREATED_AS]),
    '}',
    'SRC_CREATED=$(created_as "$SOURCE_DATABASE_URL") && DST_CREATED=$(created_as "$DATABASE_URL") && [ -n "$SRC_CREATED" ] || blocked "How the two databases were created could not be read; nothing was changed."',
    'if [ "$SRC_CREATED" != "$DST_CREATED" ]; then blocked "The two databases were created with a different text encoding or sort order; nothing was changed."; fi',

    // What no dump shows is counted on each side and refused in the same words for both.
    'NOT_OURS="object(s) owned by a role other than the app\'s own, or large objects with privileges of their own; they cannot be carried over, so nothing was changed."',
    'judge() {',
    '  F=$2; OWNDATA=${F%%|*}; F=${F#*|}; SETTINGS=${F%%|*}; F=${F#*|}; LARGE=${F%%|*}; F=${F#*|}; OTHERS=${F%%|*}; F=${F#*|}; SUBSCRIBED=${F%%|*}; GRANTED=${F#*|}',
    '  count "$OWNDATA" && count "$SETTINGS" && count "$LARGE" && count "$OTHERS" && count "$SUBSCRIBED" && count "$GRANTED" || blocked "$1 could not be inspected; nothing was changed."',
    '  if [ "$OWNDATA" -gt 0 ]; then blocked "$1 uses $OWNDATA extension(s) that keep data of their own, which this copy cannot check; nothing was changed."; fi',
    '  if [ "$SETTINGS" -gt 0 ]; then blocked "$1 has $SETTINGS setting(s) made on the database or the app\'s role, which a copy does not carry over; nothing was changed."; fi',
    '  if [ "$SUBSCRIBED" -gt 0 ]; then blocked "$1 has $SUBSCRIBED subscription(s) to another database, which cannot be moved yet; nothing was changed."; fi',
    '  if [ "$GRANTED" -gt 0 ]; then blocked "$1 itself grants access to $GRANTED other role(s), which a copy does not carry over; nothing was changed."; fi',
    '  if [ "$((LARGE + OTHERS))" -gt 0 ]; then blocked "$1 holds $((LARGE + OTHERS)) $NOT_OURS"; fi',
    '}',
    ...heredoc('if ! TARGET_FACTS=$(psql "$DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 2>/dev/null', ['SET search_path = pg_catalog;', FACTS]),
    '); then blocked "The new database could not be inspected; nothing was changed."; fi',
    'judge "The new database" "$TARGET_FACTS"',

    // 2. Empty means: PostgreSQL's own dump of the target lists nothing but the public schema every database starts with.
    // Where the new database is the move's own to clear, privileges on its public schema are not content either: a provider puts
    // its own there on every database, and clearing the database for that alone would take the provider's grant away.
    `standard() { if [ "\${MOVE_RESET_TARGET:-0}" = 1 ]; then printf '${ENTRY} (SCHEMA - public %s|ACL - SCHEMA public %s|(EXTENSION - plpgsql|COMMENT - EXTENSION plpgsql) ?)$' "$1" "$1";`,
    `  else printf '${ENTRY} (SCHEMA - public %s|(EXTENSION - plpgsql|COMMENT - EXTENSION plpgsql) ?)$' "$1"; fi; }`,
    'target_extra() {',
    `  pg_dump --format=custom "$DATABASE_URL" > ${WORK}/target.before 2>/dev/null || return 1`,
    `  pg_restore -l ${WORK}/target.before > ${WORK}/target.before.list 2>/dev/null || return 1`,
    `  sift -E '${ENTRY} ' ${WORK}/target.before.list > ${WORK}/target.before.all || return 1`,
    // Every privilege statement the new database has before anything is copied into it.
    `  pg_restore --schema-only -f ${WORK}/target.before.full ${WORK}/target.before 2>/dev/null && sift -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) ' ${WORK}/target.before.full > ${WORK}/target.grants || return 1`,
    `  sift -Ev "$(standard "$TARGET_OWNER")" ${WORK}/target.before.all > ${WORK}/target.before.extra || return 1`,
    `  lines ${WORK}/target.before.extra`,
    '}',
    'if ! EXISTING=$(target_extra) || ! count "$EXISTING"; then blocked "The new database could not be inspected; nothing was changed."; fi',
    'if [ "$EXISTING" -gt 0 ]; then',
    '  if [ "${MOVE_RESET_TARGET:-0}" != 1 ]; then blocked "The new database is not empty; nothing was changed."; fi',
    // Clearing removes only what the copy's own role owns. Anything of another owner would survive it, so it is found now, before anything is deleted.
    `  pg_restore --schema-only -f ${WORK}/target.before.full ${WORK}/target.before 2>/dev/null && sift -E ' OWNER TO ' ${WORK}/target.before.full > ${WORK}/target.before.owners || blocked "The new database could not be inspected; nothing was changed."`,
    `  sift -Ev " OWNER TO $TARGET_OWNER;\\$" ${WORK}/target.before.owners > ${WORK}/target.before.foreign || blocked "The new database could not be inspected; nothing was changed."`,
    `  if [ "$(lines ${WORK}/target.before.foreign)" -gt 0 ]; then blocked "The new database holds $(lines ${WORK}/target.before.foreign) $NOT_OURS"; fi`,
    'fi',

    // 3. One snapshot for the dump, for what the copy is compared against, and for what is refused: a session holds it open throughout.
    'STAGE=dump',
    `mkfifo ${WORK}/hold`,
    `psql "$SOURCE_DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 < ${WORK}/hold > /dev/null 2> /dev/null &`,
    'HOLD=$!',
    `exec 3> ${WORK}/hold`,
    'said() { i=0; while [ ! -s "$1" ]; do i=$((i + 1)); if [ "$i" -gt "$2" ] || ! kill -0 "$HOLD" 2>/dev/null; then return 1; fi; sleep 1; done; }',
    ...heredoc('if ! cat >&3 2>/dev/null', [...PINNED, `\\o ${WORK}/snapshot`, 'SELECT pg_export_snapshot();', `\\o ${WORK}/privileges`, PRIVILEGES, `\\o ${WORK}/facts`, FACTS, '\\o']),
    `then blocked "The source database could not be read at one point in time; nothing was changed."; fi`,
    `if ! said ${WORK}/snapshot 60 || ! said ${WORK}/facts 60; then blocked "The source database could not be read at one point in time; nothing was changed."; fi`,
    `SNAPSHOT=$(cat ${WORK}/snapshot)`,
    'case "$SNAPSHOT" in ""|*[!0-9A-Fa-f-]*) blocked "The source database could not be read at one point in time; nothing was changed." ;; esac',
    `judge "The database" "$(cat ${WORK}/facts)"`,
    'STARTED=$(date +%s)',
    // With owners and privileges in it, so both can be judged from the dump itself; the restore applies neither.
    `if pg_dump --format=custom --snapshot="$SNAPSHOT" "$SOURCE_DATABASE_URL" > ${WORK}/source.dump 2>/dev/null; then :; else`,
    '  DUMP=$?; blocked "The source database could not be read (pg_dump exit $DUMP); nothing was changed."',
    'fi',
    `pg_restore -l ${WORK}/source.dump > ${WORK}/source.list 2>/dev/null && pg_restore --schema-only -f ${WORK}/source.full ${WORK}/source.dump 2>/dev/null && sift -E '${ENTRY} ' ${WORK}/source.list > ${WORK}/source.all || blocked "${UNREADABLE}"`,
    // What the copy cannot carry over is refused here, from the same moment the data was read.
    `sift -E '${ENTRY} EXTENSION - ' ${WORK}/source.all > ${WORK}/source.extensions.all && sift -Ev '${ENTRY} EXTENSION - plpgsql ?$' ${WORK}/source.extensions.all > ${WORK}/source.extensions.used || blocked "${UNREADABLE}"`,
    `EXTENSIONS=$(lines ${WORK}/source.extensions.used)`,
    'if [ "${MOVE_BLOCK_EXTENSIONS:-0}" = 1 ] && [ "$EXTENSIONS" -gt 0 ]; then blocked "The database uses $EXTENSIONS extension(s) that cannot be installed on the new server yet; nothing was changed."; fi',
    `sift -E '${ENTRY} (PUBLICATION|SUBSCRIPTION|EVENT TRIGGER|SERVER|FOREIGN DATA WRAPPER|USER MAPPING|FOREIGN TABLE) ' ${WORK}/source.all > ${WORK}/source.unsupported || blocked "${UNREADABLE}"`,
    `UNSUPPORTED=$(lines ${WORK}/source.unsupported)`,
    'if [ "$UNSUPPORTED" -gt 0 ]; then blocked "The database has $UNSUPPORTED publication(s), subscription(s), event trigger(s) or foreign data object(s), which cannot be moved yet; nothing was changed."; fi',
    `sift -E ' OWNER TO ' ${WORK}/source.full > ${WORK}/source.owners && sift -Ev " OWNER TO $SOURCE_OWNER;\\$" ${WORK}/source.owners > ${WORK}/source.foreign || blocked "${UNREADABLE}"`,
    `FOREIGN=$(lines ${WORK}/source.foreign)`,
    'if [ "$FOREIGN" -gt 0 ]; then blocked "The database holds $FOREIGN $NOT_OURS"; fi',
    // Any privilege statement at all, on any kind of object. The one exception is the exact access Hypervibe gives a named role again after
    // the copy: use of the public schema, reading every table and view in it, and reading tables made there later. A role with all three and
    // nothing else is left out; a role with less, more or anything different is not, because giving that access again would change it.
    `sift -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) ' ${WORK}/source.full > ${WORK}/source.grants || blocked "${UNREADABLE}"`,
    // A statement the new database already has, word for word, is not something the copy loses: what a provider grants on every database is there on both.
    `if [ -s ${WORK}/target.grants ]; then sift -v -x -F -f ${WORK}/target.grants ${WORK}/source.grants > ${WORK}/source.grants.kept && mv ${WORK}/source.grants.kept ${WORK}/source.grants || blocked "${UNREADABLE}"; fi`,
    `READABLE=$(sift -Ec '${ENTRY} (TABLE|VIEW|MATERIALIZED VIEW|FOREIGN TABLE) public ' ${WORK}/source.all) || blocked "${UNREADABLE}"`,
    'OLDIFS=$IFS; IFS=,',
    'for ROLE in ${MOVE_IGNORED_GRANTEES:-}; do',
    '  IFS=$OLDIFS',
    '  WHO="\\"?$(printf \'%s\' "$ROLE" | sed \'s/[.]/[.]/g\')\\"?"',
    '  USE="^GRANT USAGE ON SCHEMA public TO $WHO;\\$"',
    '  LATER="^ALTER DEFAULT PRIVILEGES FOR ROLE $SOURCE_OWNER IN SCHEMA public GRANT SELECT ON TABLES TO $WHO;\\$"',
    '  READ="^GRANT SELECT ON TABLE public[.].+ TO $WHO;\\$"',
    `  USES=$(sift -Ec "$USE" ${WORK}/source.grants) && LATERS=$(sift -Ec "$LATER" ${WORK}/source.grants) && READS=$(sift -Ec "$READ" ${WORK}/source.grants) || blocked "${UNREADABLE}"`,
    '  if [ "$USES" = 1 ] && [ "$LATERS" = 1 ] && [ "$READS" = "$READABLE" ]; then',
    `    sift -Ev "($USE|$LATER|$READ)" ${WORK}/source.grants > ${WORK}/source.grants.kept && mv ${WORK}/source.grants.kept ${WORK}/source.grants || blocked "${UNREADABLE}"`,
    // The catalogs' account of the same access is left out with it.
    `    sift -Ev " to $WHO\\$" ${WORK}/privileges > ${WORK}/privileges.kept && mv ${WORK}/privileges.kept ${WORK}/privileges || blocked "${UNREADABLE}"`,
    '  fi',
    '  IFS=,',
    'done',
    'IFS=$OLDIFS',
    `GRANTS=$(lines ${WORK}/source.grants)`,
    'if [ "$GRANTS" -gt 0 ]; then blocked "The database has $GRANTS privilege(s) granted or taken away that the copy cannot carry over ($(named ' + WORK + '/source.grants)); nothing was changed."; fi',
    // The same question asked of the catalogs, in the very words used before a move is started: what that check refuses, this job refuses too.
    `if [ -s ${WORK}/privileges ]; then blocked "The database grants access the copy cannot carry over ($(named ${WORK}/privileges)); nothing was changed."; fi`,
    `sift -Ev "$(standard "$SOURCE_OWNER")" ${WORK}/source.list > ${WORK}/source.entries || blocked "${UNREADABLE}"`,
    // A materialized view's refresh is data: its rows are compared with every table's, and a dump of definitions alone leaves the statement out.
    `sift -Ev '${ENTRY} MATERIALIZED VIEW DATA ' ${WORK}/source.entries > ${WORK}/source.defined || blocked "${UNREADABLE}"`,
    `pg_restore --schema-only --no-owner --no-privileges -L ${WORK}/source.defined -f ${WORK}/source.rendered ${WORK}/source.dump 2>/dev/null && unkeyed ${WORK}/source.rendered ${WORK}/source.definitions && [ -s ${WORK}/source.definitions ] || blocked "${UNREADABLE}"`,
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
    '  ask "$DATABASE_URL" "GRANT USAGE ON SCHEMA public TO PUBLIC; COMMENT ON SCHEMA public IS \'standard public schema\'" >/dev/null || blocked "The new database could not be cleared."',
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
    // The same text PostgreSQL writes for the source's definitions, whole: no line of it is left out of the comparison.
    `pg_dump --format=custom --schema-only "$DATABASE_URL" > ${WORK}/target.dump 2>/dev/null && pg_restore -l ${WORK}/target.dump > ${WORK}/target.list 2>/dev/null \\`,
    `  && sift -Ev "$(standard "$TARGET_OWNER")" ${WORK}/target.list > ${WORK}/target.entries \\`,
    `  && pg_restore --no-owner --no-privileges -L ${WORK}/target.entries -f ${WORK}/target.rendered ${WORK}/target.dump 2>/dev/null && unkeyed ${WORK}/target.rendered ${WORK}/target.definitions && [ -s ${WORK}/target.definitions ] \\`,
    '  || blocked "The new database\'s definitions could not be read after the copy."',
    'DIFFERENT=',
    'for PART in tables sequences largeobjects extensions definitions; do',
    // Both files must exist: a missing one is a failure of the job, never a difference and never a match.
    `  [ -f ${WORK}/source.$PART ] && [ -f ${WORK}/target.$PART ] || blocked "Part of the comparison was never written."`,
    `  cmp -s ${WORK}/source.$PART ${WORK}/target.$PART || DIFFERENT="$DIFFERENT\${DIFFERENT:+,}\\"$PART\\""`,
    'done',
    `SRC=$(cat ${WORK}/source.summary); DST=$(cat ${WORK}/target.summary)`,
    'count "${SRC%|*}" && count "${SRC#*|}" && count "${DST%|*}" && count "${DST#*|}" || blocked "The copy could not be summarised."',
    'if [ -z "$DIFFERENT" ]; then MATCH=true; else MATCH=false; fi',
    'side() { printf \'{"tables":%s,"rows":"%s","version":"%s","sequences":%s,"largeObjects":%s}\' "${2%|*}" "${2#*|}" "$3" "$(lines "$1.sequences")" "$(lines "$1.largeobjects")"; }',
    'DONE=1',
    `printf '${RESULT_MARKER}{"ok":true,"match":%s,"different":[%s],"source":%s,"target":%s,"dumpSeconds":%s,"restoreSeconds":%s,"dumpBytes":%s}\\n' \\`,
    `  "$MATCH" "$DIFFERENT" "$(side ${WORK}/source "$SRC" "$SRC_VERSION")" "$(side ${WORK}/target "$DST" "$DST_VERSION")" "$((DUMPED - STARTED))" "$((RESTORED - DUMPED))" "$(wc -c < ${WORK}/source.dump | tr -d ' ')"`,
  ].join('\n');
}

interface MoveSideCounts { tables: number; rows: string; version: string; sequences: number; largeObjects: number }

export interface DatabaseMoveCopyResult {
  ok: boolean;
  /** Set on failure: how far the job got, and whether the target was written to. */
  stage?: 'check' | 'dump' | 'reset' | 'restore' | 'verify';
  targetChanged?: boolean;
  error?: string;
  match?: boolean;
  /** Which parts of the copy differ from the source: tables, sequences, largeobjects, extensions, definitions. */
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
 * True only for a finished copy whose every part matched and
 * whose every count is present on both sides and equal. Anything missing is
 * never read as "the same".
 */
export function databaseMoveCopyVerified(result: DatabaseMoveCopyResult | undefined): boolean {
  if (!result || result.ok !== true || result.match !== true || !Array.isArray(result.different) || result.different.length !== 0) return false;
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
      // The target is always a database the move itself made and no app ever wrote to, so what an earlier, unfinished copy left in it may be cleared.
      MOVE_RESET_TARGET: '1', ...(params.blockExtensions ? { MOVE_BLOCK_EXTENSIONS: '1' } : {}),
      ...(ignored.length ? { MOVE_IGNORED_GRANTEES: ignored.join(',') } : {}) },
    sourceSecrets: {},
    secretRefs: { SOURCE_DATABASE_URL: params.source.secret, DATABASE_URL: params.target.secret },
    cloudSqlConnectionName: params.target.connectionName, sourceCloudSqlConnectionName: params.source.connectionName,
    timeoutSeconds: params.timeoutSeconds ?? 3600,
  };
}
