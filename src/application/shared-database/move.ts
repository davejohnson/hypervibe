import type { GcpDatabaseConnection } from '../../adapters/providers/gcp/tofu/gcp-database-connection.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { POSTGRES_DATABASE_IDENTITY_SQL, parsePostgresDatabaseIdentity } from '../../domain/services/postgres-database-identity.js';
import { DATABASE_MOVE_FACTS, DATABASE_MOVE_PRIVILEGES, databaseMoveCopyJob, databaseMoveCopyVerified, databaseMoveFactsProblem, type DatabaseMoveCopyResult } from '../database-move-copy.js';
import type { GcpDatabaseBinding } from '../gcp-database-location.js';
import { databaseCopySecretId, parseConnectionUrl } from '../infrastructure-engine-database.js';
import { blocked } from './administrator.js';
import { pauseDatabase, resumeDatabase, type PauseContext } from './pause.js';
import type { SharedDatabaseCloud } from './ports.js';
import { SHARED_SERVER_MAJOR_VERSION, findSharedServer, type SharedServerScope } from './server.js';
import { SHARED_DATABASE_OPERATION, credentialState, recordedAllocation, tenantFor, type RunningSecretVersions, type SharedDatabaseRecord, type StepMetadata } from './tenancy.js';

/**
 * Moving one environment's database from the app's shared server to a server
 * of its own. Three ordinary plans, and the stage is read from what exists:
 *
 * 1. `prepare`: the record still says "shared" and the environment's own
 *    server, database, logins or connection secret are not all there. The
 *    caller plans them exactly as for an environment that always had its own
 *    server, while its workloads stay on the shared database.
 * 2. `switch`: all of that exists. One step shuts the app out of the shared
 *    database, copies it, checks the copy and only then changes the record to
 *    "own server"; the caller's workload changes follow it. A failure before
 *    the record changes lets the app back in. After it, the environment simply
 *    is one with its own server, and any later plan finishes what is left.
 * 3. `cleanup`: the record says "own server, moved from the shared one". Once
 *    every workload runs the new connection, the old database is deleted with
 *    the same step that deletes any database on the shared server.
 *
 * Nothing is kept about the move but two notes on the environment's database
 * record: `move` (the own server chosen for it) and `movedFrom` (the shared
 * record, until clean-up).
 */
export interface DatabaseMove {
  stage: 'prepare' | 'switch' | 'cleanup';
  /** The environment's own server, once one was chosen. */
  instanceName?: string;
  /** prepare: what the workloads stay connected to, and whether the environment's connection secret already holds its own server's login. */
  workloads?: { connection: GcpDatabaseConnection; secretVersion: string };
  ownSecretWritten?: boolean;
  /** Secrets the move needs beside the environment's own while it runs. */
  secretIds: string[];
  /** switch: runs before any workload changes. cleanup: runs after everything else. */
  actions: PlanAction[];
  warnings: string[];
  reviewed: Record<string, unknown>;
}

export interface MovePlanRequest {
  environment: { id: string; name: string };
  binding: GcpDatabaseBinding | undefined;
  desired: { version?: number; passwordGeneration?: number };
  scope: SharedServerScope;
  secret: { id: string; labels: Record<string, string> };
  runningSecretVersions: RunningSecretVersions;
  cloud: SharedDatabaseCloud;
}

/** A dump is held in the copy job's memory-backed working space (4 GiB with everything else it holds). */
const LARGEST_DATABASE_BYTES = 2 * 1024 ** 3;
const resource = { kind: 'database' as const, name: 'postgres', provider: 'gcp' };
const shown = (bytes: number): string => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);
const withoutMove = (record: SharedDatabaseRecord): SharedDatabaseRecord => { const { move: _move, ...rest } = record; return rest; };

export async function planMove(request: MovePlanRequest): Promise<DatabaseMove> {
  const { environment, binding, cloud, scope, secret, desired } = request;
  const name = environment.name;
  const record = binding!.database!;
  const identity = tenantFor(environment, binding);
  if (recordedAllocation(binding, identity) !== 'finished') throw blocked(`${name}'s database on the app's shared database server is not fully set up, so it cannot be moved. Keep "placement": "app" on it, run hv_plan and hv_apply, then move it.`);
  if ((binding as { migration?: unknown }).migration) throw blocked(`${name} is part of a migration. Finish that before moving its database to a server of its own.`);
  if (desired.version !== undefined && desired.version !== SHARED_SERVER_MAJOR_VERSION) {
    throw blocked(`The app's shared database server runs PostgreSQL ${SHARED_SERVER_MAJOR_VERSION}, and a move keeps the version. Remove "version" from ${name}'s database (or set it to ${SHARED_SERVER_MAJOR_VERSION}) for the move.`);
  }
  const listed = await cloud.listServers(scope.gcpProjectId);
  if (listed.state === 'unknown') throw blocked(listed.reason);
  const found = findSharedServer(listed.servers, scope);
  if (found.state !== 'present' || found.server.instanceName !== record.instanceName) throw blocked(`${name}'s database is recorded on shared database server ${record.instanceName}, which was not found in ${scope.gcpProjectId}. Nothing was planned.`);

  const seen = await cloud.observeConnectionSecret(scope.gcpProjectId, secret.id);
  const onShared = credentialState(seen, { secretId: secret.id, environmentLabel: secret.labels['hv-environment'] ?? '', instanceName: record.instanceName, names: identity.names });
  const generation = desired.passwordGeneration ?? 1;
  const connection: GcpDatabaseConnection = { connectionName: `${scope.gcpProjectId}:${scope.region}:${record.instanceName}`, wireServices: true,
    workerQuery: { projectId: scope.gcpProjectId, instanceName: record.instanceName, databaseName: identity.names.database } };
  const copySecretId = databaseCopySecretId(secret.id);
  const reviewed = { instanceName: record.instanceName };
  const steps = `This is a move in three steps, each its own hv_plan and hv_apply: (1) create ${name}'s own database server, (2) copy the data and switch the app over, (3) delete the old database from the shared server.`;
  const prepare = (secretVersion: string, ownSecretWritten: boolean): DatabaseMove => ({
    stage: 'prepare', ...(record.move ? { instanceName: record.move.instanceName } : {}), workloads: { connection, secretVersion }, ownSecretWritten, secretIds: [copySecretId], actions: [], reviewed,
    warnings: [`${steps} This plan is step 1: ${name}'s app keeps using its database on the shared server and is not interrupted. Run hv_plan again afterwards for step 2.`] });

  if (onShared.ready) {
    // The connection secret still holds the shared database's login: nothing of the environment's own has been stored yet.
    if (onShared.login !== record.activeLogin) throw blocked(`${name}'s connection secret does not hold the login recorded for its database. Keep "placement": "app" on it, run hv_plan and hv_apply, then move it.`);
    if (onShared.retirePending || onShared.generation < generation) throw blocked(`${name}'s database password is being changed. Finish that first (keep "placement": "app", then hv_plan and hv_apply until nothing is left), then move the database.`);
    // Whether this database can be moved at all is found out now, read as the app itself, before a server is created and paid for.
    const pinned = await cloud.readSecretVersion(scope.gcpProjectId, secret.id, onShared.latestVersion!);
    const held = pinned.state === 'present' ? parseConnectionUrl(pinned.value) : undefined;
    if (!held || held.login !== record.activeLogin || held.databaseName !== identity.names.database || held.connectionName !== connection.connectionName) {
      throw blocked(pinned.state === 'unknown' ? pinned.reason : `The newest version of ${secret.id} is not the connection to ${name}'s database on the shared server. Nothing was planned.`);
    }
    const facts = await cloud.withSession({ connectionName: held.connectionName, user: held.login, password: held.password, database: held.databaseName }, async (session) => {
      await session.query('SET search_path = pg_catalog');
      const size = await session.query('SELECT pg_database_size(current_database())::text AS bytes');
      const counted = await session.query(DATABASE_MOVE_FACTS);
      const granted = await session.query(DATABASE_MOVE_PRIVILEGES);
      return { bytes: Number(size.rows[0]?.bytes), counts: Object.values(counted.rows[0] ?? {})[0], granted: granted.rows.map((row) => String(Object.values(row)[0])) };
    }).catch(() => undefined);
    if (!facts) throw blocked(`${name}'s database could not be read to see whether it can be moved. Nothing was planned; try again.`);
    const problem = databaseMoveFactsProblem(facts.counts);
    if (problem) throw blocked(`${name}'s database ${problem}, so it cannot be moved. Nothing was planned.`);
    // The copy job refuses these by the same statement; here it is found out before a server is paid for.
    if (facts.granted.length) {
      throw blocked(`${name}'s database grants access the copy cannot carry over (${facts.granted.slice(0, 5).join(' | ')}${facts.granted.length > 5 ? ` and ${facts.granted.length - 5} more` : ''}), so it cannot be moved. Take those grants away, or keep "placement": "app" on the database. Nothing was planned.`);
    }
    if (!Number.isFinite(facts.bytes) || facts.bytes > LARGEST_DATABASE_BYTES) {
      throw blocked(`${name}'s database is ${Number.isFinite(facts.bytes) ? shown(facts.bytes) : 'of unknown size'}; a move can copy at most ${shown(LARGEST_DATABASE_BYTES)} for now. Nothing was planned.`);
    }
    return prepare(onShared.latestVersion!, false);
  }
  const own = record.move?.instanceName;
  const labels = seen.state === 'present' ? seen.value.labels : {};
  // Step 1 was cut short while the own server's login was being stored: the secret's newest version is one nobody recorded,
  // or one already set aside. Either way it holds nothing usable, the services still run the shared database's version,
  // and step 1 is planned again; its login step sets the leftover aside and stores a login anew.
  if (seen.state === 'present' && own && (seen.value.unrecorded || labels['hv-db-instance'] === undefined)) {
    const stillRunning = await request.runningSecretVersions();
    if ('blocked' in stillRunning) throw blocked(stillRunning.blocked);
    const run = [...new Set(stillRunning.versions)];
    if (run.length !== 1 || !/^[1-9][0-9]*$/.test(run[0]!) || run[0] === seen.value.latestVersion) {
      throw blocked(`An unfinished write left ${secret.id} with a version Hypervibe has no record of, and ${name}'s services do not all run one earlier version of it (found: ${run.join(', ') || 'none'}). Hypervibe will not guess which database the app should use; nothing was planned.`);
    }
    // The secret's versions are the move's own business here, as the copy secret's are.
    return { ...prepare(run[0]!, false), secretIds: [copySecretId, secret.id] };
  }
  if (seen.state !== 'present' || !own || seen.value.unrecorded || !seen.value.hasEnabledVersion || !seen.value.latestVersion || labels['hv-db-instance'] !== own) {
    throw blocked(`${name}'s connection secret (${secret.id}) holds neither the login of its database on the shared server nor one for a server of its own. Hypervibe will not guess which database the app should use; nothing was planned.`);
  }
  if (labels['hv-db-retire'] || (Number(labels['hv-db-generation'] ?? '1') || 1) < generation) throw blocked(`Finish moving ${name}'s database before changing its password: put "passwordGeneration" back to what it was until the move is done.`);
  const running = await request.runningSecretVersions();
  if ('blocked' in running) throw blocked(running.blocked);
  const versions = [...new Set(running.versions)];
  if (versions.length !== 1 || !/^[1-9][0-9]*$/.test(versions[0]!) || versions[0] === seen.value.latestVersion) {
    throw blocked(versions.length === 0
      ? `No service of ${name} uses its database, so there is no running connection to move and to fall back to. Hypervibe does not move such a database.`
      : `${name}'s services do not all run one and the same version of its connection secret that is still the shared database's (found: ${versions.join(', ')}). Deploy or apply until they agree, with "placement": "app" back on the database if needed.`);
  }
  const pinnedVersion = versions[0]!;
  const copySecret = await cloud.observeConnectionSecret(scope.gcpProjectId, copySecretId);
  if (copySecret.state === 'unknown') throw blocked(copySecret.reason);
  // Something of step 1 is still missing: plan it again, with the workloads where they are.
  if (copySecret.state === 'absent') return prepare(pinnedVersion, true);

  const outage = 'How long depends on the size of the database and has not been measured';
  const metadata: StepMetadata = { operation: SHARED_DATABASE_OPERATION, step: 'switch', gcpProjectId: scope.gcpProjectId, region: scope.region, instanceName: record.instanceName,
    databaseName: identity.names.database, tenantId: identity.tenantId, secretId: secret.id, labels: secret.labels, secretVersion: pinnedVersion,
    own: { instanceName: own, secretVersion: seen.value.latestVersion, majorVersion: SHARED_SERVER_MAJOR_VERSION } };
  return {
    stage: 'switch', instanceName: own, secretIds: [copySecretId], reviewed,
    warnings: [`${steps} This plan is step 2. While it runs, ${name}'s app cannot reach its database and will return database errors until the copy is checked and its services have restarted. ${outage}. Run hv_plan again afterwards for step 3.`],
    actions: [{ id: 'shared-database:switch', type: 'update', resource, verified: true, requiresConfirm: true,
      reason: `Move ${name}'s database to its own server ${own}: shut the app out of the database on the shared server, copy it, check the copy against the original, then point every service at the new one. The app returns database errors meanwhile. ${outage}. If the copy or its check fails, the app is let back into the shared database and nothing has moved.`,
      metadata: metadata as unknown as Record<string, unknown> }],
  };
}

/** The record of the database an environment left on the shared server, as a binding of its own. */
const left = (binding: GcpDatabaseBinding | undefined): GcpDatabaseBinding => ({ database: binding?.database?.movedFrom as SharedDatabaseRecord });

/** Why the old database cannot be deleted yet, if it cannot: some workload does not run the own server's connection. */
async function stillInUse(request: Pick<MovePlanRequest, 'environment' | 'binding' | 'scope' | 'secret' | 'runningSecretVersions' | 'cloud'>): Promise<string | undefined> {
  const name = request.environment.name;
  const seen = await request.cloud.observeConnectionSecret(request.scope.gcpProjectId, request.secret.id);
  if (seen.state === 'unknown') throw blocked(seen.reason);
  const latest = seen.state === 'present' && !seen.value.unrecorded && seen.value.hasEnabledVersion && seen.value.labels['hv-db-instance'] === request.binding!.database!.instanceName ? seen.value.latestVersion : undefined;
  if (!latest) return `${name}'s connection secret does not hold the login of its own database server`;
  const running = await request.runningSecretVersions();
  if ('blocked' in running) throw blocked(running.blocked);
  // Deleting needs every workload positively seen on the new connection: none seen, or one that cannot be judged, is not that.
  if (running.unsettled?.length) return running.unsettled.join(', ');
  if (!running.versions.length) return `no service of ${name} could be seen running`;
  return running.versions.every((version) => version === latest) ? undefined : `a service of ${name} does not run the connection to its own database server yet`;
}

export async function planCleanup(request: MovePlanRequest & { desired: MovePlanRequest['desired'] | undefined; wantsShared: boolean }): Promise<DatabaseMove> {
  const { environment, binding, scope } = request;
  const name = environment.name;
  const old = left(binding);
  const identity = tenantFor(environment, old);
  if (recordedAllocation(old, identity) !== 'finished') throw blocked(`The saved record of the database ${name} left on the app's shared database server is incomplete, so Hypervibe will not plan changes to it.`);
  const record = old.database!;
  if (!request.desired) throw blocked(`${name}'s database was moved to a server of its own, and the old copy is still on the app's shared database server. Finish the move first: keep the database in the spec and run hv_plan and hv_apply until the old copy is deleted.`);
  if (request.wantsShared) throw blocked(`${name}'s database was just moved to a server of its own. Moving a database onto the app's shared server is not available yet; remove "placement" from its database.`);
  const waiting = await stillInUse(request);
  const base = { stage: 'cleanup' as const, instanceName: binding!.database!.instanceName, secretIds: [], reviewed: { instanceName: record.instanceName } };
  if (waiting) {
    return { ...base, actions: [], warnings: [`${name}'s database now lives on its own server. Its old copy on the app's shared database server stays there, closed to the app, because ${waiting}. Apply this plan, then run hv_plan again to delete the old copy.`] };
  }
  const metadata: StepMetadata = { operation: SHARED_DATABASE_OPERATION, step: 'release', gcpProjectId: scope.gcpProjectId, region: scope.region, instanceName: record.instanceName,
    databaseName: identity.names.database, tenantId: identity.tenantId };
  return { ...base,
    warnings: [`This plan is the last step of moving ${name}'s database: every service now uses its own server, so the old copy on the app's shared database server is deleted. The data on its own server is not touched.`],
    actions: [{ id: 'shared-database:release', type: 'destroy', resource, verified: true, dataBearing: true, requiresConfirm: true,
      reason: `Permanently delete the old copy of ${name}'s database (${identity.names.database}) and its logins from the app's shared database server. ${name} now uses its own server; that data is not touched. The shared server and every other environment's database stay.`,
      metadata: metadata as unknown as Record<string, unknown> }] };
}

export interface MoveStepContext extends Pick<MovePlanRequest, 'environment' | 'binding' | 'scope' | 'secret' | 'runningSecretVersions' | 'cloud'> {
  metadata: StepMetadata;
  record(database: SharedDatabaseRecord | null): void;
}

/** What the clean-up's delete runs against, once it is certain nothing uses the old database: the record that was left, and how to forget it. */
export async function cleanupTarget(context: MoveStepContext): Promise<{ binding: GcpDatabaseBinding; record: MoveStepContext['record'] }> {
  const waiting = await stillInUse(context);
  if (waiting) throw blocked(`The old copy of ${context.environment.name}'s database was not deleted: ${waiting}. Nothing was changed. Run hv_plan again.`);
  const own = context.binding!.database!.instanceName;
  // Deleting it forgets the old record and nothing else: the environment's own server stays recorded.
  return { binding: left(context.binding), record: (database) => { if (database === null) context.record({ instanceName: own }); } };
}

async function identityOf(cloud: SharedDatabaseCloud, gcpProjectId: string, secretId: string, version: string, connectionName: string): Promise<string> {
  const stored = await cloud.readSecretVersion(gcpProjectId, secretId, version);
  const url = stored.state === 'present' ? parseConnectionUrl(stored.value) : undefined;
  if (!url || url.connectionName !== connectionName) throw blocked(`Version ${version} of ${secretId} is not a connection to the database server it was reviewed for.`);
  const identity = await cloud.withSession({ connectionName, user: url.login, password: url.password, database: url.databaseName },
    async (session) => parsePostgresDatabaseIdentity((await session.query(POSTGRES_DATABASE_IDENTITY_SQL)).rows[0]?.identity));
  if (!identity) throw blocked(`The database behind version ${version} of ${secretId} could not be identified.`);
  return identity;
}

/** The switch: pause, copy, check, and only then record the environment as one with its own server. */
export async function applySwitch(context: MoveStepContext): Promise<ActionResult> {
  const { cloud, scope, environment, binding, metadata, secret } = context;
  const name = environment.name;
  const stale = (): ActionResult => ({ success: false, status: 'blocked', message: `${name}'s database or its services changed since this plan. Nothing was changed. Run hv_plan again.` });
  const identity = tenantFor(environment, binding);
  const record = binding?.database;
  const own = metadata.own;
  if (!record || !own || !metadata.secretVersion || metadata.tenantId !== identity.tenantId || metadata.databaseName !== identity.names.database || recordedAllocation(binding, identity) !== 'finished'
    || record.instanceName !== metadata.instanceName || record.move?.instanceName !== own.instanceName) return stale();
  const running = await context.runningSecretVersions();
  if ('blocked' in running) return { success: false, status: 'blocked', message: running.blocked };
  if (!running.versions.length || running.versions.some((version) => version !== metadata.secretVersion)) return stale();
  const seen = await cloud.observeConnectionSecret(scope.gcpProjectId, secret.id);
  if (seen.state !== 'present' || seen.value.unrecorded || seen.value.latestVersion !== own.secretVersion || seen.value.labels['hv-db-instance'] !== own.instanceName
    || seen.value.labels['managed-by'] !== 'hypervibe' || seen.value.labels['hv-environment'] !== secret.labels['hv-environment']) return stale();
  const connectionName = (instanceName: string) => `${scope.gcpProjectId}:${scope.region}:${instanceName}`;
  // Read before the app is touched: a new database that cannot be reached is found out while nothing has changed.
  const target = { identity: await identityOf(cloud, scope.gcpProjectId, secret.id, own.secretVersion, connectionName(own.instanceName)),
    secret: { secretId: secret.id, version: own.secretVersion }, connectionName: connectionName(own.instanceName) };

  const pause: PauseContext = { cloud, scope, environment, binding, secret: { ...secret, version: metadata.secretVersion }, newestIsAnotherDatabase: true };
  const paused = await pauseDatabase(pause);
  if (!paused.success && paused.status === 'blocked') return paused;
  const backOut = async (why: string): Promise<ActionResult> => {
    const undone = await resumeDatabase(pause);
    return undone.success
      ? { success: false, message: `${name}'s database was not moved: ${why} The app's login to its database on the shared server works again, and nothing it uses has changed. The app itself may take a few minutes to come back: its instances lost their connections and are restarting.` }
      : { success: false, status: 'pending', message: `${name}'s database was not moved: ${why} Letting the app back into its database on the shared server did not finish either, so it may still be shut out. Run hv_plan and hv_apply again: that either completes the move or lets the app back in.` };
  };
  if (!paused.success) return backOut('shutting the app out of the shared database did not finish.');
  let result: DatabaseMoveCopyResult | undefined;
  try {
    const copy = paused.data as { copySecretId: string; copySecretVersion: string };
    const source = { identity: await identityOf(cloud, scope.gcpProjectId, copy.copySecretId, copy.copySecretVersion, connectionName(record.instanceName)),
      secret: { secretId: copy.copySecretId, version: copy.copySecretVersion }, connectionName: connectionName(record.instanceName) };
    if (!cloud.runCopyJob) return await backOut('this installation cannot run the copy.');
    result = await cloud.runCopyJob(scope.gcpProjectId, databaseMoveCopyJob({ majorVersion: own.majorVersion, source, target, })) as DatabaseMoveCopyResult | undefined;
  } catch {
    return backOut('the copy could not be run.');
  }
  if (!databaseMoveCopyVerified(result)) {
    const said = typeof result?.error === 'string' && /^[\x20-\x7e]{1,900}$/.test(result.error) ? result.error
      : result?.ok ? `the copy differs from the original (${(result.different ?? []).join(', ') || 'unknown parts'}).` : 'the copy job gave no result.';
    return backOut(said);
  }
  // From here the environment is one with its own server. The old database stays as it is, switched off, until clean-up.
  context.record({ instanceName: own.instanceName, movedFrom: withoutMove(record) });
  return { success: true, message: `${name}'s database was copied to its own server ${own.instanceName} and checked against the original (${result!.source!.tables} tables, ${result!.source!.rows} rows). Its services are pointed at it next. The old copy on the app's shared database server stays, closed to the app, until the last step deletes it.` };
}
