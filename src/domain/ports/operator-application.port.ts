import { z } from 'zod';
import type { PlanAction } from '../plan/plan.types.js';
import { OPERATOR_APPLICATION_PROVIDERS, type CloudInstallationDriver, type CloudInstallationRecord, type OperatorApplicationAuthentication, type OperatorApplicationIntent } from './cloud-installation.port.js';
import type { CloudDeploymentRuntimeIdentityV1 } from './cloud-deployment.port.js';
import { operatorOutputRolesSchema } from './operator-output.port.js';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const operatorApplicationDeclarationSchema = z.object({
  provider: z.enum(OPERATOR_APPLICATION_PROVIDERS), profile: z.literal('hypercloud-connect-v1'),
  originService: name, runtimeService: name,
  nativeScope: z.record(z.string().min(1).max(100), z.string().min(1).max(2048)),
  outputs: operatorOutputRolesSchema.optional(),
}).strict();
export type OperatorApplicationDeclaration = z.infer<typeof operatorApplicationDeclarationSchema>;
export interface OperatorApplicationLocalContext {
  projectId: string; environmentId: string; installationId: string; intentDigest: string;
}
export interface OperatorApplicationCapability {
  schemaVersion: 1;
  privateOutputRoles?: readonly string[];
  parseDeclaration(input: { name: string; declaration: OperatorApplicationDeclaration; origin: string;
    runtimeIdentity: CloudDeploymentRuntimeIdentityV1['principal'] }): Record<string, string>;
  parseRecord(value: unknown): CloudInstallationRecord<OperatorApplicationIntent>;
  create(scope: Record<string, string>, context?: OperatorApplicationLocalContext): Promise<{ driver: CloudInstallationDriver<OperatorApplicationIntent>; authentication: OperatorApplicationAuthentication }>;
  receipts(record: CloudInstallationRecord<OperatorApplicationIntent>): Array<Record<string, string>>;
}
export const OPERATOR_APPLICATION_OPERATION = 'operatorApplicationRegistration';
export const operatorApplicationPlanSchema = z.object({ schemaVersion: z.literal(1), name,
  installationId: z.string().guid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), provider: z.enum(OPERATOR_APPLICATION_PROVIDERS),
  mode: z.enum(['prepare', 'recover', 'verified']),
  retryActions: z.array(z.object({ actionId: z.string().min(1), attemptId: z.string().guid() }).strict()).min(1).max(1).optional(),
}).strict();
export type OperatorApplicationPlan = z.infer<typeof operatorApplicationPlanSchema>;
export const operatorApplicationActionMetadataSchema = operatorApplicationPlanSchema.extend({
  operation: z.literal(OPERATOR_APPLICATION_OPERATION), nativeActionId: z.string().min(1).max(200),
}).strict();
export function isOperatorApplicationAction(action: PlanAction): boolean {
  const parsed = operatorApplicationActionMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.id === parsed.data.nativeActionId && action.verified
    && (parsed.data.mode === 'prepare' ? ['create', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true)
      : parsed.data.mode === 'recover' && action.type === 'update' && !action.requiresConfirm && !action.billable);
}
