import type { PlanAction } from './plan.types.js';
import { isProviderNativeDeploySourceAction } from '../services/provider-native-deploy-source.service.js';
import { resolvePlanActionAuthority } from './action-authority.js';

/** Existing accepted CI contracts may receive credentials before recovery runs. */
export function isManagedCiCredentialAction(action: PlanAction): boolean {
  if (!['create', 'update'].includes(action.type) || !action.verified
    || action.metadata?.blockedReason || action.metadata?.workflowPublicationRequired === true) return false;
  const capability = resolvePlanActionAuthority(action)?.capability;
  return capability === 'github.ci.sync' || capability === 'ci.variable.sync';
}

/** A successful prerequisite apply proves its stage, never an application release. */
export function deploymentPrerequisitePhase(plan: { scope?: string; actions: PlanAction[] }): string | undefined {
  if (plan.scope && plan.scope !== 'full') return plan.scope;
  if (plan.actions.length && plan.actions.every(isProviderNativeDeploySourceAction)) return 'deploy-source';
  if (plan.actions.some(action => String(action.metadata?.operation ?? '').startsWith('maintenance'))) return 'maintenance';
  if (plan.actions.some(action => String(action.metadata?.operation ?? '').startsWith('dataMigration'))) return 'data-migration';
  return undefined;
}
