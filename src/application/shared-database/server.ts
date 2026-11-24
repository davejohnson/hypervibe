import crypto from 'node:crypto';
import type { EngineConfiguration, EngineStateIdentity } from '../../domain/ports/infrastructure-engine.port.js';
import { gcpSmallestDatabaseSize } from '../gcp-database-shape.js';
import type { SeenServer } from './ports.js';

/**
 * The app's shared database server: one Cloud SQL instance per Hypervibe
 * project, Google project and region. It outlives any one environment, so it
 * never lives in an environment's saved state: it has its own, in the
 * project-shared partition. No environment's configuration names it.
 */
export interface SharedServerScope {
  /** Hypervibe project id. */
  projectId: string;
  gcpProjectId: string;
  region: string;
}

export const SHARED_SERVER_LABEL = 'hv-shared-database';
/** PostgreSQL 16 lets only the role that created a role manage it, so this never changes. */
export const ADMINISTRATOR_LOGIN = 'hv_admin';
/** Every administrator session uses this database: the tenant module's lock is per database. */
export const MAINTENANCE_DATABASE = 'postgres';
export const SHARED_SERVER_MAJOR_VERSION = 16;
const SERVER_ADDRESS = 'google_sql_database_instance.shared';
/** Daily backups and days of point-in-time recovery a new server starts with: what a dedicated production database gets. */
const RETAINED_BACKUPS = 14;
const TRANSACTION_LOG_DAYS = 7;

const label = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);

export function sharedServerLabels(scope: SharedServerScope): Record<string, string> {
  return { 'managed-by': 'hypervibe', [SHARED_SERVER_LABEL]: label(scope.projectId) };
}

export function sharedServerState(scope: SharedServerScope): EngineStateIdentity {
  return { provider: 'gcp', projectId: scope.projectId, environmentId: `shared_database_${scope.gcpProjectId}_${scope.region}`, partition: 'project-shared' };
}

/** Google holds a deleted instance's name back for days, so each new server gets a fresh one. */
export function newSharedServerName(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app';
  return `hv-${slug}-shared-${crypto.randomBytes(3).toString('hex')}`;
}

export type FoundServer = { state: 'absent' } | { state: 'present'; server: SeenServer } | { state: 'unclear'; reason: string };

/**
 * Google's own list is the register of shared servers: the one carrying this
 * app's label in this region. A name alone proves nothing.
 */
export function findSharedServer(servers: SeenServer[], scope: SharedServerScope): FoundServer {
  const wanted = sharedServerLabels(scope);
  const ours = servers.filter((server) => server.region === scope.region && server.labels['managed-by'] === 'hypervibe' && server.labels[SHARED_SERVER_LABEL] === wanted[SHARED_SERVER_LABEL]);
  if (ours.length > 1) return { state: 'unclear', reason: `More than one shared database server for this app exists in ${scope.region} (${ours.map((server) => server.instanceName).sort().join(', ')}). Hypervibe will not choose between them.` };
  return ours[0] ? { state: 'present', server: ours[0] } : { state: 'absent' };
}

/**
 * The server, and nothing else: no login, password or database is ever in this
 * configuration. Same network posture as an environment's own instance;
 * deletion protection is on because other environments' data may be on it.
 *
 * `adopt` takes over a server Hypervibe itself began creating that saved state
 * does not track: OpenTofu reads the import from its own file.
 */
export function sharedServerConfiguration(params: { scope: SharedServerScope; instanceName: string; adopt?: boolean;
  /** False only while an empty server is being removed. */
  protect?: boolean }): EngineConfiguration {
  const { scope, instanceName } = params;
  if (!/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/.test(instanceName)) throw new Error('The shared database server name is invalid.');
  const imports = params.adopt ? { [SERVER_ADDRESS]: `projects/${scope.gcpProjectId}/instances/${instanceName}` } : undefined;
  return {
    files: {
      'shared-database.tf.json': {
        resource: {
          google_sql_database_instance: { shared: {
            name: instanceName, project: scope.gcpProjectId, region: scope.region,
            database_version: `POSTGRES_${SHARED_SERVER_MAJOR_VERSION}`,
            deletion_protection: params.protect !== false,
            // Backup policy and edition are preserved once set, as for an environment's own instance.
            lifecycle: [{ ignore_changes: ['settings[0].backup_configuration', 'settings[0].edition'] }],
            settings: [{
              deletion_protection_enabled: params.protect !== false,
              edition: 'ENTERPRISE',
              tier: gcpSmallestDatabaseSize().tier,
              availability_type: 'ZONAL',
              ip_configuration: [{ ipv4_enabled: true }],
              backup_configuration: [{ enabled: true, point_in_time_recovery_enabled: true, transaction_log_retention_days: TRANSACTION_LOG_DAYS,
                backup_retention_settings: [{ retained_backups: RETAINED_BACKUPS, retention_unit: 'COUNT' }] }],
              user_labels: sharedServerLabels(scope),
            }],
          } },
        },
      },
      ...(imports ? { 'imports.tf.json': { import: Object.entries(imports).map(([to, id]) => ({ to, id })) } } : {}),
    },
    resources: {
      [SERVER_ADDRESS]: { actionId: SERVER_ENGINE_ACTION, kind: 'database', name: instanceName, dataBearing: true, billable: true,
        costAttributes: ['settings.*.tier', 'settings.*.disk_size', 'settings.*.disk_type', 'settings.*.availability_type', 'settings.*.edition'] },
    },
    ...(imports ? { imports } : {}),
  };
}

export const SERVER_ENGINE_ACTION = 'shared-database-server:instance';

/** The server's price, said once for the whole app. The figure is the same approximate list price quoted for the smallest dedicated database. */
export function sharedServerCost(): string {
  const size = gcpSmallestDatabaseSize();
  return `${size.label}, about US$${size.monthlyUsd} a month plus storage, charged once however many of the app's environments use it`;
}

export function sharedServerProtection(): string {
  return `It starts with ${RETAINED_BACKUPS} daily backups and ${TRANSACTION_LOG_DAYS} days of point-in-time recovery, and deletion protection is on.`;
}

export type ServerOperation = 'create' | 'update' | 'delete';

/**
 * Checks the engine's own plan: it changes the shared server and nothing else, does exactly `operation` to it, and the
 * server it names (in its saved state for an update or delete, in the configuration for a create) is `instanceName`,
 * the one found by its label in Google's list. A plan that only takes the server over counts as an update.
 */
export function serverPlanReview(operation: ServerOperation, instanceName: string): (shownPlan: unknown) => boolean {
  return (shownPlan) => {
    const rows = (shownPlan as { resource_changes?: unknown } | null)?.resource_changes;
    if (!Array.isArray(rows)) return false;
    type Change = { actions?: unknown; before?: { name?: unknown } | null; after?: { name?: unknown } | null; importing?: unknown };
    const changing = (rows as Array<{ address?: unknown; change?: Change }>).filter((row) => {
      const actions = row.change?.actions;
      return !(Array.isArray(actions) && actions.length === 1 && (actions[0] === 'no-op' || actions[0] === 'read')) || Boolean(row.change?.importing);
    });
    if (changing.length !== 1 || changing[0]!.address !== SERVER_ADDRESS) return false;
    const change = changing[0]!.change!;
    const actions = Array.isArray(change.actions) ? change.actions.join(',') : '';
    const takeover = Boolean(change.importing) && (actions === 'no-op' || actions === 'update');
    if (!(actions === operation || (operation === 'update' && takeover))) return false;
    const named = (side: { name?: unknown } | null | undefined) => side?.name === instanceName;
    return operation === 'create' ? named(change.after) && change.before == null
      : operation === 'delete' ? named(change.before) && change.after == null
        : named(change.before) && named(change.after);
  };
}
