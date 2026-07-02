import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { DeployOrchestrator } from './deploy.orchestrator.js';
import { buildDeploySourceEnvVars } from './deploy-source.js';
import { buildDatabaseEnvVarsFromComponent } from './database-env.js';
import { resolveQueueEnvVars } from './queue-env.js';
import { syncProjectIntent } from './intent.service.js';
import { SpecStore } from '../spec/spec.store.js';
import { ConvergeExecutor, type ActionResult, type PlanRunDocument } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { DeployResult } from './deploy.orchestrator.js';

const runRepo = new RunRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();

export const ROLLBACK_NOTE =
  'This rollback re-triggers deployment for the last known-good service set. It does not restore provider-side manual config outside hypervibe state.';

export type RollbackFailure = {
  ok: false;
  reason: 'invalid_run' | 'no_target_run' | 'no_services' | 'no_adapter';
  error: string;
};

export type RollbackSuccess = {
  ok: true;
  success: boolean;
  rollbackFromRunId: string;
  rollbackRunId: string;
  /** The synthetic rollback plan run (audit pair with applyRunId). */
  planId: string;
  applyRunId?: string;
  status: string;
  services: string[];
  urls: DeployResult['urls'];
  errors?: string[];
  createdResources: DeployResult['createdResources'];
  rollback: DeployResult['rollback'];
  intent: ReturnType<typeof syncProjectIntent>;
};

export const ROLLBACK_OPERATION = 'rollbackRedeploy';

/**
 * Resolve the rollback target and persist it as a synthetic plan run: one
 * service:<name>:rollback action per service from the target run's receipts.
 * Rollback stays available for spec-less projects (revision 0 sentinel).
 */
export function planRollback(params: {
  project: Project;
  environment: Environment;
  toRunId?: string;
  services?: string[];
}): RollbackFailure | {
  ok: true;
  planRunId: string;
  fromRunId: string;
  specRevision: number;
  serviceNames: string[];
} {
  const { project, environment, toRunId, services } = params;

  let targetRun = toRunId ? runRepo.findById(toRunId) : null;
  if (toRunId && (!targetRun || targetRun.status !== 'succeeded' || targetRun.type !== 'deploy')) {
    return { ok: false, reason: 'invalid_run', error: `Run ${toRunId} is not a successful deploy run` };
  }

  if (!targetRun) {
    const runs = runRepo.findByEnvironmentId(environment.id, 50);
    targetRun = runs.find((r) => r.type === 'deploy' && r.status === 'succeeded') ?? null;
  }

  if (!targetRun) {
    return { ok: false, reason: 'no_target_run', error: 'No successful deploy run found to rollback to' };
  }

  const rollbackServiceNames = targetRun.receipts
    .map((r) => r.step)
    .filter((step) => step.startsWith('deploy_'))
    .map((step) => step.replace(/^deploy_/, ''));

  const allServices = serviceRepo.findByProjectId(project.id);
  let servicesToDeploy = allServices.filter((s) => rollbackServiceNames.includes(s.name));
  if (services && services.length > 0) {
    servicesToDeploy = servicesToDeploy.filter((s) => services.includes(s.name));
  }

  if (servicesToDeploy.length === 0) {
    return {
      ok: false,
      reason: 'no_services',
      error: 'No services resolved for rollback. Check run contents or provided services.',
    };
  }

  const specRevision = new SpecStore().get(project)?.revision ?? 0;
  const provider = project.defaultPlatform ?? 'unknown';
  const actions: PlanAction[] = servicesToDeploy.map((service) => ({
    id: `service:${service.name}:rollback`,
    type: 'update',
    resource: { kind: 'service', name: service.name, provider },
    verified: false,
    reason: `Redeploy from run ${targetRun.id}`,
    metadata: { operation: ROLLBACK_OPERATION, fromRunId: targetRun.id },
  }));
  const document: PlanRunDocument = {
    kind: 'hv_plan',
    environmentName: environment.name,
    specRevision,
    observedFingerprint: null,
    actions,
    warnings: [ROLLBACK_NOTE],
  };
  const planRun = runRepo.create({
    projectId: project.id,
    environmentId: environment.id,
    type: 'plan',
    plan: document as unknown as Record<string, unknown>,
  });
  runRepo.updateStatus(planRun.id, 'succeeded');

  return {
    ok: true,
    planRunId: planRun.id,
    fromRunId: targetRun.id,
    specRevision,
    serviceNames: servicesToDeploy.map((s) => s.name),
  };
}

/**
 * Shared rollback flow used by both the legacy `deploy_rollback` tool and the
 * new `hv_rollback` tool: find the last known-good deploy run (or a specific
 * one), resolve the services it deployed, and redeploy them.
 *
 * Confirm gating for protected environments is the caller's responsibility.
 */
export async function executeRollback(params: {
  project: Project;
  environment: Environment;
  toRunId?: string;
  services?: string[];
}): Promise<RollbackFailure | RollbackSuccess> {
  const { project, environment } = params;

  const planned = planRollback(params);
  if (!planned.ok) {
    return planned;
  }

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      ok: false,
      reason: 'no_adapter',
      error: adapterResult.error || 'No hosting adapter available for rollback',
    };
  }
  const adapter = adapterResult.adapter;

  const servicesToDeploy = serviceRepo
    .findByProjectId(project.id)
    .filter((s) => planned.serviceNames.includes(s.name));

  // One provider deploy shared across the per-service rollback actions:
  // the executor gets per-service receipts, the provider gets one run.
  let deployResult: DeployResult | null = null;
  const ensureDeploy = async (): Promise<DeployResult> => {
    if (!deployResult) {
      const orchestrator = new DeployOrchestrator();
      // Include managed database env vars (e.g. DATABASE_URL): Cloud Run scopes
      // env to the revision, so a rollback deploy must carry them too.
      const dbComponent = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
      // Queue vars are revision-scoped on Cloud Run too; a rollback deploy
      // that omitted them would strip them. Best-effort: spec-less projects
      // have no queues section and get none.
      const envSpec = new SpecStore().get(project)?.spec.environments[environment.name];
      const queueEnvVars = envSpec ? await resolveQueueEnvVars(project, envSpec, environment) : undefined;
      const deployEnvVars = {
        ...buildDeploySourceEnvVars(project, adapter.name),
        ...(dbComponent ? buildDatabaseEnvVarsFromComponent(dbComponent).envVars : {}),
        ...(queueEnvVars ?? {}),
      };
      deployResult = await orchestrator.execute({
        project,
        environment,
        services: servicesToDeploy,
        envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
        adapter,
      });
    }
    return deployResult;
  };

  const handler = async (action: PlanAction): Promise<ActionResult> => {
    const deployed = await ensureDeploy();
    const serviceName = action.resource.name;
    if (deployed.success) {
      return {
        success: true,
        message: `Redeployed ${serviceName} from run ${planned.fromRunId}`,
        data: { ...(deployed.serviceUrls[serviceName] ? { url: deployed.serviceUrls[serviceName] } : {}) },
      };
    }
    return {
      success: false,
      message: `Rollback redeploy failed for ${serviceName}`,
      error: deployed.errors.join('; ') || 'Rollback deploy failed',
    };
  };

  const converge = await new ConvergeExecutor().execute({
    planRunId: planned.planRunId,
    currentSpecRevision: planned.specRevision,
    freshObservedFingerprint: null,
    handler,
  });
  const deployed = deployResult as DeployResult | null;

  return {
    ok: true,
    success: converge.success && (deployed?.success ?? false),
    rollbackFromRunId: planned.fromRunId,
    rollbackRunId: deployed?.run.id ?? '',
    planId: planned.planRunId,
    ...(converge.applyRunId ? { applyRunId: converge.applyRunId } : {}),
    status: deployed?.run.status ?? 'failed',
    services: planned.serviceNames,
    urls: deployed?.urls ?? [],
    errors: deployed && deployed.errors.length ? deployed.errors : (converge.error ? [converge.error] : undefined),
    createdResources: deployed?.createdResources ?? [],
    rollback: deployed?.rollback,
    intent: syncProjectIntent(project.id),
  };
}
