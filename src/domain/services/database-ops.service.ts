import pg from 'pg';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import type { RailwayCredentials } from '../../adapters/providers/railway/railway.adapter.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { adapterFactory } from './adapter.factory.js';
import { getProjectScopeHints } from './project-scope.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();
const { Client } = pg;

// Common migration commands for popular ORMs
const MIGRATION_PRESETS: Record<string, string> = {
  prisma: 'npx prisma migrate deploy',
  'prisma-push': 'npx prisma db push',
  drizzle: 'npx drizzle-kit migrate',
  typeorm: 'npx typeorm migration:run',
  knex: 'npx knex migrate:latest',
  sequelize: 'npx sequelize-cli db:migrate',
  django: 'python manage.py migrate',
  rails: 'rails db:migrate',
  laravel: 'php artisan migrate --force',
};

/**
 * Drop and recreate a postgres database (DROP DATABASE with schema-cascade
 * fallback), terminating active connections first. Returns a plain payload
 * so both db_reset and hv_db_migrate(mode=reset) can use it.
 */
export async function executeDatabaseReset(
  resolvedUrl: string,
  source: string,
  tableList?: Array<{ table: string; estimatedRows: number }>
): Promise<Record<string, unknown>> {
  const tables = tableList
    ?? Object.entries(await getTableEstimates(resolvedUrl))
      .sort((a, b) => b[1] - a[1])
      .map(([table, rows]) => ({ table, estimatedRows: rows }));

  const parsedUrl = new URL(resolvedUrl);
  const dbName = parsedUrl.pathname.replace(/^\//, '');

  // Try DROP DATABASE approach first
  let resetMethod: string;
  const maintenanceUrl = new URL(resolvedUrl);
  maintenanceUrl.pathname = '/postgres';
  const maintenanceClient = new Client({ connectionString: maintenanceUrl.toString(), connectionTimeoutMillis: 10000 });

  try {
    await maintenanceClient.connect();

    // Terminate other connections
    await maintenanceClient.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName]
    );

    await maintenanceClient.query(`DROP DATABASE ${quoteIdentifier(dbName)}`);
    await maintenanceClient.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    resetMethod = 'drop_database';
  } catch {
    // Fallback: drop schema cascade
    await maintenanceClient.end().catch(() => {});

    const fallbackClient = new Client({ connectionString: resolvedUrl, connectionTimeoutMillis: 10000 });
    try {
      await fallbackClient.connect();
      await fallbackClient.query('DROP SCHEMA public CASCADE');
      await fallbackClient.query('CREATE SCHEMA public');
      resetMethod = 'drop_schema';
    } finally {
      await fallbackClient.end().catch(() => {});
    }
  } finally {
    await maintenanceClient.end().catch(() => {});
  }

  // Verify connectivity post-reset
  const postCheck = await canConnect(resolvedUrl);

  auditRepo.create({
    action: 'db_reset',
    resourceType: 'database',
    resourceId: source || maskDatabaseUrl(resolvedUrl),
    details: {
      method: resetMethod,
      tablesDropped: tables.length,
      tables: tables.map((t) => t.table),
    },
  });

  return {
    success: true,
    source,
    connectionUrl: maskDatabaseUrl(resolvedUrl),
    method: resetMethod,
    tablesDropped: tables.length,
    postResetConnectivity: postCheck.success,
    message: `Database reset complete. ${tables.length} table(s) dropped via ${resetMethod}.`,
  };
}

/**
 * Run a database migration on a deployed environment. Returns a plain payload
 * (no MCP envelope) so both db_migrate and hv_db_migrate can use it.
 */
export async function runDatabaseMigration(params: {
  project: Project;
  env: Environment;
  command?: string;
  preset?: keyof typeof MIGRATION_PRESETS;
  serviceName?: string;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const { project, env, command, preset, serviceName, dryRun } = params;

  // Get bindings
  const bindings = env.platformBindings as {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };
  const hostingProvider = hostingProviderForEnvironment(project, env);

  // Resolve service
  const services = serviceRepo.findByProjectId(project.id);
  const targetService = serviceName
    ? services.find((s) => s.name === serviceName)
    : services[0];

  if (!targetService) {
    return {
      success: false,
      error: serviceName ? `Service not found: ${serviceName}` : 'No services found',
    };
  }

  const serviceBinding = bindings.services?.[targetService.name];
  if (!serviceBinding) {
    return {
      success: false,
      error: `Service ${targetService.name} not deployed to ${hostingProvider}`,
    };
  }

  // Determine migration command
  let migrationCommand = command;
  if (!migrationCommand && preset) {
    migrationCommand = MIGRATION_PRESETS[preset];
  }
  if (!migrationCommand) {
    // Default to prisma
    migrationCommand = MIGRATION_PRESETS.prisma;
  }

  // Dry run - just show what would happen
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      message: 'Would run migration',
      project: project.name,
      environment: env.name,
      provider: hostingProvider,
      service: targetService.name,
      command: migrationCommand,
    };
  }

  if (hostingProvider !== 'railway') {
    const adapterResult = await adapterFactory.getProviderAdapter(hostingProvider, project);
    if (!adapterResult.success || !adapterResult.adapter) {
      return { success: false, error: adapterResult.error || `No ${hostingProvider} adapter available` };
    }

    if (typeof adapterResult.adapter.runJob !== 'function') {
      return {
        success: false,
        error: `Provider ${hostingProvider} does not support one-off migration jobs`,
      };
    }

    const job = await adapterResult.adapter.runJob(env, targetService, migrationCommand);
    const success = job.receipt.success && job.status !== 'failed';
    return {
      success,
      message: success ? 'Migration job started' : 'Migration job failed',
      project: project.name,
      environment: env.name,
      provider: hostingProvider,
      service: targetService.name,
      command: migrationCommand,
      jobId: job.jobId,
      status: job.status,
      output: job.output,
      error: success ? undefined : (job.receipt.error || job.receipt.message),
      receipt: job.receipt,
    };
  }

  if (!bindings.projectId || !bindings.environmentId) {
    return { success: false, error: 'Environment is marked as Railway but is missing Railway project/environment bindings' };
  }

  // Get Railway connection
  const connection = connectionRepo.findBestMatchFromHints('railway', getProjectScopeHints(project));
  if (!connection) {
    return { success: false, error: `No Railway connection found. ${formatConnectionGuidance('railway')}` };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
  const adapter = new RailwayAdapter();
  await adapter.connect(credentials);

  try {
    const result = await adapter.executeCommand(
      bindings.projectId,
      bindings.environmentId,
      serviceBinding.serviceId,
      migrationCommand
    );

    if (result.success) {
      return {
        success: true,
        message: 'Migration completed',
        project: project.name,
        environment: env.name,
        service: targetService.name,
        command: migrationCommand,
        output: result.output,
      };
    } else {
      return {
        success: false,
        error: result.error,
        project: project.name,
        environment: env.name,
        command: migrationCommand,
        hint: 'If direct execution is not available, you can run migrations locally using: railway link && railway run ' + migrationCommand,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A URL usable from OUTSIDE the hosting provider's network (CI runners, local pg_dump). */
function isExternallyUsableDatabaseUrl(url: string | null | undefined): url is string {
  return Boolean(url && !url.includes('${{') && !url.includes('.railway.internal'));
}

/**
 * Build a postgres URL that goes through a Railway TCP proxy, using the
 * datastore service's own variables for credentials. Returns null when the
 * variables are missing the required credentials.
 */
export function buildRailwayProxyDatabaseUrl(
  vars: Record<string, string>,
  proxy: { domain: string; proxyPort: number }
): string | null {
  const user = vars.PGUSER;
  const password = vars.POSTGRES_PASSWORD;
  if (!user || !password) {
    return null;
  }
  const database = vars.PGDATABASE || vars.POSTGRES_DB || 'railway';
  return `postgresql://${user}:${encodeURIComponent(password)}@${proxy.domain}:${proxy.proxyPort}/${database}`;
}

/**
 * Resolve a database URL reachable from outside the hosting network.
 * Railway components store a `${{plugin.DATABASE_URL}}` template (only
 * meaningful inside Railway), so fetch the datastore service's real
 * variables and prefer DATABASE_PUBLIC_URL (TCP proxy), falling back to a
 * read-only lookup of an existing TCP proxy on the datastore service.
 * Runs during hv_plan, so it must NEVER create a proxy.
 */
export async function resolveExternalDatabaseUrl(
  project: Project,
  env: { id: string; name: string; platformBindings: Record<string, unknown> }
): Promise<string | null> {
  const direct = await resolveEnvironmentDatabaseUrl(project, env);
  if (isExternallyUsableDatabaseUrl(direct)) {
    return direct;
  }

  const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  const componentBindings = component?.bindings as Record<string, unknown> | undefined;
  if (!component || componentBindings?.provider !== 'railway') {
    return null;
  }
  const railwayProjectId = typeof componentBindings.projectId === 'string' ? componentBindings.projectId : undefined;
  const datastoreServiceId = component.externalId
    ?? (typeof componentBindings.serviceId === 'string' ? componentBindings.serviceId : undefined);
  const envBindings = env.platformBindings as { environmentId?: string };
  const railwayEnvironmentId = typeof envBindings?.environmentId === 'string' ? envBindings.environmentId : undefined;
  if (!railwayProjectId || !datastoreServiceId || !railwayEnvironmentId) {
    return null;
  }

  const adapterResult = await adapterFactory.getProviderAdapter('railway', project);
  const adapter = adapterResult.success
    ? adapterResult.adapter as unknown as {
      getServiceVariables?: (projectId: string, serviceId: string, environmentId: string) => Promise<Record<string, string>>;
      getTcpProxy?: (environmentId: string, serviceId: string, applicationPort: number) => Promise<{ domain: string; proxyPort: number } | null>;
    }
    : null;
  if (!adapter || typeof adapter.getServiceVariables !== 'function') {
    return null;
  }
  try {
    const vars = await adapter.getServiceVariables(railwayProjectId, datastoreServiceId, railwayEnvironmentId);
    if (isExternallyUsableDatabaseUrl(vars.DATABASE_PUBLIC_URL)) return vars.DATABASE_PUBLIC_URL;
    if (isExternallyUsableDatabaseUrl(vars.DATABASE_URL)) return vars.DATABASE_URL;

    // No externally usable URL variable — check for an existing TCP proxy
    // (read-only: this runs during hv_plan and must not create one).
    if (typeof adapter.getTcpProxy === 'function') {
      const proxy = await adapter.getTcpProxy(railwayEnvironmentId, datastoreServiceId, 5432);
      if (proxy) {
        return buildRailwayProxyDatabaseUrl(vars, proxy);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveEnvironmentDatabaseUrl(
  project: Project,
  env: { id: string; name: string; platformBindings: Record<string, unknown> },
  serviceName?: string
): Promise<string | null> {
  const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  const componentBindings = component?.bindings as Record<string, unknown> | undefined;
  const componentProvider = typeof componentBindings?.provider === 'string' ? componentBindings.provider : undefined;
  if (component && componentProvider && componentProvider !== 'railway') {
    const adapterResult = await adapterFactory.getDatabaseAdapter(componentProvider, project);
    if (adapterResult.success && adapterResult.adapter) {
      const adapterUrl = await adapterResult.adapter.getConnectionUrl(component);
      if (adapterUrl) {
        return adapterUrl;
      }
    }
  }

  const componentUrl =
    typeof componentBindings?.connectionUrl === 'string' && componentBindings.connectionUrl.length > 0
      ? componentBindings.connectionUrl
      : typeof componentBindings?.connectionString === 'string' && componentBindings.connectionString.length > 0
        ? componentBindings.connectionString
        : undefined;
  if (componentUrl) {
    return componentUrl;
  }

  const bindings = env.platformBindings as {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };
  const projectId = bindings.projectId;
  const environmentId = bindings.environmentId;

  if (bindings.provider !== 'railway' || !projectId || !environmentId) {
    return null;
  }

  const services = serviceRepo.findByProjectId(project.id);
  const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];
  const serviceId = targetService ? bindings.services?.[targetService.name]?.serviceId : undefined;
  if (!serviceId) {
    return null;
  }

  const scopeHints = getProjectScopeHints(project);
  const railwayConnection = connectionRepo.findBestMatchFromHints('railway', scopeHints);
  if (!railwayConnection) {
    return null;
  }

  const secretStore = getSecretStore();
  const railwayCreds = secretStore.decryptObject<RailwayCredentials>(railwayConnection.credentialsEncrypted);
  const railwayAdapter = new RailwayAdapter();
  await railwayAdapter.connect(railwayCreds);
  return railwayAdapter.getDatabaseUrl(projectId, environmentId, serviceId);
}

export function maskDatabaseUrl(url: string): string {
  // Mask both username and password: postgres://user:pass@host → postgres://***:***@host
  return url
    .replace(/\/\/([^:@/]+):([^@]*)@/, '//***:***@')
    .replace(/\/\/([^:@/]+)@/, '//***@');
}

export async function getTableEstimates(connectionUrl: string): Promise<Record<string, number>> {
  const client = new Client({ connectionString: connectionUrl, statement_timeout: 30000 });
  await client.connect();
  try {
    const result = await client.query<{
      schema_name: string;
      table_name: string;
      row_estimate: string;
    }>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.reltuples::bigint::text AS row_estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname
    `);

    const map: Record<string, number> = {};
    for (const row of result.rows) {
      map[`${row.schema_name}.${row.table_name}`] = Number(row.row_estimate || 0);
    }
    return map;
  } finally {
    await client.end().catch(() => {});
  }
}

export function quoteIdentifier(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

async function canConnect(connectionUrl: string): Promise<{ success: boolean; error?: string }> {
  const client = new Client({ connectionString: connectionUrl, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => {});
  }
}
