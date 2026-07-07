import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DatabaseAdapter, type DatabaseCredentials } from '../adapters/providers/database/database.adapter.js';
import {
  runDatabaseMigration,
  runDatabaseSeed,
  executeDatabaseReset,
  canCreateRailwayDatabaseTcpProxy,
  ensureExternalDatabaseUrl,
  isExternallyUsableDatabaseUrl,
  isPostgresDatabaseUrl,
  resolveExternalDatabaseUrl,
  maskDatabaseUrl,
} from '../domain/services/database-ops.service.js';
import {
  databaseMigrationStrategyStatus,
  executeManagedDatabaseMove,
  resolveManagedMoveTargets,
} from '../domain/services/database-move.service.js';
import { resolveSecretValueRef } from '../domain/services/secret-value-ref.js';
import type { ToolContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

type ResolvedDatabaseTarget = { url: string; source: string; project?: Project; tcpProxyCreated?: boolean; proxyDomain?: string };

function assertPostgresTarget(url: string, source: string): void {
  if (!isPostgresDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not a supported Postgres URL.`, {
      hint: 'Hypervibe database tools currently support postgres:// and postgresql:// URLs. Provider template refs and private runtime URLs must be resolved before querying.',
    });
  }
  if (!isExternallyUsableDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not externally reachable from Hypervibe.`, {
      hint: 'Use a public/provider-supported database URL, create or reuse a managed TCP proxy through a confirmed database operation, or run migrations/seeds in-environment so no external database URL is needed.',
    });
  }
}

async function resolveConfiguredTarget(
  ctx: ToolContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseTarget | null> {
  if (opts.connectionUrl) {
    assertPostgresTarget(opts.connectionUrl, 'direct URL');
    return { url: opts.connectionUrl, source: 'direct URL' };
  }
  if (opts.connectionName) {
    const connection = ctx.repos.connections.findBestMatch('database', opts.connectionName);
    if (!connection) {
      throw new HvError('NOT_FOUND', `No database connection found for: ${opts.connectionName}.`, {
        hint: formatConnectionGuidance('database', { scope: opts.connectionName }),
      });
    }
    const creds = ctx.secretStore.decryptObject<DatabaseCredentials>(connection.credentialsEncrypted);
    assertPostgresTarget(creds.connectionUrl, `connection: ${opts.connectionName}`);
    return { url: creds.connectionUrl, source: `connection: ${opts.connectionName}` };
  }
  return null;
}

function unavailableExternalDatabaseTarget(project: Project, environment: { name: string; id: string; platformBindings: Record<string, unknown> }): HvError {
  const canCreateTcpProxy = canCreateRailwayDatabaseTcpProxy(environment);
  return new HvError('NOT_FOUND', `Could not resolve an externally reachable Postgres URL for ${project.name}/${environment.name}.`, {
    details: {
      source: `${project.name}/${environment.name}`,
      canCreateTcpProxy,
    },
    hint: canCreateTcpProxy
      ? 'The managed database appears to be internal-only or stored as provider runtime references. Create or reuse a public TCP proxy through a confirmed database operation, or pass connectionUrl/connectionName explicitly. In-environment migrations/seeds do not need this because they run inside the hosting network.'
      : 'Ensure the environment has a tracked Postgres database with an externally reachable connection URL, or pass connectionUrl/connectionName explicitly.',
  });
}

/**
 * Resolve a database URL usable by local Hypervibe tooling:
 * direct URL > named connection > externally reachable project/env database.
 *
 * This intentionally does not return provider runtime refs like
 * ${{Postgres.DATABASE_URL}} or private hosts such as *.railway.internal.
 */
async function resolveExternalTarget(
  ctx: ToolContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseTarget> {
  const configured = await resolveConfiguredTarget(ctx, opts);
  if (configured) return configured;

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  const url = await resolveExternalDatabaseUrl(project, environment, opts.service);
  if (!url) {
    throw unavailableExternalDatabaseTarget(project, environment);
  }
  return { url, source: `${project.name}/${environment.name}${opts.service ? `/${opts.service}` : ''}`, project };
}

async function resolveConfirmedExternalTarget(
  ctx: ToolContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseTarget> {
  const configured = await resolveConfiguredTarget(ctx, opts);
  if (configured) return configured;

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  const result = await ensureExternalDatabaseUrl(project, environment, opts.service);
  if (!result.ok) {
    const code = result.code === 'provider_error' ? 'PROVIDER_ERROR' : 'NOT_FOUND';
    throw new HvError(code, result.error, { hint: result.hint });
  }
  return {
    url: result.url,
    source: `${project.name}/${environment.name}${opts.service ? `/${opts.service}` : ''}`,
    project,
    tcpProxyCreated: result.tcpProxyCreated,
    proxyDomain: result.proxyDomain,
  };
}

export function registerHvDbTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_db_query',
    'Run a single SQL statement against a database. SELECT only by default; allowMutations=true enables INSERT/UPDATE/DELETE/DDL. Multi-statement SQL is always rejected.',
    {
      project: projectField,
      env: envField,
      sql: z.string().describe('One SQL statement'),
      params: z.array(z.unknown()).optional().describe('Positional query parameters ($1, $2, ...)'),
      allowMutations: z.boolean().optional().describe('Allow mutating statements (default false)'),
      connectionUrl: z.string().optional().describe('Direct postgres:// URL (overrides project/env)'),
      connectionName: z.string().optional().describe('Named database connection (overrides project/env)'),
      service: z.string().optional().describe('Service name when resolving from project bindings'),
    },
    wrapHandler(async ({ project, env, sql, params, allowMutations, connectionUrl, connectionName, service }) => {
      const target = await resolveExternalTarget(ctx, { connectionUrl, connectionName, project, env, service });

      const dbAdapter = new DatabaseAdapter();
      dbAdapter.connect({ connectionUrl: target.url });
      const analysis = dbAdapter.analyzeQuery(sql);

      if (analysis.multiStatement) {
        return toolError('VALIDATION', 'Multi-statement SQL is not allowed.', {
          hint: 'Run one statement per hv_db_query call.',
        });
      }
      if (analysis.isMutation && !allowMutations) {
        return toolError('CONFIRM_REQUIRED', 'Mutation query blocked for safety.', {
          details: { source: target.source, warnings: analysis.warnings },
          hint: 'Re-run with allowMutations=true to execute INSERT/UPDATE/DELETE/DDL.',
        });
      }

      const result = await dbAdapter.query(sql, params);
      if (!result.success) {
        return toolError('PROVIDER_ERROR', result.error ?? 'Query failed', { details: { source: target.source } });
      }

      return toolSuccess({
        source: target.source,
        queryType: analysis.isMutation ? 'mutation' : 'select',
        rowCount: result.rowCount,
        ...(analysis.isMutation
          ? { warnings: analysis.warnings.length ? analysis.warnings : undefined }
          : { rows: result.rows, fields: result.fields?.map((f) => f.name) }),
      });
    })
  );

  server.tool(
    'hv_db_migrate',
    'Database operations for a deployed environment. mode="up" runs schema migrations; mode="seed" explicitly re-runs a one-off seed/bootstrap command (fresh-environment seed/bootstrap data should be declared as database.seedCommand and applied through hv_plan/hv_apply); mode="reset" drops all tables; mode="move" copies data from the previous provider into the current database during staged provider migration (pg_dump | pg_restore snapshot plus row-count verification). up/seed default to runIn="environment": the command runs INSIDE the hosting environment (Cloud Run job / temporary Railway service) using the deployed image and its env vars — no database exposure, no local .env. runIn="local" spawns the command locally against an externally reachable database URL instead. Mutating modes are confirm-gated.',
    {
      project: projectField,
      env: envField,
      mode: z.enum(['up', 'reset', 'move', 'seed']).optional().describe('Default "up"'),
      command: z.string().optional().describe('mode=up: migration command (default: prisma preset); mode=seed: required explicit re-run/repair seed command. For fresh environments prefer database.seedCommand in the spec.'),
      preset: z.enum(['prisma', 'prisma-push', 'drizzle', 'typeorm', 'knex', 'sequelize', 'django', 'rails', 'laravel']).optional()
        .describe('mode=up: use a preset migration command'),
      service: z.string().optional().describe('Service to run the migration on (default: first service)'),
      runIn: z.enum(['environment', 'local']).optional().describe('mode=up/seed: "environment" (default when supported) runs inside the hosting environment with the deployed image + env vars; "local" spawns locally against an externally reachable database URL.'),
      dryRun: z.boolean().optional().describe('mode=up or mode=seed: show what would run without executing'),
      sourceConnectionUrl: z.string().optional().describe('mode=move: override the source database URL. Accepts chat-safe refs — env:NAME, dotenv:/absolute/path/.env#KEY, file:/absolute/path — so the URL/password never enters chat. (Default: the previous provider recorded during hv_apply.)'),
      targetConnectionUrl: z.string().optional().describe('mode=move or mode=seed: override the target database URL; same chat-safe refs supported. (Default: the environment\'s current database, creating a Railway TCP proxy only from a confirmed mutating operation when required.)'),
      criticalTables: z.array(z.string()).optional().describe('mode=move: tables to verify with exact row counts (default: the 8 largest)'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, mode = 'up', command, preset, service, runIn, dryRun, sourceConnectionUrl, targetConnectionUrl, criticalTables, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);

      if (mode === 'move') {
        const resolveUrlOverride = async (input?: string): Promise<string | undefined> => {
          if (!input) return undefined;
          if (/^(env|dotenv|file):/.test(input.trim())) {
            return resolveSecretValueRef(input, { projectId: project.id, environmentName: environment.name });
          }
          return input;
        };
        const [sourceOverride, targetOverride] = await Promise.all([
          resolveUrlOverride(sourceConnectionUrl),
          resolveUrlOverride(targetConnectionUrl),
        ]);
        const resolved = await resolveManagedMoveTargets({ project, environment, sourceConnectionUrl: sourceOverride, targetConnectionUrl: targetOverride });
        // target_unreachable is previewable: the confirm-gated execute path
        // creates a public TCP proxy so the target becomes reachable.
        if (!resolved.ok && resolved.code !== 'target_unreachable') {
          const code = resolved.code === 'tooling' ? 'UNSUPPORTED' : 'NOT_FOUND';
          return toolError(code, resolved.error, { hint: resolved.hint });
        }
        if (!confirm) {
          if (!resolved.ok) {
            return toolError('CONFIRM_REQUIRED', 'Managed database move copies data with pg_dump | pg_restore (pg_restore --clean replaces existing objects in the target). The target Railway database is internal-only: confirming will also create a public TCP proxy for it.', {
              details: {
                target: {
                  provider: 'railway',
                  reachable: false,
                  note: 'A public TCP proxy will be created for the database so pg_dump/pg_restore can reach it.',
                },
                strategy: databaseMigrationStrategyStatus('snapshot'),
              },
              hint: 'Freeze writes to the source (or plan a final re-run) and re-run with confirm=true. After the move, re-run hv_plan to repoint services, verify the app, then confirm the old database destroy.',
            });
          }
          return toolError('CONFIRM_REQUIRED', 'Managed database move copies data with pg_dump | pg_restore (pg_restore --clean replaces existing objects in the target).', {
            details: {
              source: { provider: resolved.sourceProvider ?? 'unknown', url: maskDatabaseUrl(resolved.sourceUrl) },
              target: { provider: resolved.targetProvider ?? 'unknown', url: maskDatabaseUrl(resolved.targetUrl) },
              strategy: databaseMigrationStrategyStatus('snapshot'),
            },
            hint: 'Freeze writes to the source (or plan a final re-run) and re-run with confirm=true. After the move, re-run hv_plan to repoint services, verify the app, then confirm the old database destroy.',
          });
        }

        const result = await executeManagedDatabaseMove({ project, environment, sourceConnectionUrl: sourceOverride, targetConnectionUrl: targetOverride, criticalTables });
        if (!result.ok) {
          const code = result.code === 'tooling' ? 'UNSUPPORTED' : 'PROVIDER_ERROR';
          return toolError(code, result.error, { hint: result.hint });
        }
        return toolSuccess(
          {
            moved: true,
            source: { provider: result.sourceProvider ?? 'unknown' },
            target: { provider: result.targetProvider ?? 'unknown' },
            ...(result.tcpProxyCreated !== undefined
              ? { tcpProxyCreated: result.tcpProxyCreated, proxyDomain: result.proxyDomain }
              : {}),
            verification: result.verification,
          },
          {
            warnings: result.verification.ok
              ? undefined
              : [`Row counts differ on ${result.verification.mismatches.length} table(s) — writes may have continued on the source. Freeze writes and re-run the move, or verify manually.`],
            hint: result.verification.ok
              ? 'Copy verified. Next: hv_plan then hv_apply to repoint services at the new database, verify app health, then re-run hv_plan and confirm the old database destroy action.'
              : 'Resolve the row-count mismatches before cutting over.',
            next: ['hv_plan', 'hv_apply'],
          }
        );
      }

      if (mode === 'seed') {
        const resolvedTargetRaw = targetConnectionUrl && /^(env|dotenv|file):/.test(targetConnectionUrl.trim())
          ? await resolveSecretValueRef(targetConnectionUrl, { projectId: project.id, environmentName: environment.name })
          : targetConnectionUrl;
        const resolvedTarget = resolvedTargetRaw?.trim();
        if (!command?.trim()) {
          return toolError('VALIDATION', 'mode="seed" requires command, for example command="npm run db:seed".', {
            hint: 'Seed data is a one-off database operation; do not set a temporary releaseCommand for it.',
          });
        }
        const preview = await runDatabaseSeed({
          project,
          env: environment,
          command,
          targetConnectionUrl: resolvedTarget,
          runIn,
          dryRun: true,
        });
        if (dryRun) {
          return toolSuccess(preview);
        }
        if (!confirm) {
          return toolError('CONFIRM_REQUIRED', 'Seed commands mutate the target database and must be confirmed.', {
            details: preview,
            hint: 'Review the target and command, then re-run with confirm=true. This does not change service releaseCommand.',
          });
        }
        const result = await runDatabaseSeed({
          project,
          env: environment,
          command,
          targetConnectionUrl: resolvedTarget,
          runIn,
        });
        if (result.success === false) {
          return toolError('PROVIDER_ERROR', String(result.error ?? 'Seed command failed'), {
            details: result,
            hint: typeof result.hint === 'string'
              ? result.hint
              : result.runner === 'environment'
                ? 'Check the task output. The command ran inside the hosting environment with the deployed image and env vars.'
                : 'Check the command output. The command runs locally with DATABASE_URL and DIRECT_URL pinned to the target database.',
          });
        }
        return toolSuccess(result, {
          hint: 'Seed complete. Run hv_db_query or app-level health checks to verify the seeded data.',
        });
      }

      if (mode === 'reset') {
        if (!confirm) {
          const configured = await resolveConfiguredTarget(ctx, { project: projectRef, env, service });
          const project = ctx.resolveProjectOrThrow({ project: projectRef });
          const environment = ctx.resolveEnvironmentOrThrow(project, env);
          const previewUrl = configured?.url ?? await resolveExternalDatabaseUrl(project, environment, service);
          const canCreateTcpProxy = canCreateRailwayDatabaseTcpProxy(environment);
          return toolError('CONFIRM_REQUIRED', 'Database reset drops ALL tables and data.', {
            details: previewUrl
              ? {
                source: configured?.source ?? `${project.name}/${environment.name}${service ? `/${service}` : ''}`,
                connectionUrl: maskDatabaseUrl(previewUrl),
              }
              : {
                source: `${project.name}/${environment.name}${service ? `/${service}` : ''}`,
                reachable: false,
                canCreateTcpProxy,
              },
            hint: previewUrl
              ? 'Re-run with confirm=true to execute the reset.'
              : canCreateTcpProxy
                ? 'The database is internal-only. Re-running with confirm=true will create or reuse a public TCP proxy before executing the reset.'
                : 'No externally reachable database URL is available. Pass connectionUrl/connectionName explicitly or fix the managed database bindings before confirming.',
          });
        }
        const target = await resolveConfirmedExternalTarget(ctx, { project: projectRef, env, service });
        const payload = await executeDatabaseReset(target.url, target.source);
        return toolSuccess({
          ...payload,
          ...(target.tcpProxyCreated !== undefined
            ? { tcpProxyCreated: target.tcpProxyCreated, proxyDomain: target.proxyDomain }
            : {}),
        });
      }

      const payload = await runDatabaseMigration({
        project,
        env: environment,
        command,
        preset,
        serviceName: service,
        runIn,
        dryRun,
      });
      if (payload.success === false) {
        return toolError('PROVIDER_ERROR', String(payload.error ?? 'Migration failed'), {
          details: payload,
          hint: typeof payload.hint === 'string' ? payload.hint : undefined,
        });
      }
      return toolSuccess(payload);
    })
  );

  server.tool(
    'hv_db_url',
    'Get the database connection URL for an environment. Values are always masked in tool output to avoid leaking credentials into chat transcripts.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name when resolving from bindings'),
      reveal: z.boolean().optional().describe('Deprecated: raw URLs are not returned in tool output'),
    },
    wrapHandler(async ({ project, env, service, reveal }) => {
      const target = await resolveExternalTarget(ctx, { project, env, service });
      return toolSuccess(
        {
          source: target.source,
          databaseUrl: maskDatabaseUrl(target.url),
          masked: true,
          ...(reveal ? { revealSuppressed: true } : {}),
        },
        {
          hint: reveal
            ? 'Raw database URLs are not returned in chat/tool output. Prefer hv_db_query/hv_db_migrate for managed workflows, or retrieve the credential directly from the provider/secret manager when a human must use it.'
            : 'Use hv_db_query/hv_db_migrate for managed database work without exposing the connection URL.',
        }
      );
    })
  );
}
