import { redactSensitiveString } from '../../utils/redact-sensitive-string.js';
import { requiresActionConfirmation, type PlanActionType } from './plan.types.js';

export const transferAccessCheckScope = 'Google Cloud transfer access check';
export const transferFileAccessCheckScope = 'Google Cloud export file access check';

export interface PlanReportAction {
  id: string;
  type: PlanActionType;
  kind: string;
  name: string;
  provider: string;
  fields: string[];
  dependsOn: string[];
  billable: boolean;
  dataBearing: boolean;
  requiresConfirm: boolean;
  verified: boolean;
  reason?: string;
  addresses: string[];
}

export type ReportCloudTarget =
  | { provider: 'gcp'; projectId: string }
  | { provider: 'aws'; accountId: string; region?: string; partition?: string }
  | { provider: 'azure'; subscriptionId: string; resourceGroup?: string; tenantId?: string };

export interface PlanReport {
  planId: string;
  project: string;
  environment?: string;
  scope: string;
  setupPurpose?: 'railway-transfer' | 'railway-transfer-isolation';
  target?: string;
  cloudTarget?: ReportCloudTarget;
  billingAccount?: string;
  createdAt?: string;
  /** The complete setup preview receives one approval, independently of action IDs. */
  approval?: 'whole-plan';
  actions: PlanReportAction[];
  blocked: string[];
  warnings: string[];
}

const actionTypes = new Set<unknown>(['create', 'update', 'replace', 'destroy', 'noop']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function display(value: string): string {
  return redactSensitiveString(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted]');
}

// Keep only identifiers used for display and navigation. Native connection objects may carry credentials.
function displayCloudTarget(target: ReportCloudTarget): ReportCloudTarget {
  switch (target.provider) {
    case 'gcp': return { provider: 'gcp', projectId: display(target.projectId) };
    case 'aws': return { provider: 'aws', accountId: display(target.accountId),
      ...(target.region && { region: display(target.region) }), ...(target.partition && { partition: display(target.partition) }) };
    case 'azure': return { provider: 'azure', subscriptionId: display(target.subscriptionId),
      ...(target.resourceGroup && { resourceGroup: display(target.resourceGroup) }), ...(target.tenantId && { tenantId: display(target.tenantId) }) };
  }
}

function strings(value: unknown, format = display): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(format) : [];
}

// Older plan records embed unrestricted shell commands in these descriptions.
// The review can explain their effect without copying command arguments to disk.
function reviewMessage(value: string): string {
  if (value.startsWith('migrations.mode="releaseCommand" is set but no web service exists')) {
    return 'The migration release command has no web service to run it. Configure a service to run the migration.';
  }
  if (value.startsWith('migrations.mode="releaseCommand" is set to ')) {
    return 'A web service has an explicit release command. Check that it runs the configured migration.';
  }
  if (value.startsWith('Project runtime changes from ')) return 'Update the project runtime configuration.';
  return display(value);
}

function actionForReport(value: unknown, confirmIds: ReadonlySet<string> | 'all' | undefined): PlanReportAction | undefined {
  const action = record(value);
  const resource = record(action?.resource);
  if (!action || !actionTypes.has(action.type) || typeof action.id !== 'string'
    || typeof resource?.kind !== 'string' || typeof resource.name !== 'string' || typeof resource.provider !== 'string') return;
  const segment = record(record(action.metadata)?.engineSegment);
  const fields = Array.isArray(action.diff) ? action.diff.map(entry => record(entry)?.field) : [];
  // Raw field values, provider metadata, engine inputs and execution credentials never enter the renderer.
  const flags = { type: action.type as PlanActionType, billable: action.billable === true,
    dataBearing: action.dataBearing === true, requiresConfirm: action.requiresConfirm === true };
  const requiresConfirm = confirmIds === 'all' || (confirmIds?.has(action.id) ?? requiresActionConfirmation(flags));
  return {
    id: display(action.id), type: action.type as PlanActionType,
    kind: display(resource.kind), name: display(resource.name), provider: display(resource.provider),
    fields: strings(fields), dependsOn: strings(action.dependsOn), addresses: strings(segment?.addresses),
    billable: flags.billable, dataBearing: flags.dataBearing, requiresConfirm, verified: action.verified === true,
    ...(typeof action.reason === 'string' ? { reason: action.id === 'release-command:migrations'
      ? 'Run the configured release command before switching services to the new code.' : reviewMessage(action.reason) } : {}),
  };
}

export function makePlanReport(input: Omit<PlanReport, 'actions' | 'blocked' | 'warnings'> & {
  actions: unknown; blocked?: unknown; warnings?: unknown;
  confirmActions?: readonly string[] | 'all';
}): PlanReport {
  const warnings = strings(input.warnings, reviewMessage);
  const blocked = new Set(strings(input.blocked, reviewMessage));
  const actions: PlanReportAction[] = [];
  const source = Array.isArray(input.actions) ? input.actions : [];
  const confirmActions = input.approval === 'whole-plan' ? [] : input.confirmActions;
  const confirmIds = confirmActions === 'all' ? 'all' : confirmActions && new Set(confirmActions);
  for (const value of source) {
    const action = actionForReport(value, confirmIds);
    if (action) {
      actions.push(action);
      const blocker = record(record(value)?.metadata)?.blockedReason;
      if (typeof blocker === 'string' && blocker) blocked.add(`${action.name}: ${reviewMessage(blocker)}`);
    }
  }
  if (!Array.isArray(input.actions) || actions.length !== source.length) {
    warnings.push('The saved plan contains action data that this version cannot display. Review the original plan before applying.');
  }
  return {
    planId: input.planId, project: display(input.project), scope: display(input.scope),
    ...(input.environment ? { environment: display(input.environment) } : {}),
    ...(input.target ? { target: display(input.target) } : {}),
    ...(input.cloudTarget ? { cloudTarget: displayCloudTarget(input.cloudTarget) } : {}),
    ...(input.billingAccount ? { billingAccount: display(input.billingAccount) } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
    ...((input.setupPurpose === 'railway-transfer' || input.setupPurpose === 'railway-transfer-isolation')
      ? { setupPurpose: input.setupPurpose } : {}),
    actions, blocked: [...blocked], warnings,
  };
}
