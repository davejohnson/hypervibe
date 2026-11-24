import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { ConvergeExecutor, type ConvergeResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import { gcpEngineAuthentication } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { ENGINE_PLAN_SCOPE, recordEnginePlan } from './engine-shared.js';
import type { GcpDatabaseBinding } from './gcp-database-location.js';
import { boundEngine, engineGcpAdapter, type InfrastructurePlanResult } from './infrastructure-engine.js';
import { googleSharedDatabaseCloud, sharedDatabase, type SharedServerRequest } from './shared-database/index.js';

/**
 * `hv_plan scope="shared-database" intent="remove"`: removing the app's shared
 * database server once no environment uses it. This file only finds which
 * Google project and region are meant, signs in, and saves or runs the plan;
 * what the steps are and when they are refused is the shared-database module's.
 *
 * The server belongs to the app, not to an environment, but a saved plan is
 * always filed under one: any environment of the app in that Google project
 * and region serves, including one already torn down.
 */
interface Target { gcpProjectId: string; region: string; anchor: Environment }

function googleTargets(environments: Environment[]): Target[] {
  const targets = new Map<string, Target>();
  for (const environment of environments) {
    const bindings = environment.platformBindings as { provider?: unknown; projectId?: unknown; environmentId?: unknown; region?: unknown };
    const region = typeof bindings.environmentId === 'string' && bindings.environmentId ? bindings.environmentId : bindings.region;
    if (bindings.provider !== 'cloudrun' || typeof bindings.projectId !== 'string' || !bindings.projectId || typeof region !== 'string' || !region) continue;
    if (!targets.has(`${bindings.projectId}/${region}`)) targets.set(`${bindings.projectId}/${region}`, { gcpProjectId: bindings.projectId, region, anchor: environment });
  }
  return [...targets.values()];
}

/** Signs in as the app's deployment identity for that Google project and gathers what the module asks for. */
async function serverRequest(ctx: CommandContext, project: Project, target: Pick<Target, 'gcpProjectId' | 'region'>): Promise<SharedServerRequest | { blocked: string }> {
  // An environment may have named its Google project or used the repository's default connection.
  const adapter = await engineGcpAdapter(project, target.gcpProjectId) ?? await engineGcpAdapter(project);
  const connection = adapter?.engineConnection();
  if (!adapter || !connection || connection.projectId !== target.gcpProjectId) {
    return { blocked: `Hypervibe has no saved access to Google Cloud project ${target.gcpProjectId} for ${project.name}. Connect it again with hv_connections, then plan the removal again.` };
  }
  adapter.configureTarget({ region: target.region });
  let auth: ReturnType<typeof gcpEngineAuthentication>;
  try { auth = gcpEngineAuthentication(connection); } catch (error) { return { blocked: error instanceof Error ? error.message : String(error) }; }
  const token = await adapter.engineAccessToken();
  return {
    project: { id: project.id, name: project.name }, gcpProjectId: target.gcpProjectId, region: target.region, engine: boundEngine(auth),
    cloud: googleSharedDatabaseCloud({ token, credentials: () => JSON.parse(connection.credentials) as Record<string, unknown> }),
    recorded: ctx.repos.environments.findByProjectId(project.id).map((environment) => ({ environment: environment.name, binding: (environment.platformBindings as { engine?: GcpDatabaseBinding }).engine })),
  };
}

export async function planGcpSharedDatabaseRemoval(ctx: CommandContext, params: { project: Project; specRevision: number; environmentName?: string }): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const environments = ctx.repos.environments.findByProjectId(params.project.id);
  const named = params.environmentName ? environments.filter((environment) => environment.name === params.environmentName) : environments;
  const targets = googleTargets(named);
  if (!targets.length) {
    return { blocked: [params.environmentName
      ? `Hypervibe has no record of ${params.environmentName} on Google Cloud, so it cannot tell which Google project and region to look in.`
      : `Hypervibe has no record of a Google Cloud environment for ${params.project.name}, so there is no shared database server of its to remove.`] };
  }
  if (targets.length > 1) {
    return { blocked: [`${params.project.name} has environments in more than one Google project or region (${targets.map((target) => `${target.gcpProjectId}/${target.region}: ${target.anchor.name}`).join('; ')}). Each can have its own shared database server; add env with one of those environments to say which.`] };
  }
  const target = targets[0]!;
  const request = await serverRequest(ctx, params.project, target);
  if ('blocked' in request) return { blocked: [request.blocked] };
  const planned = await sharedDatabase.planServerRemoval(request);
  if ('blocked' in planned) return { blocked: [planned.blocked] };
  if ('none' in planned) return { blocked: [`${params.project.name} has no shared database server in ${target.gcpProjectId} (${target.region}). There is nothing to remove.`] };
  return recordEnginePlan({
    projectId: params.project.id, environmentId: target.anchor.id, environmentName: target.anchor.name, specRevision: params.specRevision,
    actions: [planned.action],
    warnings: [`This is about ${params.project.name}'s shared database server (${planned.instanceName}) in ${target.gcpProjectId}, ${target.region}, not about environment ${target.anchor.name}; the plan is only filed under it.`],
    engine: { planId: (planned.reviewed as { server: { planId: string } }).server.planId, gcpProjectId: target.gcpProjectId, region: target.region, serverRemoval: true, sharedDatabase: planned.reviewed },
  });
}

export async function applyGcpSharedDatabaseRemoval(ctx: CommandContext, params: { project: Project; specRevision: number; planId: string; confirmActions: string[] }):
Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  const document = loaded.document as PlanRunDocument & { engine?: { gcpProjectId?: unknown; region?: unknown; serverRemoval?: unknown; sharedDatabase?: unknown } };
  const reviewed = document.engine;
  if (document.scope !== ENGINE_PLAN_SCOPE || loaded.run.projectId !== params.project.id || reviewed?.serverRemoval !== true || typeof reviewed.gcpProjectId !== 'string' || typeof reviewed.region !== 'string') {
    return { kind: 'blocked', reason: 'This is not a saved plan to remove this app\'s shared database server. Run hv_plan scope="shared-database" intent="remove" again.' };
  }
  const target = { gcpProjectId: reviewed.gcpProjectId, region: reviewed.region };
  const result = await executor.execute({
    planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    handler: async (action) => {
      // Asked again for every step: who is signed in, and what every environment records now.
      const request = await serverRequest(ctx, params.project, target);
      if ('blocked' in request) return { success: false, status: 'blocked', message: request.blocked };
      return sharedDatabase.applyServerRemoval({ ...request, action, reviewed: reviewed.sharedDatabase });
    },
  });
  return { kind: 'executed', envName: document.environmentName, result };
}
