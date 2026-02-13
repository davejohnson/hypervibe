import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pg from 'pg';
import { spawn, spawnSync } from 'child_process';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { DatabaseAdapter } from '../adapters/providers/database/database.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';
import type { DatabaseCredentials } from '../adapters/providers/database/database.adapter.js';
import type { Project } from '../domain/entities/project.entity.js';
import { resolveProject, resolveProjectOrError } from './resolve-project.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';

const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
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

export function registerDbTools(server: McpServer): void {
  server.tool(
    'db_migrate',
    'Run database migrations on a deployed environment',
    {
      projectName: z.string().optional().describe('Project name (auto-detects if only one)'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      command: z.string().optional().describe('Migration command (default: auto-detect or prisma)'),
      preset: z
        .enum(['prisma', 'prisma-push', 'drizzle', 'typeorm', 'knex', 'sequelize', 'django', 'rails', 'laravel'])
        .optional()
        .describe('Use a preset migration command'),
      serviceName: z.string().optional().describe('Service to run migration on (default: first service)'),
      dryRun: z.boolean().optional().describe('Show what would be run without executing'),
    },
    async ({ projectName, environment = 'staging', command, preset, serviceName, dryRun }) => {
      // Resolve project
      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

      // Resolve environment
      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        const allEnvs = envRepo.findByProjectId(project.id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment not found: ${environment}`,
              available: allEnvs.map((e) => e.name),
            }),
          }],
        };
      }

      // Get bindings
      const bindings = env.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

      // Resolve service
      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName
        ? services.find((s) => s.name === serviceName)
        : services[0];

      if (!targetService) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: serviceName ? `Service not found: ${serviceName}` : 'No services found',
            }),
          }],
        };
      }

      const serviceBinding = bindings.services?.[targetService.name];
      if (!serviceBinding) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service ${targetService.name} not deployed to Railway`,
            }),
          }],
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
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              dryRun: true,
              message: 'Would run migration',
              project: project.name,
              environment: env.name,
              service: targetService.name,
              command: migrationCommand,
            }),
          }],
        };
      }

      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection found' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      try {
        const result = await adapter.executeCommand(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          serviceBinding.serviceId,
          migrationCommand
        );

        if (result.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Migration completed',
                project: project.name,
                environment: env.name,
                service: targetService.name,
                command: migrationCommand,
                output: result.output,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: result.error,
                project: project.name,
                environment: env.name,
                command: migrationCommand,
                hint: 'If direct execution is not available, you can run migrations locally using: railway link && railway run ' + migrationCommand,
              }),
            }],
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'db_url',
    'Get the database connection URL for an environment (for local migrations or debugging)',
    {
      projectName: z.string().optional().describe('Project name'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      serviceName: z.string().optional().describe('Service name'),
    },
    async ({ projectName, environment = 'staging', serviceName }) => {
      // Resolve project
      const result2 = resolveProjectOrError({ projectName });
      if ('error' in result2) return result2.error;
      const project = result2.project;

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      const bindings = env.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
          }],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName
        ? services.find((s) => s.name === serviceName)
        : services[0];

      if (!targetService || !bindings.services?.[targetService.name]) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Service not found' }),
          }],
        };
      }

      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No Railway connection' }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      try {
        const dbUrl = await adapter.getDatabaseUrl(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          bindings.services[targetService.name].serviceId
        );

        if (dbUrl) {
          // Mask password in output
          const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':***@');
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                environment: env.name,
                databaseUrl: maskedUrl,
                hint: 'Use this URL to run migrations locally: DATABASE_URL="<url>" npx prisma migrate deploy',
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'No DATABASE_URL found in service variables',
              }),
            }],
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'db_migrate_presets',
    'List available migration command presets',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            presets: Object.entries(MIGRATION_PRESETS).map(([name, command]) => ({
              name,
              command,
            })),
            usage: 'Use with: db_migrate preset="prisma" or db_migrate command="custom command"',
          }),
        }],
      };
    }
  );

  server.tool(
    'db_provision',
    'Provision a managed database (default: Supabase Postgres), save it as a component, and optionally sync env vars to hosting.',
    {
      projectName: z.string().optional().describe('Project name (auto-detect if one project)'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      provider: z.enum(['supabase', 'rds', 'cloudsql']).optional().describe('Database provider (default: supabase)'),
      databaseType: z.enum(['postgres', 'mysql', 'mongodb', 'redis']).optional().describe('Database/cache type (default: postgres)'),
      size: z.string().optional().describe('Provider instance size/tier'),
      region: z.string().optional().describe('Provider region'),
      databaseName: z.string().optional().describe('Database name'),
      serviceName: z.string().optional().describe('Service to inject env vars into (default: first service)'),
      syncToHosting: z.boolean().optional().describe('Sync provisioned env vars to hosting provider (default: true)'),
      dryRun: z.boolean().optional().describe('Preview only'),
    },
    async ({
      projectName,
      environment = 'staging',
      provider = 'supabase',
      databaseType = 'postgres',
      size,
      region,
      databaseName,
      serviceName,
      syncToHosting = true,
      dryRun = false,
    }) => {
      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      if (dryRun) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              dryRun: true,
              plan: {
                provider,
                databaseType,
                project: project.name,
                environment: env.name,
                size,
                region,
                databaseName,
                syncToHosting,
                serviceName: serviceName ?? '(first service)',
              },
            }),
          }],
        };
      }

      const adapterResult = await adapterFactory.getDatabaseAdapter(provider, project);
      if (!adapterResult.success || !adapterResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: adapterResult.error || `No ${provider} database adapter available` }),
          }],
        };
      }

      const provisionResult = await adapterResult.adapter.provision(databaseType, env, {
        size,
        region,
        databaseName,
      });

      if (!provisionResult.receipt.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: provisionResult.receipt.error || provisionResult.receipt.message,
            }),
          }],
        };
      }

      const existing = componentRepo.findByEnvironmentAndType(env.id, databaseType);
      const component = existing
        ? componentRepo.update(existing.id, {
            type: databaseType,
            bindings: provisionResult.component.bindings,
            externalId: provisionResult.component.externalId ?? undefined,
          })
        : componentRepo.create({
            environmentId: env.id,
            type: databaseType,
            bindings: provisionResult.component.bindings,
            externalId: provisionResult.component.externalId ?? undefined,
          });

      const syncResult: { success: boolean; error?: string } = { success: false };
      if (syncToHosting && provisionResult.envVars && Object.keys(provisionResult.envVars).length > 0) {
        const hostingResult = await adapterFactory.getHostingAdapter(project);
        if (hostingResult.success && hostingResult.adapter) {
          const services = serviceRepo.findByProjectId(project.id);
          const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];

          if (targetService) {
            const receipt = await hostingResult.adapter.setEnvVars(env, targetService, provisionResult.envVars);
            syncResult.success = receipt.success;
            syncResult.error = receipt.success ? undefined : (receipt.error || receipt.message);
          } else {
            syncResult.error = 'No service found to sync env vars';
          }
        } else {
          syncResult.error = hostingResult.error || 'Hosting adapter unavailable';
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            provider,
            environment: env.name,
            component,
            connectionUrl: provisionResult.connectionUrl ? maskDatabaseUrl(provisionResult.connectionUrl) : undefined,
            envVarsSynced: syncToHosting ? syncResult.success : undefined,
            envVarsSyncError: syncToHosting && !syncResult.success ? syncResult.error : undefined,
            message: `Provisioned ${databaseType} on ${provider}${syncToHosting ? ' and attempted env sync' : ''}`,
          }),
        }],
      };
    }
  );

  server.tool(
    'db_move',
    'Move/switch your app database to another provider by provisioning target DB and switching env vars with preview+confirm.',
    {
      projectName: z.string().optional().describe('Project name'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      targetProvider: z.enum(['supabase', 'rds', 'cloudsql']).describe('Target database provider'),
      serviceName: z.string().optional().describe('Service to update DATABASE_URL on'),
      databaseName: z.string().optional().describe('Target database name'),
      region: z.string().optional().describe('Target region'),
      size: z.string().optional().describe('Target size/tier'),
      confirm: z.boolean().optional().describe('Set true to execute switch'),
    },
    async ({
      projectName,
      environment = 'staging',
      targetProvider,
      serviceName,
      databaseName,
      region,
      size,
      confirm = false,
    }) => {
      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      const currentComponent = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
      const currentConnection = (currentComponent?.bindings.connectionString as string | undefined) ?? null;
      const currentProvider = (currentComponent?.bindings.provider as string | undefined) ?? 'unknown';

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Call again with confirm=true to provision target DB and switch env vars.',
              current: {
                provider: currentProvider,
                connectionUrl: currentConnection ? maskDatabaseUrl(currentConnection) : undefined,
              },
              target: {
                provider: targetProvider,
                databaseName,
                region,
                size,
                switchVars: ['DATABASE_URL', 'DIRECT_URL'],
              },
            }),
          }],
        };
      }

      const dbAdapterResult = await adapterFactory.getDatabaseAdapter(targetProvider, project);
      if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: dbAdapterResult.error || `No ${targetProvider} adapter` }),
          }],
        };
      }

      const provision = await dbAdapterResult.adapter.provision('postgres', env, {
        databaseName,
        region,
        size,
      });
      if (!provision.receipt.success || !provision.connectionUrl) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: provision.receipt.error || provision.receipt.message || 'Target DB provisioning failed',
            }),
          }],
        };
      }

      const updatedComponent = currentComponent
        ? componentRepo.update(currentComponent.id, {
            bindings: {
              ...provision.component.bindings,
              previousProvider: currentProvider,
              previousConnectionString: currentConnection,
              movedAt: new Date().toISOString(),
            },
            externalId: provision.component.externalId ?? undefined,
          })
        : componentRepo.create({
            environmentId: env.id,
            type: 'postgres',
            bindings: provision.component.bindings,
            externalId: provision.component.externalId ?? undefined,
          });

      const hostingResult = await adapterFactory.getHostingAdapter(project);
      if (!hostingResult.success || !hostingResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: hostingResult.error || 'No hosting adapter available for env var switch',
            }),
          }],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];
      if (!targetService) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No service found to apply database switch' }),
          }],
        };
      }

      const varsToSet: Record<string, string> = {
        DATABASE_URL: provision.connectionUrl,
        DIRECT_URL: provision.connectionUrl,
      };
      const receipt = await hostingResult.adapter.setEnvVars(env, targetService, varsToSet);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: receipt.success,
            message: receipt.success
              ? `Database moved to ${targetProvider}. DATABASE_URL updated on ${targetService.name}.`
              : `Target DB provisioned but env switch failed: ${receipt.error || receipt.message}`,
            component: updatedComponent,
            oldConnectionUrl: currentConnection ? maskDatabaseUrl(currentConnection) : undefined,
            newConnectionUrl: maskDatabaseUrl(provision.connectionUrl),
            rollbackHint: currentConnection
              ? `db_query is unaffected; to rollback connection switch, set DATABASE_URL and DIRECT_URL back to previous value on service ${targetService.name}`
              : undefined,
          }),
        }],
      };
    }
  );

  server.tool(
    'db_migrate_provider',
    'Staged Postgres provider migration with plan/copy/cutover phases, verification, and rollback guardrails.',
    {
      projectName: z.string().optional().describe('Project name'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      serviceName: z.string().optional().describe('Service to apply cutover vars on (default: first service)'),
      targetProvider: z.enum(['supabase', 'rds', 'cloudsql']).describe('Target provider'),
      phase: z.enum(['plan', 'copy', 'cutover']).optional().describe('Migration phase (default: plan)'),
      sourceConnectionUrl: z.string().optional().describe('Optional explicit source connection URL'),
      targetConnectionUrl: z.string().optional().describe('Optional explicit target connection URL for cutover'),
      databaseName: z.string().optional().describe('Target DB name when provisioning'),
      region: z.string().optional().describe('Target region when provisioning'),
      size: z.string().optional().describe('Target size/tier when provisioning'),
      setShadowVar: z.boolean().optional().describe('Set NEXT_DATABASE_URL after copy (default: true)'),
      criticalTables: z.array(z.string()).optional().describe('Tables to validate with exact row counts (schema.table format)'),
      verifyExactCounts: z.boolean().optional().describe('Run exact COUNT(*) checks after copy (default: true)'),
      confirm: z.boolean().optional().describe('Required for copy/cutover'),
    },
    async ({
      projectName,
      environment = 'staging',
      serviceName,
      targetProvider,
      phase = 'plan',
      sourceConnectionUrl,
      targetConnectionUrl,
      databaseName,
      region,
      size,
      setShadowVar = true,
      criticalTables,
      verifyExactCounts = true,
      confirm = false,
    }) => {
      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];

      const sourceUrl = sourceConnectionUrl ?? await resolveEnvironmentDatabaseUrl(project, env, targetService?.name);
      if (!sourceUrl) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Could not resolve source database URL' }),
          }],
        };
      }

      const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
      const toolAvailability = {
        pgDump: hasCommand('pg_dump'),
        pgRestore: hasCommand('pg_restore'),
      };

      if (phase === 'plan') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              phase: 'plan',
              project: project.name,
              environment: env.name,
              source: {
                provider: (component?.bindings.provider as string | undefined) ?? 'unknown',
                connectionUrl: maskDatabaseUrl(sourceUrl),
              },
              target: {
                provider: targetProvider,
                databaseName,
                region,
                size,
              },
              prerequisites: {
                pgDump: toolAvailability.pgDump,
                pgRestore: toolAvailability.pgRestore,
                hostingServiceResolved: Boolean(targetService),
              },
              steps: [
                'copy: provision target postgres',
                'copy: pg_dump -> pg_restore',
                'copy: compare source/target table estimates',
                'cutover: set DATABASE_URL, DIRECT_URL, DATABASE_URL_PREV',
                'rollback: restore DATABASE_URL from DATABASE_URL_PREV',
              ],
              next: [
                'Run phase="copy" with confirm=true',
                'Validate app against NEXT_DATABASE_URL',
                'Run phase="cutover" with confirm=true',
              ],
            }),
          }],
        };
      }

      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `phase="${phase}" requires confirm=true`,
            }),
          }],
        };
      }

      if (!toolAvailability.pgDump || !toolAvailability.pgRestore) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'pg_dump and pg_restore are required for provider migration copy phase',
              prerequisites: toolAvailability,
            }),
          }],
        };
      }

      if (phase === 'copy') {
        const targetUrl = targetConnectionUrl ?? await provisionTargetDatabaseUrl({
          projectName: project.name,
          projectId: project.id,
          envName: env.name,
          targetProvider,
          databaseName,
          region,
          size,
        });

        if (!targetUrl) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'Failed to provision or resolve target database URL' }),
            }],
          };
        }

        const copyResult = await copyPostgresDatabase(sourceUrl, targetUrl);
        if (!copyResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                phase: 'copy',
                error: copyResult.error,
                source: maskDatabaseUrl(sourceUrl),
                target: maskDatabaseUrl(targetUrl),
              }),
            }],
          };
        }

        const sourceStats = await getTableEstimates(sourceUrl);
        const targetStats = await getTableEstimates(targetUrl);
        const compare = compareTableEstimates(sourceStats, targetStats);
        const exactCheck = verifyExactCounts
          ? await getExactCountVerification(sourceUrl, targetUrl, criticalTables)
          : undefined;

        if (component) {
          componentRepo.updateBindings(component.id, {
            migrationCandidate: {
              targetProvider,
              targetConnectionString: targetUrl,
              sourceConnectionString: sourceUrl,
              copiedAt: new Date().toISOString(),
              verification: compare,
              exactCountVerification: exactCheck,
            },
          });
        }

        let shadowSynced = false;
        let shadowError: string | undefined;
        if (setShadowVar && targetService) {
          const hostingResult = await adapterFactory.getHostingAdapter(project);
          if (hostingResult.success && hostingResult.adapter) {
            const shadowReceipt = await hostingResult.adapter.setEnvVars(env, targetService, {
              NEXT_DATABASE_URL: targetUrl,
            });
            shadowSynced = shadowReceipt.success;
            shadowError = shadowReceipt.success ? undefined : (shadowReceipt.error || shadowReceipt.message);
          } else {
            shadowError = hostingResult.error || 'No hosting adapter for shadow var sync';
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              phase: 'copy',
              source: maskDatabaseUrl(sourceUrl),
              target: maskDatabaseUrl(targetUrl),
              verification: compare,
              exactCountVerification: exactCheck,
              next: 'Run phase="cutover" confirm=true when ready',
              shadowVarSynced: setShadowVar ? shadowSynced : undefined,
              shadowVarError: setShadowVar && !shadowSynced ? shadowError : undefined,
            }),
          }],
        };
      }

      const candidate = component?.bindings.migrationCandidate as
        | {
            targetProvider?: string;
            targetConnectionString?: string;
            sourceConnectionString?: string;
          }
        | undefined;
      const cutoverSource = sourceUrl;
      const cutoverTarget = targetConnectionUrl ?? candidate?.targetConnectionString;

      if (!cutoverTarget) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No target connection URL found. Run phase="copy" first or provide targetConnectionUrl.',
            }),
          }],
        };
      }

      const connectivity = await canConnect(cutoverTarget);
      if (!connectivity.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              phase: 'cutover',
              error: `Target connectivity check failed: ${connectivity.error}`,
            }),
          }],
        };
      }

      if (!targetService) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No service found for cutover env var update' }),
          }],
        };
      }

      const hostingResult = await adapterFactory.getHostingAdapter(project);
      if (!hostingResult.success || !hostingResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: hostingResult.error || 'Hosting adapter unavailable' }),
          }],
        };
      }

      const cutoverVars = {
        DATABASE_URL: cutoverTarget,
        DIRECT_URL: cutoverTarget,
        DATABASE_URL_PREV: cutoverSource,
      };
      const cutoverReceipt = await hostingResult.adapter.setEnvVars(env, targetService, cutoverVars);

      if (cutoverReceipt.success && component) {
        componentRepo.updateBindings(component.id, {
          previousProvider: (component.bindings.provider as string | undefined) ?? 'unknown',
          previousConnectionString: cutoverSource,
          provider: targetProvider,
          connectionString: cutoverTarget,
          cutoverAt: new Date().toISOString(),
          migrationCandidate: undefined,
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: cutoverReceipt.success,
            phase: 'cutover',
            message: cutoverReceipt.success
              ? `Cutover complete on service ${targetService.name}`
              : `Cutover failed: ${cutoverReceipt.error || cutoverReceipt.message}`,
            currentDatabaseUrl: maskDatabaseUrl(cutoverTarget),
            rollback: {
              strategy: 'Set DATABASE_URL and DIRECT_URL back to DATABASE_URL_PREV',
              previousDatabaseUrl: maskDatabaseUrl(cutoverSource),
            },
          }),
        }],
      };
    }
  );

  server.tool(
    'db_migrate_provider_rollback',
    'Rollback database cutover by restoring DATABASE_URL and DIRECT_URL from DATABASE_URL_PREV or stored component history.',
    {
      projectName: z.string().optional().describe('Project name'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      serviceName: z.string().optional().describe('Service to update (default: first service)'),
      previousConnectionUrl: z.string().optional().describe('Optional explicit rollback URL'),
      confirm: z.boolean().optional().describe('Required to execute rollback'),
    },
    async ({ projectName, environment = 'staging', serviceName, previousConnectionUrl, confirm = false }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode: 'preview',
              message: 'Call again with confirm=true to execute rollback.',
            }),
          }],
        };
      }

      const result = resolveProjectOrError({ projectName });
      if ('error' in result) return result.error;
      const project = result.project;

      const env = envRepo.findByProjectAndName(project.id, environment);
      if (!env) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
          }],
        };
      }

      const services = serviceRepo.findByProjectId(project.id);
      const targetService = serviceName ? services.find((s) => s.name === serviceName) : services[0];
      if (!targetService) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'No service found for rollback' }),
          }],
        };
      }

      const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
      const componentPrevious = component?.bindings.previousConnectionString;
      const rollbackUrl = previousConnectionUrl ?? (typeof componentPrevious === 'string' ? componentPrevious : null);
      if (!rollbackUrl) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No previous connection URL found. Provide previousConnectionUrl explicitly.',
            }),
          }],
        };
      }

      const hostingResult = await adapterFactory.getHostingAdapter(project);
      if (!hostingResult.success || !hostingResult.adapter) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: hostingResult.error || 'No hosting adapter available' }),
          }],
        };
      }

      const receipt = await hostingResult.adapter.setEnvVars(env, targetService, {
        DATABASE_URL: rollbackUrl,
        DIRECT_URL: rollbackUrl,
      });
      if (receipt.success && component) {
        componentRepo.updateBindings(component.id, {
          connectionString: rollbackUrl,
          provider: component.bindings.previousProvider,
          rolledBackAt: new Date().toISOString(),
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: receipt.success,
            message: receipt.success
              ? `Rollback complete on ${targetService.name}`
              : `Rollback failed: ${receipt.error || receipt.message}`,
            restoredDatabaseUrl: maskDatabaseUrl(rollbackUrl),
          }),
        }],
      };
    }
  );

  server.tool(
    'db_query',
    'Run a SQL query against a database. By default, only SELECT queries are allowed. Use allowMutations=true to enable INSERT/UPDATE/DELETE (with confirmation).',
    {
      sql: z.string().describe('SQL query to execute'),
      connectionName: z.string().optional().describe('Named database connection (scope from connection_create provider=database)'),
      connectionUrl: z.string().optional().describe('Direct database connection URL (postgres://...)'),
      projectName: z.string().optional().describe('Resolve database URL from project environment'),
      environment: z.string().optional().describe('Environment name (default: staging)'),
      serviceName: z.string().optional().describe('Service name (when resolving from project)'),
      allowMutations: z.boolean().optional().describe('Allow INSERT/UPDATE/DELETE queries (default: false)'),
      params: z.array(z.unknown()).optional().describe('Query parameters for parameterized queries'),
    },
    async ({ sql, connectionName, connectionUrl, projectName, environment = 'staging', serviceName, allowMutations = false, params }) => {
      const secretStore = getSecretStore();

      // Resolve the database URL from one of the sources
      let resolvedUrl: string | null = null;
      let source: string = '';

      // Priority: direct URL > named connection > project/environment
      if (connectionUrl) {
        resolvedUrl = connectionUrl;
        source = 'direct URL';
      } else if (connectionName) {
        // Look up named database connection
        const connection = connectionRepo.findBestMatch('database', connectionName);
        if (!connection) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No database connection found for: ${connectionName}. Use connection_create provider=database scope="${connectionName}" to create one.`,
              }),
            }],
          };
        }
        const creds = secretStore.decryptObject<DatabaseCredentials>(connection.credentialsEncrypted);
        resolvedUrl = creds.connectionUrl;
        source = `connection: ${connectionName}`;
      } else if (projectName) {
        // Resolve from project/environment (existing logic)
        const project = resolveProject({ projectName });
        if (!project) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
            }],
          };
        }

        const env = envRepo.findByProjectAndName(project.id, environment);
        if (!env) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `Environment not found: ${environment}` }),
            }],
          };
        }

        const bindings = env.platformBindings as {
          railwayProjectId?: string;
          railwayEnvironmentId?: string;
          services?: Record<string, { serviceId: string }>;
        };

        if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'Environment not deployed to Railway' }),
            }],
          };
        }

        const services = serviceRepo.findByProjectId(project.id);
        const targetService = serviceName
          ? services.find((s) => s.name === serviceName)
          : services[0];

        if (!targetService || !bindings.services?.[targetService.name]) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'Service not found' }),
            }],
          };
        }

        const railwayConnection = connectionRepo.findByProvider('railway');
        if (!railwayConnection) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'No Railway connection' }),
            }],
          };
        }

        const railwayCreds = secretStore.decryptObject<RailwayCredentials>(railwayConnection.credentialsEncrypted);
        const railwayAdapter = new RailwayAdapter();
        await railwayAdapter.connect(railwayCreds);

        resolvedUrl = await railwayAdapter.getDatabaseUrl(
          bindings.railwayProjectId,
          bindings.railwayEnvironmentId,
          bindings.services[targetService.name].serviceId
        );
        source = `${projectName}/${environment}`;
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Must provide one of: connectionUrl, connectionName, or projectName',
              usage: {
                directUrl: 'db_query sql="SELECT 1" connectionUrl="postgres://..."',
                namedConnection: 'db_query sql="SELECT 1" connectionName="prod-db"',
                projectEnv: 'db_query sql="SELECT 1" projectName="myapp" environment="staging"',
              },
            }),
          }],
        };
      }

      if (!resolvedUrl) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Could not resolve database URL' }),
          }],
        };
      }

      // Create database adapter and analyze query
      const dbAdapter = new DatabaseAdapter();
      dbAdapter.connect({ connectionUrl: resolvedUrl });

      const analysis = dbAdapter.analyzeQuery(sql);

      // Check mutation safety
      if (analysis.isMutation && !allowMutations) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Mutation query blocked for safety',
              queryType: 'mutation',
              warnings: analysis.warnings,
              hint: 'Add allowMutations=true to execute INSERT/UPDATE/DELETE queries',
              query: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
            }),
          }],
        };
      }

      // Execute the query
      const result = await dbAdapter.query(sql, params);

      if (!result.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: result.error,
              source,
            }),
          }],
        };
      }

      // Format response
      const response: Record<string, unknown> = {
        success: true,
        source,
        rowCount: result.rowCount,
      };

      if (analysis.isMutation) {
        response.queryType = 'mutation';
        response.message = `Query affected ${result.rowCount} row(s)`;
        if (analysis.warnings.length > 0) {
          response.warnings = analysis.warnings;
        }
      } else {
        response.queryType = 'select';
        response.rows = result.rows;
        response.fields = result.fields?.map(f => f.name);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
        }],
      };
    }
  );
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:([^:@]+)@/, ':***@');
}

async function resolveEnvironmentDatabaseUrl(
  project: Project,
  env: { id: string; name: string; platformBindings: Record<string, unknown> },
  serviceName?: string
): Promise<string | null> {
  const component = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  const componentUrl = component?.bindings.connectionString;
  if (typeof componentUrl === 'string' && componentUrl.length > 0) {
    return componentUrl;
  }

  const bindings = env.platformBindings as {
    projectId?: string;
    railwayProjectId?: string;
    environmentId?: string;
    railwayEnvironmentId?: string;
    services?: Record<string, { serviceId: string }>;
  };
  const projectId = bindings.projectId || bindings.railwayProjectId;
  const environmentId = bindings.environmentId || bindings.railwayEnvironmentId;

  if (!projectId || !environmentId) {
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

async function provisionTargetDatabaseUrl(params: {
  projectId: string;
  projectName: string;
  envName: string;
  targetProvider: 'supabase' | 'rds' | 'cloudsql';
  databaseName?: string;
  region?: string;
  size?: string;
}): Promise<string | null> {
  const project = resolveProject({ projectId: params.projectId, projectName: params.projectName });
  if (!project) return null;
  const env = envRepo.findByProjectAndName(project.id, params.envName);
  if (!env) return null;

  const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.targetProvider, project);
  if (!dbAdapterResult.success || !dbAdapterResult.adapter) return null;

  const provision = await dbAdapterResult.adapter.provision('postgres', env, {
    databaseName: params.databaseName,
    region: params.region,
    size: params.size,
  });
  if (!provision.receipt.success || !provision.connectionUrl) return null;

  const existing = componentRepo.findByEnvironmentAndType(env.id, 'postgres');
  if (existing) {
    componentRepo.update(existing.id, {
      bindings: {
        ...provision.component.bindings,
        migrationCandidate: {
          targetProvider: params.targetProvider,
          targetConnectionString: provision.connectionUrl,
          sourceConnectionString: existing.bindings.connectionString,
          preparedAt: new Date().toISOString(),
        },
      },
      externalId: provision.component.externalId ?? undefined,
    });
  } else {
    componentRepo.create({
      environmentId: env.id,
      type: 'postgres',
      bindings: provision.component.bindings,
      externalId: provision.component.externalId ?? undefined,
    });
  }

  return provision.connectionUrl;
}

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function copyPostgresDatabase(sourceUrl: string, targetUrl: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const dump = spawn('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--dbname=${sourceUrl}`,
    ]);

    const restore = spawn('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${targetUrl}`,
    ]);

    let stderr = '';
    dump.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    restore.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    dump.stdout.pipe(restore.stdin);

    let dumpDone = false;
    let restoreDone = false;
    let dumpCode = 1;
    let restoreCode = 1;

    const maybeDone = () => {
      if (!dumpDone || !restoreDone) return;
      if (dumpCode === 0 && restoreCode === 0) {
        resolve({ success: true });
        return;
      }
      resolve({
        success: false,
        error: stderr.slice(0, 4000) || `pg_dump exited ${dumpCode}, pg_restore exited ${restoreCode}`,
      });
    };

    dump.on('close', (code) => {
      dumpDone = true;
      dumpCode = code ?? 1;
      maybeDone();
    });
    restore.on('close', (code) => {
      restoreDone = true;
      restoreCode = code ?? 1;
      maybeDone();
    });
  });
}

async function getTableEstimates(connectionUrl: string): Promise<Record<string, number>> {
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

async function getExactCountVerification(
  sourceUrl: string,
  targetUrl: string,
  criticalTables?: string[]
): Promise<{
  checkedTables: number;
  mismatches: Array<{ table: string; source: number; target: number }>;
  ok: boolean;
}> {
  const sourceEstimates = await getTableEstimates(sourceUrl);
  const candidateTables = criticalTables && criticalTables.length > 0
    ? criticalTables
    : Object.entries(sourceEstimates)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([table]) => table);

  const sourceCounts = await getExactCounts(sourceUrl, candidateTables);
  const targetCounts = await getExactCounts(targetUrl, candidateTables);

  const mismatches: Array<{ table: string; source: number; target: number }> = [];
  for (const table of candidateTables) {
    if (sourceCounts[table] !== targetCounts[table]) {
      mismatches.push({
        table,
        source: sourceCounts[table] ?? -1,
        target: targetCounts[table] ?? -1,
      });
    }
  }

  return {
    checkedTables: candidateTables.length,
    mismatches,
    ok: mismatches.length === 0,
  };
}

async function getExactCounts(connectionUrl: string, tables: string[]): Promise<Record<string, number>> {
  const client = new Client({ connectionString: connectionUrl, statement_timeout: 30000 });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const fullName of tables) {
      const [schemaRaw, tableRaw] = fullName.includes('.')
        ? fullName.split('.', 2)
        : ['public', fullName];
      const schema = quoteIdentifier(schemaRaw);
      const table = quoteIdentifier(tableRaw);
      const sql = `SELECT COUNT(*)::bigint::text AS c FROM ${schema}.${table}`;
      const result = await client.query<{ c: string }>(sql);
      counts[fullName] = Number(result.rows[0]?.c ?? 0);
    }
    return counts;
  } finally {
    await client.end().catch(() => {});
  }
}

function quoteIdentifier(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

function compareTableEstimates(
  source: Record<string, number>,
  target: Record<string, number>
): {
  sourceTables: number;
  targetTables: number;
  missingTables: string[];
  mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }>;
  ok: boolean;
} {
  const missingTables: string[] = [];
  const mismatchedTables: Array<{ table: string; source: number; target: number; deltaPct: number }> = [];

  for (const [table, sourceRows] of Object.entries(source)) {
    const targetRows = target[table];
    if (targetRows === undefined) {
      missingTables.push(table);
      continue;
    }

    const denominator = Math.max(1, sourceRows);
    const deltaPct = Math.abs(targetRows - sourceRows) / denominator;
    if (deltaPct > 0.2) {
      mismatchedTables.push({ table, source: sourceRows, target: targetRows, deltaPct });
    }
  }

  return {
    sourceTables: Object.keys(source).length,
    targetTables: Object.keys(target).length,
    missingTables,
    mismatchedTables,
    ok: missingTables.length === 0 && mismatchedTables.length === 0,
  };
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
