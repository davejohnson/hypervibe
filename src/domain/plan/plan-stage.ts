import type { PlanAction } from './plan.types.js';
import { isProviderNativeDeploySourceAction } from '../services/provider-native-deploy-source.service.js';
import { resolvePlanActionAuthority } from './action-authority.js';

/** A successful prerequisite apply proves its stage, never an application release. */
export function deploymentPrerequisitePhase(plan: { scope?: string; actions: PlanAction[] }): string | undefined {
  if (plan.scope && plan.scope !== 'full') return plan.scope;
  if (plan.actions.length && plan.actions.every(isProviderNativeDeploySourceAction)) return 'deploy-source';
  if (plan.actions.some(action => String(action.metadata?.operation ?? '').startsWith('maintenance'))) return 'maintenance';
  if (plan.actions.some(action => String(action.metadata?.operation ?? '').startsWith('dataMigration'))) return 'data-migration';
  return undefined;
}

/** Provider writes that can release code, restart workloads, or admit traffic. */
export function actionRequiresBackupReadiness(action: PlanAction): boolean {
  if (action.type === 'noop') return false;
  const capability = resolvePlanActionAuthority(action)?.capability;
  return Boolean(capability && [
    'hosting.service.converge', 'hosting.delegated-secret.sync', 'hosting.env.remove',
    'stripe.hosting-env.sync', 'cache.env.remove', 'email.runtime.sync', 'messaging.runtime.sync',
    'database.seed', 'database.migrate', 'github.ci.release',
    'github.applied-spec-hash.sync', 'ci.applied-spec-hash.sync',
    'domain.configure', 'load-balancer.mutate', 'load-balancer.pool.mutate',
  ].includes(capability)) || ['storageWire', 'storageUnwire', 'queueWire', 'queueUnwire'].includes(String(action.metadata?.operation));
}
