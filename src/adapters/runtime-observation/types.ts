import type { EngineWorkloadBinding } from '../../domain/ports/workload-diagnostics.port.js';

export type RuntimeService = Pick<EngineWorkloadBinding, 'serviceId' | 'region' | 'logGroup' | 'logStreamPrefix' | 'clusterArn' | 'taskDefinitionArn' | 'managedEnvironmentId' | 'workspaceId'> & {
  workloadKind: 'web' | 'worker' | 'cron';
};
export interface RuntimeBinding {
  provider: 'gcp' | 'aws' | 'azure';
  environmentName: string;
  services: Record<string, RuntimeService>;
}
export type RuntimeAccess = (
  | { provider: 'gcp'; token: string }
  | { provider: 'aws'; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string } }
  | { provider: 'azure'; getToken: (scope: string) => Promise<string> }
) & { redact?: string[] };
export interface RuntimeWindow { since: string; until: string }
export type RuntimeSource = 'logs' | 'jobs';
export type LogSeverity = 'ERROR' | 'CRITICAL' | 'ALERT' | 'EMERGENCY';
export type RuntimeObservation =
  | { kind: 'log'; service: string; at: string; severity: LogSeverity; message: string; id?: string }
  | { kind: 'job'; job: string; id: string; at: string; status: 'failed' | 'succeeded'; detail?: string };
export interface RuntimeReport {
  version: 1;
  environment: string;
  provider: RuntimeBinding['provider'];
  window: RuntimeWindow;
  sources: Array<{ kind: RuntimeSource | 'deploys' | 'health'; status: 'failed' | 'ok' | 'unsupported'; message?: string }>;
  observations: RuntimeObservation[];
}
export interface RuntimeExecution {
  job: string;
  id: string;
  startedAt: string;
  status: 'active' | 'failed' | 'succeeded';
  completedAt?: string;
}
export interface RuntimeReadOptions {
  signal?: AbortSignal;
  sources?: RuntimeSource[];
  /** Called only when every incomplete log read hit a read or report size limit. */
  onLogCapacity?: () => void;
  onExecution?: (execution: RuntimeExecution) => void;
}
export interface ReadContext {
  signal?: AbortSignal;
  name: string;
  service: RuntimeService;
  window: RuntimeWindow;
  redact: string[];
  log(at: string, message: string, severity?: unknown, nativeId?: string): void;
  execution(id: string, start: string, status: RuntimeExecution['status'], end?: string, detail?: string): void;
}
