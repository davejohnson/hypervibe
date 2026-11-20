import { gcpInfrastructureNotes } from '../domain/plan/gcp-infrastructure-notes.js';
import type { PlanReport } from '../domain/plan/plan-report.js';

// Recognize only the complete database summary recorded by the planner. If it
// gains a new qualification, keep the full message visible as a warning.
const databaseSummary = /^Database: (?:shared CPU|\d+ vCPU), \d+(?:\.\d+)? GB, about US\$\d+ a month plus storage\. New databases start with \d+ daily backups and \d+ days of point-in-time recovery; existing backup and recovery settings are preserved\. Deletion protection is (?:on|off)\.$/;
const setupKinds = new Set(['database', 'cache', 'service', 'secret', 'storage']);

export function groupPlanNotices(report: PlanReport) {
  const warnings: string[] = [];
  const costs: string[] = [];
  const next: string[] = [];
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
