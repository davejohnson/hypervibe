import type { NormalizedError, FetchErrorsOptions } from './types.js';

export type { NormalizedError, FetchErrorsOptions };

/**
 * Abstract interface for log watchers.
 * Each hosting platform implements this to fetch and normalize error logs.
 */
export abstract class LogWatcher {
  abstract readonly provider: string;

  /**
   * Fetch errors from a service's logs.
   *
   * @param environmentId - The environment ID (platform-specific)
   * @param serviceName - The name of the service to fetch logs from
   * @param options - Filtering options
   * @returns Normalized errors suitable for analysis
   */
  abstract fetchErrors(
    environmentId: string,
    serviceName: string,
    options?: FetchErrorsOptions
  ): Promise<NormalizedError[]>;

  /**
   * Check if this watcher can handle the given project.
   */
  abstract canHandle(projectId: string): Promise<boolean>;
}
