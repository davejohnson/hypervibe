import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_MAX_PLAN_AGE_MS, planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import type { PlanReport } from '../../domain/plan/plan-report.js';
import { getDataDir } from './paths.js';
import { savedRunReport } from './plan-report-files.js';
import { addSavedFiles, localReviewId, nativeId, resolveLocalReview, unreadableReview, type NativeReviewArtifact, type ReviewArtifact } from './local-review-files.js';
import { matchingRunEngineFiles } from './local-review-engine.js';
import { migrationResults } from './local-review-migration.js';
import { gcpReviewPlans } from './local-review-gcp.js';
import { readReviewHistory, recordReviewApproval, regularReviewDatabase, reviewDigest, setupDataDigest } from './review-authorization.js';

export { resolveLocalReview, type ReviewArtifact } from './local-review-files.js';

function actionableReport(report: PlanReport): boolean {
  return !report.blocked.length && report.actions.some(action => action.type !== 'noop')
    && report.actions.every(action => action.type === 'noop' || action.verified)
    && new Set(report.actions.map(action => action.id)).size === report.actions.length;
}

type PlanRow = { id:string; project_id:string; environment_id:string; name:string; environment:string; revision:number|null;
  plan:string; created_at:string; status:string };
type ApplyRow = { receipts:string; id:string; created_at:string; planId:string; project_id:string; environment_id:string; status:string };
const applyStatuses: Record<string,string> = {
  running:'Running', succeeded:'Applied', blocked:'Blocked', failed:'Failed', pending:'Pending', cancelled:'Cancelled',
};

function runReviews(root: string, wanted?: string): NativeReviewArtifact[] {
  const file = path.join(root,'hypervibe.db');
  if (!regularReviewDatabase(file)) return [];
  const db = new Database(file,{readonly:true,fileMustExist:true});
  try {
    const wherePlan = wanted ? ' AND r.id = ?' : '';
    const whereApply = wanted ? " AND json_extract(plan,'$.planRunId') = ?" : '';
    const args = wanted ? [wanted] : [];
    const plans = db.prepare(`SELECT r.id,r.project_id,r.environment_id,r.plan,r.created_at,r.status,
      p.name,e.name AS environment,(SELECT max(s.revision) FROM project_specs s WHERE s.project_id=r.project_id) AS revision
      FROM runs r JOIN projects p ON p.id=r.project_id JOIN environments e ON e.id=r.environment_id AND e.project_id=r.project_id
      WHERE r.type='plan' AND json_valid(r.plan) AND json_extract(r.plan,'$.kind')='hv_plan'`+wherePlan).all(...args) as PlanRow[];
    const applies = db.prepare(`SELECT id,receipts,created_at,json_extract(plan,'$.planRunId') AS planId, project_id,environment_id,status
      FROM runs WHERE type='apply' AND json_valid(plan)`+whereApply+' ORDER BY created_at DESC, rowid DESC').all(...args) as ApplyRow[];
    const latest = new Map<string,ApplyRow>();
    for (const apply of applies) {
      const key = JSON.stringify([apply.planId, apply.project_id, apply.environment_id]);
      if (!latest.has(key) || apply.status === 'succeeded') latest.set(key,apply);
    }
    const reviews: NativeReviewArtifact[] = [];
    for (const row of plans) {
      if (!nativeId.test(row.id)) continue;
      try {
        const createdAt = new Date(row.created_at), age = Date.now()-createdAt.getTime();
        if (!Number.isFinite(age)) continue;
        const plan = JSON.parse(row.plan);
        const report = savedRunReport({id:row.id, type:'plan', createdAt, plan},row.name);
        const apply = latest.get(JSON.stringify([row.id,row.project_id,row.environment_id]));
        const fresh = row.status === 'succeeded' && age >= 0 && age <= DEFAULT_MAX_PLAN_AGE_MS
          && plan.specRevision === row.revision && plan.environmentName === row.environment;
        const status = apply ? (applyStatuses[apply.status] ?? 'Unknown outcome') : !fresh ? 'Historical plan'
          : report.blocked.length ? 'Blocked' : !report.actions.some(action => action.type !== 'noop') ? 'No changes' : 'Review only';
        const item: NativeReviewArtifact = {ownerId:row.project_id,originalDigest:reviewDigest('run',row.project_id,row.environment_id,row.id,plan),id:row.id,planId:row.id,kind:'plan',title:report.scope==='full' ? 'Deployment plan' : report.scope,
          project:report.project,createdAt:report.createdAt,report,aliases:[],status,details:[]};
        if (apply?.status === 'succeeded' && report.actions.some(action => action.type !== 'noop')) item.previouslyApproved = true;
        if (apply) item.details.push(apply.status === 'succeeded' && report.actions.some(action => action.type !== 'noop')
          ? 'Approved for execution. The local apply journal records completion of this plan.'
          : 'The local apply journal records this outcome for the exact plan.');
        if (!fresh && !apply) item.details.push('The saved revision, environment or review period is no longer current.');
        if (!apply && fresh && actionableReport(report) && planRunDocumentSchema.safeParse(plan).success
          && matchingRunEngineFiles(root,row.project_id,plan)) {
          item.status = 'Awaiting approval';
          item.approval = {digest:item.originalDigest!};
        }
        reviews.push(item);
      } catch { reviews.push(unreadableReview(row.id)); }
    }
    const byPlan = new Map(reviews.map(item => [item.id,item]));
    for (const apply of applies) {
      const source = byPlan.get(apply.planId);
      if (!source || source.ownerId !== apply.project_id || !nativeId.test(apply.id)) continue;
      const allowed = new Set(source.report?.actions.map(action => action.id));
      const details = ['The local apply journal recorded this run for '+apply.planId+'.'];
      try {
        const receipts: unknown = JSON.parse(apply.receipts);
        if (Array.isArray(receipts)) for (const receipt of receipts) {
          if (allowed.has(receipt?.step) && ['success','failure','skipped','pending','blocked'].includes(receipt?.status))
            details.push(receipt.step+' — '+receipt.status);
        }
      } catch { details.push('The saved action receipts could not be read.'); }
      reviews.push({id:apply.id,planId:apply.planId,kind:'result',project:source.project,
        title:'Apply result',createdAt:apply.created_at,aliases:[],status:applyStatuses[apply.status] ?? 'Unknown outcome',
        ...(apply.status === 'succeeded' && source.report?.actions.some(action => action.type !== 'noop') && {previouslyApproved:true}),
        details});
    }
    return [...reviews, ...migrationResults(db,wanted)];
  } finally { db.close(); }
}

export class LocalReviewCatalog {
  constructor(private readonly dataDir = getDataDir()) {}

  private collect(wanted?: string): ReviewArtifact[] {
    if (!fs.lstatSync(this.dataDir,{throwIfNoEntry:false})?.isDirectory()) return [];
    const history = readReviewHistory(this.dataDir);
    const items = new Map<string,NativeReviewArtifact>();
    const native = [
      ...(!wanted || !/^(setup|probe)-/.test(wanted) ? runReviews(this.dataDir,wanted) : []),
      ...gcpReviewPlans(this.dataDir,history.setups,wanted),
    ];
    for (const item of native) {
      if (items.has(item.id)) {
        items.set(item.id,{id:item.id,kind:'plan',title:'Ambiguous plan identity',status:'Review only',
          details:['Several native records use this ID. Preview the intended operation again.'],aliases:[]});
        continue;
      }
      const consent = history.approvals.find(row => row.planId === item.id && (row.digest === item.originalDigest || (item.archivedSetup && item.report && row.displayDigest === setupDataDigest(item.report))));
      if (consent) item.previouslyApproved = true;
      if (consent && item.approval) {
        item.approval.approvedAt = consent.approvedAt;
        item.status = 'Approved';
      } else if (consent) item.details.push('Browser approval for this saved plan was recorded '+consent.approvedAt+'.');
      items.set(item.id,item);
    }
    addSavedFiles(path.join(this.dataDir,'reports'),items,wanted);
    return [...items.values()].map(({ownerId: _ownerId, originalDigest: _originalDigest,archivedSetup: _archivedSetup, ...item}) => item).sort((a,b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
  }

  list(): ReviewArtifact[] { return this.collect(); }

  get(id: string): ReviewArtifact | undefined {
    if (!localReviewId.test(id)) return;
    if (nativeId.test(id)) {
      const direct = this.collect(id).find(item => item.id === id);
      if (direct) return direct;
      const file = path.join(this.dataDir,'hypervibe.db');
      if (!fs.lstatSync(this.dataDir,{throwIfNoEntry:false})?.isDirectory() || !regularReviewDatabase(file)) return;
      const db = new Database(file,{readonly:true,fileMustExist:true});
      try {
        const apply = db.prepare("SELECT json_extract(plan,'$.planRunId') AS source FROM runs WHERE type='apply' AND id=? AND json_valid(plan)").get(id) as {source:string}|undefined;
        if (apply && nativeId.test(apply.source)) return this.collect(apply.source).find(item => item.id === id);
      } finally { db.close(); }
      return;
    }
    return resolveLocalReview(this.list(),id);
  }

  approve(id: string, digest: string): ReviewArtifact {
    const item = this.get(id);
    if (!nativeId.test(id) || !/^[a-f0-9]{64}$/.test(digest) || item?.approval?.digest !== digest || !item.report)
      throw new Error('This plan changed or is no longer awaiting approval. Open its current review.');
    recordReviewApproval(this.dataDir,id,digest,setupDataDigest(item.report),() => this.get(id)?.approval?.digest === digest);
    const updated = this.get(id);
    if (!updated) throw new Error('The saved plan is no longer available.');
    return updated;
  }
}
