import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { Component, ComponentType } from '../entities/component.entity.js';

export interface Receipt {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
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
