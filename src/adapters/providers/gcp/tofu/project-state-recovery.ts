import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../../../domain/plan/plan.types.js';

export const bootstrapProjectAddress = 'google_project.hypervibe';
export interface ObservedUnlinkedProject {
  projectId: string;
  projectNumber: string;
  scope: string;
}
export interface ObservedLinkedProject extends ObservedUnlinkedProject { billingAccountName: string }
export interface RecoveryBinding extends ObservedUnlinkedProject { selectedAccount: string; intent: string }
export interface GcpProjectRecovery {
  token: string;
  projectId: string;
  projectNumber: string;
  previousPlanId: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function selectedProjectBilling(configuration: EngineConfiguration, projectId: string): string | undefined {
  const bootstrap = record(configuration.files['bootstrap.tf.json']);
  const project = record(record(record(bootstrap.resource).google_project).hypervibe);
  if (project.project_id === projectId && project.deletion_policy === 'PREVENT'
    && record(project.lifecycle).prevent_destroy === true && typeof project.billing_account === 'string' && project.billing_account) return project.billing_account;
}

/** OpenTofu can emit the current and a deposed instance at the same address. */
export function matchesProjectInstance(document: unknown, observed: ObservedUnlinkedProject, tainted: boolean): boolean {
  const rows = record(record(record(document).values).root_module).resources;
  if (!Array.isArray(rows)) return false;
  const matches = rows.map(record).filter(row => row.address === bootstrapProjectAddress);
  if (matches.length !== 1) return false;
  const row = matches[0]!;
  const values = record(row.values);
  return row.mode === 'managed' && row.type === 'google_project' && row.name === 'hypervibe'
    && row.provider_name === 'registry.opentofu.org/hashicorp/google'
    && !('index' in row) && !('deposed_key' in row)
    && (tainted ? row.tainted === true : (row.tainted === undefined || row.tainted === false))
    && values.id === `projects/${observed.projectId}` && values.project_id === observed.projectId
    && (values.number == null || values.number === observed.projectNumber)
    && values.deletion_policy === 'PREVENT' && values.billing_account === '';
}

/** This setup owns one project. Its own action must identify exactly that instance. */
export function soleProjectAction(actions: PlanAction[]): PlanAction | undefined {
  const matching = actions.filter(action => action.id === 'project-setup:' + bootstrapProjectAddress
    || engineSegmentOf(action)?.addresses.some(address => address.startsWith('google_project.')));
  if (matching.length !== 1) return;
  const action = matching[0]!;
  const addresses = engineSegmentOf(action)?.addresses;
  if (action.verified && action.id === 'project-setup:' + bootstrapProjectAddress
    && !action.metadata?.engineAdopt && addresses?.length === 1 && addresses[0] === bootstrapProjectAddress) return action;
}

export function isInPlaceBillingUpdate(actions: PlanAction[]): boolean {
  const project = soleProjectAction(actions);
  return project?.type === 'update' && !!project.diff?.some(change => change.field === 'google_project.billing_account');
}

/** Inspect the private OpenTofu plan in memory. Only the verdict reaches the setup report. */
export function verifyBootstrapBillingPlan(
  document: unknown, projectId: string, selectedAccount: string | undefined, observed?: ObservedUnlinkedProject,
  alreadyLinked = false,
): boolean {
  const changes = record(document).resource_changes;
  if (!Array.isArray(changes)) return !observed && changes === undefined;
  const projects = changes.map(record).filter(row => row.mode !== 'data' && (row.type === 'google_project' || row.address === bootstrapProjectAddress));
  if (!observed) {
    // After an interrupted local recovery there may be no saved billing preview yet.
    // Relinking an unbilled project still requires live project and billing evidence.
    return !projects.some(row => {
      const change = record(row.change);
      return Array.isArray(change.actions) && change.actions.includes('update') && record(change.before).billing_account === ''
        && (record(change.after).billing_account !== '' || record(change.after_unknown).billing_account === true || change.after_unknown === true);
    });
  }
  if (observed.projectId !== projectId || typeof observed.projectNumber !== 'string' || !/^[1-9]\d*$/.test(observed.projectNumber)
    || !observed.scope?.trim() || !selectedAccount || projects.length !== 1) return false;
  const row = projects[0]!;
  if (row.address !== bootstrapProjectAddress || row.mode !== 'managed' || row.type !== 'google_project' || row.name !== 'hypervibe'
    || row.provider_name !== 'registry.opentofu.org/hashicorp/google' || 'index' in row || 'deposed' in row || 'previous_address' in row) return false;
  const change = record(row.change);
  const before = record(change.before);
  const after = record(change.after);
  const unknown = record(change.after_unknown);
  const known = (field: string) => unknown[field] === undefined || unknown[field] === false;
  return Array.isArray(change.actions) && change.actions.length === 1 && change.actions[0] === (alreadyLinked ? 'no-op' : 'update')
    && !change.importing && change.after_unknown !== true && known('billing_account') && known('id') && known('project_id')
    && before.id === `projects/${projectId}` && after.id === before.id && before.project_id === projectId && after.project_id === projectId
    && before.number === observed.projectNumber && (after.number == null || after.number === observed.projectNumber)
    && before.deletion_policy === 'PREVENT' && after.deletion_policy === 'PREVENT' && known('deletion_policy')
    && before.billing_account === (alreadyLinked ? selectedAccount : '') && after.billing_account === selectedAccount;
}

export function matchesRecoveryObservation(binding: RecoveryBinding, observation: ObservedUnlinkedProject | undefined): boolean {
  return !!observation && observation.projectId === binding.projectId && observation.scope === binding.scope
    && observation.projectNumber === binding.projectNumber;
}
