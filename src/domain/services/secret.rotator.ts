import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { SecretMappingRepository, SecretAccessLogRepository } from '../../adapters/db/repositories/secret-mapping.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { secretManagerRegistry } from '../registry/secretmanager.registry.js';
import { adapterFactory } from './adapter.factory.js';
import {
  parseSecretRef,
  type ISecretManagerAdapter,
  type SecretManagerProvider,
  type RotationResult,
} from '../ports/secretmanager.port.js';

export interface RotateSyncResult {
  rotation: RotationResult;
  synced: Array<{
    projectId: string;
    environmentName: string;
    envVar: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Orchestrates secret rotation and propagation to mapped environments.
 */
export class SecretRotator {
  private mappingRepo = new SecretMappingRepository();
  private accessLogRepo = new SecretAccessLogRepository();
  private connectionRepo = new ConnectionRepository();
  private envRepo = new EnvironmentRepository();
  private serviceRepo = new ServiceRepository();
  private auditRepo = new AuditRepository();
  private secretStore = getSecretStore();

  /**
   * Rotate a secret and sync the new value to all mapped environments.
   */
  async rotateAndSync(
    provider: SecretManagerProvider,
    path: string
  ): Promise<RotateSyncResult> {
    const adapter = await this.getAdapter(provider);

    // Check if adapter supports rotation
    if (!adapter.rotateSecret) {
      throw new Error(`Provider '${provider}' does not support secret rotation`);
    }

    // Rotate the secret
    const rotation = await adapter.rotateSecret(path);

    this.accessLogRepo.create({
      action: 'rotate',
      provider,
      secretPath: path,
      success: rotation.success,
      error: rotation.error,
    });

    if (!rotation.success) {
      return {
        rotation,
        synced: [],
      };
    }

    // Find all mappings that reference this secret
    // Match by provider://path (ignoring key and version)
    const secretRefPrefix = `${provider}://${path}`;
    const mappings = this.mappingRepo.findBySecretPathPrefix(path).filter((m) => {
      const ref = parseSecretRef(m.secretRef);
      return ref && ref.provider === provider;
    });

    const synced: RotateSyncResult['synced'] = [];

    // Group mappings by project+environment
    const byEnv = new Map<string, typeof mappings>();
    for (const mapping of mappings) {
      // Get all environments this mapping applies to
      const envs = mapping.environments.length > 0
        ? mapping.environments
        : this.envRepo.findByProjectId(mapping.projectId).map((e) => e.name);

      for (const envName of envs) {
        const key = `${mapping.projectId}:${envName}`;
        if (!byEnv.has(key)) {
          byEnv.set(key, []);
        }
        byEnv.get(key)!.push(mapping);
      }
    }

    // Sync to each environment
    for (const [key, envMappings] of byEnv) {
      const [projectId, environmentName] = key.split(':');
      const env = this.envRepo.findByProjectAndName(projectId, environmentName);
      if (!env) continue;

      // Resolve the new secret value for each mapping
      const varsToSync: Record<string, string> = {};

      for (const mapping of envMappings) {
        const ref = parseSecretRef(mapping.secretRef);
        if (!ref) continue;

        try {
          const secret = await adapter.getSecret(ref.path, ref.key, undefined); // Get latest version
          varsToSync[mapping.envVar] = secret.value;

          synced.push({
            projectId,
            environmentName,
            envVar: mapping.envVar,
            success: true,
          });
        } catch (error) {
          synced.push({
            projectId,
            environmentName,
            envVar: mapping.envVar,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Push to hosting platform
      if (Object.keys(varsToSync).length > 0) {
        try {
          // Get project for adapter
          const { ProjectRepository } = await import('../../adapters/db/repositories/project.repository.js');
          const projectRepo = new ProjectRepository();
          const project = projectRepo.findById(projectId);

          if (project) {
            const adapterResult = await adapterFactory.getHostingAdapter(project);
            if (adapterResult.success && adapterResult.adapter) {
              // Get first service for the project to set vars on
              const services = this.serviceRepo.findByProjectId(projectId);
              const targetService = services[0];

              if (targetService) {
                await adapterResult.adapter.setEnvVars(env, targetService, varsToSync);

                this.auditRepo.create({
                  action: 'secret.rotated_and_synced',
                  resourceType: 'environment',
                  resourceId: env.id,
                  details: {
                    provider,
                    secretPath: path,
                    varsUpdated: Object.keys(varsToSync),
                    newVersion: rotation.newVersion,
                  },
                });
              }
            }
          }
        } catch (error) {
          // Mark all as failed for this environment
          for (const s of synced) {
            if (s.projectId === projectId && s.environmentName === environmentName && s.success) {
              s.success = false;
              s.error = `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
      }
    }

    return { rotation, synced };
  }

  /**
   * Get an adapter for a provider.
   */
  private async getAdapter(provider: SecretManagerProvider): Promise<ISecretManagerAdapter> {
    const connection = this.connectionRepo.findByProvider(provider);
    if (!connection) {
      throw new Error(`No connection found for secret manager '${provider}'. Use connection_create first.`);
    }

    if (connection.status !== 'verified') {
      throw new Error(`Connection for '${provider}' is not verified (status: ${connection.status})`);
    }

    const credentials = this.secretStore.decryptObject(connection.credentialsEncrypted);
    const adapter = secretManagerRegistry.createAdapter(provider, credentials);
    await adapter.connect(credentials);

    return adapter;
  }
}
