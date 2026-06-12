import {
  type ISecretManagerAdapter,
  type SecretManagerCapabilities,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretReference,
  type SecretListItem,
  type SecretReceipt,
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

  readonly capabilities: SecretManagerCapabilities = {
    supportsVersioning: false,
    supportsMultipleKeys: false, // Each Bitwarden secret is a single key/value
    supportsRotation: false,
    supportsAuditLog: true, // Bitwarden event logs
    supportsDynamicSecrets: false,
  };

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
        capabilities: this.capabilities,
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

  async getSecrets(references: SecretReference[]): Promise<Map<string, ResolvedSecret>> {
    const results = new Map<string, ResolvedSecret>();
    if (references.length === 0) return results;

    let client: BwClient;
    try {
      client = await this.getClient();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      for (const ref of references) {
        results.set(ref.raw, { value: '', metadata: { error: errorMsg } });
      }
      return results;
    }

    for (const ref of references) {
      try {
        const id = await this.resolveSecretId(client, ref.path);
        const secret = await client.secrets().get(id);
        results.set(ref.raw, { value: secret.value });
      } catch (error) {
        results.set(ref.raw, {
          value: '',
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    return results;
  }

  async setSecret(path: string, _values: Record<string, string>): Promise<SecretReceipt> {
    return {
      success: false,
      path,
      error: 'The Bitwarden integration is resolve-only. Create or edit secrets in Bitwarden Secrets Manager, then reference them with bitwarden://<name-or-id>.',
    };
  }

  async deleteSecret(path: string): Promise<SecretReceipt> {
    return {
      success: false,
      path,
      error: 'The Bitwarden integration is resolve-only. Delete secrets in Bitwarden Secrets Manager directly.',
    };
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
  defaultCapabilities: {
    supportsVersioning: false,
    supportsMultipleKeys: false,
    supportsRotation: false,
    supportsAuditLog: true,
    supportsDynamicSecrets: false,
  },
});
