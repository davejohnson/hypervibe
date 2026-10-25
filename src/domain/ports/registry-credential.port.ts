import type { Environment } from '../entities/environment.entity.js';
import type { Receipt } from './provider.port.js';
import { z } from 'zod';
export const registryCredentialTargetSchema = z.object({
  provider: z.string().min(1), projectId: z.string().min(1), environmentId: z.string().min(1),
  serviceId: z.string().min(1), instanceId: z.string().min(1), image: z.string().min(1),
  /** Stable native secret identity; exclude mutable version numbers. */
  credentialReference: z.string().min(1).optional(),
  registry: z.string().min(1).optional(),
  upstream: z.string().min(1).optional(),
  activation: z.enum(['deferred', 'provider-rollout']).optional(),
}).strict();
export type RegistryCredentialTarget = z.infer<typeof registryCredentialTargetSchema>;
export interface RegistryCredentialUpdateContext { operationId: string; retryUncertain?: boolean }
export interface RegistryCredentialLifecycle {
  inspect(environment: Environment, service: string): Promise<RegistryCredentialTarget>;
  update(environment: Environment, service: string, expected: RegistryCredentialTarget, credential: { username: string; token: string }, context?: RegistryCredentialUpdateContext): Promise<Receipt>;
  /** Inspect and, only where native evidence/idempotency permits, finish this exact frozen attempt. */
  reconcile?(environment: Environment, service: string, expected: RegistryCredentialTarget, credential: { username: string; token: string }, context: RegistryCredentialUpdateContext): Promise<Receipt>;
}
export function registryCredentialLifecycle(adapter: unknown): RegistryCredentialLifecycle | undefined {
  const port = (adapter as { registryCredentialLifecycle?: RegistryCredentialLifecycle } | undefined)?.registryCredentialLifecycle;
  return port && typeof port.inspect === 'function' && typeof port.update === 'function' ? port : undefined;
}
