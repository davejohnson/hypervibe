import { azureSecretName } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import type { AzureEngineCredentials } from '../adapters/providers/azure/azure-engine.adapter.js';

/**
 * An Azure environment's runtime settings in its Key Vault, written by
 * Hypervibe as the deploy identity (Key Vault Secrets Officer on the project's
 * resource group) and read by the app as Key Vault references. Values only go
 * in: observe reports presence and never returns contents. Shaped like the
 * engine secret store (name, observe, write) so the shared secret collection
 * can use it unchanged.
 */
export interface AzureKeyVaultSecretStore {
  name: string;
  observe(key: string): Promise<'present' | 'absent' | { unknown: string }>;
  write(key: string, value: string): Promise<string | undefined>;
}

type Fetch = typeof fetch;
const API = 'api-version=7.4';

async function vaultToken(access: Pick<AzureEngineCredentials, 'tenantId' | 'clientId' | 'clientSecret'>, fetchImpl: Fetch): Promise<string> {
  const response = await fetchImpl(`https://login.microsoftonline.com/${access.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: access.clientId, client_secret: access.clientSecret, grant_type: 'client_credentials', scope: 'https://vault.azure.net/.default' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error(`Microsoft did not issue a Key Vault token (HTTP ${response.status}).`);
  return body.access_token;
}

export function azureKeyVaultSecretStore(access: Pick<AzureEngineCredentials, 'tenantId' | 'clientId' | 'clientSecret'>, vaultUri: string, fetchImpl: Fetch = fetch): AzureKeyVaultSecretStore {
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(vaultUri)) throw new Error('Key Vault address is invalid.');
  let token: Promise<string> | undefined;
  const call = async (method: string, key: string, body?: unknown) => fetchImpl(`${vaultUri}secrets/${azureSecretName(key)}?${API}`, {
    method, headers: { authorization: `Bearer ${await (token ??= vaultToken(access, fetchImpl))}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
  const codeOf = async (response: Response) => ((await response.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
  return {
    name: 'Azure Key Vault',
    async observe(key) {
      try {
        const response = await call('GET', key);
        // The body holds the value; it is discarded unread.
        await response.body?.cancel();
        if (response.status === 200) return 'present';
        if (response.status === 404) return 'absent';
        return { unknown: `Key Vault could not be read (HTTP ${response.status}).` };
      } catch (error) {
        return { unknown: `Key Vault could not be read (${error instanceof Error ? error.name : 'error'}).` };
      }
    },
    async write(key, value) {
      try {
        const response = await call('PUT', key, { value, contentType: 'text/plain', tags: { 'managed-by': 'hypervibe' } });
        if (response.ok) { await response.body?.cancel(); return undefined; }
        const code = await codeOf(response);
        // A deleted secret keeps its name for the vault's retention period.
        if (code === 'ObjectIsDeletedButRecoverable') return `${key} was deleted from Key Vault recently and cannot be written until it is recovered or the 7-day retention ends.`;
        return `Key Vault did not save ${key} (HTTP ${response.status}${code ? ` ${code}` : ''}).`;
      } catch (error) {
        return `Key Vault did not save ${key} (${error instanceof Error ? error.name : 'error'}).`;
      }
    },
  };
}
