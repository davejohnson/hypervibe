import { pauseTenantLogins, resumeTenantLogin, retireTenantLogin, setTenantLoginPassword, type TenantIdentity } from '../../adapters/providers/database/tenant-database.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import type { GcpDatabaseBinding } from '../gcp-database-location.js';
import { connectionUrl, parseConnectionUrl } from '../infrastructure-engine-database.js';
import { Stop, blocked, newPassword, pending, withAdministrator, type ServerAddress } from './administrator.js';
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
 * becomes the only way in: the copy login, whose URL goes to a secret of its
 * own that no service ever mounts.
 *
 * Both calls can be repeated and can follow each other in any order, whatever
 * was interrupted: pausing again replaces the copy login's password; undoing
 * again, or undoing a database that was never paused, leaves the app's login
 * working. Anything unusual is refused with its reason: a database not fully
 * set up, a password rotation still in flight, or a connection secret that is
 * not the pinned version this call was made for.
 */
export interface PauseContext {
  cloud: SharedDatabaseCloud;
  scope: SharedServerScope;
  environment: { id: string; name: string };
  binding: GcpDatabaseBinding | undefined;
  /** The environment's own connection secret (DATABASE_URL), and the version its services are pinned to. */
  secret: { id: string; labels: Record<string, string>; version: string };
  /** The secret that holds the copy login's URL. Never mounted into a service. */
  copySecret: { id: string; labels: Record<string, string> };
}

interface Known { identity: TenantIdentity; server: ServerAddress; active: string; copy: string }

/** Everything both calls must find before they touch a login. */
async function known(context: PauseContext): Promise<Known> {
  const { cloud, scope, secret } = context;
  const name = context.environment.name;
  const identity = tenantFor(context.environment, context.binding);
  if (recordedAllocation(context.binding, identity) !== 'finished') throw blocked(`${name}'s database on the app's shared database server is not fully set up, so it cannot be paused. Run hv_plan and hv_apply first.`);
  if (secret.id === context.copySecret.id) throw blocked('The copy login needs a secret of its own, never the one the app uses.');
  const record = context.binding!.database!;
  const server = await runningServer(cloud, scope, record.instanceName);
  const credential = credentialState(await cloud.observeConnectionSecret(scope.gcpProjectId, secret.id),
    { secretId: secret.id, environmentLabel: secret.labels['hv-environment'] ?? '', instanceName: server.instanceName, names: identity.names });
  if (!credential.ready || credential.login !== record.activeLogin) throw blocked(`${name}'s connection secret does not hold the login recorded for its database. Run hv_plan and hv_apply first.`);
  if (credential.retirePending) throw blocked(`${name}'s database password is still being changed: its previous login has not been switched off yet. Finish that with hv_plan and hv_apply first.`);
  if (credential.latestVersion !== secret.version) throw blocked(`${name}'s connection secret has a newer version than the one its services use (${secret.version}). Run hv_plan and hv_apply first.`);
  const active = record.activeLogin!;
  return { identity, server, active, copy: otherLogin(identity.names, active) };
}

export function pauseDatabase(context: PauseContext): Promise<ActionResult> {
  return settled(async () => {
    const { cloud, scope, copySecret } = context;
    const name = context.environment.name;
    const { identity, server, copy } = await known(context);
    return withAdministrator(cloud, scope, server, async (tenants): Promise<ActionResult> => {
      const quiet = await pauseTenantLogins(tenants, identity);
      if (quiet.remainingSessions > 0 || quiet.otherSessions > 0) {
        throw pending(`${name}'s logins are switched off, but ${quiet.remainingSessions + quiet.otherSessions} session(s) are still connected to its database${quiet.otherSessions ? ` (${quiet.otherSessions} of them not the app's)` : ''}. It is not paused until they are gone; run the same command again.`);
      }
      // The only way in from here: the login the app does not hold, with a password made now.
      const password = newPassword();
      await setTenantLoginPassword(tenants, { ...identity, login: copy, password });
      await proveLogin(cloud, server, identity.names, copy, password, `${name}'s database is paused, but its copy login did not open the database. Run the same command again, or undo the pause.`);
      const labels = { ...copySecret.labels, 'hv-db-instance': server.instanceName, 'hv-db-database': identity.names.database, 'hv-db-login': copy, 'hv-db-copy': 'true' };
      const failure = await cloud.publishConnectionSecret(scope.gcpProjectId, copySecret.id, labels, connectionUrl(copy, password, identity.names.database, server.connectionName));
      if (failure) throw new Stop({ ...failure, message: `${name}'s database is paused, but the copy login could not be stored (${failure.message}) Run the same command again, or undo the pause.` });
      const stored = await cloud.observeConnectionSecret(scope.gcpProjectId, copySecret.id);
      const version = stored.state === 'present' ? stored.value.latestVersion : undefined;
      if (!version) throw pending(`${name}'s database is paused, but the copy login's secret could not be read back. Run the same command again.`);
      return { success: true, message: `${name}'s database is paused: the app cannot connect and no session is open. Only the copy login (${copySecret.id}, version ${version}) can.`,
        data: { paused: true, copySecretId: copySecret.id, copySecretVersion: version } };
    });
  });
}

export function resumeDatabase(context: PauseContext): Promise<ActionResult> {
  return settled(async () => {
    const { cloud, scope, secret } = context;
    const name = context.environment.name;
    const { identity, server, active, copy } = await known(context);
    // What must work again is exactly what the app's pinned secret version holds. It is read into memory to prove that, and goes nowhere else.
    const pinned = await cloud.readSecretVersion(scope.gcpProjectId, secret.id, secret.version);
    if (pinned.state !== 'present') throw blocked(pinned.state === 'unknown' ? pinned.reason : `Version ${secret.version} of ${secret.id} no longer exists, so the app's login cannot be proven to work again.`);
    const held = parseConnectionUrl(pinned.value);
    if (!held || held.login !== active || held.databaseName !== identity.names.database || held.connectionName !== server.connectionName) {
      throw blocked(`Version ${secret.version} of ${secret.id} is not the connection to ${name}'s database that was recorded. Nothing was changed.`);
    }
    await withAdministrator(cloud, scope, server, async (tenants) => {
      // The copy login first: once the app is back, nothing else may still be writing.
      await retireTenantLogin(tenants, { ...identity, login: copy });
      await resumeTenantLogin(tenants, { ...identity, login: active });
    });
    await proveLogin(cloud, server, identity.names, active, held.password, `${name}'s login is switched on again, but the connection its services hold did not open its database. Do not treat the app as running; run hv_plan.`);
    return { success: true, message: `${name}'s database is no longer paused: the connection its services hold (${secret.id}, version ${secret.version}) works again, and the copy login is switched off.`,
      data: { paused: false } };
  });
}
