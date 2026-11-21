import { describe, expect, it } from 'vitest';
import type { PlanAction } from '../../../../../domain/plan/plan.types.js';
import { reviewedBucketJob, matchesBucketCopyActions } from '../bucket-copy-review.js';
import { transferBucketJob } from '../transfer-bucket-job.js';
import { transferIsolationContribution } from '../transfer-isolation.js';

const target = { projectId: 'example-project', targetRegion: 'us-central1', targetEnvironmentId: 'target',
  sourceRailwayProjectId: 'railway-project', sourceRailwayEnvironmentId: 'railway-env', sourceEnvironmentId: 'source' };
const scope = { target, storageName: 'documents', sourceBucketId: 'railway-bucket', sourceBucketName: 'documents-railway', targetBucket: 'hv-example-documents' };
const job = transferBucketJob(scope);
const evidence = { projectNumber: '123', copyUniqueId: '456', bucketTimeCreated: '2026-01-02T00:00:00Z', jobUid: null, viewer: false, creator: false };
const isolation = transferIsolationContribution({ target, targetEnvironmentName: 'production-gcp', projectNumber: evidence.projectNumber,
  runtimeEmail: 'app-runtime@example-project.iam.gserviceaccount.com', runtimeUniqueId: '789', copyUniqueId: evidence.copyUniqueId,
  bucket: target.projectId + '-hv-build-source', bucketTimeCreated: '2026-01-01T00:00:00Z', secretCreateTime: '2026-01-01T00:00:00Z' });
const existing = { [isolation.id]: isolation.configuration };
const params = { projectId: 'local', gcpProjectId: target.projectId, auth: { env: {}, redact: [] },
  contribution: { id: job.id, configuration: job.configuration }, transferBucketJobReview: { scope, evidence } };
function change(address: string, type: PlanAction['type'] = 'create'): PlanAction {
  return { id: address, type, reason: 'test', verified: true, resource: { name: address, provider: 'gcp', kind: 'storage' },
    metadata: { engineSegment: { id: 'test-plan', engine: 'opentofu', planDigest: 'digest', addresses: [address] } } };
}

describe('review of a managed Railway bucket copy job', () => {
  it('ties setup to the original isolated account, contribution and named bucket', () => {
    expect(reviewedBucketJob(params, existing)?.id).toBe(job.id);
    expect(() => reviewedBucketJob(params, {})).toThrow();
    expect(() => reviewedBucketJob({ ...params, transferBucketJobReview: undefined }, existing)).toThrow();
    expect(() => reviewedBucketJob({ ...params, confirm: true }, existing)).toThrow();
    expect(() => reviewedBucketJob({ ...params, transferBucketJobReview: { scope, evidence: { ...evidence, copyUniqueId: '999' } } }, existing)).toThrow();
    expect(() => reviewedBucketJob({ ...params, transferBucketJobReview: { scope: { ...scope, targetBucket: 'other-documents' }, evidence } }, existing)).toThrow();
    expect(() => reviewedBucketJob(params, { ...existing, other: job.configuration })).toThrow();
  });
  it('refuses to adopt a preexisting permission and shows only the missing changes on an owned setup', () => {
    const partial = { ...evidence, viewer: true };
    const withViewer = { ...params, transferBucketJobReview: { scope, evidence: partial } };
    expect(() => reviewedBucketJob(withViewer, existing)).toThrow();
    expect(reviewedBucketJob(withViewer, { ...existing, [job.id]: job.configuration })?.id).toBe(job.id);
    const shown = [change(job.addresses.job), change(job.addresses.creator), change(job.addresses.viewer, 'noop')];
    expect(matchesBucketCopyActions(shown, job, partial)).toBe(true);
    expect(matchesBucketCopyActions(shown.slice(1), job, partial)).toBe(false);
    expect(matchesBucketCopyActions([...shown, change(job.addresses.viewer)], job, partial)).toBe(false);
    expect(matchesBucketCopyActions([...shown, change('unrelated', 'destroy')], job, partial)).toBe(false);
  });
});
