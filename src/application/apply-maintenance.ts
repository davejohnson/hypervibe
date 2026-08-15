import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import {
  supportsEdgeMaintenance,
  supportsWorkloadMaintenance,
  type MaintenanceEdgeBinding,
  type MaintenanceWorkloadSnapshot,
} from '../domain/ports/maintenance.port.js';
import type { IProviderAdapter } from '../domain/ports/provider.port.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { acquireManagedDatabaseAccess } from '../domain/services/database-access.service.js';
import { getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import {
  observeEnvironmentMaintenance,
  maintenanceWorkloadsRestored,
  parseEnvironmentMaintenanceBinding,
  type EnvironmentMaintenanceBinding,
} from '../domain/services/environment-maintenance.service.js';
import {
  MAINTENANCE_OPERATIONS,
  isMaintenanceAction,
} from '../domain/services/maintenance-plan.service.js';
import { setPostgresWriteFence } from '../domain/services/postgres-maintenance.service.js';
import type { CommandContext } from './context.js';

function stringField(action: PlanAction, key: string): string | undefined {
  const value = action.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function blocked(message: string, error: string): ActionResult {
  return { success: false, status: 'blocked', message, error };
}

function saveBinding(
  ctx: CommandContext,
  environment: Environment,
  binding: EnvironmentMaintenanceBinding | undefined
): Environment {
  const platformBindings = { ...environment.platformBindings };
  if (binding) platformBindings.maintenance = binding as unknown as Record<string, unknown>;
  else delete platformBindings.maintenance;
  return ctx.repos.environments.update(environment.id, { platformBindings }) ?? {
    ...environment,
    platformBindings,
  };
}

async function hostingAdapter(params: {
  ctx: CommandContext;
  project: Project;
  environmentSpec: EnvironmentSpec;
}): Promise<IProviderAdapter | null> {
  const result = await params.ctx.adapterFactory.getProviderAdapter(
    params.environmentSpec.hosting.provider,
    params.project
  );
  if (!result.success || !result.adapter) return null;
  const adapter = result.adapter as IProviderAdapter;
  await adapter.configureTarget?.({ region: params.environmentSpec.hosting.region });
  return adapter;
}

export async function applyMaintenanceAction(params: {
  ctx: CommandContext;
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult | null> {
  if (!isMaintenanceAction(params.action)) return null;
  let environment = params.ctx.repos.environments.findByProjectAndName(
    params.project.id,
    params.environmentName
  );
  if (!environment) {
    return blocked('Maintenance environment is not tracked', 'Re-run hv_plan after the environment binding exists.');
  }
  const operation = params.action.metadata?.operation;
  const currentBinding = parseEnvironmentMaintenanceBinding(environment);

  if (
    operation === MAINTENANCE_OPERATIONS.edgeEnable
    || operation === MAINTENANCE_OPERATIONS.edgeDisable
  ) {
    const hostname = stringField(params.action, 'hostname');
    if (!hostname || hostname !== params.environmentSpec.domain) {
      return blocked('Maintenance edge target changed', 'The reviewed hostname no longer matches desired state.');
    }
    const result = getCloudflareAdapter(hostname);
    if ('error' in result || !supportsEdgeMaintenance(result.adapter)) {
      return blocked('Cloudflare maintenance edge is unavailable', 'Connect Cloudflare with Workers Scripts and Workers Routes write access, then re-run hv_plan.');
    }
    if (operation === MAINTENANCE_OPERATIONS.edgeEnable) {
      const contentHash = (result.adapter as { maintenanceContentHash?: (value: string) => string })
        .maintenanceContentHash?.(hostname);
      if (!contentHash) return blocked('Maintenance edge content is unavailable', 'The connected Cloudflare adapter cannot produce the reviewed maintenance marker.');
      const receipt = await result.adapter.ensureMaintenanceEdge(hostname, contentHash, currentBinding?.edge);
      if (!receipt.success) {
        return blocked('Maintenance edge was not enabled', receipt.error ?? receipt.message);
      }
      const edge = (receipt.data?.binding ?? null) as MaintenanceEdgeBinding | null;
      if (!edge?.routeId || !edge.scriptName || !edge.contentHash) {
        return blocked('Maintenance edge binding was not returned', 'Cloudflare mutation completed without a durable route/script identity.');
      }
      environment = saveBinding(params.ctx, environment, {
        ...currentBinding,
        state: 'entering',
        edge,
        updatedAt: new Date().toISOString(),
      });
      const verified = await result.adapter.observeMaintenanceEdge(hostname, edge);
      if (verified.state !== 'active' || !verified.markerVerified) {
        return blocked(
          'Maintenance edge marker was not verified',
          'The durable Cloudflare route/script binding was saved for a safe retry, but public traffic did not yet return the reviewed 503 marker.'
        );
      }
      return { success: true, message: receipt.message, data: receipt.data };
    }
    if (!currentBinding?.edge) {
      return blocked('Maintenance edge binding is missing', 'Hypervibe will not remove an unbound Cloudflare Worker route.');
    }
    const exitAdapter = await hostingAdapter(params);
    if (!exitAdapter) {
      return blocked('Hosting provider maintenance is unavailable', 'Normal workload state cannot be verified before removing the maintenance edge.');
    }
    const exitObservation = await observeEnvironmentMaintenance({
      project: params.project,
      environment,
      environmentSpec: params.environmentSpec,
      hostingAdapter: exitAdapter,
    });
    if (
      !maintenanceWorkloadsRestored(exitObservation.workloads, currentBinding)
      || !['unfenced', 'not-applicable'].includes(exitObservation.database.state)
    ) {
      return blocked(
        'Maintenance edge removal preconditions changed',
        'Every workload must match its pre-maintenance state and PostgreSQL must be unfenced before the edge can be removed.'
      );
    }
    const receipt = await result.adapter.removeMaintenanceEdge(currentBinding.edge);
    if (!receipt.success) return blocked('Maintenance edge was not removed', receipt.error ?? receipt.message);
    const { edge: _removed, ...remaining } = currentBinding;
    saveBinding(params.ctx, environment, {
      ...remaining,
      state: 'exiting',
      updatedAt: new Date().toISOString(),
    });
    return { success: true, message: receipt.message, data: receipt.data };
  }

  const adapter = await hostingAdapter(params);
  if (!adapter) {
    return blocked('Hosting provider maintenance is unavailable', `No connected ${params.environmentSpec.hosting.provider} adapter is available.`);
  }

  if (
    operation === MAINTENANCE_OPERATIONS.workloadSuspend
    || operation === MAINTENANCE_OPERATIONS.workloadResume
  ) {
    if (!supportsWorkloadMaintenance(adapter)) {
      return blocked(
        'Hosting provider cannot prove workload suspension',
        `${params.environmentSpec.hosting.provider} does not implement reversible maintenance for every workload type.`
      );
    }
    const serviceName = stringField(params.action, 'serviceName');
    const serviceId = stringField(params.action, 'serviceId');
    const workloadKind = stringField(params.action, 'workloadKind') as MaintenanceWorkloadSnapshot['workloadKind'] | undefined;
    const serviceSpec = serviceName ? params.environmentSpec.services[serviceName] : undefined;
    if (!serviceName || !serviceId || !workloadKind || serviceSpec?.workloadKind !== workloadKind) {
      return blocked('Maintenance workload target changed', 'The reviewed service identity or workload kind no longer matches desired state.');
    }
    if (operation === MAINTENANCE_OPERATIONS.workloadSuspend) {
      const existingSnapshot = currentBinding?.workloads?.[serviceName];
      const observed = await adapter.observeMaintenanceWorkload(environment, serviceId, workloadKind);
      if (observed.state === 'unknown') {
        return blocked(`Cannot suspend ${serviceName}`, 'The provider could not prove the current workload state.');
      }
      if (observed.state === 'suspended' && !existingSnapshot) {
        return blocked(`Cannot adopt suspended workload ${serviceName}`, 'The exact pre-maintenance restoration state is not bound locally.');
      }
      const fresh = await observeEnvironmentMaintenance({
        project: params.project,
        environment,
        environmentSpec: params.environmentSpec,
        hostingAdapter: adapter,
      });
      if (fresh.edge.state !== 'active' || !fresh.edge.markerVerified) {
        return blocked(`Cannot suspend ${serviceName}`, 'The public maintenance marker is not currently provider-verified.');
      }
      const rank = (kind: string): number => kind === 'cron' ? 0 : kind === 'worker' ? 1 : 2;
      const earlier = Object.entries(params.environmentSpec.services)
        .filter(([name, spec]) => name !== serviceName && rank(spec.workloadKind) < rank(workloadKind));
      if (earlier.some(([name]) => fresh.workloads[name]?.state !== 'suspended')) {
        return blocked(`Cannot suspend ${serviceName}`, 'An earlier workload suspension stage is no longer provider-verified.');
      }
      const snapshot = existingSnapshot ?? {
        ...observed,
        wasRunning: observed.state === 'running',
      };
      environment = saveBinding(params.ctx, environment, {
        ...currentBinding,
        state: 'entering',
        workloads: {
          ...(currentBinding?.workloads ?? {}),
          [serviceName]: snapshot,
        },
        updatedAt: new Date().toISOString(),
      });
      const receipt = await adapter.suspendMaintenanceWorkload(environment, snapshot);
      return receipt.success
        ? { success: true, message: receipt.message, data: receipt.data }
        : blocked(`Failed to suspend ${serviceName}`, receipt.error ?? receipt.message);
    }
    const snapshot = currentBinding?.workloads?.[serviceName];
    if (!snapshot || snapshot.serviceId !== serviceId || snapshot.workloadKind !== workloadKind) {
      return blocked(`Cannot restore ${serviceName}`, 'The exact pre-maintenance workload snapshot is missing or changed.');
    }
    const fresh = await observeEnvironmentMaintenance({
      project: params.project,
      environment,
      environmentSpec: params.environmentSpec,
      hostingAdapter: adapter,
    });
    if (fresh.edge.state !== 'active' || !fresh.edge.markerVerified) {
      return blocked(`Cannot restore ${serviceName}`, 'The public maintenance marker must remain active until every workload is restored.');
    }
    const receipt = await adapter.resumeMaintenanceWorkload(environment, snapshot);
    if (!receipt.success) return blocked(`Failed to restore ${serviceName}`, receipt.error ?? receipt.message);
    saveBinding(params.ctx, environment, {
      ...currentBinding,
      state: 'exiting',
      workloads: currentBinding?.workloads,
      updatedAt: new Date().toISOString(),
    });
    return { success: true, message: receipt.message, data: receipt.data };
  }

  if (
    operation === MAINTENANCE_OPERATIONS.databaseFence
    || operation === MAINTENANCE_OPERATIONS.databaseUnfence
  ) {
    const enabling = operation === MAINTENANCE_OPERATIONS.databaseFence;
    const fresh = await observeEnvironmentMaintenance({
      project: params.project,
      environment,
      environmentSpec: params.environmentSpec,
      hostingAdapter: adapter,
    });
    if (
      fresh.edge.state !== 'active'
      || !fresh.edge.markerVerified
      || Object.values(fresh.workloads).some((workload) => workload.state !== 'suspended')
    ) {
      return blocked('Database fence preconditions changed', 'The edge and every workload must remain provider-verified before the database fence changes.');
    }
    const access = await acquireManagedDatabaseAccess(params.project, environment);
    if (!access.ok) {
      return blocked('Managed PostgreSQL access is unavailable', access.error);
    }
    let result;
    try {
      result = await access.lease.withConnection((connectionUrl) =>
        setPostgresWriteFence(connectionUrl, enabling)
      );
    } finally {
      await access.lease.release();
    }
    const expected = enabling ? 'fenced' : 'unfenced';
    if (result.state !== expected) {
      return blocked('PostgreSQL write fence was not verified', 'A fresh database session did not observe the reviewed fence state.');
    }
    saveBinding(params.ctx, environment, {
      ...currentBinding,
      state: enabling ? 'entering' : 'exiting',
      database: enabling ? { fenced: true } : { fenced: false },
      updatedAt: new Date().toISOString(),
    });
    return {
      success: true,
      message: enabling ? 'Enabled and verified PostgreSQL write fence' : 'Removed and verified PostgreSQL write fence',
      data: { applied: 1, skipped: 0, state: result.state },
    };
  }

  if (
    operation === MAINTENANCE_OPERATIONS.verifyEnter
    || operation === MAINTENANCE_OPERATIONS.verifyExit
  ) {
    const observation = await observeEnvironmentMaintenance({
      project: params.project,
      environment,
      environmentSpec: params.environmentSpec,
      hostingAdapter: adapter,
    });
    const entering = operation === MAINTENANCE_OPERATIONS.verifyEnter;
    if (observation.state !== (entering ? 'active' : 'inactive')) {
      return blocked(
        'Maintenance boundary verification is incomplete',
        `Observed state is ${observation.state} at stage ${observation.stage}; no transition marker was finalized.`
      );
    }
    if (entering) {
      saveBinding(params.ctx, environment, {
        ...currentBinding,
        state: 'active',
        updatedAt: new Date().toISOString(),
      });
    } else {
      saveBinding(params.ctx, environment, undefined);
    }
    return {
      success: true,
      message: entering
        ? `Maintenance is active and provider-verified for ${params.environmentName}`
        : `Maintenance is inactive and normal operation is restored for ${params.environmentName}`,
      data: { applied: 1, skipped: 0, state: observation.state, stage: observation.stage },
    };
  }

  return blocked('Unknown maintenance operation', 'Re-run hv_plan with the current Hypervibe version.');
}
