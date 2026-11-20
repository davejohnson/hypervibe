import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from '../../domain/entities/run.entity.js';
import { makePlanReport, type ReportCloudTarget } from '../../domain/plan/plan-report.js';
import { getDb } from '../db/sqlite.adapter.js';
import { ProjectRepository } from '../db/repositories/project.repository.js';
import { planReportPath, writePlanReport } from './write-plan-report.js';

export { findSavedSetupReport } from './gcp-setup-report.js';

let memoryReports: string | undefined;
function reportDirectory(): string {
  const db = getDb();
  if (db.memory) return memoryReports ??= mkdtempSync(path.join(tmpdir(), 'hypervibe-plan-reports-'));
  return path.resolve(path.dirname(db.name), 'reports');
}

export function runPlanReportPath(runId: string): string {
  return planReportPath(reportDirectory(), runId);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function savedTarget(engine: Record<string, unknown> | undefined): { target?: string; cloudTarget?: ReportCloudTarget } {
  const aws = engine?.aws as Record<string, unknown> | undefined;
  const azure = engine?.azure as Record<string, unknown> | undefined;
  const stateProvider = (engine?.state as { provider?: unknown } | undefined)?.provider;
  const gcpProject = engine?.gcpProjectId;
  const account = aws?.accountId ?? engine?.accountId;
  const subscription = azure?.subscriptionId ?? engine?.subscriptionId;
  const target = optionalString(gcpProject ?? aws?.accountId ?? azure?.subscriptionId ?? account ?? subscription);
  // Older plans sometimes stored only a bare target. Show it as text when the provider is ambiguous.
  const providersWithTargets = [gcpProject, account, subscription].filter(id => id != null);
  const conflictingLegacyId = [engine?.accountId, engine?.subscriptionId].some(id => id != null && id !== target);
  if (!target || providersWithTargets.length !== 1 || conflictingLegacyId) return { target };
  if (gcpProject && (stateProvider == null || stateProvider === 'gcp')) {
    return { target, cloudTarget: { provider: 'gcp', projectId: target } };
  }
  if (account && (stateProvider === 'aws' || (stateProvider == null && aws?.accountId))) {
    return { target, cloudTarget: { provider: 'aws', accountId: target,
      region: optionalString(aws?.region ?? engine?.region), partition: optionalString(aws?.partition) } };
  }
  if (subscription && (stateProvider === 'azure' || (stateProvider == null && azure?.subscriptionId))) {
    return { target, cloudTarget: { provider: 'azure', subscriptionId: target,
      resourceGroup: optionalString(azure?.resourceGroup ?? engine?.resourceGroup), tenantId: optionalString(azure?.tenantId) } };
  }
  return { target };
}

export function writeRunPlanReport(run: Run): { htmlPath: string } {
  const document = run.plan as Record<string, unknown>;
  if (run.type !== 'plan' || document.kind !== 'hv_plan') throw new Error('This run does not contain a saved infrastructure plan.');
  const project = new ProjectRepository().findById(run.projectId);
  const engine = document.engine as Record<string, unknown> | undefined;
  const aws = engine?.aws as { accountId?: unknown } | undefined;
  // Older engine plans omitted the confirmation list. AWS teardown requested every action ID.
  const savedConfirm = document.reviewConfirmActions;
  const confirmActions = Array.isArray(savedConfirm) && savedConfirm.every(id => typeof id === 'string')
    ? savedConfirm : (document.scope === 'infrastructure-engine' && engine?.teardown === true && aws ? 'all' : undefined);
  const blockers = Array.isArray(document.reviewBlockers) ? [...document.reviewBlockers] : [];
  if (Array.isArray(document.inputRequired)) {
    for (const requirement of document.inputRequired) {
      if (requirement && typeof requirement.key === 'string') blockers.push(`Supply a value for ${requirement.key} before applying.`);
    }
  }
  return writePlanReport(reportDirectory(), makePlanReport({
    planId: run.id, project: project?.name ?? run.projectId, createdAt: run.createdAt.toISOString(),
    environment: typeof document.environmentName === 'string' ? document.environmentName : undefined,
    ...savedTarget(engine),
    scope: typeof document.scope === 'string' ? document.scope : 'full',
    actions: document.actions, confirmActions, blocked: blockers, warnings: document.warnings,
  }));
}
