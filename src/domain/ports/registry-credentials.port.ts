import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';

export const registryTargetSchema = z.object({
  serviceId: z.string().min(1),
  instanceId: z.string().min(1),
  providerScope: z.record(z.string().min(1)),
  image: z.string().min(1),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RegistryTarget = z.infer<typeof registryTargetSchema>;
export type RegistryCredentials = { username: string; token: string };

/** Exact existing targets only. No create, deploy, image, schedule or env writes. */
export interface RegistryCredentialRepairPort {
  observe(environment: Environment, serviceName: string): Promise<RegistryTarget>;
  update(environment: Environment, serviceName: string, reviewed: RegistryTarget,
    credentials: RegistryCredentials): Promise<{ state: 'acknowledged' | 'rejected' | 'uncertain'; mutationAttempted: boolean }>;
}

export interface RegistryCredentialSource {
  resolve(credentials: unknown): RegistryCredentials;
  validate(image: string, credentials: RegistryCredentials): Promise<void>;
}
