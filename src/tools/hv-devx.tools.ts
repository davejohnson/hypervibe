import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ToolContext } from './context.js';
import { projectField, envField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';
import { SqliteAdapter } from '../adapters/db/sqlite.adapter.js';
import { tunnelManager, getTunnelConfig } from '../adapters/providers/tunnel/tunnel.manager.js';
import { ComposeGenerator } from '../adapters/providers/local/compose.generator.js';
import type { ComponentType } from '../domain/entities/component.entity.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { generateVisualizationHtml } from './visualize.template.js';
import { findRepoRoot, readRepoSpecFile } from '../domain/spec/repo-spec-file.js';
import { readRepoBindingsFile } from '../domain/spec/repo-bindings-file.js';

const componentTypeField = z.enum(['postgres']);

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function repoUpgradeState(): Record<string, unknown> {
  const root = findRepoRoot();
  const state: Record<string, unknown> = {
    root,
    spec: { present: false },
    bindings: { present: false },
  };

  try {
    const specFile = readRepoSpecFile();
    state.spec = specFile
      ? {
        present: true,
        valid: true,
        path: specFile.path,
        project: specFile.spec.project,
        environments: Object.keys(specFile.spec.environments),
      }
      : { present: false };
  } catch (error) {
    state.spec = {
      present: true,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const bindingsFile = readRepoBindingsFile();
    state.bindings = bindingsFile
      ? {
        present: true,
        valid: true,
        path: bindingsFile.path,
        project: bindingsFile.document.project,
        environments: Object.keys(bindingsFile.document.environments),
      }
      : { present: false };
  } catch (error) {
    state.bindings = {
      present: true,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return state;
}

/**
 * Redact secret-bearing fields when returning stored run plans to chat.
 * Current plans store env var key names only, but runs persisted before
 * that change carry plaintext values in steps[].params.vars — mask them.
 */
function redactRunPlan(plan: unknown): unknown {
  if (!plan || typeof plan !== 'object') return plan;
  const record = plan as Record<string, unknown>;
  if (!Array.isArray(record.steps)) return plan;
  return {
    ...record,
    steps: record.steps.map((step) => {
      if (!step || typeof step !== 'object') return step;
      const stepRecord = step as Record<string, unknown>;
      const params = stepRecord.params as Record<string, unknown> | undefined;
      if (!params || typeof params.vars !== 'object' || params.vars === null) return step;
      return {
        ...stepRecord,
        params: {
          ...params,
          vars: Object.fromEntries(Object.keys(params.vars as Record<string, unknown>).map((key) => [key, '***'])),
        },
      };
    }),
  };
}

export function registerHvDevxTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_upgrade',
    'Inspect or apply Hypervibe local upgrade tasks after updating the package. action="status" reports package version, SQLite schema migrations, repo-backed spec/bindings files, and local connection/project counts. action="migrate" explicitly applies pending local SQLite migrations; startup normally does this automatically.',
    {
      action: z.enum(['status', 'migrate']).optional().describe('Upgrade operation (default: status)'),
      project: projectField,
    },
    wrapHandler(async ({ action = 'status', project: projectRef }) => {
      const adapter = SqliteAdapter.getInstance();
      const appliedNow = action === 'migrate' ? adapter.migrate() : [];
      const schema = adapter.getMigrationStatus();
      const projects = ctx.repos.projects.findAll();
      const connections = ctx.repos.connections.findAll();
      const project = projectRef
        ? ctx.resolveProjectOrThrow({ project: projectRef })
        : ctx.resolveProject({});

      return toolSuccess(
        {
          hypervibe: {
            version: readPackageVersion(),
            upgradeAction: action,
          },
          storage: {
            dataDir: schema.dataDir,
            databasePath: schema.databasePath,
          },
          sqlite: {
            currentVersion: schema.currentVersion,
            latestVersion: schema.latestVersion,
            needsMigration: schema.needsMigration,
            appliedCount: schema.applied.length,
            pending: schema.pending,
            appliedNow: appliedNow.map((migration) => ({ version: migration.version, name: migration.name })),
          },
          localState: {
            projects: projects.length,
            connections: connections.length,
            verifiedConnections: connections.filter((connection) => connection.status === 'verified').length,
          },
          repo: repoUpgradeState(),
          ...(project
            ? {
              project: {
                id: project.id,
                name: project.name,
                gitRemoteUrl: project.gitRemoteUrl,
                environments: ctx.repos.environments.findByProjectId(project.id).map((environment) => environment.name),
              },
            }
            : {}),
        },
        {
          hint: schema.needsMigration
            ? 'Run hv_upgrade action="migrate", then restart the MCP server and run hv_status or hv_plan in each repo.'
            : 'Hypervibe local state is on the current schema. After a package update, run hv_status or hv_plan in each repo to reconcile repo spec/bindings and live infrastructure drift.',
          next: schema.needsMigration ? ['hv_upgrade action="migrate"', 'hv_status', 'hv_plan'] : ['hv_status', 'hv_plan'],
        }
      );
    })
  );

  server.tool(
    'hv_tunnel',
    'Manage webhook tunnels that expose a local port to the internet (for testing webhooks from Stripe, SendGrid, etc.). action="start" needs port; "stop"/"status" need tunnelId (or port, from which the id is derived); "list" shows all active tunnels.',
    {
      action: z.enum(['start', 'stop', 'status', 'list']).describe('Tunnel operation'),
      port: z.number().int().optional().describe('Local port to expose (required for start; can substitute for tunnelId on stop/status)'),
      tunnelId: z.string().optional().describe('Tunnel id, e.g. "cloudflared-3000" (for stop/status)'),
      provider: z.enum(['cloudflared', 'ngrok']).optional().describe('Tunnel provider (default: cloudflared, or the stored tunnel connection preference)'),
    },
    wrapHandler(async ({ action, port, tunnelId, provider }) => {
      const config = getTunnelConfig();
      const selectedProvider = provider ?? config.provider;

      if (action === 'list') {
        const tunnels = tunnelManager.listTunnels();
        return toolSuccess({ count: tunnels.length, tunnels });
      }

      if (action === 'start') {
        if (port === undefined) {
          throw new HvError('VALIDATION', 'port is required for action="start".');
        }
        try {
          const tunnel = await tunnelManager.start(port, selectedProvider, {
            ngrokAuthToken: config.ngrokAuthToken,
          });
          return toolSuccess(
            { tunnel },
            { hint: `Use ${tunnel.publicUrl} as your webhook URL for testing. Stop it with hv_tunnel action="stop" tunnelId="${tunnel.id}".` }
          );
        } catch (error) {
          return toolError('PROVIDER_ERROR', error instanceof Error ? error.message : String(error), {
            hint: selectedProvider === 'ngrok'
              ? 'Make sure ngrok is installed: https://ngrok.com/download'
              : 'Make sure cloudflared is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
          });
        }
      }

      const id = tunnelId ?? (port !== undefined ? `${selectedProvider}-${port}` : undefined);
      if (!id) {
        throw new HvError('VALIDATION', `tunnelId (or port) is required for action="${action}".`);
      }

      if (action === 'stop') {
        const stopped = await tunnelManager.stop(id);
        return stopped
          ? toolSuccess({ stopped: true, tunnelId: id })
          : toolError('NOT_FOUND', `Tunnel ${id} not found.`, { hint: 'List active tunnels with hv_tunnel action="list".' });
      }

      // action === 'status'
      const status = tunnelManager.getStatus(id);
      return status
        ? toolSuccess({ tunnel: status })
        : toolError('NOT_FOUND', `Tunnel ${id} not found or not running.`, { hint: 'List active tunnels with hv_tunnel action="list".' });
    })
  );

  server.tool(
    'hv_local_bootstrap',
    'Local development setup. Default action="bootstrap" generates compose.yaml and .env.local for the project (registering the requested components — postgres — on the local environment). action="components" lists registered components per environment without writing files.',
    {
      action: z.enum(['bootstrap', 'components']).optional().describe('Operation (default: bootstrap)'),
      project: projectField,
      env: envField.describe('Environment to list components for (action="components" only; default: all environments)'),
      outputDir: z.string().optional().describe('Output directory for generated files (default: current directory)'),
      components: z.array(componentTypeField).optional().describe('Components to include (default: postgres)'),
    },
    wrapHandler(async ({ action = 'bootstrap', project: projectRef, env, outputDir, components }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      if (action === 'components') {
        const environments = env
          ? [ctx.repos.environments.findByProjectAndName(project.id, env)].filter((e): e is NonNullable<typeof e> => e !== null)
          : ctx.repos.environments.findByProjectId(project.id);
        return toolSuccess({
          project: { id: project.id, name: project.name },
          environments: environments.map((e) => ({
            environment: e.name,
            components: ctx.repos.components.findByEnvironmentId(e.id).map((c) => ({ type: c.type, bindings: c.bindings })),
          })),
        });
      }

      // action === 'bootstrap'
      let localEnv = ctx.repos.environments.findByProjectAndName(project.id, 'local');
      if (!localEnv) {
        localEnv = ctx.repos.environments.create({ projectId: project.id, name: 'local' });
      }

      const componentTypes: ComponentType[] = components ?? ['postgres'];
      const generator = new ComposeGenerator();
      for (const componentType of componentTypes) {
        if (!ctx.repos.components.findByEnvironmentAndType(localEnv.id, componentType)) {
          ctx.repos.components.create({
            environmentId: localEnv.id,
            type: componentType,
            bindings: generator.getComponentBindings(componentType),
          });
        }
      }

      const targetDir = outputDir ?? process.cwd();
      const composeFilePath = path.join(targetDir, 'compose.yaml');
      const envFilePath = path.join(targetDir, '.env.local');
      try {
        fs.writeFileSync(composeFilePath, generator.generateCompose(project, componentTypes), 'utf-8');
        fs.writeFileSync(envFilePath, generator.generateEnvLocal(project, componentTypes), 'utf-8');
      } catch (error) {
        return toolError('INTERNAL', `Failed to write files: ${error}`);
      }

      ctx.repos.audit.create({
        action: 'local.bootstrap',
        resourceType: 'environment',
        resourceId: localEnv.id,
        details: { projectId: project.id, components: componentTypes, files: [composeFilePath, envFilePath] },
      });

      return toolSuccess(
        {
          message: `Local development environment bootstrapped for "${project.name}"`,
          files: { compose: composeFilePath, env: envFilePath },
          components: componentTypes,
          intent: syncProjectIntent(project.id),
        },
        { hint: 'Start local services with "docker compose up -d" (stop with "docker compose down"). Environment variables are in .env.local.' }
      );
    })
  );

  server.tool(
    'hv_visualize',
    'Generate a 3D infrastructure visualization for a project as a self-contained HTML file (open it in a browser).',
    { project: projectField },
    wrapHandler(async ({ project: projectRef }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });

      const environments = ctx.repos.environments.findByProjectId(project.id);
      const services = ctx.repos.services.findByProjectId(project.id);
      const connections = ctx.repos.connections.findAll();
      const recentRuns = ctx.repos.runs.findByProjectId(project.id, 10);
      const components = environments.flatMap((env) =>
        ctx.repos.components.findByEnvironmentId(env.id).map((c) => ({
          id: c.id,
          type: c.type,
          envId: env.id,
          envName: env.name,
        }))
      );

      const html = generateVisualizationHtml({
        project: { id: project.id, name: project.name },
        environments: environments.map((e) => ({ id: e.id, name: e.name })),
        services: services.map((s) => ({ id: s.id, name: s.name, builder: s.buildConfig?.builder })),
        components,
        connections: connections.map((c) => ({ provider: c.provider, status: c.status })),
        recentRuns: recentRuns.map((r) => ({ envId: r.environmentId, status: r.status, type: r.type, completedAt: r.completedAt?.toISOString() ?? null })),
      });
      const safeName = project.name.replace(/[^a-zA-Z0-9-_]/g, '-');
      const filePath = path.join(os.tmpdir(), `hypervibe-viz-${safeName}.html`);
      fs.writeFileSync(filePath, html, 'utf-8');

      return toolSuccess(
        { message: `3D visualization generated for "${project.name}"`, filePath },
        { hint: 'Open this HTML file in a browser to view the interactive 3D infrastructure visualization.' }
      );
    })
  );

  server.tool(
    'hv_runs',
    'Inspect run history. action="list" (default) shows recent deployment/apply runs (with the latest run\'s status surfaced); action="get" returns full details (plan, receipts) for one run; action="audit" lists recent audit events.',
    {
      action: z.enum(['list', 'get', 'audit']).optional().describe('Operation (default: list)'),
      runId: z.string().optional().describe('Run id (required for action="get")'),
      project: projectField,
      env: envField.describe('Filter runs by environment name (action="list")'),
      limit: z.number().int().min(1).optional().describe('Max items to return (default: 20 runs, 50 audit events)'),
      resourceType: z.string().optional().describe('Audit filter: resource type (project, environment, run, ...)'),
      resourceId: z.string().optional().describe('Audit filter: resource id (used with resourceType)'),
      auditAction: z.string().optional().describe('Audit filter: action name (e.g. deploy.started)'),
    },
    wrapHandler(async ({ action = 'list', runId, project: projectRef, env, limit, resourceType, resourceId, auditAction }) => {
      if (action === 'audit') {
        const max = limit ?? 50;
        const events = resourceType && resourceId
          ? ctx.repos.audit.findByResource(resourceType, resourceId, max)
          : auditAction
            ? ctx.repos.audit.findByAction(auditAction, max)
            : ctx.repos.audit.findRecent(max);
        return toolSuccess({
          count: events.length,
          events: events.map((e) => ({
            id: e.id,
            timestamp: e.timestamp,
            actor: e.actor,
            action: e.action,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            details: e.details,
          })),
        });
      }

      const describeRun = (run: NonNullable<ReturnType<typeof ctx.repos.runs.findById>>) => ({
        id: run.id,
        type: run.type,
        status: run.status,
        project: ctx.repos.projects.findById(run.projectId)?.name,
        environment: ctx.repos.environments.findById(run.environmentId)?.name,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        error: run.error,
      });

      if (action === 'get') {
        if (!runId) {
          throw new HvError('VALIDATION', 'runId is required for action="get".');
        }
        const run = ctx.repos.runs.findById(runId);
        if (!run) {
          return toolError('NOT_FOUND', `Run not found: ${runId}`, { hint: 'List runs with hv_runs action="list".' });
        }
        return toolSuccess({
          run: { ...describeRun(run), plan: redactRunPlan(run.plan), receipts: run.receipts, createdAt: run.createdAt },
        });
      }

      // action === 'list'
      const max = limit ?? 20;
      let runs;
      if (projectRef) {
        const project = ctx.resolveProjectOrThrow({ project: projectRef });
        if (env) {
          const environment = ctx.resolveEnvironmentOrThrow(project, env);
          runs = ctx.repos.runs.findByEnvironmentId(environment.id, max);
        } else {
          runs = ctx.repos.runs.findByProjectId(project.id, max);
        }
      } else {
        runs = ctx.repos.runs.findRecent(max);
      }

      const enriched = runs.map(describeRun);
      const latest = enriched[0] ?? null;
      return toolSuccess(
        { count: enriched.length, latest, runs: enriched },
        latest ? { hint: `Latest run is ${latest.status} (${latest.type}). Use hv_runs action="get" runId="${latest.id}" for plan and receipts.` } : undefined
      );
    })
  );
}
