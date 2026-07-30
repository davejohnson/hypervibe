import type { CommandRegistrar } from '../application/commands.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import {
  DatabaseAdapter,
  stripSqlLiteralsAndComments,
  type DatabaseCredentials,
} from '../adapters/providers/database/database.adapter.js';
import {
  isExternallyUsableDatabaseUrl,
  isPostgresDatabaseUrl,
  resolveExternalDatabaseUrl,
  maskDatabaseUrl,
} from '../domain/services/database-ops.service.js';
import {
  acquireExistingDatabaseAccess,
  acquireManagedDatabaseAccess,
  type DatabaseAccessCleanup,
  type DatabaseAccessLease,
} from '../domain/services/database-access.service.js';
import type { CommandContext } from '../application/context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import { projectField, envField } from './schemas.js';
import { commandSuccess, commandError, wrapCommandHandler, HvError } from '../application/results.js';

type ResolvedDatabaseTarget = {
  url: string;
  source: string;
  project?: Project;
};

type ResolvedDatabaseAccessTarget = {
  source: string;
  project?: Project;
  environment?: string;
  databaseAccess: DatabaseAccessLease;
};

function assertManagedEnvironmentUsesPostgres(
  ctx: CommandContext,
  environment: { id: string; name: string }
): void {
  const postgres = ctx.repos.components.findByEnvironmentAndType(environment.id, 'postgres');
  const mongodb = ctx.repos.components.findByEnvironmentAndType(environment.id, 'mongodb');
  if (!postgres && mongodb) {
    throw new HvError(
      'VALIDATION',
      `Environment "${environment.name}" uses MongoDB; hv_db_query and hv_db_url support PostgreSQL only.`,
      {
        details: { engine: 'mongodb' },
        hint: 'Use an engine-aware MongoDB operation through the application or provider until Hypervibe exposes a bounded MongoDB command contract.',
      }
    );
  }
}

function sqlFingerprint(sql: string): string {
  const normalized = stripSqlLiteralsAndComments(sql).trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function assertPostgresTarget(url: string, source: string): void {
  if (!isPostgresDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not a supported Postgres URL.`, {
      hint: 'Hypervibe database tools currently support postgres:// and postgresql:// URLs. Provider template refs and private runtime URLs must be resolved before querying.',
    });
  }
  if (!isExternallyUsableDatabaseUrl(url)) {
    throw new HvError('VALIDATION', `Database target ${source} is not externally reachable from Hypervibe.`, {
      hint: 'Use a public/provider-supported database URL, or select the managed environment with hv_db_query so Hypervibe can acquire operation-scoped access.',
    });
  }
}

async function resolveConfiguredTarget(
  ctx: CommandContext,
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
  return new HvError('NOT_FOUND', `Could not resolve an externally reachable Postgres URL for ${project.name}/${environment.name}.`, {
    details: {
      source: `${project.name}/${environment.name}`,
    },
    hint: 'The managed database may be internal-only or stored as a provider runtime reference. Use hv_db_query for bounded diagnostics with operation-scoped access, or pass connectionUrl/connectionName explicitly.',
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
  ctx: CommandContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseTarget> {
  const configured = await resolveConfiguredTarget(ctx, opts);
  if (configured) return configured;

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  assertManagedEnvironmentUsesPostgres(ctx, environment);
  const url = await resolveExternalDatabaseUrl(project, environment, opts.service);
  if (!url) {
    throw unavailableExternalDatabaseTarget(project, environment);
  }
  return { url, source: `${project.name}/${environment.name}${opts.service ? `/${opts.service}` : ''}`, project };
}

async function resolveTemporaryExternalTarget(
  ctx: CommandContext,
  opts: { connectionUrl?: string; connectionName?: string; project?: string; env?: string; service?: string }
): Promise<ResolvedDatabaseAccessTarget> {
  const configured = await resolveConfiguredTarget(ctx, opts);
  if (configured) {
    return {
      source: configured.source,
      project: configured.project,
      databaseAccess: acquireExistingDatabaseAccess(configured.url),
    };
  }

  const project = ctx.resolveProjectOrThrow({ project: opts.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, opts.env);
  assertManagedEnvironmentUsesPostgres(ctx, environment);
  const result = await acquireManagedDatabaseAccess(project, environment, opts.service);
  if (!result.ok) {
    const code = result.code === 'provider_error' ? 'PROVIDER_ERROR' : 'NOT_FOUND';
    throw new HvError(code, result.error, {
      details: {
        provider: result.provider,
        resourceCreated: result.resourceCreated,
        cleanup: result.cleanup,
      },
      hint: result.hint,
    });
  }
  return {
    source: `${project.name}/${environment.name}${opts.service ? `/${opts.service}` : ''}`,
    project,
    environment: environment.name,
    databaseAccess: result.lease,
  };
}

export function registerHvDbTools(commands: CommandRegistrar, ctx: CommandContext): void {
  commands.register(
    'hv_db_query',
    'Run one bounded SQL statement against a database. Hypervibe uses an existing reachable endpoint or acquires provider-owned operation-scoped access (such as a connector, TCP proxy, or temporary firewall rule), then releases only access it created and reports cleanup status. SELECT is database-enforced read-only by default; allowMutations=true enables INSERT/UPDATE/DELETE/DDL. Multi-statement SQL is always rejected.',
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
    wrapCommandHandler(async ({ project, env, sql, params, allowMutations, connectionUrl, connectionName, service }) => {
      const dbAdapter = new DatabaseAdapter();
      const analysis = dbAdapter.analyzeQuery(sql);

      if (analysis.multiStatement) {
        return commandError('VALIDATION', 'Multi-statement SQL is not allowed.', {
          hint: 'Run one statement per hv_db_query call.',
        });
      }
      if (analysis.isMutation && !allowMutations) {
        const requestedSource = connectionName
          ? `connection: ${connectionName}`
          : connectionUrl
            ? 'direct URL'
            : `${project ?? 'auto-detected project'}/${env ?? 'staging'}${service ? `/${service}` : ''}`;
        return commandError('CONFIRM_REQUIRED', 'Mutation query blocked for safety.', {
          details: { source: requestedSource, warnings: analysis.warnings },
          hint: 'Re-run with allowMutations=true to execute INSERT/UPDATE/DELETE/DDL.',
        });
      }

      const target = await resolveTemporaryExternalTarget(ctx, { connectionUrl, connectionName, project, env, service });
      const lease = target.databaseAccess;
      const startedAt = Date.now();
      let result: Awaited<ReturnType<DatabaseAdapter['query']>> | undefined;
      let queryError: unknown;
      let cleanup: DatabaseAccessCleanup = { status: 'no_op' };
      try {
        result = await lease.withConnection(async (resolvedUrl) => {
          dbAdapter.connect({ connectionUrl: resolvedUrl });
          return dbAdapter.query(sql, params, { readOnly: !analysis.isMutation });
        });
      } catch (error) {
        queryError = error;
      } finally {
        try {
          cleanup = await lease.release();
        } catch {
          cleanup = {
            status: 'failed',
            safeResourceId: lease.safeResourceId,
            warning: 'Temporary database access cleanup failed unexpectedly and could not be verified.',
          };
        }
      }

      const durationMs = Date.now() - startedAt;
      const access = {
        mode: lease.mode,
        provider: lease.provider,
        leaseId: lease.id,
        leaseCreated: lease.createdByInvocation,
        cleanup: cleanup.status,
        ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
        ...(cleanup.safeResourceId ? { resourceId: cleanup.safeResourceId } : {}),
      };
      let auditWarning: string | undefined;
      try {
        ctx.repos.audit.create({
          action: result?.success === true && !queryError ? 'db_query.succeeded' : 'db_query.failed',
          resourceType: 'database',
          resourceId: target.source,
          details: {
            project: target.project?.name ?? project ?? null,
            environment: target.environment ?? env ?? null,
            provider: lease.provider,
            queryType: analysis.isMutation ? 'mutation' : 'select',
            sqlFingerprint: sqlFingerprint(sql),
            durationMs,
            rowCount: result?.rowCount,
            accessMode: lease.mode,
            leaseId: lease.id,
            leaseCreated: lease.createdByInvocation,
            cleanup: cleanup.status,
            cleanupResourceId: cleanup.safeResourceId,
          },
        });
      } catch {
        auditWarning = 'The query completed, but Hypervibe could not record its local diagnostic audit event.';
      }

      const responseWarnings = [cleanup.warning, auditWarning].filter((value): value is string => Boolean(value));
      if (queryError) {
        return commandError('PROVIDER_ERROR', queryError instanceof Error ? queryError.message : String(queryError), {
          details: { source: target.source, durationMs, access },
          warnings: responseWarnings,
          hint: cleanup.status === 'failed'
            ? 'The query and cleanup both failed. Inspect the managed database with hv_inspect before retrying.'
            : 'Check the database connection and SQL, then retry the diagnostic query.',
        });
      }
      if (!result) {
        throw new Error('Database query returned no result.');
      }
      if (!result.success) {
        return commandError('PROVIDER_ERROR', result.error ?? 'Query failed', {
          details: { source: target.source, durationMs, access },
          warnings: responseWarnings,
          hint: cleanup.status === 'failed'
            ? 'The query failed and temporary access cleanup is pending. Inspect with hv_inspect before retrying.'
            : undefined,
        });
      }

      return commandSuccess(
        {
          source: target.source,
          queryType: analysis.isMutation ? 'mutation' : 'select',
          rowCount: result.rowCount,
          durationMs,
          access,
          ...(analysis.isMutation
            ? { warnings: analysis.warnings.length ? analysis.warnings : undefined }
            : { rows: result.rows, fields: result.fields?.map((f) => f.name) }),
        },
        {
          warnings: responseWarnings,
          ...(cleanup.status === 'failed'
            ? {
              agentInstruction: {
                action: 'stop_and_report' as const,
                message: 'The query result is valid, but temporary database access cleanup failed. Report the safe resource id and inspect it with hv_inspect before another query.',
              },
              hint: 'The query succeeded, but public access may remain until the registered cleanup retry succeeds. Inspect with hv_inspect.',
            }
            : {}),
        }
      );
    })
  );

  commands.register(
    'hv_db_url',
    'Get the database connection URL for an environment. Values are always masked in command output to avoid leaking credentials into transcripts or terminals.',
    {
      project: projectField,
      env: envField,
      service: z.string().optional().describe('Service name when resolving from bindings'),
      reveal: z.boolean().optional().describe('Deprecated: raw URLs are not returned in command output'),
    },
    wrapCommandHandler(async ({ project, env, service, reveal }) => {
      const target = await resolveExternalTarget(ctx, { project, env, service });
      return commandSuccess(
        {
          source: target.source,
          databaseUrl: maskDatabaseUrl(target.url),
          masked: true,
          ...(reveal ? { revealSuppressed: true } : {}),
        },
        {
          hint: reveal
            ? 'Raw database URLs are not returned in command output. Prefer hv_db_query for bounded diagnostics, or retrieve the credential directly from the provider/secret manager when a human must use it.'
            : 'Use hv_db_query for bounded diagnostics without exposing the connection URL.',
        }
      );
    })
  );
}
