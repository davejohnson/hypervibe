import type { PlanAction } from './plan.types.js';

/** Both the persisted marker and the caller's exact action id grant authority. */
export function hasExactPlanActionConfirmationAuthority(
  action: PlanAction,
  confirmationRequired: boolean,
  confirmedActionIds: ReadonlySet<string>
): boolean {
  return !confirmationRequired || (action.requiresConfirm === true && confirmedActionIds.has(action.id));
}
