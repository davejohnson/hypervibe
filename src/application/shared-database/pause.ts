import { TenantBusyError, TenantRefusedError, pauseTenant, resumeTenant, type TenantIdentity } from '../../adapters/providers/database/tenant-database.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { GcpDatabaseBinding } from '../gcp-database-location.js';
import { connectionUrl, databaseCopySecretId, parseConnectionUrl } from '../infrastructure-engine-database.js';
import { Stop, blocked, newPassword, withAdministrator, type ServerAddress } from './administrator.js';
import type { SharedDatabaseCloud } from './ports.js';
import type { SharedServerScope } from './server.js';
import { credentialState, otherLogin, proveLogin, recordedAllocation, runningServer, settled, tenantFor } from './tenancy.js';

/**
 * Pausing one environment's database on the shared server, and undoing it.
 *
 * Paused means: neither of its two logins can log in, every session of theirs
 * has ended, and nobody else is connected to the database either. The
 * passwords are kept, which is what lets the pause be undone: the login the
 * app's connection secret holds is switched on again exactly as it was, and
 * that is proven by connecting with the secret's own pinned version.
 *
 * While paused, the login the app does not use is given a new password and
 * becomes the only way in: the copy login. Its URL goes to one secret, named
 * after the app's own, that no service ever mounts.
 *
 * Everything that can be refused is checked before the app is touched, and
 * then nothing was changed. From the moment the app's logins are switched off,
 * no outcome says otherwise: whatever goes wrong is reported as unfinished,
 * with the app shut out and how to let it back in.
 *
 * Both calls can be repeated and can follow each other in any order, whatever
 * was interrupted: pausing again replaces the copy login's password; undoing
 * again, or undoing a database that was never paused, leaves the app's login
 * working.
 */
export interface PauseContext {
  cloud: SharedDatabaseCloud;
  scope: SharedServerScope;
  environment: { id: string; name: string };
  binding: GcpDatabaseBinding | undefined;
  /** The environment's own connection secret (DATABASE_URL), and the version its services are pinned to. */
  secret: { id: string; labels: Record<string, string>; version: string };
}

interface Known { identity: TenantIdentity; server: ServerAddress; active: string; copy: string; copySecretId: string; held: { password: string } }

/** Everything both calls must find, with nothing changed, before they touch a login. */
async function known(context: PauseContext): Promise<Known> {
  const { cloud, scope, secret } = context;
  const name = context.environment.name;
  const owner = secret.labels['hv-environment'];
  if (secret.labels['managed-by'] !== 'hypervibe' || !owner) throw blocked(`${name}'s connection secret was not named with the environment it belongs to. Nothing was changed.`);
  const identity = tenantFor(context.environment, context.binding);
  if (recordedAllocation(context.binding, identity) !== 'finished') throw blocked(`${name}'s database on the app's shared database server is not fully set up, so it cannot be paused. Run hv_plan and hv_apply first.`);
  const record = context.binding!.database!;
  const server = await runningServer(cloud, scope, record.instanceName);
  const credential = credentialState(await cloud.observeConnectionSecret(scope.gcpProjectId, secret.id),
    { secretId: secret.id, environmentLabel: owner, instanceName: server.instanceName, names: identity.names });
  if (!credential.ready || credential.login !== record.activeLogin) throw blocked(`${name}'s connection secret does not hold the login recorded for its database. Run hv_plan and hv_apply first.`);
  if (credential.retirePending) throw blocked(`${name}'s database password is still being changed: its previous login has not been switched off yet. Finish that with hv_plan and hv_apply first.`);
  if (credential.latestVersion !== secret.version) throw blocked(`${name}'s services use version ${secret.version} of its connection secret, which is not its newest (${credential.latestVersion}). Run hv_plan and hv_apply first.`);
  const active = record.activeLogin!;

  // What an undo must make work again is exactly what the pinned version holds. If that cannot be read and recognised now, a pause could not be undone.
  const pinned = await cloud.readSecretVersion(scope.gcpProjectId, secret.id, secret.version);
  if (pinned.state !== 'present') throw blocked(pinned.state === 'unknown' ? pinned.reason : `Version ${secret.version} of ${secret.id} no longer exists. Nothing was changed.`);
  const held = parseConnectionUrl(pinned.value);
  if (!held || held.login !== active || held.databaseName !== identity.names.database || held.connectionName !== server.connectionName) {
    throw blocked(`Version ${secret.version} of ${secret.id} is not the connection to ${name}'s database that was recorded. Nothing was changed.`);
  }

  // The copy login's secret: this environment's own, and holding nothing but an earlier copy login.
  const copySecretId = databaseCopySecretId(secret.id);
  const copySecret = await cloud.observeConnectionSecret(scope.gcpProjectId, copySecretId);
  if (copySecret.state === 'unknown') throw blocked(copySecret.reason);
  if (copySecret.state === 'absent') throw blocked(`The secret for ${name}'s copy login (${copySecretId}) does not exist yet. Nothing was changed.`);
  const labels = copySecret.value.labels;
  if (labels['managed-by'] !== 'hypervibe' || !labels['hv-environment'] || labels['hv-environment'] !== owner) throw blocked(`Secret ${copySecretId} does not belong to ${name}. Nothing was changed.`);
  if (copySecret.value.unrecorded) {
    // An earlier pause stored a copy login here and never heard back. Nobody has that password; the version is set aside so the next one can be stored.
    if (!copySecret.value.latestVersion || !cloud.relabelConnectionSecret(scope.gcpProjectId, copySecretId, copySecret.value.latestVersion, { ...secret.labels, 'hv-db-copy': 'true' })) {
      throw blocked(`An earlier, unfinished write to ${copySecretId} could not be set aside. Nothing else was changed.`);
    }
  } else if (copySecret.value.latestVersion !== undefined && labels['hv-db-copy'] !== 'true') {
    throw blocked(`Secret ${copySecretId} holds something other than a copy login. Nothing was changed.`);
  }
  return { identity, server, active, copy: otherLogin(identity.names, active), copySecretId, held: { password: held.password } };
}

/** How an unexpected stop is named: by class and code only. Its text may quote a statement or a value. */
function named(error: unknown): string {
  if (error instanceof TenantBusyError) return 'the server was busy with another change';
  const raw = (error as { code?: unknown } | null)?.code;
  const kind = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  return typeof raw === 'string' && /^[A-Z0-9_]{3,40}$/.test(raw) ? `${kind} ${raw}` : kind;
}

export async function pauseDatabase(context: PauseContext): Promise<ActionResult> {
  const { cloud, scope, secret } = context;
  const name = context.environment.name;
  let shutOut = false;
  const unfinished = (why: string): ActionResult => ({ success: false, status: 'pending',
    message: `${name}'s app is shut out of its database, and the pause did not finish: ${why} Run the same command again to finish it, or undo the pause to let the app back in.` });
  try {
    // settled() turns a refusal into a result; before the app is touched its wording ("nothing was changed") is true.
    let found: Known | undefined;
    const refusal = await settled(async () => { found = await known(context); return { success: true, message: '' }; });
    if (!found) return refusal;
    const { identity, server, copy, copySecretId } = found;
    return await withAdministrator(cloud, scope, server, async (tenants): Promise<ActionResult> => {
      const password = newPassword();
      shutOut = true;
      const paused = await pauseTenant(tenants, { ...identity, copyLogin: copy, copyPassword: password, whilePaused: async (): Promise<ActionResult> => {
        // Still under the server's lock: nothing can let the app back in while the copy login is proven and stored.
        try {
          await proveLogin(cloud, server, identity.names, copy, password);
        } catch (error) {
          if (error instanceof Stop) return unfinished('its copy login did not open the database.');
          throw error;
        }
        const labels = { ...secret.labels, 'hv-db-instance': server.instanceName, 'hv-db-database': identity.names.database, 'hv-db-login': copy, 'hv-db-copy': 'true' };
        const failure = await cloud.publishConnectionSecret(scope.gcpProjectId, copySecretId, labels, connectionUrl(copy, password, identity.names.database, server.connectionName));
        if (failure) return unfinished(`the copy login could not be stored in ${copySecretId}.`);
        const stored = await cloud.observeConnectionSecret(scope.gcpProjectId, copySecretId);
        const version = stored.state === 'present' && !stored.value.unrecorded ? stored.value.latestVersion : undefined;
        if (!version) return unfinished(`the copy login's secret (${copySecretId}) could not be read back.`);
        return { success: true, message: `${name}'s database is paused: the app cannot connect and no session is open. Only the copy login (${copySecretId}, version ${version}) can.`,
          data: { paused: true, copySecretId, copySecretVersion: version } };
      } 
      }).catch((error: unknown) => {
        // Turned away before anything was switched off: the server was busy, or the database is not as it was recorded.
        if (error instanceof TenantRefusedError || error instanceof TenantBusyError) shutOut = false;
        throw error;
      });
      if (paused.outcome) return paused.outcome;
      const open = paused.remainingSessions + paused.otherSessions;
      return unfinished(`${open} session(s) are still connected to its database${paused.otherSessions ? ` (${paused.otherSessions} of them not the app's)` : ''}.`);
    });
  } catch (error) {
    if (shutOut) return unfinished(`${named(error)}.`);
    // Nothing of the app's was touched: the administrator could not get in, or the server could not be reached.
    return settled(async () => { throw error; });
  }
}

export async function resumeDatabase(context: PauseContext): Promise<ActionResult> {
  const { cloud, scope, secret } = context;
  const name = context.environment.name;
  let started = false;
  const unfinished = (why: string): ActionResult => ({ success: false, status: 'pending',
    message: `Undoing the pause of ${name}'s database did not finish: ${why} The app may still be shut out. Run the same command again.` });
  try {
    let found: Known | undefined;
    const refusal = await settled(async () => { found = await known(context); return { success: true, message: '' }; });
    if (!found) return refusal;
    const { identity, server, active, copy, held } = found;
    started = true;
    const undone = await withAdministrator(cloud, scope, server, (tenants) => resumeTenant(tenants, { ...identity, login: active, copyLogin: copy }));
    // A copy still connected could write beside the app: the app stays out until it is gone.
    if (undone.remainingSessions > 0) return unfinished(`${undone.remainingSessions} session(s) of the copy login are still connected, so the app's login was not switched back on.`);
    try {
      await proveLogin(cloud, server, identity.names, active, held.password);
    } catch (error) {
      if (error instanceof Stop) return unfinished('its login is switched on again, but the connection its services hold did not open the database.');
      throw error;
    }
    return { success: true, message: `${name}'s database is no longer paused: the connection its services hold (${secret.id}, version ${secret.version}) works again, and the copy login is switched off.`,
      data: { paused: false } };
  } catch (error) {
    if (!started) return settled(async () => { throw error; });
    return unfinished(error instanceof Stop ? error.result.message : error instanceof TenantRefusedError ? error.message : `${named(error)}.`);
  }
}
