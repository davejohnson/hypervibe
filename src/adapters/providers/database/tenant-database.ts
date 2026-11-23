import { scramVerifier } from '../../../utils/scram.js';

/**
 * Tenant databases on one shared PostgreSQL server (version 15 or later).
 *
 * A tenant is one environment's PostgreSQL database with its own owner role and
 * two logins that take turns, so a password can be rotated with no downtime.
 * Tenants cannot open each other's databases. Everything here is plain SQL over
 * a privileged session the caller supplies: this module knows nothing about any
 * cloud, about how the session was opened, or about where passwords are kept.
 *
 * Ownership is never inferred from a name. Each role is created together with a
 * comment naming its tenant, and the database carries a comment that also says
 * how far it has got: being created, finished, or being removed. Nothing is
 * changed or dropped unless those markers match the caller's tenant id.
 *
 * The administrator needs only CREATEROLE and CREATEDB (it need not be a
 * superuser), and must be the same login every time: on PostgreSQL 16 and later
 * only the role that created a role may manage it.
 *
 * In the finished state the administrator owns the database and the tenant's
 * owner role owns its `public` schema. The tenant can therefore create tables
 * and schemas, but cannot drop the database, lift its connection limit, reopen
 * it to other roles or change its marker.
 *
 * Every privileged session is pinned to `pg_catalog` before anything else runs,
 * so nothing a tenant creates can be picked up by the administrator's queries.
 * Every function that changes something holds one server-wide advisory lock
 * while it works; see `TenantServer.admin`.
 */

export interface TenantNames {
  database: string;
  /** The role that owns every table, whichever login created it. */
  owner: string;
  logins: readonly [string, string];
}

export interface TenantSession {
  /** Runs one statement. `values` are bound parameters and only ever accompany a SELECT. */
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TenantServer {
  /**
   * A privileged session on the server's maintenance database (never a tenant's).
   * Its `search_path` is changed to `pg_catalog`. Writers are serialized by an
   * advisory lock, and such locks are per database and per session: every caller
   * must use the same maintenance database, and one session must not be shared
   * by calls running at the same time. A lock wait is bounded only by the
   * session's own `lock_timeout`.
   */
  admin: TenantSession;
  /** Runs `work` in a privileged session connected to the named database, then closes it. Used only while a database is being created. */
  inDatabase<T>(database: string, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

export interface TenantIdentity {
  names: TenantNames;
  /** The caller's stable id for the environment; recorded on the database and its roles. */
  tenantId: string;
}

/**
 * What the server itself says about one tenant.
 * - `absent`: no database and no role with its names.
 * - `ready`: finished in every respect; passwords can be set and rotated.
 * - `partial`: something of this tenant's exists, but not a finished tenant.
 * - `foreign`: a database or role with its names is not this tenant's.
 */
export interface TenantObservation extends TenantIdentity {
  state: 'absent' | 'partial' | 'ready' | 'foreign';
  /** `finished` is the database's own marker; only `state: 'ready'` says every grant is also in place. */
  database: 'absent' | 'creating' | 'finished' | 'dropping' | 'foreign';
  /** This tenant's roles that exist. */
  roles: string[];
  /** Roles with this tenant's names that are not its own, or no longer plain. */
  foreignRoles: string[];
}

/** The tenant is not in a state the call accepts, or something with its name belongs to someone else. Nothing was changed. */
export class TenantRefusedError extends Error {
  constructor(readonly standing: 'absent' | 'partial' | 'foreign', message: string) {
    super(message);
    this.name = 'TenantRefusedError';
  }
}

/** The server is older than PostgreSQL 15. Nothing was changed. */
export class TenantServerUnsupportedError extends Error {
  constructor() {
    super('Tenant databases need PostgreSQL 15 or later.');
    this.name = 'TenantServerUnsupportedError';
  }
}

const ROLE_MARKER = 'hypervibe-tenant:';
const DATABASE_MARKERS = { creating: 'hypervibe-tenant-creating:', finished: ROLE_MARKER, dropping: 'hypervibe-tenant-dropping:' } as const;
const KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const KEY_MAX = 40;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERIFIER = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
export const TENANT_CONNECTION_LIMIT_MAX = 10_000;
/** The advisory lock every writer holds, as `pg_advisory_lock(key1, key2)` on the maintenance database: "hvtd", and the plan's issue number. */
export const TENANT_WRITER_LOCK = [0x68767464, 830] as const;
const PIN = `SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false)`;
/** How long a login's sessions are given to end: 50 checks, a tenth of a second apart. */
const SESSION_END_CHECKS = 50;

/**
 * Deterministic identifiers for one environment. The key must already be lower
 * case letters, digits and single underscores: it is rejected, not cleaned up,
 * so two different keys can never produce the same names.
 */
export function tenantNames(key: string): TenantNames {
  if (typeof key !== 'string' || key.length > KEY_MAX || !KEY.test(key)) throw new Error('A tenant key must be 1 to 40 lower case letters, digits and single underscores.');
  return { database: `app_${key}`, owner: `app_${key}_owner`, logins: [`app_${key}_a`, `app_${key}_b`] };
}

/** Only names that `tenantNames` itself produces are accepted, so nothing else can reach SQL text. */
function checked(identity: TenantIdentity): { names: TenantNames; tenantId: string } {
  const given = identity?.names;
  const database = typeof given?.database === 'string' ? given.database : '';
  const names = tenantNames(database.startsWith('app_') ? database.slice(4) : '');
  if (given.owner !== names.owner || !Array.isArray(given.logins) || given.logins.length !== 2 || given.logins[0] !== names.logins[0] || given.logins[1] !== names.logins[1]) {
    throw new Error('The tenant names do not belong together.');
  }
  if (typeof identity.tenantId !== 'string' || !TENANT_ID.test(identity.tenantId)) throw new Error('A tenant id must be 1 to 128 letters, digits, dots, colons, hyphens and underscores.');
  return { names, tenantId: identity.tenantId };
}

function checkedLogin(names: TenantNames, login: string): string {
  if (login !== names.logins[0] && login !== names.logins[1]) throw new Error('That login does not belong to this tenant.');
  return login;
}

function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > TENANT_CONNECTION_LIMIT_MAX) throw new Error(`A tenant's connection limit must be a whole number from 1 to ${TENANT_CONNECTION_LIMIT_MAX}.`);
  return limit;
}

const ident = (name: string): string => {
  if (!/^app_[a-z0-9_]{1,59}$/.test(name)) throw new Error('Unsafe SQL identifier.');
  return `"${name}"`;
};
const literal = (value: string): string => {
  if (!/^[A-Za-z0-9._:$+/=-]+$/.test(value)) throw new Error('Unsafe SQL literal.');
  return `'${value}'`;
};

interface RoleState {
  name: string;
  standing: 'absent' | 'ours' | 'foreign';
  /** The administrator holds this role's privileges and may act as it. */
  held: boolean;
  /** This role holds the owner role's privileges and may act as it. */
  actsAsOwner: boolean;
  /** This role switches to the owner role on every connection. */
  defaultsToOwner: boolean;
  connectionLimit: number;
}

interface DatabaseState {
  stage: TenantObservation['database'];
  /** False only for a database interrupted between its creation and its first comment. */
  commented: boolean;
  adminOwned: boolean;
  publicAccess: boolean;
  ownerAccess: boolean;
  connectionLimit: number;
}

interface TenantState { v16: boolean; roles: RoleState[]; database: DatabaseState }

const ABSENT_DATABASE: DatabaseState = { stage: 'absent', commented: false, adminOwned: false, publicAccess: false, ownerAccess: false, connectionLimit: -1 };

/** Refuses a server older than PostgreSQL 15; true on 16 and later, where role membership has separate options. */
async function supportedServer(admin: TenantSession): Promise<boolean> {
  const server = await admin.query(`SELECT pg_catalog.current_setting('server_version_num')::int AS version`);
  const version = Number(server.rows[0]?.version);
  if (!(version >= 150000)) throw new TenantServerUnsupportedError();
  return version >= 160000;
}

/** Reads the tenant's state. The session must already be pinned to `pg_catalog`. */
async function observe(admin: TenantSession, names: TenantNames, tenantId: string): Promise<TenantState> {
  const v16 = await supportedServer(admin);
  // PostgreSQL 16 separated "may act as" (SET) from "has the privileges of" (USAGE); both are needed.
  const holds = (member: string, role: string) => `(pg_catalog.pg_has_role(${member}, ${role}, 'USAGE')${v16 ? ` AND pg_catalog.pg_has_role(${member}, ${role}, 'SET')` : ''})`;
  const roleMarker = `${ROLE_MARKER}${tenantId}`;
  const roleNames = [names.owner, ...names.logins];
  const found = await admin.query(
    `SELECT r.rolname AS name, pg_catalog.shobj_description(r.oid, 'pg_authid') AS comment,
       (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
       r.rolcanlogin AS can_login, r.rolconnlimit AS connection_limit, ${holds('current_user', 'r.oid')} AS held,
       COALESCE((SELECT ${holds('r.oid', 'o.oid')} FROM pg_catalog.pg_roles o WHERE o.rolname = $1::text), false) AS acts_as_owner,
       COALESCE(('role=' || $1::text) = ANY (r.rolconfig), false) AS defaults_to_owner
     FROM pg_catalog.pg_roles r WHERE r.rolname IN ($1::text, $2::text, $3::text)`, roleNames);
  const roles = roleNames.map((name): RoleState => {
    const row = found.rows.find((candidate) => candidate.name === name);
    if (!row) return { name, standing: 'absent', held: false, actsAsOwner: false, defaultsToOwner: false, connectionLimit: -1 };
    // A role of ours that gained server-wide powers, or whose login attribute changed, is no longer the role this module made.
    const plain = row.elevated === false && row.can_login === (name !== names.owner);
    return {
      name, standing: row.comment === roleMarker && plain ? 'ours' : 'foreign', held: row.held === true,
      actsAsOwner: row.acts_as_owner === true, defaultsToOwner: row.defaults_to_owner === true, connectionLimit: Number(row.connection_limit),
    };
  });
  const acl = `pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba)))`;
  const databases = await admin.query(
    `SELECT pg_catalog.shobj_description(d.oid, 'pg_database') AS comment, o.rolname AS owner, o.rolname = current_user AS admin_owned,
       d.datconnlimit AS connection_limit,
       EXISTS (SELECT 1 FROM ${acl} a WHERE a.grantee = 0::oid) AS public_access,
       (SELECT count(DISTINCT a.privilege_type) FROM ${acl} a JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
         WHERE g.rolname = $2::text AND a.privilege_type IN ('CONNECT', 'TEMPORARY', 'CREATE')) = 3::bigint AS owner_access
     FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid = d.datdba WHERE d.datname = $1::text`, [names.database, names.owner]);
  const row = databases.rows[0];
  if (!row) return { v16, roles, database: ABSENT_DATABASE };
  const adminOwned = row.admin_owned === true;
  const connectionLimit = Number(row.connection_limit);
  // Only the administrator, or this tenant's own marked owner role, may own a database that counts as this tenant's.
  const ownerRoleOwned = row.owner === names.owner && roles[0]!.standing === 'ours';
  let stage: DatabaseState['stage'] = 'foreign';
  if (adminOwned || ownerRoleOwned) {
    for (const [name, prefix] of Object.entries(DATABASE_MARKERS)) if (row.comment === `${prefix}${tenantId}`) stage = name as keyof typeof DATABASE_MARKERS;
  }
  // CREATE DATABASE cannot be made atomic with its comment. Only the exact state a database is born in (owned by the
  // tenant's marked owner role, no connections allowed, no comment) is accepted as that interruption; a database
  // restored or made by hand with the same name is not.
  if (row.comment === null && ownerRoleOwned && connectionLimit === 0) stage = 'creating';
  return {
    v16, roles,
    database: { stage, commented: row.comment !== null, adminOwned, publicAccess: row.public_access !== false, ownerAccess: row.owner_access === true, connectionLimit },
  };
}

function isReady(state: TenantState, names: TenantNames): boolean {
  const { database } = state;
  return database.stage === 'finished' && database.adminOwned && !database.publicAccess && database.ownerAccess
    && state.roles.every((role) => role.standing === 'ours' && role.held && (role.name === names.owner || (role.actsAsOwner && role.defaultsToOwner)));
}

function describe(identity: { names: TenantNames; tenantId: string }, state: TenantState): TenantObservation {
  const roles = state.roles.filter((role) => role.standing === 'ours').map((role) => role.name);
  const foreignRoles = state.roles.filter((role) => role.standing === 'foreign').map((role) => role.name);
  const stage = state.database.stage;
  let overall: TenantObservation['state'] = 'partial';
  if (stage === 'foreign' || foreignRoles.length) overall = 'foreign';
  else if (stage === 'absent' && !roles.length) overall = 'absent';
  else if (isReady(state, identity.names)) overall = 'ready';
  return { names: identity.names, tenantId: identity.tenantId, state: overall, database: stage, roles, foreignRoles };
}

/** Throws before anything is changed when a role or the database with this tenant's name is someone else's. */
function refuseForeign(state: TenantState, names: TenantNames): void {
  if (state.database.stage === 'foreign') throw new TenantRefusedError('foreign', `Database ${names.database} exists but is not this tenant's. It was left untouched.`);
  for (const role of state.roles) {
    if (role.standing === 'foreign') throw new TenantRefusedError('foreign', `Role ${role.name} exists but is not this tenant's, or no longer has the plain attributes it was created with. It was left untouched.`);
  }
}

function requireReady(state: TenantState, names: TenantNames): void {
  refuseForeign(state, names);
  if (isReady(state, names)) return;
  const nothing = state.database.stage === 'absent' && state.roles.every((role) => role.standing === 'absent');
  throw new TenantRefusedError(nothing ? 'absent' : 'partial', nothing ? `Tenant ${names.database} does not exist on this server.` : `Tenant ${names.database} is not finished. Finish creating or removing it first.`);
}

/** Pins the session, then runs `work` while holding the writers' lock. The state must be read inside `work`. */
async function exclusively<T>(admin: TenantSession, work: () => Promise<T>): Promise<T> {
  const [key1, key2] = TENANT_WRITER_LOCK;
  try {
    await admin.query(PIN);
    await admin.query(`SELECT pg_catalog.pg_advisory_lock(${key1}, ${key2})`);
    return await work();
  } finally {
    // If this fails the session is gone, and the lock went with it.
    await admin.query(`SELECT pg_catalog.pg_advisory_unlock(${key1}, ${key2})`).catch(() => {});
  }
}

const grantRole = (v16: boolean, role: string, member: string) => `GRANT ${ident(role)} TO ${member}${v16 ? ' WITH INHERIT TRUE, SET TRUE' : ''}`;

/** Takes a login's password away and ends its sessions, waiting a bounded time; returns how many sessions are still there. */
async function disableLogin(admin: TenantSession, v16: boolean, role: RoleState): Promise<number> {
  // Ending another role's sessions needs that role's privileges.
  if (!role.held) await admin.query(grantRole(v16, role.name, 'CURRENT_USER'));
  await admin.query(`ALTER ROLE ${ident(role.name)} PASSWORD NULL`);
  await admin.query(`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1::name AND pid <> pg_catalog.pg_backend_pid()`, [role.name]);
  for (let check = 1; ; check++) {
    const sessions = await admin.query(`SELECT count(*)::int AS remaining FROM pg_catalog.pg_stat_activity WHERE usename = $1::name`, [role.name]);
    const remaining = Number(sessions.rows[0]?.remaining);
    if (remaining === 0 || check >= SESSION_END_CHECKS) return remaining;
    await admin.query(`SELECT pg_catalog.pg_sleep(0.1)`);
  }
}

/** Read-only: what exists for this tenant and whether it is finished. Takes no lock. */
export async function observeTenant(server: TenantServer, params: TenantIdentity): Promise<TenantObservation> {
  const identity = checked(params);
  await server.admin.query(PIN);
  return describe(identity, await observe(server.admin, identity.names, identity.tenantId));
}

/**
 * Finishes or repairs the tenant, and creates it when `allocate` is true. Safe
 * to repeat after an interruption at any point; on a ready tenant it only reads.
 *
 * Without `allocate` it never creates a database: a missing database is
 * refused, so a lost database is not quietly replaced by an empty one. With
 * `allocate`, roles left over from an earlier database first lose their
 * passwords and sessions, so no existing credential opens the new database.
 *
 * It never sets a password: new logins have none until `setTenantLoginPassword`.
 * `connectionLimit` caps the tenant's database and, separately, each login
 * across the whole server.
 */
export async function ensureTenant(server: TenantServer, params: TenantIdentity & { connectionLimit: number; allocate: boolean }): Promise<{ database: 'created' | 'existing' }> {
  const { names, tenantId } = checked(params);
  const limit = checkedLimit(params.connectionLimit);
  const { admin } = server;
  return exclusively(admin, async () => {
    let state = await observe(admin, names, tenantId);
    refuseForeign(state, names);
    if (state.database.stage === 'dropping') throw new TenantRefusedError('partial', `Tenant ${names.database} is being removed. Finish removing it before creating it again.`);
    const create = state.database.stage === 'absent';
    const leftover = state.roles.filter((role) => role.standing === 'ours');
    if (create && !params.allocate) {
      throw new TenantRefusedError(leftover.length ? 'partial' : 'absent', leftover.length
        ? `Tenant ${names.database} has roles but no database. A new, empty database is created only when allocating.`
        : `Tenant ${names.database} does not exist on this server.`);
    }
    if (create) for (const role of leftover) if (role.name !== names.owner) await disableLogin(admin, state.v16, role);

    // A role and its marker are created in one statement, so a role with this name is never half ours.
    const roleMarker = literal(`${ROLE_MARKER}${tenantId}`);
    const missing = state.roles.filter((role) => role.standing === 'absent');
    for (const role of missing) {
      const attributes = role.name === names.owner ? 'NOLOGIN NOCREATEDB NOCREATEROLE INHERIT' : `LOGIN NOCREATEDB NOCREATEROLE INHERIT CONNECTION LIMIT ${limit}`;
      await admin.query(`DO $tenant$ BEGIN CREATE ROLE ${ident(role.name)} ${attributes}; COMMENT ON ROLE ${ident(role.name)} IS ${roleMarker}; END $tenant$`);
    }
    if (missing.length) state = await observe(admin, names, tenantId);
    for (const role of state.roles) {
      // The administrator acts as the owner role to hand objects over, and must hold a login to end its sessions.
      if (!role.held) await admin.query(grantRole(state.v16, role.name, 'CURRENT_USER'));
      if (role.name === names.owner) continue;
      if (!role.actsAsOwner) await admin.query(grantRole(state.v16, names.owner, ident(role.name)));
      if (!role.defaultsToOwner) await admin.query(`ALTER ROLE ${ident(role.name)} SET role = ${literal(names.owner)}`);
      // A database's own limit does not count sessions the login opens elsewhere on the server; this one does.
      if (role.connectionLimit !== limit) await admin.query(`ALTER ROLE ${ident(role.name)} CONNECTION LIMIT ${limit}`);
    }

    const database = ident(names.database);
    // Copied from template0, which nobody can connect to or change: nothing left in template1 comes along, and a
    // session on template1 cannot block the copy. Born with no connections allowed and owned by the owner role.
    if (create) await admin.query(`CREATE DATABASE ${database} OWNER ${ident(names.owner)} TEMPLATE template0 CONNECTION LIMIT 0`);
    const now: DatabaseState = create ? { stage: 'creating', commented: false, adminOwned: false, publicAccess: true, ownerAccess: false, connectionLimit: 0 } : state.database;
    const finished = now.stage === 'finished';
    // Marked as being created before anything else changes, so from here on it is recognised by its comment alone.
    if (!now.commented) await admin.query(`COMMENT ON DATABASE ${database} IS ${literal(`${DATABASE_MARKERS.creating}${tenantId}`)}`);
    if (now.publicAccess) await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    // From here the administrator can connect. Nobody else can: PUBLIC is revoked and the logins have no password yet.
    if (now.connectionLimit !== limit) await admin.query(`ALTER DATABASE ${database} CONNECTION LIMIT ${limit}`);
    if (!finished) {
      await server.inDatabase(names.database, async (session) => {
        await session.query(PIN);
        const found = await session.query(`SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'`);
        if (!found.rows[0]) throw new Error(`Database ${names.database} has no public schema to give to its tenant.`);
        // `public` belongs to "the database owner", which is about to become the administrator; name the tenant's owner role instead.
        if (found.rows[0].owner !== names.owner) await session.query(`ALTER SCHEMA public OWNER TO ${ident(names.owner)}`);
      });
    }
    if (!now.adminOwned) await admin.query(`ALTER DATABASE ${database} OWNER TO CURRENT_USER`);
    // Changing the owner removes the previous owner's privileges, so they are granted afterwards.
    if (!now.adminOwned || !now.ownerAccess) await admin.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO ${ident(names.owner)}`);
    // The finished marker comes last: it is what lets passwords be set.
    if (!finished) await admin.query(`COMMENT ON DATABASE ${database} IS ${literal(`${DATABASE_MARKERS.finished}${tenantId}`)}`);
    return { database: create ? 'created' : 'existing' };
  });
}

/**
 * Rotation, step one: gives one login of a ready tenant a new password. The
 * other login keeps working. Only a SCRAM verifier enters the SQL text, never
 * the password.
 */
export async function setTenantLoginPassword(server: TenantServer, params: TenantIdentity & { login: string; password: string }): Promise<void> {
  const { names, tenantId } = checked(params);
  const login = checkedLogin(names, params.login);
  if (typeof params.password !== 'string' || params.password.length < 16) throw new Error('A tenant login password must be at least 16 characters.');
  const verifier = scramVerifier(params.password);
  if (!VERIFIER.test(verifier)) throw new Error('Unexpected SCRAM verifier format.');
  await exclusively(server.admin, async () => {
    requireReady(await observe(server.admin, names, tenantId), names);
    try {
      await server.admin.query(`ALTER ROLE ${ident(login)} PASSWORD ${literal(verifier)}`);
    } catch (error) {
      // A driver may attach the statement to its error. Keep only the PostgreSQL error code.
      const code = (error as { code?: unknown } | null)?.code;
      throw new Error(`The password for ${login} could not be set${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (PostgreSQL error ${code})` : ''}.`);
    }
  });
}

/**
 * Rotation, last step: the retired login of a ready tenant loses its password
 * and its open sessions are ended. Call it only after the app has moved to the
 * other login. `remainingSessions` is above zero when sessions had not ended
 * within about five seconds; the password is gone either way.
 */
export async function retireTenantLogin(server: TenantServer, params: TenantIdentity & { login: string }): Promise<{ remainingSessions: number }> {
  const { names, tenantId } = checked(params);
  const login = checkedLogin(names, params.login);
  return exclusively(server.admin, async () => {
    const state = await observe(server.admin, names, tenantId);
    requireReady(state, names);
    return { remainingSessions: await disableLogin(server.admin, state.v16, state.roles.find((role) => role.name === login)!) };
  });
}

/**
 * Removes the tenant: marks its database as being removed, disables its logins
 * (no password, sessions ended), drops the database, then drops the roles. Only
 * a tenant whose markers match is touched. Safe to repeat.
 *
 * A role that something elsewhere on the server still depends on (an object it
 * owns in another database, a grant another tenant gave it) cannot be dropped.
 * That is reported in `remainingRoles`, not thrown: those roles are disabled,
 * stay in the inventory, and a repeat removes them once the dependency is gone.
 */
export async function dropTenant(server: TenantServer, params: TenantIdentity): Promise<{ database: 'dropped' | 'absent'; remainingRoles: string[] }> {
  const { names, tenantId } = checked(params);
  const { admin } = server;
  return exclusively(admin, async () => {
    const state = await observe(admin, names, tenantId);
    refuseForeign(state, names);
    const present = state.database.stage !== 'absent';
    const ours = state.roles.filter((role) => role.standing === 'ours');
    // Dropping a database not yet handed to the administrator needs the owner role's privileges.
    for (const role of ours) if (!role.held) await admin.query(grantRole(state.v16, role.name, 'CURRENT_USER'));
    if (present && state.database.stage !== 'dropping') await admin.query(`COMMENT ON DATABASE ${ident(names.database)} IS ${literal(`${DATABASE_MARKERS.dropping}${tenantId}`)}`);
    // Credentials go first, so no later failure leaves a working login behind.
    const busy = new Set<string>();
    for (const role of ours) if (role.name !== names.owner && await disableLogin(admin, state.v16, { ...role, held: true }) > 0) busy.add(role.name);
    if (present) await admin.query(`DROP DATABASE ${ident(names.database)} WITH (FORCE)`);
    const remainingRoles = [...busy];
    for (const name of [...names.logins, names.owner]) {
      if (busy.has(name) || !ours.some((role) => role.name === name)) continue;
      try {
        await admin.query(`DROP ROLE ${ident(name)}`);
      } catch (error) {
        // 2BP01: other objects still depend on the role. Anything else is a real failure.
        if ((error as { code?: unknown } | null)?.code !== '2BP01') throw error;
        remainingRoles.push(name);
      }
    }
    return { database: present ? 'dropped' : 'absent', remainingRoles };
  });
}

/**
 * Everything on the server that carries a tenant marker, read from the server
 * itself: finished tenants, and tenants that exist only in part (roles without
 * a database, a database being created or removed). An empty list means
 * nothing made by this module is on the server.
 */
export async function listTenants(server: TenantServer): Promise<TenantObservation[]> {
  const { admin } = server;
  await admin.query(PIN);
  await supportedServer(admin);
  const found = await admin.query(
    `SELECT 'database' AS kind, d.datname::text AS name, pg_catalog.shobj_description(d.oid, 'pg_database') AS comment FROM pg_catalog.pg_database d
     UNION ALL SELECT 'role', r.rolname::text, pg_catalog.shobj_description(r.oid, 'pg_authid') FROM pg_catalog.pg_roles r`);
  const claims = new Map<string, TenantIdentity>();
  for (const row of found.rows) {
    const name = String(row.name);
    const comment = typeof row.comment === 'string' ? row.comment : '';
    const prefix = (row.kind === 'database' ? Object.values(DATABASE_MARKERS) : [ROLE_MARKER]).find((candidate) => comment.startsWith(candidate));
    const key = row.kind === 'database' ? name.slice(4) : name.slice(4).replace(/_(?:owner|a|b)$/, '');
    if (prefix === undefined || !name.startsWith('app_') || key.length > KEY_MAX || !KEY.test(key)) continue;
    const names = tenantNames(key);
    const tenantId = comment.slice(prefix.length);
    if (!TENANT_ID.test(tenantId) || ![names.database, names.owner, ...names.logins].includes(name)) continue;
    claims.set(`${names.database} ${tenantId}`, { names, tenantId });
  }
  const tenants: TenantObservation[] = [];
  for (const key of [...claims.keys()].sort()) {
    const identity = claims.get(key)!;
    const seen = describe(identity, await observe(admin, identity.names, identity.tenantId));
    if (seen.state !== 'absent') tenants.push(seen);
  }
  return tenants;
}
