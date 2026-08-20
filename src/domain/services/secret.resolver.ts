import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseSecretRef, type ISecretManagerAdapter } from '../ports/secretmanager.port.js';
import { secretManagerRegistry } from '../registry/secretmanager.registry.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { getProjectScopeHints } from './project-scope.js';

/** Resolve one registered secret-manager reference on demand. */
export class SecretResolver {
  private readonly connectionRepo = new ConnectionRepository();
  private readonly projectRepo = new ProjectRepository();
  private readonly secretStore = getSecretStore();

  async resolveSecret(
    secretRef: string,
    context?: { projectId?: string; environmentName?: string }
  ): Promise<{ value: string; version?: string } | { error: string }> {
    const ref = parseSecretRef(secretRef);
    if (!ref) return { error: 'Invalid or unsupported secret reference' };

    try {
      const project = context?.projectId ? this.projectRepo.findById(context.projectId) : null;
      const adapter = await this.getAdapter(
        ref.provider,
        project ? getProjectScopeHints(project) : undefined
      );
      const secret = await adapter.getSecret(ref.path, ref.key, ref.version);
      return { value: secret.value, version: secret.version };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async getAdapter(provider: string, scopeHints?: string[]): Promise<ISecretManagerAdapter> {
    const connection = this.connectionRepo.findBestMatchFromHints(provider, scopeHints);
    if (!connection) {
      const metadata = secretManagerRegistry.getMetadata(provider);
      if (metadata?.credentials?.supportsNativeCliAuth) {
        const credentials = { authMode: 'default' };
        const adapter = secretManagerRegistry.createAdapter(provider, credentials);
        await adapter.connect(credentials);
        return adapter;
      }
      throw new Error(`No connection found for secret manager '${provider}'. ${formatConnectionGuidance(provider)}`);
    }
    if (connection.status !== 'verified') {
      throw new Error(`Connection for '${provider}' is not verified (status: ${connection.status}). ${formatConnectionGuidance(provider)}`);
    }

    const credentials = this.secretStore.decryptObject(connection.credentialsEncrypted);
    const adapter = secretManagerRegistry.createAdapter(provider, credentials);
    await adapter.connect(credentials);
    return adapter;
  }
}
