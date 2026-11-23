import fs from 'node:fs';
import path from 'node:path';
import { engineSegmentOf, type EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { fileDigest, type EngineStatePaths } from '../../../engine/opentofu/workspace.js';
import { setupReport, setupReportChecksum } from '../../../storage/gcp-setup-report.js';
import { matchingReviewEngineFiles } from '../../../storage/local-review-engine.js';
import { reviewJson } from '../../../storage/local-review-files.js';
import { readReviewHistory, recordBucketJobVerification, reviewDigest, setupDataDigest as digest, type SetupExecution } from '../../../storage/review-authorization.js';
import { matchesBucketCopyActions, type TransferBucketJobReview } from './bucket-copy-review.js';
import type { GcpProjectSetupParams, SetupManifest, SetupPreview } from './project-setup-executor.js';
import type { transferBucketJob, TransferBucketJobEvidence } from './transfer-bucket-job.js';

const unverifiable = 'The original bucket job setup, browser approval and native apply evidence could not be verified together.';
const incomplete = 'The idle job and both bucket permissions must match the original private state and fresh Google observations.';

function stateAfterAttempt(paths: EngineStatePaths, attempt: SetupExecution, approvedAt: string): string {
  const { planId, status, updatedAt } = attempt;
  const backups = fs.readdirSync(paths.backups).filter(name => name.endsWith('.tfstate')).sort();
  const latest = backups.at(-1);
  const stamp = latest?.slice(0, 24);
  if (!latest || !stamp || latest !== stamp + '-' + planId + '.tfstate' ||
      backups.filter(name => name.endsWith('-' + planId + '.tfstate')).length !== 1 ||
      !/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(stamp) ||
      stamp < approvedAt.replace(/[:.]/g, '-') ||
      (status === 'running' && stamp < updatedAt.replace(/[:.]/g, '-')) ||
      (status === 'failed' && stamp > updatedAt.replace(/[:.]/g, '-')) ||
      !fs.lstatSync(path.join(paths.backups, latest)).isFile()) throw new Error(unverifiable);
  const stat = fs.lstatSync(paths.statePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.mtime.toISOString().replace(/[:.]/g, '-') < stamp ||
      (status === 'failed' && Math.floor(stat.mtimeMs) > Date.parse(updatedAt))) throw new Error(unverifiable);
  const hash = fileDigest(paths.statePath);
  if (hash === fileDigest(path.join(paths.backups, latest))) throw new Error(unverifiable);
  return hash;
}

/** Once an execution exists, this operation can only inspect it. It has no plan/apply capability. */
export function bucketJobRecovery(
  params: GcpProjectSetupParams, dataDir: string, paths: EngineStatePaths, existing: SetupManifest, configuration: EngineConfiguration,
  job: ReturnType<typeof transferBucketJob>, review: TransferBucketJobReview, intentFor: (review: TransferBucketJobReview) => string,
) {
  const id = params.gcpSetupPlanId!;
  const history = readReviewHistory(dataDir);
  const attempts = history.setups.filter(row => row.planId === id && row.projectId === params.projectId && row.targetId === params.gcpProjectId);
  if (!attempts.length) return;
  const attempt = attempts[0]!;
  if (attempts.length !== 1 || !['failed','running'].includes(attempt.status)) throw new Error(unverifiable);
  const approval = history.approvals.find(row => row.planId === id && row.digest === attempt.digest);
  if (!approval || approval.approvedAt > attempt.updatedAt) throw new Error(unverifiable);
  const uid = review.evidence.jobUid;
  if (!uid || !review.evidence.viewer || !review.evidence.creator || (attempt.verification && attempt.verification.jobUid !== uid)) {
    throw new Error(incomplete);
  }
  // The first-generation envelope signed the complete pre-apply evidence in the intent.
  // Recover the prior absence flags exclusively from the browser-approved native creates.
  const candidates = fs.readdirSync(paths.plans).filter(name => /^setup-[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ name, saved: reviewJson(path.join(paths.plans, name)) as unknown as SetupPreview | undefined }))
    .filter(({ saved }) => saved?.planId === id);
  const candidate = candidates[0];
  const saved = candidate?.saved;
  if (candidates.length !== 1 || !candidate || !saved || candidate.name !== 'setup-' + saved.intent + '.json' ||
      reviewDigest('setup', params.projectId, params.gcpProjectId, id, saved) !== attempt.digest ||
      saved.reviewContributionId !== job.id || saved.setupPurpose !== 'railway-bucket-copy' ||
      !saved.planned?.ok || saved.planned.blockers.length || saved.planned.unmanagedDeletes.length ||
      saved.planned.segmentId !== 'opentofu:' + id || digest(saved.manifest) !== digest(existing) ||
      digest(saved.configuration) !== digest(configuration)) throw new Error(unverifiable);
  const creates = saved.planned.actions.filter(action => action.type !== 'noop');
  const addresses = new Set(creates.flatMap(action => engineSegmentOf(action)?.addresses ?? []));
  const before = { ...review.evidence, jobUid: addresses.has(job.addresses.job) ? null : uid,
    viewer: !addresses.has(job.addresses.viewer), creator: !addresses.has(job.addresses.creator) };
  const previous = { ...existing.contributions };
  delete previous[job.id];
  if (!creates.length || !matchesBucketCopyActions(saved.planned.actions, job, before) ||
      intentFor({ scope: review.scope, evidence: before }) !== saved.intent ||
      ![digest(existing), digest({ contributions: previous })].includes(saved.baseline)) throw new Error(unverifiable);
  const report = setupReport(params, saved);
  const display = digest(report);
  if (display !== approval.displayDigest) throw new Error(unverifiable);
  const assertArtifacts = () => {
    const snapshot = reviewJson(path.join(paths.plans, id + '.report.json'));
    if (!snapshot || snapshot.projectId !== params.projectId || digest(snapshot.report) !== display ||
        snapshot.checksum !== setupReportChecksum(params.projectId, report) ||
        digest(reviewJson(path.join(paths.plans, id + '.config.json')) ?? null) !== digest(configuration) ||
        !matchingReviewEngineFiles(paths.plans, id, { ...saved.planned.segment }) ||
        digest(reviewJson(path.join(paths.root, 'setup-manifest.json')) ?? null) !== digest(saved.manifest) ||
        digest(reviewJson(path.join(paths.plans, candidate.name)) ?? null) !== digest(saved)) throw new Error(unverifiable);
    return stateAfterAttempt(paths, attempt, approval.approvedAt);
  };
  const initialState = assertArtifacts();
  return {
    saved,
    async verify(inspect: (evidence: TransferBucketJobEvidence) => Promise<boolean>) {
      if (!await inspect(review.evidence)) throw new Error(incomplete);
      const after = await params.observeBucketJobAfterApply!();
      if (digest(after) !== digest(review.evidence) || !await inspect(after) || initialState !== assertArtifacts()) throw new Error(incomplete);
      recordBucketJobVerification(dataDir, attempt, display, uid);
      return { success: true, mode: 'confirm' as const, planId: id, actions: [], htmlPath: path.join(paths.plans, id + '.html') };
    },
  };
}
