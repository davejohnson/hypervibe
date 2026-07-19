import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type {
  Receipt,
  DeployResult,
  VerifyResult,
  JobResult,
  DeploymentMutationOptions,
} from './provider.port.js';

/**
 * Capabilities that a hosting platform supports.
 * Used to determine what features are available for a given platform.
 */
export interface HostingCapabilities {
  /** Build methods the platform supports */
  supportedBuilders: Array<'nixpacks' | 'dockerfile' | 'buildpack' | 'static'>;

  /** Whether the platform can auto-wire database connections from components */
  supportsAutoWiring: boolean;

  /** Whether health check endpoints are configurable */
  supportsHealthChecks: boolean;

  /** Whether cron/scheduled jobs are supported */
  supportsCronSchedule: boolean;

  /** Whether release commands (run before deploy) are supported */
  supportsReleaseCommand: boolean;

  /** Whether multiple environments per project are supported natively */
  supportsMultiEnvironment: boolean;

  /** Whether the platform manages TLS certificates automatically */
  managedTls: boolean;

  /** Whether auto-scaling is available */
  supportsAutoScaling: boolean;

  /** Whether the adapter can read back live state via observe() */
  supportsObserve: boolean;

  /** Whether config can converge while exact-SHA CI remains the code release boundary. */
  supportsDeferredDeploy?: boolean;
}

/**
 * Standard binding keys used in platformBindings for hosting providers.
 * Each hosting adapter uses these keys to store its identifiers.
 */
export interface HostingBindings {
  /** Provider name (e.g., 'railway', 'cloudrun') */
  provider: string;

  /** External project/app ID on the hosting platform */
  projectId: string;

  /** External environment ID (if platform supports multi-env) */
  environmentId?: string;

  /** Map of service names to their external IDs */
  services: Record<string, {
    serviceId: string;
    url?: string;
    customDomains?: string[];
    imageUri?: string;
    workloadKind?: string;
    resourceType?: string;
    jobName?: string;
    schedulerJobName?: string;
    source?: {
      repo?: string;
      branch?: string;
    };
  }>;
}

/**
 * Tolerant runtime schema for platformBindings blobs. Passthrough at every
 * level so provider-specific extras (ci sync metadata, Railway rebind data,
 * scheduler bindings) survive a parse round-trip; every field optional so
 * legacy rows never throw. Use parseHostingBindings for reads.
 */
export const hostingBindingsSchema = z.object({
  provider: z.string().optional(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  services: z.record(
    z.object({
      serviceId: z.string().optional(),
      url: z.string().optional(),
      customDomains: z.array(z.string()).optional(),
      imageUri: z.string().optional(),
      workloadKind: z.string().optional(),
      resourceType: z.string().optional(),
      jobName: z.string().optional(),
      schedulerJobName: z.string().optional(),
      source: z.object({
        repo: z.string().optional(),
        branch: z.string().optional(),
      }).passthrough().optional(),
    }).passthrough()
  ).optional(),
}).passthrough();

export type ParsedHostingBindings = z.infer<typeof hostingBindingsSchema>;

/**
 * Read an environment's platformBindings as HostingBindings-shaped data.
 * Never throws: malformed blobs (legacy rows, hand-edited files) return {}.
 */
export function parseHostingBindings(
  environment: Pick<Environment, 'platformBindings'> | null | undefined
): ParsedHostingBindings {
  const parsed = hostingBindingsSchema.safeParse(environment?.platformBindings ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Interface for hosting platform adapters.
 * Hosting adapters handle deploying services to cloud platforms.
 */
export interface IHostingAdapter {
  readonly name: string;

  /** Platform capabilities */
  readonly capabilities: HostingCapabilities;

  /**
   * Connect to the hosting platform with credentials
   */
  connect(credentials: unknown): Promise<void>;

  /**
   * Verify the connection and credentials are valid
   */
  verify(): Promise<VerifyResult>;

  /**
   * Disconnect and clean up
   */
  disconnect?(): Promise<void>;

  /**
   * Ensure a project/app exists on the hosting platform.
   * Creates one if it doesn't exist, or verifies the existing one.
   * Returns the external project ID in receipt.data.projectId
   */
  ensureProject(projectName: string, environment: Environment): Promise<Receipt>;

  /**
   * Deploy a service to the hosting platform.
   * Includes setting environment variables and triggering the deployment.
   */
  deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<DeployResult>;

  /**
   * Update environment variables for a deployed service.
   */
  setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options?: DeploymentMutationOptions
  ): Promise<Receipt>;

  /**
   * Delete only explicitly retired environment variable names. Omitted
   * variables are not deletions.
   */
  deleteEnvVars?(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt>;

  /**
   * Get the current deployment status.
   */
  getDeployStatus?(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }>;

  /**
   * Run a one-off command in a deployed service environment. Implementations
   * must wait for terminal completion and return status="completed" only
   * after a zero/successful exit.
   */
  runJob?(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult>;

  /**
   * Delete a provider project/app that was created by Hypervibe.
   * Optional because not all hosting providers expose this operation.
   */
  deleteProject?(projectId: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Delete a provider service/resource that was created by Hypervibe.
   * Optional because not all hosting providers expose this operation.
   */
  deleteService?(serviceId: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Get connection URL for a database component.
   * Used when the hosting platform also provides databases.
   */
  getDatabaseUrl?(
    environment: Environment,
    componentType: string
  ): Promise<string | null>;

  /**
   * Get runtime logs for a service (for error monitoring).
   * Used by the auto-fix agent to detect and analyze errors.
   */
  getLogs?(
    environment: Environment,
    serviceName: string,
    options?: GetLogsOptions
  ): Promise<LogEntry[]>;

  /**
   * Read back live state for an environment (services, config, env var
   * hashes, databases). Implemented when capabilities.supportsObserve is true.
   */
  observe?(environment: Environment): Promise<import('./observe.port.js').ObservedState>;
}

/**
 * Options for fetching logs from a hosting platform.
 */
export interface GetLogsOptions {
  /** Maximum number of log entries to return */
  limit?: number;
  /** Only return logs after this timestamp */
  since?: Date;
  /** Only return errors/warnings */
  errorsOnly?: boolean;
}

/**
 * A normalized log entry from any hosting platform.
 */
export interface LogEntry {
  /** When the log was emitted */
  timestamp: Date;
  /** The log message content */
  message: string;
  /** Log severity level */
  severity: 'info' | 'warn' | 'error';
  /** Raw log line as returned by the platform */
  raw: string;
}
