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
  supportsWorkloadMaintenance,
} from '../ports/maintenance.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { getCloudflareAdapter } from './cloudflare-ops.service.js';
import { resolveExternalDatabaseUrl } from './database-ops.service.js';
import { observePostgresWriteFence } from './postgres-maintenance.service.js';

export interface EnvironmentMaintenanceBinding {
  state?: 'entering' | 'active' | 'exiting';
  edge?: MaintenanceEdgeBinding;
  workloads?: Record<string, MaintenanceWorkloadSnapshot>;
  database?: {
    componentId?: string;
    externalId?: string;
    fenced?: boolean;
  };
  updatedAt?: string;
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

export function parseEnvironmentMaintenanceBinding(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): EnvironmentMaintenanceBinding | undefined {
  const source = asRecord(environment?.platformBindings?.maintenance);
  if (!source) return undefined;
  const edge = asRecord(source.edge);
  const workloads = asRecord(source.workloads);
  const parsedEdge = edge
    && ['hostname', 'accountId', 'zoneId', 'routeId', 'scriptName', 'contentHash']
      .every((field) => stringField(edge, field))
    ? {
        hostname: stringField(edge, 'hostname')!,
        accountId: stringField(edge, 'accountId')!,
        zoneId: stringField(edge, 'zoneId')!,
        routeId: stringField(edge, 'routeId')!,
        scriptName: stringField(edge, 'scriptName')!,
        contentHash: stringField(edge, 'contentHash')!,
      }
    : undefined;
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
    ...(parsedEdge ? { edge: parsedEdge } : {}),
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
  const hostname = params.environmentSpec.domain ?? '';
  const edgeResult = hostname ? getCloudflareAdapter(hostname) : { error: 'domain missing' };
  const edge = !hostname
    ? { state: 'unknown' as const, hostname, markerVerified: false, reason: 'maintenance_domain_missing' }
    : 'error' in edgeResult || !supportsEdgeMaintenance(edgeResult.adapter)
      ? { state: 'unknown' as const, hostname, markerVerified: false, reason: 'maintenance_edge_connection_unavailable' }
      : await edgeResult.adapter.observeMaintenanceEdge(hostname, binding?.edge);

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
  if (!params.environmentSpec.database) {
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
  const databaseFenced = database.state === 'fenced' || database.state === 'not-applicable';
  const databaseUnfenced = database.state === 'unfenced' || database.state === 'not-applicable';
  const active = edge.state === 'active' && edge.markerVerified && allSuspended && databaseFenced;
  const inactive = edge.state === 'inactive' && allRestored && databaseUnfenced;
  const unknown = edge.state === 'unknown'
    || workloadStates.includes('unknown')
    || database.state === 'unknown';
  const state = active ? 'active' : inactive ? 'inactive' : unknown ? 'unknown' : 'partial';
  const stage = active ? 'verified'
    : edge.state !== (params.environmentSpec.maintenance?.enabled ? 'active' : 'inactive') ? 'edge'
      : !((params.environmentSpec.maintenance?.enabled && allSuspended)
        || (!params.environmentSpec.maintenance?.enabled && allRestored)) ? 'workloads'
        : !((params.environmentSpec.maintenance?.enabled && databaseFenced)
          || (!params.environmentSpec.maintenance?.enabled && databaseUnfenced)) ? 'database'
          : params.environmentSpec.maintenance?.enabled ? 'verified' : 'exit';

  return {
    state,
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
