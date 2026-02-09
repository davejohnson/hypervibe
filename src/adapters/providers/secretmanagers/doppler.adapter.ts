import {
  type ISecretManagerAdapter,
  type SecretManagerCapabilities,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretReference,
  type SecretListItem,
  type SecretReceipt,
  type DopplerCredentials,
  DopplerCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

const DOPPLER_API_URL = 'https://api.doppler.com/v3';

interface DopplerSecret {
  name: string;
  value: {
    raw: string;
    computed: string;
  };
}

interface DopplerSecretsResponse {
  secrets: Record<string, DopplerSecret>;
}

interface DopplerProjectResponse {
  project: {
    id: string;
    name: string;
    created_at: string;
  };
}

export class DopplerAdapter implements ISecretManagerAdapter {
  readonly name = 'doppler' as const;

  readonly capabilities: SecretManagerCapabilities = {
    supportsVersioning: false, // Doppler has activity log but not secret versioning
    supportsMultipleKeys: false, // Each secret is a single key-value
    supportsRotation: false,
    supportsAuditLog: true, // Via activity logs
    supportsDynamicSecrets: false,
    maxSecretSize: 64 * 1024, // Estimated
  };

  private credentials: DopplerCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as DopplerCredentials;

    if (!this.credentials.token) {
      throw new Error('Doppler service token is required');
    }

    // Parse project and config from token if service token
    // Service tokens are scoped to project/config, so we may not need these
    // But they can be overridden in credentials
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      // Verify token by fetching secrets (will fail if invalid)
      await this.request<DopplerSecretsResponse>('GET', '/configs/config/secrets');
      return {
        success: true,
        identity: `Doppler (${this.credentials?.project || 'service token'})`,
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
    // In Doppler, "path" is just the secret name
    // Optionally with project/config prefix: project/config/SECRET_NAME
    const { project, config, secretName } = this.parsePath(path);

    const endpoint = this.buildEndpoint('/configs/config/secret', project, config);
    const response = await this.request<{ secret: DopplerSecret }>(
      'GET',
      `${endpoint}&name=${encodeURIComponent(secretName)}`
    );

    return {
      value: response.secret.value.computed,
    };
  }

  async getSecrets(references: SecretReference[]): Promise<Map<string, ResolvedSecret>> {
    const results = new Map<string, ResolvedSecret>();

    // Group by project/config to minimize API calls
    const grouped = new Map<string, { ref: SecretReference; secretName: string }[]>();

    for (const ref of references) {
      const { project, config, secretName } = this.parsePath(ref.path);
      const key = `${project || ''}/${config || ''}`;

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push({ ref, secretName });
    }

    // Fetch each group
    for (const [groupKey, items] of grouped) {
      const [project, config] = groupKey.split('/');
      try {
        const endpoint = this.buildEndpoint('/configs/config/secrets', project || undefined, config || undefined);
        const response = await this.request<DopplerSecretsResponse>('GET', endpoint);

        for (const { ref, secretName } of items) {
          const secret = response.secrets[secretName];
          if (secret) {
            results.set(ref.raw, { value: secret.value.computed });
          } else {
            results.set(ref.raw, {
              value: '',
              metadata: { error: `Secret '${secretName}' not found` },
            });
          }
        }
      } catch (error) {
        // Set error for all items in this group
        for (const { ref } of items) {
          results.set(ref.raw, {
            value: '',
            metadata: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    }

    return results;
  }

  async setSecret(path: string, values: Record<string, string>): Promise<SecretReceipt> {
    try {
      const { project, config } = this.parsePath(path);

      // Doppler sets multiple secrets at once
      const secrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        secrets[key] = value;
      }

      const endpoint = this.buildEndpoint('/configs/config/secrets', project, config);
      await this.request('POST', endpoint, { secrets });

      return {
        success: true,
        path,
      };
    } catch (error) {
      return {
        success: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteSecret(path: string): Promise<SecretReceipt> {
    try {
      const { project, config, secretName } = this.parsePath(path);

      const endpoint = this.buildEndpoint('/configs/config/secret', project, config);
      await this.request('DELETE', `${endpoint}&name=${encodeURIComponent(secretName)}`);

      return { success: true, path };
    } catch (error) {
      return {
        success: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const parsed = pathPrefix ? this.parsePath(pathPrefix) : { project: undefined, config: undefined, secretName: '' };
    const { project, config } = parsed;

    const endpoint = this.buildEndpoint('/configs/config/secrets', project, config);
    const response = await this.request<DopplerSecretsResponse>('GET', endpoint);

    return Object.keys(response.secrets).map((name) => ({
      path: name,
    }));
  }

  /**
   * Parse a Doppler path which can be:
   * - SECRET_NAME (uses token's default project/config)
   * - project/config/SECRET_NAME
   */
  private parsePath(path: string): { project?: string; config?: string; secretName: string } {
    const parts = path.split('/');

    if (parts.length >= 3) {
      return {
        project: parts[0],
        config: parts[1],
        secretName: parts.slice(2).join('/'),
      };
    }

    // Just a secret name
    return {
      project: this.credentials?.project,
      config: this.credentials?.config,
      secretName: path,
    };
  }

  private buildEndpoint(base: string, project?: string, config?: string): string {
    const params = new URLSearchParams();
    if (project) params.append('project', project);
    if (config) params.append('config', config);

    const queryString = params.toString();
    return queryString ? `${base}?${queryString}` : base;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.credentials?.token) {
      throw new Error('Not connected. Call connect() first.');
    }

    const url = endpoint.startsWith('http') ? endpoint : `${DOPPLER_API_URL}${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.credentials.token}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = `Doppler API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.messages) {
          errorMessage = errorJson.messages.join(', ');
        } else if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        if (responseText) {
          errorMessage = responseText;
        }
      }
      throw new Error(errorMessage);
    }

    return responseText ? (JSON.parse(responseText) as T) : ({} as T);
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'doppler',
    displayName: 'Doppler',
    credentialsSchema: DopplerCredentialsSchema,
    setupHelpUrl: 'https://docs.doppler.com/docs/service-tokens',
  },
  factory: (credentials) => {
    const adapter = new DopplerAdapter();
    return adapter;
  },
  defaultCapabilities: {
    supportsVersioning: false,
    supportsMultipleKeys: false,
    supportsRotation: false,
    supportsAuditLog: true,
    supportsDynamicSecrets: false,
    maxSecretSize: 64 * 1024,
  },
});
