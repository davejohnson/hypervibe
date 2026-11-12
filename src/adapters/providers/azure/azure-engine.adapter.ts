import { z } from 'zod';
import type { VerifyResult } from '../../../domain/ports/provider.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

/**
 * Hypervibe's own Azure access, created by one-time setup: the project's
 * deploy app (hypervibe-deploy-<project>) with a client secret, holding roles
 * on the project's resource group only. OpenTofu deploys as this identity.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const AzureEngineCredentialsSchema = z.object({
  tenantId: uuid,
  subscriptionId: uuid,
  clientId: uuid,
  /** Object id of the deploy app's service principal (the database's Entra administrator). */
  deployPrincipalId: uuid,
  clientSecret: z.string().min(16),
  /** When Microsoft expires the secret; setup runs again before then. */
  clientSecretExpiresAt: z.string().datetime({ offset: true }),
  resourceGroup: z.string().regex(/^hv-[a-z0-9-]{1,60}$/),
  location: z.string().regex(/^[a-z][a-z0-9]{2,30}$/),
}).strict();
export type AzureEngineCredentials = z.infer<typeof AzureEngineCredentialsSchema>;

export type AzureDeployAccess = Pick<AzureEngineCredentials, 'tenantId' | 'subscriptionId' | 'clientId' | 'clientSecret' | 'resourceGroup'>;

type Fetch = typeof fetch;

/** A Resource Manager token for the deploy app (client credentials). */
export async function azureDeployToken(access: Pick<AzureDeployAccess, 'tenantId' | 'clientId' | 'clientSecret'>, fetchImpl: Fetch = fetch): Promise<string> {
  const response = await fetchImpl(`https://login.microsoftonline.com/${access.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: access.clientId, client_secret: access.clientSecret, grant_type: 'client_credentials', scope: 'https://management.azure.com/.default' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) throw new Error(`Microsoft did not issue a deploy token (HTTP ${response.status}${body.error ? `, ${body.error}` : ''}).`);
  return body.access_token;
}

/**
 * Proves the stored secret signs in and can read the project's resource group.
 * New secrets and role assignments take up to a few minutes to apply.
 */
export async function verifyAzureDeployAccess(access: AzureDeployAccess, options: { fetchImpl?: Fetch; attempts?: number; delayMs?: number } = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError = '';
  for (let attempt = 0; attempt < (options.attempts ?? 24); attempt++) {
    try {
      const token = await azureDeployToken(access, fetchImpl);
      const response = await fetchImpl(`https://management.azure.com/subscriptions/${access.subscriptionId}/resourceGroups/${access.resourceGroup}?api-version=2021-04-01`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return { ok: true };
      lastError = `HTTP ${response.status} reading ${access.resourceGroup}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, options.delayMs ?? 5000));
  }
  return { ok: false, message: `The deploy identity was not usable yet (${lastError}).` };
}

export class AzureEngineAdapter {
  readonly name = 'azure';
  readonly capabilities = { supportedBuilders: ['dockerfile'], supportedComponents: [], supportsAutoWiring: false, supportsHealthChecks: true };
  private credentials: AzureEngineCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureEngineCredentialsSchema.parse(credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) return { success: false, error: 'Not connected.' };
    const verified = await verifyAzureDeployAccess(this.credentials);
    return verified.ok ? { success: true } : { success: false, error: verified.message };
  }
}

providerRegistry.register({
  metadata: {
    name: 'azure',
    displayName: 'Microsoft Azure',
    category: 'deployment',
    credentialsSchema: AzureEngineCredentialsSchema,
    setupHelpUrl: 'https://portal.azure.com/',
    maturity: {
      lifecycle: {
        hosting: { status: 'planned', reason: 'The OpenTofu Azure engine is being built; setup creates Hypervibe\'s access only.' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new AzureEngineAdapter();
    await adapter.connect(credentials);
    return adapter as never;
  },
});
