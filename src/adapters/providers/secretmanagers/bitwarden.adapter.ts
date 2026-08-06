import {
  type ISecretManagerAdapter,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretListItem,
  type BitwardenCredentials,
  BitwardenCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal surface of @bitwarden/sdk-napi used here (dynamically imported). */
interface BwSecretsClient {
  get(id: string): Promise<{ id: string; key: string; value: string; revisionDate: Date }>;
  list(organizationId: string): Promise<{ data: Array<{ id: string; key: string }> }>;
}
interface BwClient {
  auth(): { loginAccessToken(accessToken: string): Promise<void> };
  secrets(): BwSecretsClient;
}

/**
 * Bitwarden Secrets Manager adapter backed by a machine account access token
 * (read/resolve only). Values are end-to-end encrypted; the official SDK
 * handles decryption with the key embedded in the access token.
 *
 * Reference format: bitwarden://<secret-uuid> or bitwarden://<secret-key-name>
 * (names are matched against the organization's secret list).
 */
export class BitwardenAdapter implements ISecretManagerAdapter {
  readonly name = 'bitwarden' as const;

  private credentials: BitwardenCredentials | null = null;
  private client: BwClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = BitwardenCredentialsSchema.parse(credentials);
    this.client = null;
  }

  private async getClient(): Promise<BwClient> {
    if (this.client) return this.client;
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const { BitwardenClient } = await import('@bitwarden/sdk-napi');
    const client = new BitwardenClient({
      ...(this.credentials.apiUrl ? { apiUrl: this.credentials.apiUrl } : {}),
      ...(this.credentials.identityUrl ? { identityUrl: this.credentials.identityUrl } : {}),
    }) as unknown as BwClient;
    await client.auth().loginAccessToken(this.credentials.accessToken);
    this.client = client;
    return client;
  }

  /** Resolve a ref path (uuid or key name) to a secret id. */
  private async resolveSecretId(client: BwClient, path: string): Promise<string> {
    if (UUID_RE.test(path)) return path;
    const list = await client.secrets().list(this.credentials!.organizationId);
    const match = list.data.find((s) => s.key === path);
    if (!match) {
      throw new Error(`No Bitwarden secret named "${path}" in organization ${this.credentials!.organizationId}`);
    }
    return match.id;
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      const client = await this.getClient();
      await client.secrets().list(this.credentials!.organizationId);
      return {
        success: true,
        identity: `Bitwarden Secrets Manager (org ${this.credentials!.organizationId})`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, _key?: string, _version?: string): Promise<ResolvedSecret> {
    const client = await this.getClient();
    const id = await this.resolveSecretId(client, path);
    const secret = await client.secrets().get(id);
    return { value: secret.value };
  }

  async listSecrets(_pathPrefix?: string): Promise<SecretListItem[]> {
    const client = await this.getClient();
    const list = await client.secrets().list(this.credentials!.organizationId);
    return list.data.map((s) => ({ path: s.key }));
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'bitwarden',
    displayName: 'Bitwarden Secrets Manager',
    credentialsSchema: BitwardenCredentialsSchema,
    setupHelpUrl: 'https://bitwarden.com/help/access-tokens/',
  },
  factory: () => new BitwardenAdapter(),
});
