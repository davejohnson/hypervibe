import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { makePlanReport, transferAccessCheckScope, transferFileAccessCheckScope } from '../../domain/plan/plan-report.js';
import type { AccessProbeFileEvidence } from '../providers/gcp/gcp-transfer-probe-workload.js';
import type { TransferResources } from '../providers/gcp/gcp-data.client.js';
import type { DestroyedProbeVersion } from '../providers/gcp/gcp-transfer-slot-evidence.js';
import type { ProbeObject, ProbeVersion } from '../providers/gcp/gcp-transfer-probe-fixtures.js';
import { transferSlot } from '../providers/gcp/tofu/transfer-slot.js';
import type { TransferIsolationScope } from '../providers/gcp/tofu/transfer-isolation.js';
import { setupPlansDirectory } from './gcp-setup-report.js';
import { hardenPrivateFile } from './paths.js';
import { writePlanReport } from './write-plan-report.js';

export interface ProbePlan {
  planId: string;
  /** Earlier plans cover both the copy and app accounts. */
  fileOnly?: boolean;
  createdAt: string;
  projectId: string;
  projectName: string;
  sourceName: string;
  scope: TransferIsolationScope;
  deployEmail: string;
  evidenceDigest: string;
  inventoryDigest: string;
  softDeleteSeconds: number;
  workloadDigest: string;
  objectName: string;
  actions: PlanAction[];
}
export interface ProbeRun {
  status: 'ready' | 'running' | 'passed' | 'failed';
  finishedAt?: string;
  marker?: string;
  pending?: 'object' | 'version';
  object?: ProbeObject;
  version?: ProbeVersion;
  job?: TransferResources;
  operatorReadVerified?: boolean;
  fileEvidence?: AccessProbeFileEvidence;
  copyPassed?: boolean;
  appPassed?: boolean;
  destroyed?: DestroyedProbeVersion;
}
export const probeIdPattern = /^probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function probeDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function probeActions(plan: Omit<ProbePlan, 'actions'>): PlanAction[] {
  const { scope } = plan;
  const action = (
    id: string,
    type: PlanAction['type'],
    kind: PlanAction['resource']['kind'],
    name: string,
    reason: string,
    dependsOn: string[] = [],
  ): PlanAction => ({
    id,
    type,
    resource: { kind, name, provider: kind === 'service' ? 'cloudrun' : 'gcp' },
    reason,
    dependsOn,
    verified: true,
    requiresConfirm: true,
    billable: type === 'create',
  });
  const retention = plan.softDeleteSeconds
    ? ` Google keeps the deleted file recoverable for ${plan.softDeleteSeconds / 86400} days.`
    : '';
  if (plan.fileOnly) {
    return [
      action(
        'file', 'create', 'storage', 'Create and verify one disposable export file',
        `Write random test bytes to gs://${scope.bucket}/${plan.objectName}. Read back the exact uploaded generation to verify its contents before testing the app.`,
      ),
      action(
        'app', 'create', 'service', 'Run one temporary job as the app',
        `Use ${scope.runtimeEmail} to request this file generation directly. Check whether Google denies the app access.`,
        ['file'],
      ),
      action(
        'cleanup', 'destroy', 'maintenance', 'Remove the job and the test file',
        `Remove the temporary app job and delete the exact file generation, including after a failed test.${retention}`,
        ['app'],
      ),
    ];
  }
  const slot = transferSlot(scope.target);
  return [
    action(
      'file',
      'create',
      'storage',
      'Create one disposable export file',
      `For the move from ${plan.sourceName} to ${scope.targetEnvironmentName}, write random test text to gs://${scope.bucket}/${plan.objectName}.`,
    ),
    action(
      'version',
      'create',
      'secret',
      `Add a test version to ${slot.secretId}`,
      `Store a test marker and a 15-minute download link for this one file. The version contains no Railway credentials or customer data.`,
      ['file'],
    ),
    action(
      'copy',
      'create',
      'service',
      'Run a short-lived job as the copy account',
      `Use ${slot.accountEmail} to read the test version and download the expected file contents through its link.`,
      ['version'],
    ),
    action(
      'app',
      'create',
      'service',
      'Run a short-lived job as the app',
      `Use ${scope.runtimeEmail} to request the same secret version and file directly. Both reads must return permission denied.`,
      ['copy'],
    ),
    action(
      'cleanup',
      'destroy',
      'maintenance',
      'Clean up the two jobs and the test data',
      `Remove the temporary jobs, destroy the test version and delete the test file. Google keeps a record of the destroyed version.${retention} A failed or interrupted check still requires cleanup.`,
      ['app'],
    ),
  ];
}
function directory(projectId: string, gcpProjectId: string) {
  return setupPlansDirectory({ projectId, gcpProjectId });
}
function database(projectId: string, gcpProjectId: string, create: boolean) {
  const file = path.join(directory(projectId, gcpProjectId), 'access-probes.sqlite');
  if (!hardenPrivateFile(file)) {
    if (!create) return;
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  const db = new Database(file, { readonly: !create, fileMustExist: true });
  if (create)
    db.exec(
      'CREATE TABLE IF NOT EXISTS probes (id TEXT PRIMARY KEY, slot TEXT NOT NULL, plan TEXT NOT NULL, run TEXT NOT NULL, digest TEXT NOT NULL)',
    );
  return db;
}
export function decodeProbe(raw: unknown, projectId: string, gcpProjectId: string) {
  if (!raw) return;
  const row = raw as { id: string; slot: string; plan: string; run: string; digest: string };
  if (probeDigest([row.plan, row.run]) !== row.digest) throw new Error('The saved access check is damaged.');
  const plan = JSON.parse(row.plan) as ProbePlan,
    run = JSON.parse(row.run) as ProbeRun;
  if (
    plan.projectId !== projectId ||
    plan.scope.target.projectId !== gcpProjectId ||
    plan.planId !== row.id ||
    (plan.fileOnly !== undefined && typeof plan.fileOnly !== 'boolean') ||
    !probeIdPattern.test(row.id) ||
    row.slot !== transferSlot(plan.scope.target).secretId
  )
    throw new Error('The saved access check belongs to a different target.');
  return { plan, run };
}
export function loadProbe(projectId: string, gcpProjectId: string, planId: string) {
  if (!probeIdPattern.test(planId)) return;
  const db = database(projectId, gcpProjectId, false);
  try {
    return decodeProbe(db?.prepare('SELECT * FROM probes WHERE id=?').get(planId), projectId, gcpProjectId);
  } finally {
    db?.close();
  }
}
export function probeHistory(projectId: string, gcpProjectId: string, slot: string) {
  const db = database(projectId, gcpProjectId, false);
  try {
    return (db?.prepare('SELECT * FROM probes WHERE slot=? ORDER BY id').all(slot) ?? []).map((row) =>
      decodeProbe(row, projectId, gcpProjectId)!,
    );
  } finally {
    db?.close();
  }
}
export function readDestroyedTransferProbeVersions(
  projectId: string,
  gcpProjectId: string,
  slot: string,
): DestroyedProbeVersion[] {
  return probeHistory(projectId, gcpProjectId, slot).flatMap(({ run }) => (run.destroyed ? [run.destroyed] : []));
}
export function storeProbe(plan: ProbePlan, run: ProbeRun, create = false) {
  const db = database(plan.projectId, plan.scope.target.projectId, true)!;
  try {
    const p = JSON.stringify(plan),
      r = JSON.stringify(run),
      digest = probeDigest([p, r]);
    if (create)
      db.prepare('INSERT INTO probes VALUES (?,?,?,?,?)').run(
        plan.planId,
        transferSlot(plan.scope.target).secretId,
        p,
        r,
        digest,
      );
    else if (
      db.prepare('UPDATE probes SET run=?,digest=? WHERE id=? AND plan=?').run(r, digest, plan.planId, p).changes !== 1
    )
      throw new Error('The approved access check is missing.');
  } finally {
    db.close();
  }
}
export function findTransferAccessProbeReport(projectId: string, gcpProjectId: string, planId: string) {
  const saved = loadProbe(projectId, gcpProjectId, planId);
  if (!saved) return;
  const { plan } = saved;
  return writePlanReport(
    directory(projectId, gcpProjectId),
    makePlanReport({
      planId,
      scope: plan.fileOnly ? transferFileAccessCheckScope : transferAccessCheckScope,
      project: plan.projectName,
      environment: plan.scope.targetEnvironmentName,
      target: gcpProjectId,
      cloudTarget: { provider: 'gcp', projectId: gcpProjectId },
      createdAt: plan.createdAt,
      approval: 'whole-plan',
      actions: plan.actions,
    }),
  );
}
/** Share the OS-backed lock with ordinary setup. Probe progress commits to its own journal before each remote action. */
export async function withProbeLock<T>(projectId: string, gcpProjectId: string, work: () => Promise<T>) {
  const file = path.join(path.dirname(directory(projectId, gcpProjectId)), 'setup-lock.sqlite');
  if (!hardenPrivateFile(file)) throw new Error('Restore the original private project setup before checking access.');
  const db = new Database(file, { timeout: 0, fileMustExist: true });
  try {
    db.exec('BEGIN EXCLUSIVE');
    return await work();
  } finally {
    db.close();
  }
}
