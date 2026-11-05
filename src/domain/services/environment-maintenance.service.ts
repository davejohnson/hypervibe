import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type {
  EnvironmentMaintenanceObservation,
  ObservedMaintenanceWorkload,
} from '../ports/observe.port.js';
import type {
  MaintenanceEdgeBinding,
  MaintenanceWorkloadSnapshot,
} from '../ports/maintenance.port.js';
import {
  supportsEdgeMaintenance,
  supportsEdgeTraffic,
  supportsWorkloadMaintenance,
} from '../ports/maintenance.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { getCloudflareAdapter } from './cloudflare-ops.service.js';
import { resolveExternalDatabaseUrl } from './database-ops.service.js';
import { observePostgresWriteFence } from './postgres-maintenance.service.js';
import { observeDomainTarget } from './domain-target.service.js';

export interface EnvironmentMaintenanceBinding {
  mode?: 'application' | 'data';
  state?: 'entering' | 'active' | 'exiting';
  edge?: MaintenanceEdgeBinding;
  /** Exact proposed script update saved before changing the owned route. */
  pendingEdge?: MaintenanceEdgeBinding;
  workloads?: Record<string, MaintenanceWorkloadSnapshot>;
  database?: {
    componentId?: string;
    externalId?: string;
    fenced?: boolean;
  };
  updatedAt?: string;
}

export function maintenanceMode(spec: EnvironmentSpec, binding?: EnvironmentMaintenanceBinding): 'application' | 'data' {
  return spec.maintenance?.mode ?? binding?.mode ?? 'data';
}

export function maintenanceModeChanged(spec: EnvironmentSpec, binding?: EnvironmentMaintenanceBinding): boolean {
  return Boolean(binding && maintenanceMode(spec, binding) !== (binding.mode ?? 'data'));
}

export function maintenanceTransitionChanged(spec: EnvironmentSpec, binding?: EnvironmentMaintenanceBinding,
  target?: { origin: string; targetFingerprint: string }): boolean {
  const pending = binding?.pendingEdge;
  if (!pending) return false;
  if (spec.maintenance?.enabled !== true) return true;
  // An explicitly reviewed return to the 503 page is always a safe continuation
  // on this owned route, even when the replacement can no longer pass health checks.
  if (spec.maintenance.page !== 'off') return false;
  if (!pending.origin) return spec.maintenance.page === 'off';
  return spec.maintenance.page !== 'off' || target?.origin !== pending.origin
    || target.targetFingerprint !== pending.targetFingerprint;
}

export function maintenanceWorkloadsRestored(
  workloads: Record<string, ObservedMaintenanceWorkload>,
  binding: EnvironmentMaintenanceBinding | undefined
): boolean {
  return Object.entries(workloads).every(([name, workload]) => {
    const snapshot = binding?.workloads?.[name];
    const expected = snapshot?.wasRunning === false ? 'suspended' : 'running';
    return workload.state === expected;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseEdge(value: unknown): MaintenanceEdgeBinding | undefined {
  const edge = asRecord(value);
  if (!edge) return undefined;
  if (!['hostname', 'accountId', 'zoneId', 'routeId', 'scriptName', 'contentHash'].every(field => stringField(edge, field))) return undefined;
  const origin = stringField(edge, 'origin');
  const targetFingerprint = stringField(edge, 'targetFingerprint');
  if ((edge.origin !== undefined || edge.targetFingerprint !== undefined)
    && (!origin || !targetFingerprint || !/^[a-f0-9]{64}$/.test(targetFingerprint))) {
    throw new Error('Stored maintenance routing identity is incomplete.');
  }
  return {
    hostname: stringField(edge, 'hostname')!, accountId: stringField(edge, 'accountId')!,
    zoneId: stringField(edge, 'zoneId')!, routeId: stringField(edge, 'routeId')!,
    scriptName: stringField(edge, 'scriptName')!, contentHash: stringField(edge, 'contentHash')!,
    ...(origin && targetFingerprint ? { origin, targetFingerprint } : {}),
  };
}

export function parseEnvironmentMaintenanceBinding(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): EnvironmentMaintenanceBinding | undefined {
  const source = asRecord(environment?.platformBindings?.maintenance);
  if (!source) return undefined;
  const workloads = asRecord(source.workloads);
  const parsedEdge = parseEdge(source.edge);
  const pendingEdge = parseEdge(source.pendingEdge);
  if (source.pendingEdge !== undefined && !pendingEdge) throw new Error('Stored maintenance transition identity is incomplete.');
  if (source.mode !== undefined && source.mode !== 'application' && source.mode !== 'data') throw new Error('Stored maintenance mode is invalid.');
  const parsedWorkloads = Object.fromEntries(
    Object.entries(workloads ?? {}).flatMap(([name, value]) => {
      const item = asRecord(value);
      const serviceId = stringField(item, 'serviceId');
      const workloadKind = stringField(item, 'workloadKind');
      if (!serviceId || !['web', 'worker', 'cron'].includes(workloadKind ?? '')) return [];
      return [[name, item as unknown as MaintenanceWorkloadSnapshot]];
    })
  );
  return {
    ...(source.state === 'entering' || source.state === 'active' || source.state === 'exiting'
      ? { state: source.state }
      : {}),
    ...(source.mode === 'application' || source.mode === 'data' ? { mode: source.mode } : {}),
    ...(parsedEdge ? { edge: parsedEdge } : {}),
    ...(pendingEdge ? { pendingEdge } : {}),
    ...(Object.keys(parsedWorkloads).length > 0 ? { workloads: parsedWorkloads } : {}),
    ...(asRecord(source.database) ? { database: asRecord(source.database) as EnvironmentMaintenanceBinding['database'] } : {}),
    ...(stringField(source, 'updatedAt') ? { updatedAt: stringField(source, 'updatedAt') } : {}),
  };
}

export async function observeEnvironmentMaintenance(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  hostingAdapter: unknown;
}): Promise<EnvironmentMaintenanceObservation> {
  const binding = parseEnvironmentMaintenanceBinding(params.environment);
  const mode = maintenanceMode(params.environmentSpec, binding);
  const hostname = params.environmentSpec.domain ?? '';
  const edgeResult = hostname ? getCloudflareAdapter(hostname) : { error: 'domain missing' };
  const observeEdge = async (edgeBinding?: MaintenanceEdgeBinding) => !hostname
    ? { state: 'unknown' as const, hostname, markerVerified: false, reason: 'maintenance_domain_missing' }
    : 'error' in edgeResult || !supportsEdgeMaintenance(edgeResult.adapter)
      ? { state: 'unknown' as const, hostname, markerVerified: false, reason: 'maintenance_edge_connection_unavailable' }
      : edgeBinding?.origin && edgeBinding.targetFingerprint
        ? supportsEdgeTraffic(edgeResult.adapter)
          ? await edgeResult.adapter.observeTrafficEdge(hostname, { origin: edgeBinding.origin, targetFingerprint: edgeBinding.targetFingerprint }, edgeBinding)
          : { state: 'unknown' as const, hostname, markerVerified: false, reason: 'maintenance_routing_unsupported' }
        : await edgeResult.adapter.observeMaintenanceEdge(hostname, edgeBinding);
  let edge = await observeEdge(binding?.edge);
  if (binding?.pendingEdge) {
    const pending = await observeEdge(binding.pendingEdge);
    if (pending.state === 'active' && pending.markerVerified) edge = pending;
  }
  const page = edge.state === 'active'
    ? (edge.binding?.origin ? 'off' as const : 'active' as const)
    : edge.state === 'inactive' ? 'off' as const : 'unknown' as const;
  const desiredPage = params.environmentSpec.maintenance?.page ?? 'active';
  const routing = mode === 'application' && params.environmentSpec.domainTarget
    ? await observeDomainTarget(params) : undefined;
  const routingMatches = desiredPage !== 'off' || (routing?.state === 'ready' && routing.target
    && edge.binding?.targetFingerprint === routing.target.targetFingerprint
    && edge.binding.origin === routing.target.origin);

  const workloads: Record<string, ObservedMaintenanceWorkload> = {};
  for (const [name, spec] of Object.entries(params.environmentSpec.services ?? {})) {
    const serviceBinding = asRecord(asRecord(params.environment.platformBindings.services)?.[name]);
    const serviceId = stringField(serviceBinding, 'serviceId')
      ?? stringField(serviceBinding, 'jobName');
    if (!serviceId || !supportsWorkloadMaintenance(params.hostingAdapter)) {
      workloads[name] = {
        state: 'unknown',
        serviceId: serviceId ?? '',
        workloadKind: spec.workloadKind,
        reason: serviceId ? 'maintenance_provider_unsupported' : 'maintenance_workload_unbound',
      };
      continue;
    }
    const observed = await params.hostingAdapter.observeMaintenanceWorkload(
      params.environment,
      serviceId,
      spec.workloadKind
    );
    workloads[name] = observed;
  }

  let database: EnvironmentMaintenanceObservation['database'];
  if (maintenanceModeChanged(params.environmentSpec, binding)) {
    database = { state: 'unknown', reason: 'maintenance_mode_changed' };
  } else if (mode === 'application') {
    database = { state: 'unmanaged' };
  } else if (!params.environmentSpec.database) {
    database = { state: 'not-applicable' };
  } else if (params.environmentSpec.database.engine !== 'postgres') {
    database = { state: 'unknown', reason: 'maintenance_database_engine_unsupported' };
  } else {
    const connectionUrl = await resolveExternalDatabaseUrl(params.project, params.environment);
    database = connectionUrl
      ? await observePostgresWriteFence(connectionUrl)
      : { state: 'unknown', reason: 'maintenance_database_access_unavailable' };
  }

  const workloadStates = Object.values(workloads).map((workload) => workload.state);
  const allSuspended = workloadStates.every((state) => state === 'suspended');
  const allRestored = maintenanceWorkloadsRestored(workloads, binding);
  const databaseFenced = database.state === 'fenced' || database.state === 'not-applicable' || database.state === 'unmanaged';
  const databaseUnfenced = database.state === 'unfenced' || database.state === 'not-applicable' || database.state === 'unmanaged';
  const active = edge.state === 'active' && edge.markerVerified && allSuspended && databaseFenced
    && page === desiredPage && routingMatches;
  const inactive = edge.state === 'inactive' && allRestored && databaseUnfenced;
  const unknown = edge.state === 'unknown'
    || workloadStates.includes('unknown')
    || database.state === 'unknown'
    || (desiredPage === 'off' && routing?.state !== 'ready');
  const state = active ? 'active' : inactive ? 'inactive' : unknown ? 'unknown' : 'partial';
  const stage = active ? 'verified'
    : edge.state !== (params.environmentSpec.maintenance?.enabled ? 'active' : 'inactive') ? 'edge'
      : !((params.environmentSpec.maintenance?.enabled && allSuspended)
        || (!params.environmentSpec.maintenance?.enabled && allRestored)) ? 'workloads'
        : !((params.environmentSpec.maintenance?.enabled && databaseFenced)
          || (!params.environmentSpec.maintenance?.enabled && databaseUnfenced)) ? 'database'
          : !routingMatches || page !== desiredPage ? 'routing'
            : params.environmentSpec.maintenance?.enabled ? 'verified' : 'exit';

  return {
    state,
    mode,
    page,
    ...(routing ? { routing } : {}),
    stage,
    edge: {
      state: edge.state,
      hostname: edge.hostname,
      markerVerified: edge.markerVerified,
      ...(edge.binding ?? {}),
      ...(edge.reason ? { reason: edge.reason } : {}),
    },
    workloads,
    database,
  };
}
