import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { adapterFactory } from './adapter.factory.js';
import { DeployOrchestrator } from './deploy.orchestrator.js';
import { buildDeploySourceEnvVars } from './deploy-source.js';
import { syncProjectIntent } from './intent.service.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { DeployResult } from './deploy.orchestrator.js';

const runRepo = new RunRepository();
const serviceRepo = new ServiceRepository();

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
  status: string;
  services: string[];
  urls: DeployResult['urls'];
  errors?: string[];
  createdResources: DeployResult['createdResources'];
  rollback: DeployResult['rollback'];
  intent: ReturnType<typeof syncProjectIntent>;
};

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

  const adapterResult = await adapterFactory.getHostingAdapter(project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      ok: false,
      reason: 'no_adapter',
      error: adapterResult.error || 'No hosting adapter available for rollback',
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deployEnvVars = buildDeploySourceEnvVars(project, adapterResult.adapter.name);
  const rollback = await orchestrator.execute({
    project,
    environment,
    services: servicesToDeploy,
    envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
    adapter: adapterResult.adapter,
  });

  return {
    ok: true,
    success: rollback.success,
    rollbackFromRunId: targetRun.id,
    rollbackRunId: rollback.run.id,
    status: rollback.run.status,
    services: servicesToDeploy.map((s) => s.name),
    urls: rollback.urls,
    errors: rollback.errors.length ? rollback.errors : undefined,
    createdResources: rollback.createdResources,
    rollback: rollback.rollback,
    intent: syncProjectIntent(project.id),
  };
}
