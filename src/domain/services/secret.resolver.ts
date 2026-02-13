import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { SecretMappingRepository, SecretAccessLogRepository } from '../../adapters/db/repositories/secret-mapping.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { secretManagerRegistry } from '../registry/secretmanager.registry.js';
import {
  parseSecretRef,
  type SecretReference,
  type ISecretManagerAdapter,
  type SecretManagerProvider,
} from '../ports/secretmanager.port.js';
import { getProjectScopeHints } from './project-scope.js';

export interface ResolveOptions {
  projectId: string;
  environmentName: string;
  serviceName?: string | null;
}

export interface ResolvedEnvVars {
  vars: Record<string, string>;
  errors: Array<{ envVar: string; secretRef: string; error: string }>;
  resolved: number;
  failed: number;
}

/**
 * Resolves secret references to actual values at deploy time.
 * Looks up secret mappings for a project/environment and fetches values from secret managers.
 */
export class SecretResolver {
  private mappingRepo = new SecretMappingRepository();
  private projectRepo = new ProjectRepository();
  private accessLogRepo = new SecretAccessLogRepository();
  private connectionRepo = new ConnectionRepository();
  private secretStore = getSecretStore();
  private adapterCache = new Map<string, ISecretManagerAdapter>();

  /**
   * Resolve all secret mappings for an environment into actual values.
   */
  async resolveForEnvironment(options: ResolveOptions): Promise<ResolvedEnvVars> {
    const mappings = this.mappingRepo.findByProjectEnvironmentAndService(
      options.projectId,
      options.environmentName,
      options.serviceName ?? null
    );

    if (mappings.length === 0) {
      return { vars: {}, errors: [], resolved: 0, failed: 0 };
    }

    const result: ResolvedEnvVars = {
      vars: {},
      errors: [],
      resolved: 0,
      failed: 0,
    };

    // Group by provider to batch requests
    const byProvider = new Map<SecretManagerProvider, Array<{ envVar: string; ref: SecretReference }>>();

    for (const mapping of mappings) {
      const ref = parseSecretRef(mapping.secretRef);
      if (!ref) {
        result.errors.push({
          envVar: mapping.envVar,
          secretRef: mapping.secretRef,
          error: 'Invalid secret reference format',
        });
        result.failed++;
        continue;
      }

      if (!byProvider.has(ref.provider)) {
        byProvider.set(ref.provider, []);
      }
      byProvider.get(ref.provider)!.push({ envVar: mapping.envVar, ref });
    }

    // Resolve secrets from each provider
    for (const [provider, items] of byProvider) {
      try {
        const project = this.projectRepo.findById(options.projectId);
        const scopeHints = project ? getProjectScopeHints(project) : undefined;
        const adapter = await this.getAdapter(provider, scopeHints);
        const refs = items.map((i) => i.ref);
        const secrets = await adapter.getSecrets(refs);

        for (const { envVar, ref } of items) {
          const secret = secrets.get(ref.raw);

          if (!secret || secret.metadata?.error) {
            const error = secret?.metadata?.error || 'Secret not found';
            result.errors.push({ envVar, secretRef: ref.raw, error });
            result.failed++;

            this.accessLogRepo.create({
              action: 'read',
              provider,
              secretPath: ref.path,
              projectId: options.projectId,
              environmentName: options.environmentName,
              success: false,
              error,
            });
          } else {
            result.vars[envVar] = secret.value;
            result.resolved++;

            this.accessLogRepo.create({
              action: 'read',
              provider,
              secretPath: ref.path,
              projectId: options.projectId,
              environmentName: options.environmentName,
              success: true,
            });
          }
        }
      } catch (error) {
        // Provider-level error affects all secrets from this provider
        const errorMsg = error instanceof Error ? error.message : String(error);
        for (const { envVar, ref } of items) {
          result.errors.push({ envVar, secretRef: ref.raw, error: errorMsg });
          result.failed++;

          this.accessLogRepo.create({
            action: 'read',
            provider,
            secretPath: ref.path,
            projectId: options.projectId,
            environmentName: options.environmentName,
            success: false,
            error: errorMsg,
          });
        }
      }
    }

    return result;
  }

  /**
   * Resolve a single secret reference.
   */
  async resolveSecret(
    secretRef: string,
    context?: { projectId?: string; environmentName?: string }
  ): Promise<{ value: string; version?: string } | { error: string }> {
    const ref = parseSecretRef(secretRef);
    if (!ref) {
      return { error: 'Invalid secret reference format' };
    }

    try {
      const project = context?.projectId ? this.projectRepo.findById(context.projectId) : null;
      const scopeHints = project ? getProjectScopeHints(project) : undefined;
      const adapter = await this.getAdapter(ref.provider, scopeHints);
      const secret = await adapter.getSecret(ref.path, ref.key, ref.version);

      this.accessLogRepo.create({
        action: 'read',
        provider: ref.provider,
        secretPath: ref.path,
        projectId: context?.projectId,
        environmentName: context?.environmentName,
        success: true,
      });

      return { value: secret.value, version: secret.version };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.accessLogRepo.create({
        action: 'read',
        provider: ref.provider,
        secretPath: ref.path,
        projectId: context?.projectId,
        environmentName: context?.environmentName,
        success: false,
        error: errorMsg,
      });

      return { error: errorMsg };
    }
  }

  /**
   * Get or create a connected adapter for a provider.
   */
  private async getAdapter(
    provider: SecretManagerProvider,
    scopeHints?: string[]
  ): Promise<ISecretManagerAdapter> {
    const cacheKey = `${provider}|${(scopeHints ?? []).join('|')}`;
    if (this.adapterCache.has(cacheKey)) {
      return this.adapterCache.get(cacheKey)!;
    }

    // Find connection for this provider
    const connection = this.connectionRepo.findBestMatchFromHints(provider, scopeHints);
    if (!connection) {
      throw new Error(`No connection found for secret manager '${provider}'. Use connection_create first.`);
    }

    if (connection.status !== 'verified') {
      throw new Error(`Connection for '${provider}' is not verified (status: ${connection.status})`);
    }

    // Decrypt credentials and create adapter
    const credentials = this.secretStore.decryptObject(connection.credentialsEncrypted);
    const adapter = secretManagerRegistry.createAdapter(provider, credentials);
    await adapter.connect(credentials);

    this.adapterCache.set(cacheKey, adapter);
    return adapter;
  }

  /**
   * Clear the adapter cache (useful if connections change).
   */
  clearCache(): void {
    this.adapterCache.clear();
  }
}
