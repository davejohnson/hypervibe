import type { Environment } from '../entities/environment.entity.js';

/** Read-only deployment evidence. Present does not imply healthy or successful execution. */
export interface WorkloadDeploymentObservation {
  presence: 'present' | 'absent' | 'unknown';
  status: string;
  reason?: string;
  url?: string;
}
export interface WorkloadDiagnostics {
  readDeployment(environment: Environment, serviceName: string): Promise<WorkloadDeploymentObservation>;
}
export function hasWorkloadDiagnostics(value: unknown): value is WorkloadDiagnostics {
  return !!value && typeof (value as WorkloadDiagnostics).readDeployment === 'function';
}
export interface EngineWorkloadBinding {
  serviceId: string;
  workloadKind: string;
  resourceType: 'ecs-express' | 'ecs-service' | 'ecs-task' | 'container-app' | 'container-job';
  region: string;
  url?: string;
  logGroup?: string;
  logStreamPrefix?: string;
  clusterArn?: string;
  taskDefinitionArn?: string;
  managedEnvironmentId?: string;
  workspaceId?: string;
}
export function workloadBinding(environment: Environment, name: string): EngineWorkloadBinding {
  const binding = (environment.platformBindings as { services?: Record<string, EngineWorkloadBinding> }).services?.[name];
  if (!binding?.serviceId || !binding.region || !binding.resourceType) throw new Error('No exact engine workload binding is recorded. Run hv_plan and hv_apply to record identities from the retained engine state.');
  return binding;
}
/** Allowlist resource values privately; never return the state or unrelated attributes. */
export function stateResources(state: unknown): Map<string, Record<string, unknown>> {
  const root = (state as { values?: { root_module?: { resources?: Array<{ address?: string; values?: Record<string, unknown> }> } } })?.values?.root_module;
  if (!root || !Array.isArray(root.resources)) throw new Error('Engine state has no readable resources.');
  return new Map(root.resources.filter((r) => typeof r.address === 'string' && r.values).map((r) => [r.address!, r.values!]));
}
export function stateString(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
