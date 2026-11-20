import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makePlanReport, type PlanReport } from '../../domain/plan/plan-report.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import { engineStatePaths } from '../engine/opentofu/workspace.js';
import { getDataDir, hardenPrivateFile, PRIVATE_FILE_MODE } from './paths.js';
import { writePlanReport } from './write-plan-report.js';

const setupId = /^setup-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const intentFile = /^setup-([a-f0-9]{64})\.json$/;

type SetupScope = { projectId: string; gcpProjectId: string; projectName?: string; dataDir?: string };
interface ReportSource {
  planId: string;
  setupPurpose?: PlanReport['setupPurpose'];
  projectName?: string;
  createdAt?: string;
  planned: { actions: unknown; blockers?: unknown };
  configuration: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Check every directory inside the configured data root before reading, writing or creating setup files. */
export function setupPlansDirectory({ projectId, gcpProjectId, dataDir = getDataDir() }: SetupScope): string {
  const base = path.resolve(dataDir);
  const { plans } = engineStatePaths({ provider: 'gcp', projectId, environmentId: gcpProjectId, partition: 'project-shared' }, base);
  let current = base;
  for (const component of ['', ...path.relative(base, plans).split(path.sep)]) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('Google Cloud setup reports require a regular private state directory.');
  }
  return plans;
}

function setupReport(scope: SetupScope, source: ReportSource): PlanReport {
  if (!setupId.test(source.planId) || !Array.isArray(source.planned?.actions)) {
    throw new Error('The saved Google Cloud setup plan is incomplete.');
  }
  const report = makePlanReport({
    planId: source.planId, project: source.projectName ?? scope.projectName ?? scope.projectId,
    target: scope.gcpProjectId, cloudTarget: { provider: 'gcp', projectId: scope.gcpProjectId },
    scope: 'Google Cloud project setup', createdAt: source.createdAt,
    actions: source.planned.actions, blocked: source.planned.blockers, approval: 'whole-plan',
    setupPurpose: source.setupPurpose,
  });
  if (report.actions.length !== source.planned.actions.length) throw new Error('The saved Google Cloud setup actions could not be read.');

  const changed = new Map(report.actions.filter(action => action.type !== 'noop')
    .flatMap(action => action.addresses.map(address => [address, action] as const)));
  const documents = Object.values(record(record(source.configuration).files));
  for (const document of documents) {
    const resources = record(record(document).resource);
    const project = record(record(resources.google_project).hypervibe);
    if (project.project_id === scope.gcpProjectId && typeof project.billing_account === 'string'
      && /^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(project.billing_account)) {
      report.billingAccount = project.billing_account;
    }
    for (const [address, action] of changed) {
      const match = /^(google_[a-z0-9_]+)\.([A-Za-z0-9_-]+)$/.exec(address);
      if (!match || action.type === 'destroy') continue;
      const resource = record(record(resources[match[1]])[match[2]]);
      const prerequisites = new Set<string>(Array.isArray(resource.depends_on)
        ? resource.depends_on.filter((entry): entry is string => typeof entry === 'string') : []);
      // Setup emits a few whole-attribute references, including the build bucket's name.
      // Only a literal template traversal of a resource attribute proves this edge.
      for (const field of ['bucket', 'project', 'service_account_id', 'workload_identity_pool_id']) {
        const value = resource[field];
        const reference = typeof value === 'string' && /^\$\{(google_[a-z0-9_]+\.[A-Za-z0-9_-]+)\.[a-z_]+\}$/.exec(value);
        if (reference) prerequisites.add(reference[1]);
      }
      for (const prerequisite of prerequisites) {
        const parent = changed.get(prerequisite);
        if (parent && parent.type !== 'destroy' && parent.id !== action.id && !action.dependsOn.includes(parent.id)) {
          action.dependsOn.push(parent.id);
        }
      }
    }
  }
  return report;
}

// A checksum binds the saved display model to its local owner. It detects damaged or
// misplaced reports; confirmation always reads the engine's original intent manifest.
function checksum(projectId: string, report: PlanReport): string {
  return createHash('sha256').update(JSON.stringify([projectId, report])).digest('hex');
}

export function saveSetupReport(scope: SetupScope, source: ReportSource, redact: string[] = []): { htmlPath: string } {
  const directory = setupPlansDirectory(scope);
  const report = redactExactValues(setupReport(scope, source), redact);
  const file = path.join(directory, `${source.planId}.report.json`);
  hardenPrivateFile(file);
  const rendered = writePlanReport(directory, report);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ projectId: scope.projectId, checksum: checksum(scope.projectId, report), report }),
      { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return rendered;
}

function readStoredJson(file: string): Record<string, unknown> | undefined {
  if (!hardenPrivateFile(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  // A JSON syntax error can include bytes from a private configuration.
  try { return record(JSON.parse(content)); } catch { return; }
}

function storedReport(directory: string, scope: SetupScope, planId: string): PlanReport | undefined {
  if (!setupId.test(planId)) return;
  const snapshot = readStoredJson(path.join(directory, `${planId}.report.json`));
  const report = snapshot?.report as PlanReport | undefined;
  if (snapshot?.projectId === scope.projectId && report?.planId === planId && report.target === scope.gcpProjectId
    && snapshot.checksum === checksum(scope.projectId, report)) return report;
}

/** Preserve display data before a new preview replaces the previous intent manifest. */
export function preserveSetupReport(scope: SetupScope, source: ReportSource, redact: string[]): void {
  if (!storedReport(setupPlansDirectory(scope), scope, source.planId)) saveSetupReport(scope, source, redact);
}

export function findSavedSetupReport(projectId: string, gcpProjectId: string, planId: string, projectName?: string, dataDir?: string): { htmlPath: string } | undefined {
  if (!setupId.test(planId) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProjectId)) return;
  const scope = { projectId, gcpProjectId, projectName, dataDir };
  const directory = setupPlansDirectory(scope);
  if (!fs.existsSync(directory)) return;
  const report = storedReport(directory, scope, planId);
  if (report) return writePlanReport(directory, { ...report, approval: 'whole-plan',
    cloudTarget: { provider: 'gcp', projectId: gcpProjectId },
    actions: report.actions.map(action => ({ ...action, requiresConfirm: false })) });

  // Older releases keyed their current approval by intent. Search only those
  // manifests in this exact state partition, never a latest plan or another project.
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const intent = intentFile.exec(entry.name)?.[1];
    if (!intent || !entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    const saved = readStoredJson(file);
    if (saved?.planId !== planId || saved.intent !== intent) continue;
    return saveSetupReport(scope, {
      planId, planned: { actions: record(saved.planned).actions, blockers: record(saved.planned).blockers },
      setupPurpose: saved.setupPurpose === 'railway-transfer' || saved.setupPurpose === 'railway-transfer-isolation'
        ? saved.setupPurpose : undefined,
      configuration: saved.configuration, projectName: typeof saved.projectName === 'string' ? saved.projectName : undefined,
      createdAt: typeof saved.createdAt === 'string' ? saved.createdAt : fs.statSync(file).mtime.toISOString(),
    });
  }
}
