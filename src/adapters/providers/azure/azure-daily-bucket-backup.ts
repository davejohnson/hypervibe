import type { TokenCredential } from '@azure/core-auth';
import { ManagedIdentityCredential } from '@azure/identity';
import { z } from 'zod';
import { AzureSdkBlobDataPlane } from './azure-blob-data-plane.js';
import { decodeEnrollmentWitness, enrolledBucketClients } from '../../../domain/services/bucket-backup-enrollment.js';

const account = z.string().regex(/^[a-z0-9]{3,24}$/);
const container = z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/);
export const azureDailyBucketConfig = z.object({
  version: z.literal(1), provider: z.literal('azure-blob'), subscriptionId: z.string().uuid(),
  resourceGroup: z.string().regex(/^hv-[a-z0-9-]{1,60}$/), sourceAccount: account, sourceContainer: container,
  archiveAccount: account, archiveContainer: container,
}).strict().refine(value => value.sourceAccount !== value.archiveAccount);
export type AzureDailyBucketConfig = z.infer<typeof azureDailyBucketConfig>;
export function azureBucketId(subscriptionId: string, resourceGroup: string, storageAccount: string, storageContainer: string): string {
  return '/subscriptions/' + subscriptionId + '/resourceGroups/' + resourceGroup + '/providers/Microsoft.Storage/storageAccounts/' +
    storageAccount + '/blobServices/default/containers/' + storageContainer;
}

export function azureDailyBucketClients(raw: unknown, credential: TokenCredential) {
  const config = azureDailyBucketConfig.parse(raw);
  const identity = (storageAccount: string, storageContainer: string) => ({ provider: 'azureblob',
    externalId: azureBucketId(config.subscriptionId, config.resourceGroup, storageAccount, storageContainer),
    instanceScope: { subscriptionId: config.subscriptionId, resourceGroup: config.resourceGroup, storageAccount } });
  return { source: new AzureSdkBlobDataPlane(config.sourceAccount, credential, config.sourceContainer),
    archive: new AzureSdkBlobDataPlane(config.archiveAccount, credential, config.archiveContainer),
    sourceIdentity: identity(config.sourceAccount, config.sourceContainer), destinationIdentity: identity(config.archiveAccount, config.archiveContainer) };
}

export async function openAzureDailyBucketBackup(raw: unknown) {
  const clientId = z.string().uuid().parse(process.env.AZURE_CLIENT_ID);
  const { enrollmentId, enrollmentWitness, ...config } = z.object({ enrollmentId: z.guid(), enrollmentWitness: z.string() }).passthrough().parse(raw);
  const witness = decodeEnrollmentWitness(enrollmentWitness);
  return enrolledBucketClients(azureDailyBucketClients(config, new ManagedIdentityCredential({ clientId })), enrollmentId, witness);
}
