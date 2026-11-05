import type { Environment } from '../entities/environment.entity.js';
import type { ObservedMaintenanceWorkload, ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { maintenanceMode, maintenanceModeChanged, maintenanceTransitionChanged, parseEnvironmentMaintenanceBinding } from './environment-maintenance.service.js';

export const MAINTENANCE_OPERATIONS = {
  edgeEnable: 'maintenanceEdgeEnable',
  edgeDisable: 'maintenanceEdgeDisable',
  edgeRoute: 'maintenanceEdgeRoute',
  workloadSuspend: 'maintenanceWorkloadSuspend',
  workloadResume: 'maintenanceWorkloadResume',
  databaseFence: 'maintenanceDatabaseFence',
  databaseUnfence: 'maintenanceDatabaseUnfence',
  verifyEnter: 'maintenanceVerifyEnter',
  verifyExit: 'maintenanceVerifyExit',
} as const;

export interface MaintenancePlanResult {
  actions: PlanAction[];
  pending: boolean;
  providers: string[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function operationAction(params: {
  id: string;
  name: string;
  provider: string;
  operation: string;
  type: PlanAction['type'];
  reason: string;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  blockedReason?: string;
  confirm?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'maintenance', name: params.name, provider: params.provider },
    verified: !params.blockedReason,
    reason: params.reason,
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    ...(params.confirm && params.type !== 'noop'
      ? { billable: true, requiresConfirm: true }
      : {}),
    metadata: {
      operation: params.operation,
      ...params.metadata,
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    },
  };
}

function workloadOrder(environmentSpec: EnvironmentSpec): string[] {
  return Object.entries(environmentSpec.services ?? {})
    .sort(([, left], [, right]) => {
      const rank = (kind: string) => kind === 'cron' ? 0 : kind === 'worker' ? 1 : 2;
      return rank(left.workloadKind) - rank(right.workloadKind);
    })
    .map(([name]) => name);
}

function unknownReason(state: string | undefined, reason: string): string | undefined {
  return state === 'unknown' ? reason : undefined;
}

export function planMaintenance(params: {
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState;
}): MaintenancePlanResult {
  const desired = params.environmentSpec.maintenance?.enabled === true;
  const binding = asRecord(params.environment?.platformBindings?.maintenance);
  if (!desired && !binding) return { actions: [], pending: false, providers: [], warnings: [] };

  const maintenance = params.observed.maintenance;
  const hostingProvider = params.environmentSpec.hosting.provider;
  const parsedBinding = parseEnvironmentMaintenanceBinding(params.environment);
  const mode = maintenanceMode(params.environmentSpec, parsedBinding);
  const databaseProvider = mode === 'data' ? params.environmentSpec.database?.provider : undefined;
  const hostname = params.environmentSpec.domain ?? '';
  const actions: PlanAction[] = [];
  const workloadNames = workloadOrder(params.environmentSpec);
  const routingDesired = mode === 'application' && params.environmentSpec.maintenance?.page === 'off';

  if (desired) {
    const edgeState = maintenance?.edge.state ?? 'unknown';
    const edgeId = `maintenance:${params.environmentName}:edge`;
    const edgeNeedsUpdate = edgeState !== 'active'
      || (!routingDesired && (maintenance?.page === 'off' || Boolean(parsedBinding?.pendingEdge?.origin)));
    actions.push(operationAction({
      id: edgeId,
      name: hostname || params.environmentName,
      provider: 'cloudflare',
      operation: MAINTENANCE_OPERATIONS.edgeEnable,
      type: edgeNeedsUpdate ? 'update' : 'noop',
      reason: edgeNeedsUpdate
        ? `Serve a verified maintenance response while ${params.environmentName} is paused`
        : `Maintenance edge for ${hostname} is active`,
      blockedReason: !hostname
        ? 'maintenance_domain_missing'
        : !routingDesired && parsedBinding?.pendingEdge ? undefined
          : unknownReason(edgeState, 'maintenance_edge_unknown'),
      confirm: true,
      metadata: { environmentName: params.environmentName, hostname },
    }));

    let predecessor = edgeId;
    for (const name of workloadNames) {
      const spec = params.environmentSpec.services?.[name];
      const observation = maintenance?.workloads[name];
      const id = `maintenance:${params.environmentName}:workload:${name}`;
      actions.push(operationAction({
        id,
        name,
        provider: hostingProvider,
        operation: MAINTENANCE_OPERATIONS.workloadSuspend,
        type: observation?.state === 'suspended' ? 'noop' : 'update',
        reason: observation?.state === 'suspended'
          ? `${name} is suspended`
          : `Suspend ${spec?.workloadKind ?? 'service'} workload ${name}`,
        dependsOn: [predecessor],
        blockedReason: !observation || observation.state === 'unknown'
          ? observation?.reason ?? 'maintenance_workload_unknown'
          : undefined,
        metadata: {
          environmentName: params.environmentName,
          serviceName: name,
          serviceId: observation?.serviceId,
          workloadKind: spec?.workloadKind,
        },
      }));
      predecessor = id;
    }

    const databaseId = `maintenance:${params.environmentName}:database-fence`;
    if (databaseProvider) {
      const databaseState = maintenance?.database.state ?? 'unknown';
      actions.push(operationAction({
        id: databaseId,
        name: params.environmentSpec.database?.engine ?? 'database',
        provider: databaseProvider,
        operation: MAINTENANCE_OPERATIONS.databaseFence,
        type: databaseState === 'fenced' ? 'noop' : 'update',
        reason: databaseState === 'fenced'
          ? 'PostgreSQL write fence is active'
          : 'Fence new PostgreSQL sessions against writes',
        dependsOn: [predecessor],
        blockedReason: databaseState === 'unknown'
          ? maintenance?.database.reason ?? 'maintenance_database_unknown'
          : undefined,
        metadata: { environmentName: params.environmentName },
      }));
      predecessor = databaseId;
    }

    if (routingDesired) {
      const target = maintenance?.routing?.target;
      const targetSpec = params.environmentSpec.domainTarget;
      const routed = maintenance?.edge.state === 'active' && maintenance.page === 'off'
        && target && maintenance.edge.targetFingerprint === target.targetFingerprint
        && maintenance.edge.origin === target.origin;
      const routeId = `maintenance:${params.environmentName}:traffic`;
      actions.push(operationAction({
        id: routeId, name: hostname, provider: 'cloudflare', operation: MAINTENANCE_OPERATIONS.edgeRoute,
        type: routed ? 'noop' : 'update', reason: 'Send public traffic to the verified replacement while keeping the original app paused',
        dependsOn: [predecessor], confirm: true,
        blockedReason: !targetSpec ? 'maintenance_target_missing'
          : maintenance?.routing?.state !== 'ready' || !target
            ? maintenance?.routing?.reason ?? 'maintenance_target_unverified' : undefined,
        metadata: { environmentName: params.environmentName, hostname,
          targetEnvironment: targetSpec?.environment, targetService: targetSpec?.service, ...target },
      }));
      predecessor = routeId;
    }

    actions.push(operationAction({
      id: `maintenance:${params.environmentName}:verify`,
      name: params.environmentName,
      provider: 'local',
      operation: MAINTENANCE_OPERATIONS.verifyEnter,
      type: maintenance?.state === 'active' && binding?.state === 'active' && !parsedBinding?.pendingEdge
        ? 'noop'
        : 'update',
      reason: maintenance?.state === 'active'
        ? `${params.environmentName} maintenance is provider-verified`
        : `Verify the complete maintenance boundary for ${params.environmentName}`,
      dependsOn: [predecessor],
      metadata: { environmentName: params.environmentName },
    }));
  } else {
    const databaseId = `maintenance:${params.environmentName}:database-fence`;
    if (databaseProvider) {
      actions.push(operationAction({
        id: databaseId,
        name: params.environmentSpec.database?.engine ?? 'database',
        provider: databaseProvider,
        operation: MAINTENANCE_OPERATIONS.databaseUnfence,
        type: maintenance?.database.state === 'unfenced' ? 'noop' : 'update',
        reason: 'Remove the PostgreSQL write fence before restoring workloads',
        metadata: { environmentName: params.environmentName },
      }));
    }
    let predecessor = databaseProvider ? databaseId : undefined;
    for (const name of [...workloadNames].reverse()) {
      const spec = params.environmentSpec.services?.[name];
      const observation: ObservedMaintenanceWorkload | undefined = maintenance?.workloads[name];
      const snapshot = asRecord(asRecord(binding?.workloads)?.[name]);
      const expectedState = snapshot?.wasRunning === false ? 'suspended' : 'running';
      const restored = observation?.state === expectedState;
      const id = `maintenance:${params.environmentName}:workload:${name}`;
      actions.push(operationAction({
        id,
        name,
        provider: hostingProvider,
        operation: MAINTENANCE_OPERATIONS.workloadResume,
        type: restored ? 'noop' : 'update',
        reason: `Restore ${name} to its exact pre-maintenance state`,
        ...(predecessor ? { dependsOn: [predecessor] } : {}),
        blockedReason: !snapshot
          ? 'maintenance_workload_snapshot_missing'
          : undefined,
        metadata: {
          environmentName: params.environmentName,
          serviceName: name,
          serviceId: observation?.serviceId,
          workloadKind: spec?.workloadKind,
        },
      }));
      predecessor = id;
    }
    const edgeId = `maintenance:${params.environmentName}:edge`;
    actions.push(operationAction({
      id: edgeId,
      name: hostname || params.environmentName,
      provider: 'cloudflare',
      operation: MAINTENANCE_OPERATIONS.edgeDisable,
      type: maintenance?.edge.state === 'inactive' ? 'noop' : 'update',
      reason: 'Remove the maintenance edge only after workloads are restored',
      ...(predecessor ? { dependsOn: [predecessor] } : {}),
      blockedReason: !asRecord(binding?.edge) ? 'maintenance_edge_binding_missing' : undefined,
      metadata: { environmentName: params.environmentName, hostname },
    }));
    actions.push(operationAction({
      id: `maintenance:${params.environmentName}:verify`,
      name: params.environmentName,
      provider: 'local',
      operation: MAINTENANCE_OPERATIONS.verifyExit,
      type: 'update',
      reason: 'Verify normal traffic and writes are restored',
      dependsOn: [edgeId],
      metadata: { environmentName: params.environmentName },
    }));
  }

  const transitionChanged = maintenanceTransitionChanged(params.environmentSpec, parsedBinding, maintenance?.routing?.target);
  if (transitionChanged || maintenanceModeChanged(params.environmentSpec, parsedBinding) || (!desired && params.environmentSpec.domainTarget)) {
    for (const action of actions) {
      action.verified = false;
      action.metadata = { ...action.metadata, blockedReason: transitionChanged ? 'maintenance_edge_transition_pending' : params.environmentSpec.domainTarget && !desired
        ? 'maintenance_target_still_selected' : 'maintenance_mode_changed' };
    }
  }
  const pending = actions.some((action) => action.type !== 'noop');
  const providers = [...new Set(actions.map((action) => action.resource.provider).filter((name) => name !== 'local'))];
  return {
    actions,
    pending,
    providers,
    warnings: pending ? [`Maintenance transition for "${params.environmentName}" must complete before unrelated reconciliation.`] : [],
  };
}

export function isMaintenanceAction(action: PlanAction): boolean {
  return action.resource.kind === 'maintenance'
    && Object.values(MAINTENANCE_OPERATIONS).includes(
      action.metadata?.operation as typeof MAINTENANCE_OPERATIONS[keyof typeof MAINTENANCE_OPERATIONS]
    );
}
