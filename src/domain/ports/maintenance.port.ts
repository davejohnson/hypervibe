import type { Environment } from '../entities/environment.entity.js';
import type { Receipt } from './provider.port.js';

export interface MaintenanceWorkloadSnapshot {
  serviceId: string;
  environmentId?: string;
  workloadKind: 'web' | 'worker' | 'cron';
  wasRunning: boolean;
  deploymentId?: string;
  deploymentStatus?: string;
  numReplicas?: number;
  sleepApplication?: boolean;
  cronSchedule?: string;
  /** Non-secret provider-native settings required for exact restoration. */
  providerState?: Record<string, unknown>;
}

export interface MaintenanceWorkloadObservation extends MaintenanceWorkloadSnapshot {
  state: 'running' | 'suspended' | 'unknown';
  reason?: string;
}

export interface IWorkloadMaintenanceAdapter {
  observeMaintenanceWorkload(
    environment: Environment,
    serviceId: string,
    workloadKind: MaintenanceWorkloadSnapshot['workloadKind']
  ): Promise<MaintenanceWorkloadObservation>;

  suspendMaintenanceWorkload(
    environment: Environment,
    expected: MaintenanceWorkloadSnapshot,
    options?: { drainMs?: number }
  ): Promise<Receipt>;

  resumeMaintenanceWorkload(
    environment: Environment,
    snapshot: MaintenanceWorkloadSnapshot
  ): Promise<Receipt>;
}

export interface MaintenanceEdgeBinding {
  hostname: string;
  accountId: string;
  zoneId: string;
  routeId: string;
  scriptName: string;
  contentHash: string;
}

export interface MaintenanceEdgeObservation {
  state: 'active' | 'inactive' | 'unknown';
  hostname: string;
  markerVerified: boolean;
  binding?: MaintenanceEdgeBinding;
  reason?: string;
}

export interface IEdgeMaintenanceAdapter {
  observeMaintenanceEdge(
    hostname: string,
    binding?: MaintenanceEdgeBinding
  ): Promise<MaintenanceEdgeObservation>;

  ensureMaintenanceEdge(
    hostname: string,
    expectedContentHash: string,
    binding?: MaintenanceEdgeBinding
  ): Promise<Receipt>;

  removeMaintenanceEdge(binding: MaintenanceEdgeBinding): Promise<Receipt>;
}

export function supportsWorkloadMaintenance(value: unknown): value is IWorkloadMaintenanceAdapter {
  const candidate = value as Partial<IWorkloadMaintenanceAdapter> | null;
  return Boolean(
    candidate
    && typeof candidate.observeMaintenanceWorkload === 'function'
    && typeof candidate.suspendMaintenanceWorkload === 'function'
    && typeof candidate.resumeMaintenanceWorkload === 'function'
  );
}

export function supportsEdgeMaintenance(value: unknown): value is IEdgeMaintenanceAdapter {
  const candidate = value as Partial<IEdgeMaintenanceAdapter> | null;
  return Boolean(
    candidate
    && typeof candidate.observeMaintenanceEdge === 'function'
    && typeof candidate.ensureMaintenanceEdge === 'function'
    && typeof candidate.removeMaintenanceEdge === 'function'
  );
}
