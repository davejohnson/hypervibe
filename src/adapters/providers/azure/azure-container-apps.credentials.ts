import { z } from 'zod';

const azureResourceId = z.string().regex(
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ContainerRegistry\/registries\/[^/]+$/i,
  'Azure Container Registry resource ID must be a full ARM registry resource ID'
);

export const AzureContainerAppsCredentialsSchema = z.object({
  tenantId: z.string().min(1, 'Azure tenant ID is required'),
  subscriptionId: z.string().min(1, 'Azure subscription ID is required'),
  clientId: z.string().min(1, 'Azure service principal client ID is required'),
  clientSecret: z.string().min(1, 'Azure service principal client secret is required'),
  resourceGroup: z.string().min(1, 'Azure resource group is required'),
  location: z.string().min(1, 'Azure location is required'),
  registryId: azureResourceId,
  registryServer: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/,
      'Azure Container Registry server must be a hostname'
    ),
  cpu: z.number().positive().default(0.25),
  memory: z.string().regex(/^\d+(?:\.\d+)?Gi$/, 'Azure memory must use Gi units').default('0.5Gi'),
});

export type AzureContainerAppsCredentials = z.infer<
  typeof AzureContainerAppsCredentialsSchema
>;
