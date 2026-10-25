import { z } from 'zod';
import { databaseCredentialTargetSchema } from '../ports/database-credential.port.js';
import type { PlanAction } from './plan.types.js';

export const DATABASE_PASSWORD_OPERATIONS = ['databasePasswordRotate', 'databasePasswordSynchronize'] as const;
export const databasePasswordMetadataSchema = z.object({
  operation: z.enum(DATABASE_PASSWORD_OPERATIONS), role: z.string().min(1), target: databaseCredentialTargetSchema,
  issuerNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
  consumers: z.array(z.object({ service: z.string().min(1), externalId: z.string().min(1), keys: z.array(z.string().min(1)).min(1) }).strict()).min(1),
}).strict();
export function databasePasswordActionId(componentId: string, operation: typeof DATABASE_PASSWORD_OPERATIONS[number]): string {
  return `database-password:${componentId}:${operation}`;
}
export function isDatabasePasswordAction(action: PlanAction): boolean {
  const parsed = databasePasswordMetadataSchema.safeParse(action.metadata);
  if (!parsed.success) return false;
  const m = parsed.data;
  return action.id === databasePasswordActionId(m.target.componentId, m.operation)
    && action.type === 'update' && action.resource.kind === 'database' && action.resource.name === 'postgres'
    && action.resource.provider === m.target.provider && action.verified && action.requiresConfirm === true
    && action.dataBearing === true && !action.billable
    && (m.operation === 'databasePasswordRotate' ? !action.dependsOn?.length
      : action.dependsOn?.length === 1 && action.dependsOn[0] === databasePasswordActionId(m.target.componentId, 'databasePasswordRotate'));
}
export function isDatabasePasswordPlan(actions: PlanAction[]): boolean {
  if (actions.length !== 2 || !actions.every(isDatabasePasswordAction)) return false;
  const first = databasePasswordMetadataSchema.parse(actions[0].metadata);
  const second = databasePasswordMetadataSchema.parse(actions[1].metadata);
  return first.operation === 'databasePasswordRotate' && second.operation === 'databasePasswordSynchronize'
    && JSON.stringify({ ...first, operation: undefined }) === JSON.stringify({ ...second, operation: undefined });
}
