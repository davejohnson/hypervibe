import { z } from 'zod';

export const AzureDatastoreCredentialsSchema = z.object({
  tenantId: z.string().min(1, 'Azure tenant ID is required'),
  subscriptionId: z.string().min(1, 'Azure subscription ID is required'),
  clientId: z.string().min(1, 'Azure service principal client ID is required'),
  clientSecret: z.string().min(1, 'Azure service principal client secret is required'),
  resourceGroup: z.string().min(1, 'Azure resource group is required'),
  location: z.string().min(1, 'Azure location is required'),
});

export const AzurePostgresCredentialsSchema =
  AzureDatastoreCredentialsSchema.extend({
    postgresSkuName: z.string().min(1).default('Standard_B1ms'),
    postgresSkuTier: z.string().min(1).default('Burstable'),
    postgresVersion: z.string().regex(/^\d+$/).default('16'),
    postgresStorageSizeGb: z.number().int().min(32).default(32),
  });

export const AzureManagedRedisCredentialsSchema =
  AzureDatastoreCredentialsSchema.extend({
    redisSkuName: z.string().min(1).default('Balanced_B0'),
  });

export type AzureDatastoreCredentials = z.infer<
  typeof AzureDatastoreCredentialsSchema
>;

export type AzurePostgresCredentials = z.infer<
  typeof AzurePostgresCredentialsSchema
>;

export type AzureManagedRedisCredentials = z.infer<
  typeof AzureManagedRedisCredentialsSchema
>;
