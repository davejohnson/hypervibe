import { openAwsDailyBucketBackup } from '../adapters/providers/aws/aws-daily-bucket-backup.js';
import { cloudBucketBackupMain } from './cloud-bucket-backup.js';

void cloudBucketBackupMain(openAwsDailyBucketBackup);
