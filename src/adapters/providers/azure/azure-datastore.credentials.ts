import { z } from 'zod';

import { resolveAzureDefaultSubscription, type AzureResourceManagerCredentials } from './azure-resource-manager.client.js';

export const AzureAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'servicePrincipal']).optional(),
  tenantId: z.string().guid('Azure tenant ID must be a UUID').optional(),
  subscriptionId: z.string().guid('Azure subscription ID must be a UUID').optional(),
  clientId: z.string().guid('Azure service principal client ID must be a UUID').optional(),
  clientSecret: z.string().min(8, 'Azure service principal client secret is required').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default') {
    for (const key of ['clientId', 'clientSecret'] as const) {
      if (value[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Local Azure authentication cannot include service-principal credentials.' });
    }
    return;
  }
  for (const key of ['tenantId', 'subscriptionId', 'clientId', 'clientSecret'] as const) {
    if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `Azure ${key} is required` });
  }
});

export type ResolvedAzureAuthentication = Exclude<AzureResourceManagerCredentials, { authMode: 'default' | 'federated' }>
  | { authMode: 'default'; subscriptionId: string; tenantId: string };

export async function resolveAzureAuthentication(credentials: z.infer<typeof AzureAuthenticationSchema>): Promise<ResolvedAzureAuthentication> {
  if (credentials.authMode === 'default') return resolveAzureDefaultSubscription(credentials.subscriptionId, { tenantId: credentials.tenantId });
  return { ...credentials, tenantId: credentials.tenantId!, subscriptionId: credentials.subscriptionId!, clientId: credentials.clientId!, clientSecret: credentials.clientSecret!, authMode: credentials.authMode };
}

export function azureConnectionIdentity(credentials: AzureResourceManagerCredentials | null): Record<string, string> {
  return credentials?.authMode === 'default'
    ? { authMode: 'default', subscriptionId: credentials.subscriptionId, ...(credentials.tenantId ? { tenantId: credentials.tenantId } : {}) }
    : {};
}

/** Local sessions stay on their original host and cannot authorize unattended jobs. */
export function canUseAzureCredentialsForAutomation(credentials: Record<string, unknown>): boolean {
  const parsed = AzureAuthenticationSchema.safeParse(credentials);
  return parsed.success && parsed.data.authMode !== 'default';
}

const LEGACY_PLACEMENT_FIELDS = new Set([
  'resourceGroup',
  'location',
  'postgresSkuName',
  'postgresSkuTier',
  'postgresVersion',
  'postgresStorageSizeGb',
  'redisSkuName',
]);

/**
 * Old connections may still contain placement and SKU fields. Strip only
 * those known legacy keys during decryption/verification; unknown keys remain
 * rejected by the strict authentication schema and nothing placement-shaped
 * is persisted by new connections.
 */
function withoutLegacyPlacement(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([key]) => !LEGACY_PLACEMENT_FIELDS.has(key))
  );
}

export const AzureDatastoreCredentialsSchema = z.preprocess(
  withoutLegacyPlacement,
  AzureAuthenticationSchema
);

export const AzurePostgresCredentialsSchema = AzureDatastoreCredentialsSchema;

export const AzureManagedRedisCredentialsSchema = AzureDatastoreCredentialsSchema;

export type AzureDatastoreCredentials = z.infer<
  typeof AzureDatastoreCredentialsSchema
>;

export type AzurePostgresCredentials = z.infer<
  typeof AzurePostgresCredentialsSchema
>;

export type AzureManagedRedisCredentials = z.infer<
  typeof AzureManagedRedisCredentialsSchema
>;
