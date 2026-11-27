import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { fromContainerMetadata } from '@smithy/credential-provider-imds';
import { z } from 'zod';
import { s3BucketObjectClient } from '../../../domain/services/object-storage-transfer.service.js';
import { decodeEnrollmentWitness, enrolledBucketClients } from '../../../domain/services/bucket-backup-enrollment.js';

const bucket = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
export const awsDailyBucketConfig = z.object({
  version: z.literal(1), provider: z.literal('s3'), accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/), sourceBucket: bucket, archiveBucket: bucket,
}).strict().refine(value => value.sourceBucket !== value.archiveBucket);
export type AwsDailyBucketConfig = z.infer<typeof awsDailyBucketConfig>;

export function awsDailyBucketClients(raw: unknown, credentials?: S3ClientConfig['credentials']) {
  const config = awsDailyBucketConfig.parse(raw);
  const options = { region: config.region, ...(credentials ? { credentials } : {}) };
  const identity = (name: string) => ({ provider: 's3', externalId: 'arn:aws:s3:::' + name,
    instanceScope: { accountId: config.accountId, region: config.region } });
  return { source: s3BucketObjectClient(new S3Client(options), config.sourceBucket, config.accountId),
    archive: s3BucketObjectClient(new S3Client(options), config.archiveBucket, config.accountId),
    sourceIdentity: identity(config.sourceBucket), destinationIdentity: identity(config.archiveBucket) };
}

/** Fargate supplies rotating credentials for this job's dedicated task role. */
export async function openAwsDailyBucketBackup(raw: unknown) {
  // ECS injects this relative URI and rotates the session. The worker never
  // falls back to a profile, an environment key, or an instance role.
  if (!/^\/v2\/credentials\/[a-zA-Z0-9-]+$/.test(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? '') ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) throw new Error('The dedicated Fargate task identity is unavailable.');
  const { enrollmentId, enrollmentWitness, ...config } = z.object({ enrollmentId: z.guid(), enrollmentWitness: z.string() }).passthrough().parse(raw);
  const witness = decodeEnrollmentWitness(enrollmentWitness);
  return enrolledBucketClients(awsDailyBucketClients(config, fromContainerMetadata({ timeout: 10_000, maxRetries: 1 })), enrollmentId, witness);
}
