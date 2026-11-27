import { openAzureDailyBucketBackup } from '../adapters/providers/azure/azure-daily-bucket-backup.js';
import { cloudBucketBackupMain } from './cloud-bucket-backup.js';

void cloudBucketBackupMain(openAzureDailyBucketBackup);
