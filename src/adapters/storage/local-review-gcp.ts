import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { makePlanReport, transferAccessCheckScope, transferFileAccessCheckScope, type PlanReport } from '../../domain/plan/plan-report.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import { matchingReviewEngineFiles } from './local-review-engine.js';
import { configurationDigest } from '../engine/opentofu/workspace.js';
import { transferSlot } from '../providers/gcp/tofu/transfer-slot.js';
import { probeWorkloadDigest } from '../providers/gcp/gcp-transfer-probe-workload.js';
import { setupReport, setupReportChecksum } from './gcp-setup-report.js';
import { decodeProbe, probeActions } from './transfer-access-probe.js';
import { evidenceDetails, files, nativeId, unreadableReview, reviewRecord, reviewJson, subdirectories, type NativeReviewArtifact } from './local-review-files.js';
import { regularReviewDatabase, reviewDigest, setupDataDigest, type readReviewHistory } from './review-authorization.js';

type ReviewHistory = ReturnType<typeof readReviewHistory>;
type Scope = {projectId:string; gcpProjectId:string};
type SavedSetup = Parameters<typeof setupReport>[1] & {
  intent:string; baseline:string; reviewContributionId?:string; requiresPlanId?:boolean; manifest:unknown;
  planned:{ok:boolean; actions:unknown[]; blockers:string[]; segment:{id:string; engine:string; planDigest:string; configurationDigest:string}};
  configuration:EngineConfiguration;
};

function reportArtifact(report: PlanReport, status: string): NativeReviewArtifact {
  return {id:report.planId,planId:report.planId,kind:'plan',title:report.scope,project:report.project,
    createdAt:report.createdAt,status,details:[],aliases:[],report};
}

function probeReviews(directory: string, {projectId,gcpProjectId}: Scope, wanted?: string): NativeReviewArtifact[] {
  const file = path.join(directory,'access-probes.sqlite');
  if (!regularReviewDatabase(file)) return [];
  const db = new Database(file,{readonly:true,fileMustExist:true});
  try {
    let damaged = false;
    const unavailable: NativeReviewArtifact[] = [];
    const records = db.prepare('SELECT * FROM probes').all().flatMap(row => {
      try {
        const saved = decodeProbe(row,projectId,gcpProjectId);
        if (!saved || !['ready','running','passed','failed'].includes(saved.run.status)
          || !Array.isArray(saved.plan.actions) || typeof saved.plan.projectName !== 'string'
          || typeof saved.plan.createdAt !== 'string' || (saved.run.finishedAt !== undefined && typeof saved.run.finishedAt !== 'string')) throw new Error();
        return [saved];
      } catch {
        // A damaged receipt may hide an active run. Keep this partition read-only.
        damaged = true;
        const id = reviewRecord(row).id;
        if (typeof id === 'string' && nativeId.test(id) && (!wanted || id === wanted)) unavailable.push(unreadableReview(id));
        return [];
      }
    });
    const activeSlots = new Set(records.filter(({run}) => run.status === 'running').map(({plan}) => transferSlot(plan.scope.target).id));
    const items: NativeReviewArtifact[] = [];
    for (const {plan,run} of records.filter(({plan}) => !wanted || plan.planId===wanted)) {
      try {
        const report = makePlanReport({planId:plan.planId,scope:plan.fileOnly ? transferFileAccessCheckScope : transferAccessCheckScope,
          project:plan.projectName,environment:plan.scope.targetEnvironmentName,target:gcpProjectId,cloudTarget:{provider:'gcp',projectId:gcpProjectId},
          createdAt:plan.createdAt,approval:'whole-plan',actions:plan.actions});
        const status = {ready:'Review only',running:'Running',passed:'Passed',failed:'Failed'}[run.status];
        const item = reportArtifact(report,status);
        item.ownerId = projectId;
        item.originalDigest = reviewDigest('probe',projectId,gcpProjectId,plan.planId,plan);
        if (run.status === 'ready') {
          const verified = plan.workloadDigest === probeWorkloadDigest && isDeepStrictEqual(plan.actions,probeActions(plan));
          if (!damaged && verified && !activeSlots.has(transferSlot(plan.scope.target).id)) {
            item.status = 'Awaiting approval';
            item.approval = {digest:item.originalDigest};
          }
        } else if (['running','passed','failed'].includes(run.status)) {
          item.previouslyApproved = true;
          item.details.push('Approved for this access check.');
          if (run.finishedAt) item.details.push('Finished '+run.finishedAt+'.');
          item.details.push(...evidenceDetails({...run,softDeleteSeconds:plan.softDeleteSeconds}));
          if (!plan.fileOnly && run.copyPassed) item.details.push('The copy account read the test secret and downloaded the file.');
          if (!plan.fileOnly && run.status === 'failed' && !run.appPassed) item.details.push('The test did not verify the app’s access restrictions.');
          if (run.status === 'passed' || run.status === 'failed') item.details.push('The recorded temporary resources were cleaned up.');
        }
        items.push(item);
      } catch {
        damaged = true;
        unavailable.push(unreadableReview(plan.planId));
      }
    }
    if (damaged) for (const item of items) {
      if (item.approval || item.status === 'Review only') {
        delete item.approval;
        item.status = 'Review only';
        item.details.push('An access-check receipt for this project could not be verified.');
      }
    }
    const related: NativeReviewArtifact[] = items.flatMap(item => item.status === 'Passed' || item.status === 'Failed'
      ? [item, {id:item.id+'-result',kind:'result',title:item.title+' result',planId:item.id,project:item.project,
        createdAt:records.find(row => row.plan.planId === item.id)?.run.finishedAt,
        status:item.status,previouslyApproved:true,aliases:[],details:[...item.details]}] : [item]);
    return [...unavailable,...related];
  } finally { db.close(); }
}

function originalPreview(raw: Record<string,unknown> | undefined, intent: string): SavedSetup | undefined {
  const planned = reviewRecord(raw?.planned);
  if (raw?.intent !== intent || typeof raw.planId !== 'string' || !raw.planId.startsWith('setup-') || !nativeId.test(raw.planId)
    || typeof raw.baseline !== 'string' || !Array.isArray(planned.actions) || !Array.isArray(planned.blockers)
    || !reviewRecord(raw.configuration).files || !reviewRecord(raw.manifest).contributions) return;
  return raw as unknown as SavedSetup;
}

// Old plans did not name the contribution being previewed. Match the CI grant's
// exact saved intent, since other setup plans may retain an existing CI contribution.
function undisclosedCiRelease(saved: SavedSetup, gcpProjectId: string): boolean {
  if (Array.isArray(saved.ciReleaseAccess) && saved.ciReleaseAccess.length) return false;
  if (saved.reviewContributionId) return saved.reviewContributionId === 'ci-release';
  const configuration = reviewRecord(reviewRecord(saved.manifest).contributions)['ci-release'];
  return Boolean(configuration && saved.intent === setupDataDigest({
    gcpProjectId, contribution: { id: 'ci-release', configuration }, authenticationScope: 'google-project-admin',
    destroy: [], imports: [], existing: [],
  }));
}

function currentSetup(directory: string, saved: SavedSetup): boolean {
  const segment = saved.planned.segment;
  if (!saved.planned.ok || segment?.engine !== 'opentofu' || segment.id !== 'opentofu:'+saved.planId
    || segment.configurationDigest !== configurationDigest(saved.configuration)) return false;
  const manifest = path.join(path.dirname(directory),'setup-manifest.json');
  const existing = fs.lstatSync(manifest,{throwIfNoEntry:false}) ? reviewJson(manifest) : {contributions:{}};
  if (!existing) return false;
  const baseline = setupDataDigest(existing);
  if (saved.baseline !== baseline && !(saved.requiresPlanId && saved.baseline === 'project-recovery-v1:'+baseline)) return false;
  return matchingReviewEngineFiles(directory,saved.planId,segment);
}

/** Older bootstrap previews did not describe the distinct deployment-key operation. */
function bootstrapNeedsDisclosure(saved: SavedSetup, report: PlanReport): boolean {
  if (report.bootstrapConnection || saved.setupPurpose) return false;
  if (saved.reviewContributionId) return saved.reviewContributionId === 'bootstrap';
  if (saved.requiresPlanId) return true;
  const contributions = reviewRecord(reviewRecord(saved.manifest).contributions);
  if (!Object.hasOwn(contributions,'bootstrap')) return false;
  const resources = reviewRecord(reviewRecord(contributions.bootstrap).resources);
  return Object.keys(contributions).length === 1 || report.actions.some(action =>
    action.type !== 'noop' && action.addresses.some(address => Object.hasOwn(resources,address)));
}

function setupReviews(directory: string, scope: Scope, history: ReviewHistory, wanted?: string): NativeReviewArtifact[] {
  const entries = files(directory).filter(entry => entry.isFile());
  const previews = new Map<string,SavedSetup>();
  for (const entry of entries) {
    const intent = /^setup-([a-f0-9]{64})\.json$/.exec(entry.name)?.[1];
    if (!intent) continue;
    const saved = originalPreview(reviewJson(path.join(directory,entry.name)),intent);
    if (saved && (!wanted || saved.planId === wanted)) previews.set(saved.planId,saved);
  }
  const reportIds = entries.filter(entry => entry.name.endsWith('.report.json')).map(entry => entry.name.slice(0,-12))
    .filter(id => nativeId.test(id) && id.startsWith('setup-') && (!wanted || wanted === id));
  const result: NativeReviewArtifact[] = [];
  for (const id of new Set([...previews.keys(), ...reportIds])) {
    try {
      const saved = previews.get(id);
      const snapshot = reviewJson(path.join(directory,id+'.report.json'));
      let report: PlanReport | undefined;
      if (snapshot) {
        const value = snapshot.report as PlanReport | undefined;
        if (snapshot.projectId !== scope.projectId || value?.planId !== id || value.target !== scope.gcpProjectId ||
            typeof value.project !== 'string' || snapshot.checksum !== setupReportChecksum(scope.projectId,value) || !Array.isArray(value.actions) || !Array.isArray(value.blocked)) continue;
        // This sidecar holds only the deliberately redacted display model written by saveSetupReport.
        const connection = reviewRecord(value.bootstrapConnection);
        report = makePlanReport({
          planId:id, project:value.project, scope:'Google Cloud project setup', target:scope.gcpProjectId,
          cloudTarget:{provider:'gcp',projectId:scope.gcpProjectId}, approval:'whole-plan',
          createdAt:typeof value.createdAt === 'string' ? value.createdAt : undefined,
          setupPurpose:value.setupPurpose, bucketCopy:value.bucketCopy, warnings:value.warnings, blocked:value.blocked, ciReleaseAccess:value.ciReleaseAccess, runtimeObservationAccess:value.runtimeObservationAccess,
          billingAccount:typeof value.billingAccount === 'string' && /^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(value.billingAccount) ? value.billingAccount : undefined,
          bootstrapConnection:typeof connection.scope === 'string' && typeof connection.deploymentAccount === 'string'
            ? {scope:connection.scope,deploymentAccount:connection.deploymentAccount} : undefined,
          actions:value.actions.map(action => ({
            id:action.id,type:action.type,verified:action.verified,reason:action.reason,billable:action.billable,dataBearing:action.dataBearing,
            resource:{kind:action.kind,name:action.name,provider:action.provider}, dependsOn:action.dependsOn,
            diff:action.fields?.map(field => ({field})),metadata:{engineSegment:{addresses:action.addresses}},
          })),
        });
      }
      const original = saved && setupReport(scope,saved);
      report ??= original;
      if (!report) continue;
      const item = reportArtifact(report,'Historical plan');
      const record = history.setups.find(row => row.projectId === scope.projectId && row.targetId === scope.gcpProjectId && row.planId === id
        && (!saved || row.digest === reviewDigest('setup',scope.projectId,scope.gcpProjectId,id,saved)));
      item.ownerId = scope.projectId;
      item.originalDigest = saved ? reviewDigest('setup',scope.projectId,scope.gcpProjectId,id,saved) : record?.digest;
      item.archivedSetup = !saved && !record;
      if (record?.verification) {
        const approved = history.approvals.find(row => row.planId === id && row.digest === record.digest);
        if (report.setupPurpose !== 'railway-bucket-copy' || approved?.displayDigest !== setupDataDigest(report)) {
          result.push(unreadableReview(id));
          continue;
        }
      }
      if (record) {
        item.previouslyApproved = true;
        if (record.verification) {
          item.status = 'Applied';
          item.details.push('The original setup attempt was recorded as '+record.status+' at '+record.updatedAt+'.',
            'At '+record.verification.verifiedAt+', Hypervibe verified the idle copy job and both bucket permissions.');
        } else {
          item.status = {running:'Running',applied:'Applied',failed:'Failed'}[record.status];
          item.details.push('Approved for this project setup. Last recorded update '+record.updatedAt+'.');
        }
      } else if (saved && original && isDeepStrictEqual(original,report) && currentSetup(directory,saved) &&
          !report.blocked.length && (report.bootstrapConnection || report.actions.some(a => a.type !== 'noop')) && report.actions.every(a => a.verified || a.type === 'noop')) {
        item.status = 'Awaiting approval';
        item.approval = {digest:item.originalDigest!};
      } else item.details.push('This saved setup has no confirmed execution outcome in the local journal.');
      if (report.runtimeObservationAccess) item.details.push(...report.runtimeObservationAccess);
      if (report.ciReleaseAccess) item.details.push(...report.ciReleaseAccess);
      if (item.approval && saved && undisclosedCiRelease(saved,scope.gcpProjectId)) {
        delete item.approval;
        item.status = 'Review only';
        item.details.push('Preview GitHub release access again to review the exact workflows, branches, environments and triggers.');
      }
      const connection = reviewRecord(reviewRecord(report).bootstrapConnection);
      if (typeof connection.deploymentAccount === 'string' && typeof connection.scope === 'string') {
        item.details.push('Approval also lets Hypervibe reuse the deployment key for '+connection.deploymentAccount
          +' or create one, verify it with Cloud Run and Cloud SQL, and save the connections encrypted on this computer for '+connection.scope+'.');
      }
      if (item.approval && saved && bootstrapNeedsDisclosure(saved,report)) {
        delete item.approval;
        item.status = 'Review only';
        item.details.push('Preview project setup again to review and approve the deployment key and its connection scope.');
      }
      result.push(item);
    } catch { result.push(unreadableReview(id)); }
  }
  return result;
}

export function gcpReviewPlans(root: string, history: ReviewHistory, wanted?: string): NativeReviewArtifact[] {
  if (wanted && !/^(probe|setup)-/.test(wanted)) return [];
  const result: NativeReviewArtifact[] = [];
  const engine = path.join(root,'engine');
  for (const gcp of subdirectories(engine,/^gcp$/)) {
    for (const project of subdirectories(gcp,/^[a-z0-9_-]{1,128}$/i)) {
      for (const target of subdirectories(project,/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)) {
        const shared = path.join(target,'project-shared');
        const directory = path.join(shared,'plans');
        if (!fs.lstatSync(shared,{throwIfNoEntry:false})?.isDirectory() || !fs.lstatSync(directory,{throwIfNoEntry:false})?.isDirectory()) continue;
        const scope = {projectId:path.basename(project),gcpProjectId:path.basename(target)};
        if (!wanted || wanted.startsWith('probe-')) {
          // A broken journal cannot authorize a check. Other projects and setup reports remain readable.
          try { result.push(...probeReviews(directory,scope,wanted)); } catch { /* No verifiable probe rows. */ }
        }
        if (!wanted || wanted.startsWith('setup-')) result.push(...setupReviews(directory,scope,history,wanted));
      }
    }
  }
  return result;
}
