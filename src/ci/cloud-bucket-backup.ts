import { DailyBucketPartialLimitError, runDailyBucketBackup, type DailyBucketBackupClients } from '../domain/services/daily-bucket-backup.service.js';

/** Each cloud image entrypoint supplies only its own workload-identity adapter.
 * Raw provider errors and manifests may contain customer object names or tokens. */
export async function runCloudBucketBackupWorker(open: (raw: unknown) => Promise<DailyBucketBackupClients>, environment = process.env) {
  const config: unknown = JSON.parse(environment.HYPERVIBE_BUCKET_BACKUP_CONFIG ?? '');
  const clients = await open(config);
  try { return await runDailyBucketBackup(clients); }
  finally { try { clients.source.destroy(); } finally { clients.archive.destroy(); } }
}

export async function cloudBucketBackupMain(open: (raw: unknown) => Promise<DailyBucketBackupClients>) {
  try { process.stdout.write(JSON.stringify(await runCloudBucketBackupWorker(open)) + '\n'); }
  catch (error) {
    const message = error instanceof DailyBucketPartialLimitError ? error.message : 'The cloud bucket backup could not be verified.';
    process.stderr.write(message + '\n'); process.exitCode = 1;
  }
}
