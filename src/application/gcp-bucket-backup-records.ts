import { z } from 'zod';
import type { Environment } from '../domain/entities/environment.entity.js';

const target = z.object({ projectId: z.string(), source: z.string(), sourceCreated: z.string(), archive: z.string(), schedule: z.string() });
export const googleBucketBackupRecords = z.record(z.string(), z.union([
  target.extend({ status: z.literal('pending') }).strict(),
  target.extend({ archiveCreated: z.string(), jobUid: z.string(), workerUid: z.string(), timerUid: z.string() }).strict(),
]));

export function googleBackupTeardownWarnings(environment: Environment): string[] {
  if (!environment.platformBindings.gcpBucketBackups) return [];
  const parsed = googleBucketBackupRecords.safeParse(environment.platformBindings.gcpBucketBackups);
  if (!parsed.success) return ['The saved bucket backup record is unreadable. Review the Google Cloud backup storage and schedules that will keep incurring charges.'];
  return Object.values(parsed.data).map(program => ('status' in program ? 'Check the partially applied backup setup for gs://' : 'The separate backup bucket gs://')
    + program.archive + ' and schedule ' + program.schedule + '. This teardown preserves backup resources. Their storage and scheduled runs can keep incurring charges.');
}
