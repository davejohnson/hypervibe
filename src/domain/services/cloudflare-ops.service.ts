import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { CloudflareCredentials } from '../entities/connection.entity.js';

const connectionRepo = new ConnectionRepository();

function adapterFromConnection(connection: NonNullable<ReturnType<ConnectionRepository['findById']>>): { adapter: CloudflareAdapter; scope: string | null } {
  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter, scope: connection.scope };
}

/**
 * Get a Cloudflare adapter, using scoped connection if available.
 * @param scopeHint - Optional domain hint (e.g., "example.com") for finding scoped tokens
 */
export function getCloudflareAdapter(scopeHint?: string): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', scopeHint);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use hv_connect provider=cloudflare first. Recommended: use credentialsRef="env:CLOUDFLARE_API_TOKEN" for an exported token or credentialsRef="dotenv:/absolute/path/.env#CLOUDFLARE_API_TOKEN" for an existing .env file; raw credentials={...} is still accepted if intentional.' };
  }

  return adapterFromConnection(connection);
}

/**
 * Get any verified Cloudflare adapter. Useful for provider-level operations
 * like listing zones when the user only has scoped domain connections.
 */
export function getAnyVerifiedCloudflareAdapter(): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  const connection = connectionRepo
    .findAllByProvider('cloudflare')
    .find((candidate) => candidate.status === 'verified');
  if (!connection) {
    return { error: 'No verified Cloudflare connection found. Use hv_connect provider=cloudflare first. Scoped domain connections are fine for listing zones visible to that token.' };
  }
  return adapterFromConnection(connection);
}
