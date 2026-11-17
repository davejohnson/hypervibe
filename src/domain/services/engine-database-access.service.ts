import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { DatabaseAccessAcquireResult } from './database-access.service.js';
import { adapterFactory } from './adapter.factory.js';
import { supportsEngineDatabaseAccess, type AwsDatabaseBinding, type AzureDatabaseBinding } from '../ports/engine-database-access.port.js';
export type { AwsDatabaseBinding, AzureDatabaseBinding } from '../ports/engine-database-access.port.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sqlName = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
const value = (record: Record<string, unknown>, key: string): string => typeof record[key] === 'string' ? record[key] as string : '';

/** Native identities saved only after an accepted database login operation. Names never substitute for these IDs. */
export function engineDatabaseIdentity(environment: Environment): { provider: 'aws'; database: AwsDatabaseBinding } | { provider: 'azure'; database: AzureDatabaseBinding } | undefined {
  const bindings = environment.platformBindings;
  const aws = object(bindings.aws); const azure = object(bindings.azure);
  const provider = bindings.provider === 'aws' || aws.kind === 'opentofu' ? 'aws' : bindings.provider === 'azure' || azure.kind === 'opentofu' ? 'azure' : undefined;
  if (!provider) return;
  if (aws.kind === 'opentofu' && azure.kind === 'opentofu' || bindings.provider && bindings.provider !== provider) throw new Error('The environment has conflicting cloud database bindings.');
  const engine = provider === 'aws' ? aws : azure;
  if (engine.tornDownAt) throw new Error('The recorded engine environment was torn down; database access is unavailable.');
  const database = object(engine.database);
  if (!engine.databaseLoginAt || !sqlName(database.name) || !sqlName(database.owner)) throw new Error('The accepted engine database identity is incomplete. Database access remains blocked until its exact native identity is recovered.');
  if (provider === 'aws') {
    const arn = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:([a-zA-Z0-9-]+)$/.exec(value(database, 'clusterArn'));
    if (!arn || arn[1] !== database.region || arn[2] !== database.accountId) throw new Error('The accepted Aurora cluster identity conflicts with its account or region.');
    return { provider, database: database as unknown as AwsDatabaseBinding };
  }
  const arm = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/([a-z0-9-]+)$/i.exec(value(database, 'serverId'));
  if (!arm || arm[1]!.toLowerCase() !== value(database, 'subscriptionId').toLowerCase() || arm[2]!.toLowerCase() !== value(database, 'resourceGroup').toLowerCase()
    || !/^[a-z0-9-]+\.postgres\.database\.azure\.com$/.test(value(database, 'host'))
    || !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+$/.test(value(database, 'secretUrl'))) throw new Error('The accepted Azure database identity or credential reference is incomplete or conflicting.');
  return { provider, database: database as unknown as AzureDatabaseBinding };
}

export function isManagedEngineDatabase(environment: Environment): boolean {
  return ['aws', 'azure'].includes(String(environment.platformBindings.provider)) || object(environment.platformBindings.aws).kind === 'opentofu' || object(environment.platformBindings.azure).kind === 'opentofu';
}

const fail = (error: string, provider: string, connectionUnavailable = false): DatabaseAccessAcquireResult => ({ ok: false, code: 'provider_error', provider, error, connectionUnavailable,
  resourceCreated: false, cleanup: 'not_needed', hint: 'Restore the accepted database binding and verify its native identity with hv_inspect; do not recreate the database or derive its name from the project.' });


/** Capability routing keeps native SDKs, credentials and engine state outside the domain. */
export async function observeManagedEngineDatabase(project: Project, environment: Environment): Promise<Record<string, unknown>> {
  const provider = object(environment.platformBindings.aws).kind === 'opentofu' || environment.platformBindings.provider === 'aws' ? 'aws' : 'azure';
  try {
    const resolved = await adapterFactory.getProviderAdapter(provider, project);
    if (!resolved.success || !resolved.adapter) return { provider, state: 'unknown', authentication: 'unchecked', reason: 'A verified cloud connection for this repository is required.' };
    if (!supportsEngineDatabaseAccess(resolved.adapter)) throw new Error('The provider has no managed database access capability.');
    return await resolved.adapter.observeManagedDatabase(project, environment);
  } catch { return { state: 'unknown', authentication: 'unchecked', reason: 'The accepted database identity or its scoped provider observation could not be verified.' }; }
}

export async function acquireEngineDatabaseAccess(project: Project, environment: Environment): Promise<DatabaseAccessAcquireResult> {
  const provider = object(environment.platformBindings.aws).kind === 'opentofu' || environment.platformBindings.provider === 'aws' ? 'aws' : 'azure';
  try {
    const resolved = await adapterFactory.getProviderAdapter(provider, project);
    if (!resolved.success || !resolved.adapter) return fail(`A verified ${provider} connection for this repository is required.`, provider, true);
    if (!supportsEngineDatabaseAccess(resolved.adapter)) throw new Error('The provider has no managed database access capability.');
    return await resolved.adapter.acquireManagedDatabaseAccess(project, environment);
  } catch { return fail('The accepted database identity, cloud connection or exact provider observation could not be verified. No database access was opened. Run hv_plan and hv_apply to apply the environment-owned query credential before retrying.', provider); }
}
