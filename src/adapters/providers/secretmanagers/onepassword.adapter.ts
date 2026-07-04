import {
  type ISecretManagerAdapter,
  type SecretManagerCapabilities,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretReference,
  type SecretListItem,
  type SecretReceipt,
  type OnePasswordCredentials,
  OnePasswordCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

/** Minimal surface of @1password/sdk used here (the SDK is dynamically imported). */
interface OpClient {
  secrets: {
    resolve(secretReference: string): Promise<string>;
    resolveAll(secretReferences: string[]): Promise<{
      individualResponses: Record<
        string,
        { content?: { secret: string }; error?: { type: string; message?: string } }
      >;
    }>;
  };
  vaults: {
    list(): Promise<Array<{ id: string; title: string }>>;
  };
  items: {
    list(vaultId: string): Promise<Array<{ id: string; title: string }>>;
  };
}

/**
 * 1Password adapter backed by a service account token (read/resolve only).
 *
 * Reference format: 1password://<vault>/<item>[/<section>]#<field>
 * which maps to 1Password's op://<vault>/<item>[/<section>]/<field>.
 * When no #field is given, the conventional "password" field is used.
 *
 * Guidance: create a dedicated vault per project and grant the service
 * account access to only that vault.
 */
export class OnePasswordAdapter implements ISecretManagerAdapter {
  readonly name = '1password' as const;

  readonly capabilities: SecretManagerCapabilities = {
    supportsVersioning: false,
    supportsMultipleKeys: true, // Items hold multiple fields
    supportsRotation: false,
    supportsAuditLog: false,
    supportsDynamicSecrets: false,
  };

  private credentials: OnePasswordCredentials | null = null;
  private client: OpClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = OnePasswordCredentialsSchema.parse(credentials);
    this.client = null;
  }

  private async getClient(): Promise<OpClient> {
    if (this.client) return this.client;
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const { createClient } = await import('@1password/sdk');
    this.client = await createClient({
      auth: this.credentials.serviceAccountToken,
      integrationName: 'Hypervibe',
      integrationVersion: '1.0.0',
    });
    return this.client;
  }

  /** 1password ref path/key → op:// reference understood by the SDK. */
  private toOpReference(path: string, key?: string): string {
    return `op://${path}/${key ?? 'password'}`;
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      const client = await this.getClient();
      const vaults = await client.vaults.list();
      if (vaults.length === 0) {
        return {
          success: false,
          error: 'The 1Password service account token is valid but has access to no vaults. Grant the service account access to the vault(s) Hypervibe should read.',
        };
      }
      return {
        success: true,
        identity: '1Password service account',
        capabilities: this.capabilities,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, _version?: string): Promise<ResolvedSecret> {
    const client = await this.getClient();
    const value = await client.secrets.resolve(this.toOpReference(path, key));
    return { value };
  }

  async getSecrets(references: SecretReference[]): Promise<Map<string, ResolvedSecret>> {
    const results = new Map<string, ResolvedSecret>();
    if (references.length === 0) return results;

    try {
      const client = await this.getClient();
      const opRefs = new Map(references.map((ref) => [ref.raw, this.toOpReference(ref.path, ref.key)]));
      const response = await client.secrets.resolveAll([...new Set(opRefs.values())]);

      for (const ref of references) {
        const opRef = opRefs.get(ref.raw)!;
        const individual = response.individualResponses[opRef];
        if (individual?.content) {
          results.set(ref.raw, { value: individual.content.secret });
        } else {
          const error = individual?.error
            ? `${individual.error.type}${individual.error.message ? `: ${individual.error.message}` : ''}`
            : 'Secret not found';
          results.set(ref.raw, { value: '', metadata: { error } });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      for (const ref of references) {
        results.set(ref.raw, { value: '', metadata: { error: errorMsg } });
      }
    }

    return results;
  }

  async setSecret(path: string, _values: Record<string, string>): Promise<SecretReceipt> {
    return {
      success: false,
      path,
      error: 'The 1Password integration is resolve-only. Create or edit items in 1Password, then reference them with 1password://<vault>/<item>#<field>.',
    };
  }

  async deleteSecret(path: string): Promise<SecretReceipt> {
    return {
      success: false,
      path,
      error: 'The 1Password integration is resolve-only. Delete items in 1Password directly.',
    };
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const client = await this.getClient();
    const vaults = await client.vaults.list();
    const results: SecretListItem[] = [];

    for (const vault of vaults) {
      const items = await client.items.list(vault.id);
      for (const item of items) {
        const path = `${vault.title}/${item.title}`;
        if (pathPrefix && !path.startsWith(pathPrefix)) continue;
        results.push({ path });
      }
    }

    return results;
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: '1password',
    displayName: '1Password',
    credentialsSchema: OnePasswordCredentialsSchema,
    setupHelpUrl: 'https://www.1password.dev/service-accounts/',
  },
  factory: () => new OnePasswordAdapter(),
  defaultCapabilities: {
    supportsVersioning: false,
    supportsMultipleKeys: true,
    supportsRotation: false,
    supportsAuditLog: false,
    supportsDynamicSecrets: false,
  },
});
