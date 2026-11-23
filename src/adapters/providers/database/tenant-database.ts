import { scramVerifier } from '../../../utils/scram.js';

/**
 * Tenant databases on one shared PostgreSQL server.
 *
 * A tenant is one environment's PostgreSQL database with its own owner role and
 * two logins that take turns, so a password can be rotated with no downtime.
 * Tenants cannot open each other's databases. Everything here is plain SQL over
 * a privileged session the caller supplies: this module knows nothing about any
 * cloud, about how the session was opened, or about where passwords are kept.
 *
 * Ownership is never inferred from a name. Each role is created together with a
 * comment naming its tenant, and the database carries the same comment. Nothing
 * is changed or dropped unless those markers match the caller's tenant id.
 *
 * The administrator needs only CREATEROLE and CREATEDB (it need not be a
 * superuser), and must be the same login every time: on PostgreSQL 16 and later
 * only the role that created a role may manage it.
 *
 * In the finished state the administrator owns the database and the tenant's
 * owner role owns its `public` schema. The tenant can therefore create tables,
 * schemas and trusted extensions, but cannot drop the database, lift its
 * connection limit, reopen it to other roles or change its marker.
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
  /** A privileged session on the server's maintenance database (never a tenant's). */
  admin: TenantSession;
  /** Runs `work` in a privileged session connected to the named database, then closes it. Used once, while a database is being created. */
  inDatabase<T>(database: string, work: (session: TenantSession) => Promise<T>): Promise<T>;
}

export interface TenantIdentity {
  names: TenantNames;
  /** The caller's stable id for the environment; recorded on the database and its roles. */
  tenantId: string;
}

/** The tenant is not there, or something with its name belongs to someone else. Nothing was changed. */
export class TenantRefusedError extends Error {
  constructor(readonly standing: 'absent' | 'foreign', message: string) {
    super(message);
    this.name = 'TenantRefusedError';
  }
}

const MARKER_PREFIX = 'hypervibe-tenant:';
const KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const KEY_MAX = 40;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERIFIER = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
export const TENANT_CONNECTION_LIMIT_MAX = 10_000;

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
function checked(identity: TenantIdentity): { names: TenantNames; marker: string } {
  const given = identity?.names;
  const database = typeof given?.database === 'string' ? given.database : '';
  const names = tenantNames(database.startsWith('app_') ? database.slice(4) : '');
  if (given.owner !== names.owner || !Array.isArray(given.logins) || given.logins.length !== 2 || given.logins[0] !== names.logins[0] || given.logins[1] !== names.logins[1]) {
    throw new Error('The tenant names do not belong together.');
  }
  if (typeof identity.tenantId !== 'string' || !TENANT_ID.test(identity.tenantId)) throw new Error('A tenant id must be 1 to 128 letters, digits, dots, colons, hyphens and underscores.');
  return { names, marker: `${MARKER_PREFIX}${identity.tenantId}` };
}

function checkedLogin(names: TenantNames, login: string): string {
  if (login !== names.logins[0] && login !== names.logins[1]) throw new Error('That login does not belong to this tenant.');
  return login;
}

const ident = (name: string): string => {
  if (!/^app_[a-z0-9_]{1,59}$/.test(name)) throw new Error('Unsafe SQL identifier.');
  return `"${name}"`;
};
const literal = (value: string): string => {
  if (!/^[A-Za-z0-9._:$+/=-]+$/.test(value)) throw new Error('Unsafe SQL literal.');
  return `'${value}'`;
};

type Standing = 'absent' | 'ours' | 'foreign';

interface RoleState {
  name: string;
  standing: Standing;
  /** Has any of SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. */
  elevated: boolean;
  canLogin: boolean;
  /** The administrator holds this role's privileges and may act as it. */
  held: boolean;
  /** This role holds the owner role's privileges and may act as it. */
  actsAsOwner: boolean;
  /** This role switches to the owner role on every connection. */
  defaultsToOwner: boolean;
}

interface DatabaseState {
  standing: Standing;
  marked: boolean;
  adminOwned: boolean;
  publicAccess: boolean;
  ownerAccess: boolean;
  connectionLimit: number;
}

interface TenantState { v16: boolean; roles: RoleState[]; database: DatabaseState }

const ABSENT_DATABASE: DatabaseState = { standing: 'absent', marked: false, adminOwned: false, publicAccess: false, ownerAccess: false, connectionLimit: -1 };

async function observe(admin: TenantSession, names: TenantNames, marker: string): Promise<TenantState> {
  const version = await admin.query(`SELECT current_setting('server_version_num')::int >= 160000 AS v16`);
  const v16 = version.rows[0]?.v16 === true;
  // PostgreSQL 16 separated "may act as" (SET) from "has the privileges of" (USAGE); both are needed.
  const holds = (member: string, role: string) => `(pg_has_role(${member}, ${role}, 'USAGE')${v16 ? ` AND pg_has_role(${member}, ${role}, 'SET')` : ''})`;
  const roleNames = [names.owner, ...names.logins];
  const found = await admin.query(
    `SELECT r.rolname AS name, shobj_description(r.oid, 'pg_authid') AS comment,
       (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
       r.rolcanlogin AS can_login, ${holds('current_user', 'r.oid')} AS held,
       COALESCE((SELECT ${holds('r.oid', 'o.oid')} FROM pg_roles o WHERE o.rolname = $1::text), false) AS acts_as_owner,
       COALESCE(('role=' || $1::text) = ANY (r.rolconfig), false) AS defaults_to_owner
     FROM pg_roles r WHERE r.rolname IN ($1::text, $2::text, $3::text)`, roleNames);
  const roles = roleNames.map((name): RoleState => {
    const row = found.rows.find((candidate) => candidate.name === name);
    if (!row) return { name, standing: 'absent', elevated: false, canLogin: false, held: false, actsAsOwner: false, defaultsToOwner: false };
    return {
      name, standing: row.comment === marker ? 'ours' : 'foreign', elevated: row.elevated !== false, canLogin: row.can_login === true,
      held: row.held === true, actsAsOwner: row.acts_as_owner === true, defaultsToOwner: row.defaults_to_owner === true,
    };
  });
  const acl = `aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba)))`;
  const databases = await admin.query(
    `SELECT shobj_description(d.oid, 'pg_database') AS comment, o.rolname AS owner, shobj_description(o.oid, 'pg_authid') AS owner_comment,
       o.rolname = current_user AS admin_owned, d.datconnlimit AS connection_limit,
       EXISTS (SELECT 1 FROM ${acl} a WHERE a.grantee = 0) AS public_access,
       (SELECT count(DISTINCT a.privilege_type) FROM ${acl} a JOIN pg_roles g ON g.oid = a.grantee
         WHERE g.rolname = $2::text AND a.privilege_type IN ('CONNECT', 'TEMPORARY', 'CREATE')) = 3 AS owner_access
     FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba WHERE d.datname = $1::text`, [names.database, names.owner]);
  const row = databases.rows[0];
  if (!row) return { v16, roles, database: ABSENT_DATABASE };
  const marked = row.comment === marker;
  // CREATE DATABASE cannot be made atomic with its comment. A database born owned by this
  // tenant's marked owner role, and not yet commented, is one whose creation was interrupted.
  const unfinished = row.comment === null && row.owner === names.owner && row.owner_comment === marker;
  return {
    v16, roles,
    database: {
      standing: marked || unfinished ? 'ours' : 'foreign', marked, adminOwned: row.admin_owned === true, publicAccess: row.public_access !== false,
      ownerAccess: row.owner_access === true, connectionLimit: Number(row.connection_limit),
    },
  };
}

/** Throws before anything is changed when a role or the database with this tenant's name is someone else's. */
function refuseForeign(state: TenantState, names: TenantNames): void {
  if (state.database.standing === 'foreign') throw new TenantRefusedError('foreign', `Database ${names.database} exists but is not marked as this tenant's. It was left untouched.`);
  for (const role of state.roles) {
    if (role.standing === 'foreign') throw new TenantRefusedError('foreign', `Role ${role.name} exists but is not marked as this tenant's. It was left untouched.`);
    const login = role.name !== names.owner;
    if (role.standing === 'ours' && (role.elevated || role.canLogin !== login)) throw new TenantRefusedError('foreign', `Role ${role.name} no longer has the plain attributes this tenant's roles are created with. It was left untouched.`);
  }
}

function requirePresent(state: TenantState, names: TenantNames): void {
  refuseForeign(state, names);
  if (state.database.standing !== 'ours' || !state.database.marked || state.roles.some((role) => role.standing !== 'ours')) {
    throw new TenantRefusedError('absent', `Tenant ${names.database} is not fully set up on this server.`);
  }
}

const grantRole = (v16: boolean, role: string, member: string) => `GRANT ${ident(role)} TO ${member}${v16 ? ' WITH INHERIT TRUE, SET TRUE' : ''}`;

/**
 * Creates the tenant, or finishes or repairs it. Safe to repeat after an
 * interruption at any point; on a healthy tenant it only reads. It never sets
 * or changes a password: new logins have none and cannot be used until
 * `setTenantLoginPassword` gives them one.
 */
export async function ensureTenant(server: TenantServer, params: TenantIdentity & { connectionLimit: number }): Promise<{ database: 'created' | 'existing' }> {
  const { names, marker } = checked(params);
  const limit = params.connectionLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > TENANT_CONNECTION_LIMIT_MAX) throw new Error(`A tenant's connection limit must be a whole number from 1 to ${TENANT_CONNECTION_LIMIT_MAX}.`);
  const { admin } = server;
  let state = await observe(admin, names, marker);
  refuseForeign(state, names);

  // A role and its marker are created in one statement, so a role with this name is never half ours.
  const missing = state.roles.filter((role) => role.standing === 'absent');
  for (const role of missing) {
    const attributes = `${role.name === names.owner ? 'NOLOGIN' : 'LOGIN'} NOCREATEDB NOCREATEROLE INHERIT`;
    await admin.query(`DO $tenant$ BEGIN CREATE ROLE ${ident(role.name)} ${attributes}; COMMENT ON ROLE ${ident(role.name)} IS ${literal(marker)}; END $tenant$`);
  }
  if (missing.length) state = await observe(admin, names, marker);
  for (const role of state.roles) {
    // The administrator acts as the owner role to hand objects over, and must hold a login to end its sessions.
    if (!role.held) await admin.query(grantRole(state.v16, role.name, 'CURRENT_USER'));
    if (role.name === names.owner) continue;
    if (!role.actsAsOwner) await admin.query(grantRole(state.v16, names.owner, ident(role.name)));
    if (!role.defaultsToOwner) await admin.query(`ALTER ROLE ${ident(role.name)} SET role = ${literal(names.owner)}`);
  }

  const database = ident(names.database);
  const before = state.database;
  const created = before.standing === 'absent';
  // Born with no connections allowed: until PUBLIC's default access is revoked, any role on the server could connect.
  if (created) await admin.query(`CREATE DATABASE ${database} OWNER ${ident(names.owner)} CONNECTION LIMIT 0`);
  const now: DatabaseState = created ? { standing: 'ours', marked: false, adminOwned: false, publicAccess: true, ownerAccess: false, connectionLimit: 0 } : before;
  if (now.publicAccess) await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  if (now.connectionLimit !== limit) await admin.query(`ALTER DATABASE ${database} CONNECTION LIMIT ${limit}`);
  if (!now.marked) {
    await server.inDatabase(names.database, async (session) => {
      const found = await session.query(
        `SELECT pg_get_userbyid(n.nspowner) AS owner, pg_has_role(current_user, n.nspowner, 'USAGE') AS held,
           has_schema_privilege($1::name, n.oid, 'CREATE') AND has_schema_privilege($1::name, n.oid, 'USAGE') AS usable
         FROM pg_namespace n WHERE n.nspname = 'public'`, [names.owner]);
      const schema = found.rows[0];
      if (!schema || schema.owner === names.owner) return;
      // PostgreSQL 15 and later give `public` to the database owner. Older versions leave it with the
      // bootstrap superuser, which this administrator cannot change; there every role may create in it anyway.
      if (schema.held === true) await session.query(`ALTER SCHEMA public OWNER TO ${ident(names.owner)}`);
      else if (schema.usable !== true) throw new Error(`The public schema of ${names.database} cannot be given to its tenant.`);
    });
    // The marker is written only after the schema step, so a marked database never needs that connection again.
    await admin.query(`COMMENT ON DATABASE ${database} IS ${literal(marker)}`);
  }
  if (!now.adminOwned) await admin.query(`ALTER DATABASE ${database} OWNER TO CURRENT_USER`);
  // Changing the owner removes the previous owner's privileges, so they are granted afterwards.
  if (!now.adminOwned || !now.ownerAccess) await admin.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO ${ident(names.owner)}`);
  return { database: created ? 'created' : 'existing' };
}

/**
 * Rotation, step one: gives one login a new password. The other login keeps
 * working. Only a SCRAM verifier enters the SQL text, never the password.
 */
export async function setTenantLoginPassword(server: TenantServer, params: TenantIdentity & { login: string; password: string }): Promise<void> {
  const { names, marker } = checked(params);
  const login = checkedLogin(names, params.login);
  if (typeof params.password !== 'string' || params.password.length < 16) throw new Error('A tenant login password must be at least 16 characters.');
  const verifier = scramVerifier(params.password);
  if (!VERIFIER.test(verifier)) throw new Error('Unexpected SCRAM verifier format.');
  requirePresent(await observe(server.admin, names, marker), names);
  try {
    await server.admin.query(`ALTER ROLE ${ident(login)} PASSWORD ${literal(verifier)}`);
  } catch (error) {
    // A driver may attach the statement to its error. Keep only the PostgreSQL error code.
    const code = (error as { code?: unknown } | null)?.code;
    throw new Error(`The password for ${login} could not be set${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (PostgreSQL error ${code})` : ''}.`);
  }
}

/**
 * Rotation, last step: the retired login loses its password and its open
 * sessions are ended. Call it only after the app has moved to the other login.
 */
export async function retireTenantLogin(server: TenantServer, params: TenantIdentity & { login: string }): Promise<void> {
  const { names, marker } = checked(params);
  const login = checkedLogin(names, params.login);
  const state = await observe(server.admin, names, marker);
  requirePresent(state, names);
  if (!state.roles.find((role) => role.name === login)!.held) await server.admin.query(grantRole(state.v16, login, 'CURRENT_USER'));
  await server.admin.query(`ALTER ROLE ${ident(login)} PASSWORD NULL`);
  await server.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`, [login]);
}

/**
 * Removes the tenant's database (ending its connections) and its roles. Only a
 * tenant whose markers match is touched; anything else with its name is
 * refused. Safe to repeat: what is already gone is skipped.
 */
export async function dropTenant(server: TenantServer, params: TenantIdentity): Promise<{ database: 'dropped' | 'absent' }> {
  const { names, marker } = checked(params);
  const { admin } = server;
  const state = await observe(admin, names, marker);
  refuseForeign(state, names);
  const present = state.database.standing === 'ours';
  if (present) {
    // Ending another role's sessions, and dropping a database not yet handed to the administrator, both need that role's privileges.
    for (const role of state.roles) if (role.standing === 'ours' && !role.held) await admin.query(grantRole(state.v16, role.name, 'CURRENT_USER'));
    await admin.query(`DROP DATABASE ${ident(names.database)} WITH (FORCE)`);
  }
  for (const name of [...names.logins, names.owner]) {
    if (state.roles.find((role) => role.name === name)!.standing === 'ours') await admin.query(`DROP ROLE ${ident(name)}`);
  }
  return { database: present ? 'dropped' : 'absent' };
}

/** Every tenant database on the server, read from the server itself. Databases without a valid marker are not tenants and are left out. */
export async function listTenants(server: TenantServer): Promise<Array<TenantIdentity>> {
  const found = await server.admin.query(
    `SELECT d.datname AS database, shobj_description(d.oid, 'pg_database') AS comment, o.rolname AS owner, shobj_description(o.oid, 'pg_authid') AS owner_comment
     FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba WHERE NOT d.datistemplate ORDER BY d.datname`);
  const tenants: TenantIdentity[] = [];
  for (const row of found.rows) {
    const database = String(row.database);
    if (!database.startsWith('app_') || database.length > KEY_MAX + 4 || !KEY.test(database.slice(4))) continue;
    const names = tenantNames(database.slice(4));
    // Same rule as `observe`: the database's own marker, or its marked owner role while creation is unfinished.
    const marker = row.comment ?? (row.owner === names.owner ? row.owner_comment : null);
    if (typeof marker !== 'string' || !marker.startsWith(MARKER_PREFIX)) continue;
    const tenantId = marker.slice(MARKER_PREFIX.length);
    if (TENANT_ID.test(tenantId)) tenants.push({ names, tenantId });
  }
  return tenants;
}
