import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { Component, ComponentType } from '../entities/component.entity.js';

export interface Receipt {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Capabilities that a deployment provider supports.
 * Used to determine what features are available and how to configure deployments.
 */
export interface ProviderCapabilities {
  /** Build methods the platform supports */
  supportedBuilders: Array<'nixpacks' | 'dockerfile' | 'buildpack' | 'static'>;

  /** Component types the platform can provision (databases, caches) */
  supportedComponents: ComponentType[];

  /** Whether the platform can auto-wire database connections */
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
}

export interface ComponentResult {
  component: Component;
  receipt: Receipt;
}

export interface DeployResult {
  serviceId: string;
  externalId?: string;
  url?: string;
  status: 'deploying' | 'deployed' | 'failed';
  receipt: Receipt;
}

export interface JobResult {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  receipt: Receipt;
}

export interface ProjectInfo {
  id: string;
  name: string;
  environments?: Array<{ id: string; name: string }>;
}

export interface VerifyResult {
  success: boolean;
  error?: string;
  email?: string;
}

export interface IProviderAdapter {
  readonly name: string;

  /** Platform capabilities - describes what features this provider supports */
  readonly capabilities: ProviderCapabilities;

  connect(credentials: unknown): Promise<void>;
  verify(): Promise<VerifyResult>;
  disconnect?(): Promise<void>;

  ensureProject(
    projectName: string,
    environment: Environment
  ): Promise<Receipt>;

  ensureComponent(
    type: ComponentType,
    environment: Environment
  ): Promise<ComponentResult>;

  deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<DeployResult>;

  setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>
  ): Promise<Receipt>;

  getDeployStatus?(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }>;

  runJob?(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult>;
}
