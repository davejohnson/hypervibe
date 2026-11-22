import { isDeepStrictEqual } from 'node:util';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../../../domain/plan/plan.types.js';
import { retainedIsolations } from './transfer-isolation.js';
import { isTransferBucketJobContribution, transferBucketJob, type TransferBucketJobScope, type TransferBucketJobEvidence } from './transfer-bucket-job.js';
import type { GcpProjectSetupParams } from './project-setup-executor.js';

export interface TransferBucketJobReview {
  scope: TransferBucketJobScope;
  evidence: TransferBucketJobEvidence;
}

export function reviewedBucketJob(params: GcpProjectSetupParams, existing: Record<string, EngineConfiguration>) {
  const review = params.transferBucketJobReview;
  if (!review) {
    if (isTransferBucketJobContribution(params.contribution.id)) throw new Error('Use the dedicated bucket copy setup review for this job.');
    return;
  }
  if (params.transferSlotReview || params.transferIsolationReview || params.allowDestroyAddresses?.length ||
      params.allowImportAddresses?.length || params.existingResourceAddresses?.length || params.recoverProjectState ||
      params.observedUnlinkedProject || params.observedLinkedProject ||
      (params.confirm && (!params.gcpSetupPlanId || !params.observeBucketJobAfterApply))) {
    throw new Error('Review the bucket copy job and its bucket permissions together using its own saved plan.');
  }
  const { scope, evidence } = review;
  const job = transferBucketJob(scope);
  const original = existing[job.id];
  const isolation = retainedIsolations(existing, params.gcpProjectId).find(item => isDeepStrictEqual(item.target, scope.target));
  if (scope.target.projectId !== params.gcpProjectId || params.contribution.id !== job.id ||
      !isDeepStrictEqual(params.contribution.configuration, job.configuration) ||
      !isolation || isolation.projectNumber !== evidence.projectNumber || isolation.copyUniqueId !== evidence.copyUniqueId ||
      (original && !isDeepStrictEqual(original, job.configuration)) ||
      Object.entries(existing).some(([owner, config]) => owner !== job.id && Object.values(job.addresses).some(address => Object.hasOwn(config.resources, address)))) {
    throw new Error('The source, destination bucket and dedicated account must match their original managed setup.');
  }
  if (!original && (evidence.jobUid || evidence.viewer || evidence.creator)) {
    throw new Error('This job or one of its grants already exists outside the reviewed setup. Hypervibe cannot adopt it.');
  }
  return job;
}

export function matchesBucketCopyActions(
  actions: PlanAction[], job: ReturnType<typeof transferBucketJob>, evidence: TransferBucketJobEvidence,
): boolean {
  const expected = new Set<string>();
  if (!evidence.jobUid) expected.add(job.addresses.job);
  if (!evidence.viewer) expected.add(job.addresses.viewer);
  if (!evidence.creator) expected.add(job.addresses.creator);
  for (const action of actions) {
    if (action.type === 'noop') continue;
    const addresses = engineSegmentOf(action)?.addresses;
    if (action.type !== 'create' || !addresses || addresses.length !== 1 || !expected.delete(addresses[0]!)) return false;
  }
  return expected.size === 0;
}
