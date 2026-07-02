import { LogWatcher, type NormalizedError, type FetchErrorsOptions } from './log-watcher.js';
import { groupConsecutiveErrors, isErrorLog, normalizeErrorGroups } from './types.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { parseHostingBindings } from '../../domain/ports/hosting.port.js';

/**
 * Log watcher for Cloud Run deployments.
 * Delegates to CloudRunAdapter.getLogs, which resolves service vs
 * scheduled-job bindings and returns severity-normalized entries.
 */
export class CloudRunLogWatcher extends LogWatcher {
  readonly provider = 'cloudrun';

  private adapter: CloudRunAdapter;
  private envRepo: EnvironmentRepository;

  private constructor(adapter: CloudRunAdapter) {
    super();
    this.adapter = adapter;
    this.envRepo = new EnvironmentRepository();
  }

  /**
   * Create a Cloud Run log watcher if GCP credentials are available.
   */
  static async create(): Promise<CloudRunLogWatcher | null> {
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.findByProvider('cloudrun');

    if (!connection) {
      console.log('No Cloud Run connection found');
      return null;
    }

    try {
      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<Record<string, unknown>>(connection.credentialsEncrypted);

      const adapter = new CloudRunAdapter();
      await adapter.connect(credentials);

      // Verify connection
      const verified = await adapter.verify();
      if (!verified.success) {
        console.error('Cloud Run connection verification failed:', verified.error);
        return null;
      }

      return new CloudRunLogWatcher(adapter);
    } catch (error) {
      console.error('Failed to create Cloud Run log watcher:', error);
      return null;
    }
  }

  async canHandle(projectId: string): Promise<boolean> {
    // Check if any environment in this project has Cloud Run bindings
    const envs = this.envRepo.findByProjectId(projectId);
    return envs.some((env) => {
      const bindings = parseHostingBindings(env);
      return bindings.provider === 'cloudrun' && !!bindings.projectId;
    });
  }

  async fetchErrors(
    environmentId: string,
    serviceName: string,
    options?: FetchErrorsOptions
  ): Promise<NormalizedError[]> {
    const env = this.envRepo.findById(environmentId);
    if (!env) {
      console.warn(`Environment not found: ${environmentId}`);
      return [];
    }

    const bindings = parseHostingBindings(env);
    if (bindings.provider !== 'cloudrun') {
      console.warn('Environment not bound to Cloud Run');
      return [];
    }

    try {
      // Fetch more than requested so grouping/filtering has material to work with
      const limit = options?.limit ? options.limit * 10 : 500;
      const logs = await this.adapter.getLogs(env, serviceName, {
        limit,
        since: options?.since,
        errorsOnly: true,
      });

      const errorGroups = groupConsecutiveErrors(
        logs
          .map((log) => ({
            timestamp: log.timestamp.toISOString(),
            message: log.message,
            severity: log.severity,
          }))
          .filter((log) => isErrorLog(log.message, log.severity))
      );

      const errors = normalizeErrorGroups(errorGroups, {
        serviceName,
        environmentName: env.name,
        projectId: env.projectId,
      });

      const maxErrors = options?.limit ?? 10;
      return errors.slice(0, maxErrors);
    } catch (error) {
      console.error('Failed to fetch Cloud Run logs:', error);
      return [];
    }
  }
}
