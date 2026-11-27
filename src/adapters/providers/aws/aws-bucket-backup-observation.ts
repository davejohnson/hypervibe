import { GetBucketLocationCommand, GetBucketTaggingCommand, ListBucketsCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AwsDailyBucketConfig } from './aws-daily-bucket-backup.js';

const cleanScope = 'The backup bucket ownership, tags or region could not be verified in the selected AWS account.';

/** GetBucketTagging returns a named NoSuchBucket error for absence. A generic
 * HEAD error or NoSuchTagSet cannot authorize creation over an existing bucket. */
export async function observedAwsBackupBucket(s3: S3Client, name: string, accountId: string, region: string, environmentId: string) {
  const target = { Bucket: name, ExpectedBucketOwner: accountId };
  let tags;
  try { tags = await s3.send(new GetBucketTaggingCommand(target)); }
  catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (failure.name === 'NoSuchBucket' && failure.$metadata?.httpStatusCode === 404) return 'absent' as const;
    throw new Error(cleanScope);
  }
  const location = await s3.send(new GetBucketLocationCommand(target));
  const actualRegion = location.LocationConstraint === 'EU' ? 'eu-west-1' : location.LocationConstraint || 'us-east-1';
  const labels = Object.fromEntries((tags.TagSet ?? []).map(tag => [tag.Key, tag.Value]));
  if (actualRegion !== region || labels['managed-by'] !== 'hypervibe' || labels['hv-environment'] !== environmentId.toLowerCase()) throw new Error(cleanScope);
  return 'owned' as const;
}

/** The source timestamp can advance when an owner edits bucket policy. In that
 * case the next successful daily copy supplies fresh evidence for cutover. */
async function awsBucketTimestamp(s3: S3Client, bucket: string, region: string) {
  const seen = new Set<string>();
  let continuation: string | undefined;
  let timestamp: string | undefined;
  do {
    const page = await s3.send(new ListBucketsCommand({ Prefix: bucket, MaxBuckets: 1000, ContinuationToken: continuation }));
    if (!Array.isArray(page.Buckets)) throw new Error(cleanScope);
    for (const item of page.Buckets) {
      if (item.Name !== bucket) continue;
      if (timestamp || item.BucketRegion !== region || !item.CreationDate || !Number.isFinite(item.CreationDate.getTime())) throw new Error(cleanScope);
      timestamp = item.CreationDate.toISOString();
    }
    continuation = page.ContinuationToken;
    if (continuation && seen.has(continuation)) throw new Error(cleanScope);
    if (continuation) seen.add(continuation);
  } while (continuation);
  if (!timestamp) throw new Error(cleanScope);
  return timestamp;
}

export async function observeAwsBackupBuckets(config: AwsDailyBucketConfig, environmentId: string, credentials: S3ClientConfig['credentials']) {
  const { region, accountId, sourceBucket, archiveBucket } = config;
  const s3 = new S3Client({ region, credentials, maxAttempts: 1 });
  try {
    if (await observedAwsBackupBucket(s3, sourceBucket, accountId, region, environmentId) !== 'owned') return;
    const sourceEpoch = await awsBucketTimestamp(s3, sourceBucket, region);
    const archivePresent = (await observedAwsBackupBucket(s3, archiveBucket, accountId, region, environmentId)) === 'owned';
    return { sourceEpoch, archivePresent };
  } finally { s3.destroy(); }
}
