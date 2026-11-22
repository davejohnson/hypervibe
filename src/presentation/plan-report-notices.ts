import { gcpInfrastructureNotes, railwayTransferIsolationNote, railwayTransferSetupNote } from '../domain/plan/gcp-infrastructure-notes.js';
import { transferAccessCheckScope, transferFileAccessCheckScope, type PlanReport } from '../domain/plan/plan-report.js';

// Recognize only the complete database summary recorded by the planner. If it
// gains a new qualification, keep the full message visible as a warning.
const databaseSummary = /^Database: (?:shared CPU|\d+ vCPU), \d+(?:\.\d+)? GB, about US\$\d+ a month plus storage\. New databases start with \d+ daily backups and \d+ days of point-in-time recovery; existing backup and recovery settings are preserved\. Deletion protection is (?:on|off)\.$/;
const setupKinds = new Set(['database', 'cache', 'service', 'secret', 'storage']);
// Archived setup reports saved this exact explanation as a warning.
const legacyTransferWarning = 'Hypervibe will leave this secret empty. Before adding credentials, verify that the app cannot read them through a project-wide or inherited grant. The data copy is a separate step.';

export function groupPlanNotices(report: PlanReport) {
  const warnings: string[] = [];
  const costs: string[] = [];
  const next: string[] = [];
  if (report.scope === transferAccessCheckScope || report.scope === transferFileAccessCheckScope) {
    const cleanup = report.actions.find(action => action.id === 'cleanup')?.reason;
    next.push(report.scope === transferFileAccessCheckScope
      ? 'This plan creates one disposable export file and checks its contents. One temporary Cloud Run job then tries to download that same file directly as the app account. The check passes only if Google denies the app permission to read the file and cleanup succeeds. Google Cloud may charge for the job, requests and storage.'
      : 'This plan runs two temporary Cloud Run jobs with test data. The copy account must read the test secret and use its short-lived link to download the file. The app must be denied direct access to both. Google Cloud may charge for the jobs and storage.');
    if (cleanup) next.push(cleanup);
    return { warnings: report.warnings, costs, next };
  }
  if (report.scope === 'Google Cloud project setup' && report.setupPurpose === 'railway-bucket-copy') {
    return { warnings: report.warnings, costs, next: [
      'Hypervibe will prepare an unscheduled copy job and give its account permission to read and add objects in the selected destination bucket. Existing documents are preserved.',
      'A separate approval is required to pass Railway credentials to the job and start copying documents. Google Cloud charges for the job when it runs.',
    ] };
  }
  if (report.scope === 'Google Cloud project setup' && report.setupPurpose === 'railway-transfer-isolation') {
    return { warnings: report.warnings, costs, next: [railwayTransferIsolationNote] };
  }
  if (report.scope === 'Google Cloud project setup' && (report.setupPurpose === 'railway-transfer'
    || report.actions.some(action => action.id.startsWith('transfer-slot:') && action.type !== 'noop'))) {
    const secrets = report.actions.filter(action => action.kind === 'secret' && action.id.startsWith('transfer-slot:secret:'));
    const detail = secrets.length === 1 ? { index: report.actions.indexOf(secrets[0]!), label: 'View the secret in this plan' } : undefined;
    return { warnings: report.warnings.filter(message => message !== legacyTransferWarning), costs, next: [railwayTransferSetupNote], detail };
  }
  if (report.scope !== 'infrastructure-engine' || !report.warnings.includes(gcpInfrastructureNotes.release)) {
    return { warnings: report.warnings, costs, next };
  }

  const prerequisites: string[] = [];
  const connections: string[] = [];
  for (const message of report.warnings) {
    if (message === gcpInfrastructureNotes.database) {
      prerequisites.push('creates the database login');
      connections.push('the database');
    } else if (message === gcpInfrastructureNotes.redis) {
      prerequisites.push('makes the Redis address available');
      connections.push('Redis');
    } else if (databaseSummary.test(message)) {
      costs.push(message.slice('Database: '.length).replace('; existing', '. Existing'));
    } else if (message !== gcpInfrastructureNotes.release) {
      warnings.push(message);
    }
  }
  if (connections.length) {
    next.push(`Once Hypervibe ${prerequisites.join(' and ')}, your coding agent prepares the plan to connect your app to ${connections.join(' and ')}. Your agent shows you any changes that need your approval before applying that plan.`);
  }
  // Other plans can update a live service or change where a domain sends traffic.
  const setupOnly = !warnings.length && !report.blocked.length && report.actions.length > 0
    && report.actions.every(action => action.provider === 'gcp' && action.type === 'create' && setupKinds.has(action.kind));
  next.push(setupOnly ? 'Releasing the app, copying production data and switching live traffic are separate steps.'
    : 'Releasing the app is a separate step.');
  return { warnings, costs, next };
}
