import { openGcsDailyBucketBackup } from '../adapters/providers/gcp/gcp-daily-bucket-backup.js';
import { cloudBucketBackupMain } from './cloud-bucket-backup.js';

void cloudBucketBackupMain(openGcsDailyBucketBackup);
