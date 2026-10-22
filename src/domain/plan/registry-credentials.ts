import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { PlanAction } from './plan.types.js';
import { registryTargetSchema } from '../ports/registry-credentials.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';

export const registryRepairMetadataSchema = z.object({
  operation: z.literal('registryCredentialsRepair'),
  target: registryTargetSchema,
  codeHost: z.object({ provider: z.string().min(1), scope: z.string().min(1) }).strict(),
  previousAttemptPlanId: z.string().min(1).optional(),
}).strict();
export const registryRepairAttemptSchema = z.object({
  planId: z.string().min(1), state: z.enum(['uncertain', 'acknowledged', 'rejected']),
  mutationAttempted: z.boolean(),
}).strict();

export function registryRepairAttempt(environment: Environment, name: string) {
  const attempts = z.record(registryRepairAttemptSchema).parse(environment.platformBindings.registryCredentialRepairs ?? {});
  return attempts[name];
}

export function isRegistryRepairAction(action: PlanAction): boolean {
  const parsed = registryRepairMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.type === 'update' && action.resource.kind === 'service'
    && action.id === `registry-credentials:${action.resource.name}` && action.verified
    && !action.dependsOn?.length && !action.billable && !action.dataBearing
    && Boolean(action.requiresConfirm) === Boolean(parsed.data.previousAttemptPlanId);
}

export function assertRegistryRepairBinding(environment: Environment, provider: string, name: string) {
  const binding = parseHostingBindings(environment);
  const id = binding.services?.[name]?.serviceId;
  if (binding.provider !== provider || !binding.projectId || !id
    || Object.values(binding.services ?? {}).filter(service => service.serviceId === id).length !== 1
    || binding.serviceCreateRecovery?.[name]) {
    throw new Error('Registry repair requires one exact existing service binding without unresolved creation.');
  }
}
