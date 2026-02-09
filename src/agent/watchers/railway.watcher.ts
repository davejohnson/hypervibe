import { LogWatcher, type NormalizedError, type FetchErrorsOptions } from './log-watcher.js';
import { groupConsecutiveErrors, isErrorLog } from './types.js';
import { RailwayAdapter, type RailwayCredentials, type RailwayLogEntry } from '../../adapters/providers/railway/railway.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

/**
 * Log watcher for Railway deployments.
 * Uses the existing RailwayAdapter to fetch deployment logs.
 */
export class RailwayLogWatcher extends LogWatcher {
  readonly provider = 'railway';

  private adapter: RailwayAdapter;
  private envRepo: EnvironmentRepository;

  private constructor(adapter: RailwayAdapter) {
    super();
    this.adapter = adapter;
    this.envRepo = new EnvironmentRepository();
  }

  /**
   * Create a Railway log watcher if Railway credentials are available.
   */
  static async create(): Promise<RailwayLogWatcher | null> {
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.findByProvider('railway');

    if (!connection) {
      console.log('No Railway connection found');
      return null;
    }

    try {
      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);

      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      // Verify connection
      const verified = await adapter.verify();
      if (!verified.success) {
        console.error('Railway connection verification failed:', verified.error);
        return null;
      }

      return new RailwayLogWatcher(adapter);
    } catch (error) {
      console.error('Failed to create Railway log watcher:', error);
      return null;
    }
  }

  async canHandle(projectId: string): Promise<boolean> {
    // Check if any environment in this project has Railway bindings
    const envs = this.envRepo.findByProjectId(projectId);
    return envs.some((env) => {
      const bindings = env.platformBindings as { railwayProjectId?: string };
      return !!bindings.railwayProjectId;
    });
  }

  async fetchErrors(
    environmentId: string,
    serviceName: string,
    options?: FetchErrorsOptions
  ): Promise<NormalizedError[]> {
    // Find the environment
    const env = this.envRepo.findById(environmentId);
    if (!env) {
      console.warn(`Environment not found: ${environmentId}`);
      return [];
    }

    const bindings = env.platformBindings as {
      railwayProjectId?: string;
      railwayEnvironmentId?: string;
      services?: Record<string, { serviceId: string }>;
    };

    if (!bindings.railwayProjectId || !bindings.railwayEnvironmentId) {
      console.warn('Environment not bound to Railway');
      return [];
    }

    const serviceBinding = bindings.services?.[serviceName];
    if (!serviceBinding) {
      console.warn(`Service ${serviceName} not found in Railway bindings`);
      return [];
    }

    try {
      // Get latest deployment
      const deployments = await this.adapter.getDeployments(
        bindings.railwayProjectId,
        bindings.railwayEnvironmentId,
        serviceBinding.serviceId,
        1
      );

      if (deployments.length === 0) {
        console.log('No deployments found');
        return [];
      }

      const deployment = deployments[0];

      // Fetch logs
      const limit = options?.limit ? options.limit * 10 : 500; // Fetch more to filter
      const logs = await this.adapter.getDeploymentLogs(deployment.id, limit);

      // Filter by timestamp if specified
      let filteredLogs = logs;
      if (options?.since) {
        filteredLogs = logs.filter((log) => new Date(log.timestamp) > options.since!);
      }

      // Group consecutive error logs
      const errorGroups = groupConsecutiveErrors(
        filteredLogs.filter((log) => isErrorLog(log.message, log.severity))
      );

      // Convert to normalized errors
      const errors: NormalizedError[] = errorGroups.map((group) => {
        const firstLine = group.lines[0];
        const stackLines = group.lines.slice(1).filter((l) => /^\s+at\s/.test(l));

        return {
          timestamp: new Date(group.timestamp),
          message: firstLine,
          stackTrace: stackLines.length > 0 ? stackLines.join('\n') : undefined,
          serviceName,
          environmentName: env.name,
          projectId: env.projectId,
          rawLines: group.lines,
          errorType: this.extractErrorType(firstLine),
        };
      });

      // Limit results
      const maxErrors = options?.limit ?? 10;
      return errors.slice(0, maxErrors);

    } catch (error) {
      console.error('Failed to fetch Railway logs:', error);
      return [];
    }
  }

  /**
   * Extract error type from a log message.
   */
  private extractErrorType(message: string): string | undefined {
    // Common patterns
    const patterns = [
      /^(\w+Error):/,           // TypeError:, ReferenceError:, etc.
      /^(\w+Exception):/,       // NullPointerException:, etc.
      /^Error: (\w+):/,         // Error: ENOENT:, etc.
      /^Uncaught (\w+Error)/,   // Uncaught TypeError
      /^\[(\w+Error)\]/,        // [DatabaseError]
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }
}
