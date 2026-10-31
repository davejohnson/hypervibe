import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { ProviderRuntimeIdentity, Receipt } from './provider.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';

export interface RuntimeIdentityStep {
  operation: 'create' | 'attach' | 'destroy' | 'recover';
  /** Exact provider-native target and expected prior state, never credentials. */
  target: Record<string, string>;
  description: string;
  requiresConfirm: boolean;
  /** An explicit activation changes a running revision and needs backup readiness. */
  restartsWorkload?: boolean;
}

export interface RuntimeIdentityBinding {
  provider: string;
  /** Native IDs and independently observed ownership evidence. */
  evidence: Record<string, string>;
  pending?: { attemptId: string; step: RuntimeIdentityStep };
}

export interface RuntimeIdentityRequest {
  environment: Environment;
  environmentSpec?: EnvironmentSpec;
  service: Pick<Service, 'name' | 'buildConfig'>;
  binding?: RuntimeIdentityBinding;
  mode: 'ensure' | 'destroy';
}

export type RuntimeIdentityObservation =
  | { state: 'ready'; identity?: ProviderRuntimeIdentity; warnings?: string[] }
  | { state: 'action'; step: RuntimeIdentityStep; preparedIdentity?: ProviderRuntimeIdentity; requiresStorageAccess?: true }
  | { state: 'waiting' | 'unknown'; reason: string };

/** Only the ready frontier is authorized; callers persist intent before writes. */
export interface IRuntimeIdentities {
  inspect(request: RuntimeIdentityRequest): Promise<RuntimeIdentityObservation>;
  apply(request: RuntimeIdentityRequest & { step: RuntimeIdentityStep; attemptId: string }): Promise<{
    receipt: Receipt;
    binding?: RuntimeIdentityBinding;
  }>;
}
