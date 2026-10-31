import { z } from 'zod';
import type { CloudInstallationDriver, CloudInstallationEvidence, CloudInstallationRecord, LocalCloudScopePreparationAuthentication, LocalCloudScopePreparationIntent } from './cloud-installation.port.js';
import type { CloudDeploymentPreparedResourcesV1, CloudDeploymentRuntimeIdentityV1, CloudDeploymentTopologyV1 } from './cloud-deployment.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';

/** Verified local administration is never a hosted deployment grant. */
export interface LocalPreparedHostingReceiptV1 {
  schemaVersion: 1;
  purpose: 'local-holding';
  installationId: string;
  planDigest: string;
  appId: string;
  environment: string;
  source: LocalCloudScopePreparationIntent['source'];
  provider: 'gcp' | 'aws' | 'azure';
  hostingProvider: string;
  nativeScope: Record<string, string>;
  deployment: CloudDeploymentTopologyV1;
  preparedResources: CloudDeploymentPreparedResourcesV1;
  runtimeIdentities: CloudDeploymentRuntimeIdentityV1[];
  origins: Record<string, string>;
  /** Immutable native creation/owned-grant receipts, excluding all response bodies. */
  creationProofs: Record<string, CloudInstallationEvidence>;
}
export interface LocalHoldingPreparationCapability {
  schemaVersion: 1;
  provider: 'gcp' | 'aws' | 'azure';
  parseDeclaration(input: { environment: EnvironmentSpec; bindings: Record<string, unknown>; publication: Record<string, string> }): Record<string, string>;
  parseRecord(value: unknown): CloudInstallationRecord<LocalCloudScopePreparationIntent>;
  create(nativeScope: Record<string, string>): Promise<{ driver: CloudInstallationDriver<LocalCloudScopePreparationIntent>; authentication: LocalCloudScopePreparationAuthentication }>;
  receipt(record: CloudInstallationRecord<LocalCloudScopePreparationIntent>): LocalPreparedHostingReceiptV1;
  /** Fresh native origin/public access and immutable runtime principal proof.
   * This grants neither application release nor registration authority. */
  verifyOperatorOrigin?(receipt: LocalPreparedHostingReceiptV1, selection: { service: string; runtimeService: string }): Promise<{
    origin: string; runtimeIdentity: CloudDeploymentRuntimeIdentityV1['principal'];
  }>;
}
export const LOCAL_HOLDING_OPERATION = 'localHoldingPreparation';
export const localHoldingPlanSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().guid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/), provider: z.string().min(1).max(100),
  mode: z.enum(['prepare', 'recover', 'bind']),
  retryActions: z.array(z.object({ actionId: z.string().min(1).max(255), attemptId: z.string().guid() }).strict()).length(1).optional(),
}).strict();
export type LocalHoldingPlan = z.infer<typeof localHoldingPlanSchema>;
export const localHoldingActionMetadataSchema = localHoldingPlanSchema.extend({ operation: z.literal(LOCAL_HOLDING_OPERATION), nativeActionId: z.string().min(1).max(255) }).strict();
export function isLocalHoldingAction(action: PlanAction): boolean {
  const parsed = localHoldingActionMetadataSchema.safeParse(action.metadata);
  return parsed.success && action.id === parsed.data.nativeActionId && action.verified && (parsed.data.mode === 'recover'
    ? action.type === 'update' && !action.requiresConfirm && !action.billable && !action.dataBearing
    : ['create', 'update', 'noop'].includes(action.type) && (action.type === 'noop' || action.requiresConfirm === true));
}
