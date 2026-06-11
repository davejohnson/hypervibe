import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DatabaseAdapter, type DatabaseCredentials } from '../adapters/providers/database/database.adapter.js';
import {
  runDatabaseMigration,
  executeDatabaseReset,
  resolveEnvironmentDatabaseUrl,
  maskDatabaseUrl,
} from '../domain/services/database-ops.service.js';
import type { ToolContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

/**
 * Resolve a database URL with the same priority the legacy db tools use:
 * direct URL > named connection > project/environment component bindings.
 */
async function resolveTarget(
  ctx: ToolContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<{ url: string; source: string; project?: Project }> {
  if (opts.connectionUrl) {
    return { url: opts.connectionUrl, source: 'direct URL' };
  }
  if (opts.connectionName) {
    const connection = ctx.repos.connections.findBestMatch('database', opts.connectionName);
    if (!connection) {
      throw new HvError('NOT_FOUND', `No database connection found for: ${opts.connectionName}.`, {
        hint: `Create one with hv_connect provider="database" scope="${opts.connectionName}".`,
      });
    }
    const creds = ctx.secretStore.decryptObject<DatabaseCredentials>(connection.credentialsEncrypted);
    return { url: creds.connectionUrl, source: `connection: ${opts.connectionName}` };
  }

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  const url = await resolveEnvironmentDatabaseUrl(project, environment, opts.service);
  if (!url) {
    throw new HvError('NOT_FOUND', `Could not resolve a database URL for ${project.name}/${environment.name}.`, {
      hint: 'Ensure the environment has a database component (hv_apply with database in the spec) or pass connectionUrl directly.',
    });
  }
  return { url, source: `${project.name}/${environment.name}`, project };
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
      const target = await resolveTarget(ctx, { connectionUrl, connectionName, project, env, service });

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
    'Run database migrations on a deployed environment (mode "up", default), or reset the database by dropping all tables (mode "reset", confirm-gated).',
    {
      project: projectField,
      env: envField,
      mode: z.enum(['up', 'reset']).optional().describe('Default "up"'),
      command: z.string().optional().describe('mode=up: migration command (default: prisma preset)'),
      preset: z.enum(['prisma', 'prisma-push', 'drizzle', 'typeorm', 'knex', 'sequelize', 'django', 'rails', 'laravel']).optional()
        .describe('mode=up: use a preset migration command'),
      service: z.string().optional().describe('Service to run the migration on (default: first service)'),
      dryRun: z.boolean().optional().describe('mode=up: show what would run without executing'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, env, mode = 'up', command, preset, service, dryRun, confirm }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);

      if (mode === 'reset') {
        const target = await resolveTarget(ctx, { project: projectRef, env, service });
        if (!confirm) {
          return toolError('CONFIRM_REQUIRED', 'Database reset drops ALL tables and data.', {
            details: { source: target.source, connectionUrl: maskDatabaseUrl(target.url) },
            hint: 'Re-run with confirm=true to execute the reset.',
          });
        }
        const payload = await executeDatabaseReset(target.url, target.source);
        return toolSuccess(payload);
      }

      const payload = await runDatabaseMigration({
        project,
        env: environment,
        command,
        preset,
        serviceName: service,
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
    'Get the database connection URL for an environment. Masked by default; reveal=true returns the full URL (for local migrations/debugging).',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name when resolving from bindings'),
      reveal: z.boolean().optional().describe('Return the unmasked URL (default false)'),
    },
    wrapHandler(async ({ project, env, service, reveal }) => {
      const target = await resolveTarget(ctx, { project, env, service });
      return toolSuccess(
        {
          source: target.source,
          databaseUrl: reveal ? target.url : maskDatabaseUrl(target.url),
          masked: !reveal,
        },
        {
          hint: reveal
            ? 'Use for local debugging only. Prefer hv_db_query/hv_db_migrate for managed workflows.'
            : 'Pass reveal=true if you need the full URL.',
        }
      );
    })
  );
}
