import fs from 'node:fs';
import path from 'node:path';
import { planIdInSavedReport, type PlanReport } from '../../domain/plan/plan-report.js';
import { parseAccessProbeFileEvidence } from '../providers/gcp/gcp-transfer-probe-workload.js';

export interface ReviewArtifact {
  id: string;
  kind: 'plan' | 'result';
  title: string;
  project?: string;
  createdAt?: string;
  planId?: string;
  report?: PlanReport;
  details: string[];
  aliases: string[];
  status: string;
  previouslyApproved?: true;
  approval?: { digest: string; approvedAt?: string };
}

export function unreadableReview(id: string): ReviewArtifact {
  return {id,planId:id,kind:'plan',title:'Saved plan',status:'Review unavailable',aliases:[],
    details:['The saved record could not be verified. Restore its original data or preview the operation again.']};
}

/** Private join keys used by the catalog; never serialized into a review. */
export interface NativeReviewArtifact extends ReviewArtifact {
  ownerId?: string;
  originalDigest?: string;
  archivedSetup?: boolean;
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const nativeId = new RegExp('^(?:setup-|probe-)?'+uuid+'$');
export const localReviewId = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;

export function files(dir: string): fs.Dirent[] {
  if (!fs.lstatSync(dir, {throwIfNoEntry: false})?.isDirectory()) return [];
  return fs.readdirSync(dir, {withFileTypes:true});
}

/** Scan fixed native directory levels. Never descend through symbolic links. */
export function subdirectories(dir: string, names: RegExp): string[] {
  return files(dir).filter(entry => entry.isDirectory() && names.test(entry.name)).map(entry => path.join(dir, entry.name));
}

export function reviewFile(file: string): Buffer | undefined {
  try {
    if (!fs.lstatSync(file, {throwIfNoEntry:false})?.isFile()) return;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return;
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { return; }
}

export function reviewRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

export function reviewJson(file: string) {
  const bytes = reviewFile(file);
  if (!bytes) return;
  try { return reviewRecord(JSON.parse(bytes.toString('utf8'))); } catch { return; }
}

export function evidenceDetails(data: Record<string, unknown>): string[] {
  const details: string[] = [];
  if (data.operatorReadVerified === true) details.push('Hypervibe read the uploaded file and verified its contents.');
  const evidence = parseAccessProbeFileEvidence(data.fileEvidence);
  if (evidence) {
    const outcomes = { denied:'Google denied the app access to the file.', readable:'The app could read the file.', inconclusive:'The test could not establish whether the app could read the file.' };
    details.push(outcomes[evidence.outcome]);
    for (const [label, check] of [['File download', evidence.media], ['File metadata', evidence.metadata]] as const) {
      if (check) details.push(label+' returned '+(check.status === null ? 'no HTTP status' : 'HTTP '+check.status)+' ('+check.classification+').');
    }
  }
  if (typeof data.softDeleteSeconds === 'number' && Number.isSafeInteger(data.softDeleteSeconds) && data.softDeleteSeconds > 0)
    details.push('Google keeps the deleted file recoverable for '+data.softDeleteSeconds / 86400+' days.');
  return details;
}

export function addSavedFiles(directory: string, items: Map<string, NativeReviewArtifact>, wanted?: string): void {
  for (const entry of files(directory)) {
    if (!entry.isFile() || !localReviewId.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.name.endsWith('.html')) {
      const filenameId = entry.name.slice(0,-5);
      // Resolve a friendly copy only through its native report identity. Never serve its markup or trust its outcome.
      const id = nativeId.test(filenameId) ? filenameId
        : planIdInSavedReport(reviewFile(file)?.toString('utf8') ?? '');
      if (id && items.has(id)) {
        const aliases = items.get(id)!.aliases;
        if (nativeId.test(filenameId)) aliases.push(entry.name);
        else aliases.unshift(filenameId,entry.name);
      }
      continue;
    }
    if (!/(?:^|[-_.])result\.json$/i.test(entry.name)) continue;
    const envelope = reviewJson(file);
    const error = reviewRecord(envelope?.error);
    const data = envelope?.ok === false && !envelope.data ? reviewRecord(error.details) : reviewRecord(envelope?.data);
    if (typeof envelope?.ok !== 'boolean' || typeof data.planId !== 'string' || !nativeId.test(data.planId)) continue;
    if ((envelope.ok && typeof data.success !== 'boolean') || data.mode === 'preview') continue;
    if (wanted && data.planId !== wanted) continue;
    const native = items.get(data.planId);
    const success = envelope.ok && data.success === true;
    // Legacy setup confirmations lack a native execution row. A matching exported result can
    // document the earlier decision. It never enters the browser authorization journal.
    if (native?.archivedSetup && native.report && data.mode === 'confirm' && reviewRecord(data.project).id === native.ownerId
      && (!data.gcpProjectId || data.gcpProjectId === native.report.target)) {
      const actions = data.actions;
      const sameActions = Array.isArray(actions) && actions.length === native.report.actions.length
        && actions.every((raw,index) => {
          const action = reviewRecord(raw), resource = reviewRecord(action.resource), original = native.report!.actions[index];
          return action.id === original.id && action.type === original.type && resource.name === original.name
            && resource.kind === original.kind && resource.provider === original.provider;
        });
      const boundTarget = reviewRecord(data.target).projectId === native.report.target;
      if (sameActions || (actions === undefined && boundTarget)) {
        native.status = success ? 'Applied (saved receipt)' : 'Failed (saved receipt)';
        if (success) native.previouslyApproved = true;
        native.details = native.details.filter(line => !line.startsWith('This saved setup has no confirmed execution'));
        native.details.push(success ? 'The saved confirmation receipt records approval and completion of this plan.'
          : 'The saved confirmation receipt records an unsuccessful attempt to run this plan.');
      }
    }
    const sameOwner = !!native?.ownerId && reviewRecord(data.project).id === native.ownerId;
    const corroborated = sameOwner && (success ? ['Passed','Applied','Applied (saved receipt)'] : ['Failed','Failed (saved receipt)']).includes(native?.status ?? '');
    const status = corroborated ? native!.status : (success ? 'Reported success' : 'Reported failure');
    const friendly = entry.name.slice(0,-5).replace(/[._-]+/g,' ');
    const title = native?.report?.scope === 'Google Cloud export file access check' ? 'Export file access check result'
      : friendly.charAt(0).toUpperCase()+friendly.slice(1);
    const canonicalResult = items.get(data.planId+'-result');
    if (canonicalResult && corroborated) {
      canonicalResult.aliases.push(entry.name.slice(0,-5),entry.name);
    } else {
      items.set(entry.name, {id:entry.name, kind:'result', title, project:native?.project,
        planId:data.planId, createdAt:fs.statSync(file).mtime.toISOString(), status,
        ...(corroborated && native?.previouslyApproved && {previouslyApproved:true}),
        aliases:[entry.name.slice(0,-5), entry.name], details:['Saved result for '+data.planId+'.', ...evidenceDetails(data)]});
    }
  }
  const owners = new Map<string, string|null>();
  for (const item of items.values()) for (const alias of item.aliases) {
    if (!owners.has(alias)) owners.set(alias,item.id);
    else if (owners.get(alias) !== item.id) owners.set(alias,null);
  }
  for (const item of items.values()) item.aliases = item.aliases.filter(alias =>
    owners.get(alias) === item.id && (!items.has(alias) || alias === item.id));

}

export function resolveLocalReview(items: ReviewArtifact[], id: string): ReviewArtifact | undefined {
  const exact = items.find(item => item.id === id);
  if (exact) return exact;
  const aliases = items.filter(item => item.aliases.includes(id));
  return aliases.length === 1 ? aliases[0] : undefined;
}
