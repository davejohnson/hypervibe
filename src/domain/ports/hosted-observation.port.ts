import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from './observe.port.js';

export interface HostedObservationRequest {
  environment: Environment;
  credentials: unknown;
  /** Trusted connection scope, independently authorized by the hosting application. */
  scope: { projectId: string; environmentId: string };
  limits: { maxRequests: number; maxResources: number; timeoutMs: number };
  signal?: AbortSignal;
}

export type HostedObservationReason = 'scope_mismatch' | 'budget_exhausted' | 'timeout'
  | 'cancelled' | 'provider_error' | 'invalid_credentials';

export interface HostedObservationResult {
  /** Internal engine evidence; hosting interfaces must allowlist fields before output. */
  observed: ObservedState | null;
  scopeVerified: boolean;
  requests: number;
  reason?: HostedObservationReason;
}

export interface HostedObservationCapability {
  observe(input: HostedObservationRequest): Promise<HostedObservationResult>;
}

/** Provider-owned control outcome, never a raw provider error or credential-bearing message. */
export class HostedObservationError extends Error {
  constructor(readonly reason: HostedObservationReason) {
    super(reason);
    this.name = 'HostedObservationError';
  }
}
