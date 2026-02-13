import { z } from 'zod';
import type {
  IProviderAdapter,
  Receipt,
  ComponentResult,
  DeployResult,
  JobResult,
  ProviderCapabilities,
} from '../../../domain/ports/provider.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const AppRunnerCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, 'Access key ID is required'),
  secretAccessKey: z.string().min(1, 'Secret access key is required'),
  region: z.string().default('us-east-1'),
});

export type AppRunnerCredentials = z.infer<typeof AppRunnerCredentialsSchema>;

interface AppRunnerService {
  ServiceId: string;
  ServiceName: string;
  ServiceArn: string;
  ServiceUrl?: string;
  Status: string;
}

interface AppRunnerOperation {
  Id: string;
  Status: string;
  Type: string;
}

export class AppRunnerAdapter implements IProviderAdapter {
  readonly name = 'apprunner';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [], // RDS is separate
    supportsAutoWiring: false, // Manual env var setup needed
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per env
    managedTls: true,
  };

  private credentials: AppRunnerCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as AppRunnerCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      // List services to verify credentials
      await this.appRunnerRequest('ListServices', {});
      return { success: true, email: `AWS Account (${this.credentials.region})` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    // App Runner doesn't have "projects" - each service is standalone
    // We use naming convention to group services
    const bindings = environment.platformBindings as {
      projectId?: string;
      provider?: string;
    };

    const projectId = bindings.projectId || `${projectName}-${environment.name}`;

    return {
      success: true,
      message: `Using App Runner service prefix: ${projectId}`,
      data: { projectId, projectName },
    };
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    // App Runner doesn't provision databases
    // Users should use RDS separately
    const emptyComponent: Component = {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return {
      component: emptyComponent,
      receipt: {
        success: false,
        message: `App Runner does not provision databases. Use the RDS adapter separately, then pass DATABASE_URL as an env var.`,
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>
  ): Promise<DeployResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      projectId?: string;
      services?: Record<string, { serviceId: string; serviceArn?: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';
    const serviceName = `${prefix}-${service.name}`;

    try {
      // Check if service exists
      let appRunnerService: AppRunnerService | null = null;
      const existingServiceArn = bindings.services?.[service.name]?.serviceArn;

      if (existingServiceArn) {
        try {
          const describeResponse = await this.appRunnerRequest<{
            Service: AppRunnerService;
          }>('DescribeService', {
            ServiceArn: existingServiceArn,
          });
          appRunnerService = describeResponse.Service;
        } catch {
          // Service doesn't exist anymore
        }
      }

      if (!appRunnerService) {
        // Create new service
        // Note: This requires an ECR image or source code connection
        const createResponse = await this.appRunnerRequest<{
          Service: AppRunnerService;
          OperationId: string;
        }>('CreateService', {
          ServiceName: serviceName,
          SourceConfiguration: {
            // For now, assume ECR image source
            // In production, you'd want to support both code and image
            ImageRepository: {
              ImageIdentifier: envVars['IMAGE_URI'] || `${prefix}/${service.name}:latest`,
              ImageRepositoryType: 'ECR',
              ImageConfiguration: {
                Port: envVars['PORT'] || '8080',
                RuntimeEnvironmentVariables: this.formatEnvVars(envVars),
              },
            },
            AutoDeploymentsEnabled: true,
          },
          InstanceConfiguration: {
            Cpu: '256', // 0.25 vCPU
            Memory: '512', // 512 MB
          },
        });

        appRunnerService = createResponse.Service;
      } else {
        // Update existing service with new env vars
        await this.appRunnerRequest('UpdateService', {
          ServiceArn: appRunnerService.ServiceArn,
          SourceConfiguration: {
            ImageRepository: {
              ImageConfiguration: {
                RuntimeEnvironmentVariables: this.formatEnvVars(envVars),
              },
            },
          },
        });
      }

      const url = appRunnerService.ServiceUrl
        ? `https://${appRunnerService.ServiceUrl}`
        : undefined;

      return {
        serviceId: service.id,
        externalId: appRunnerService.ServiceId,
        url,
        status: 'deploying',
        receipt: {
          success: true,
          message: `App Runner service ${appRunnerService.Status}: ${serviceName}`,
          data: {
            serviceId: appRunnerService.ServiceId,
            serviceArn: appRunnerService.ServiceArn,
            url,
          },
        },
      };
    } catch (error) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: `Deployment failed for ${service.name}`,
          error: String(error),
        },
      };
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>
  ): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as {
      services?: Record<string, { serviceArn?: string }>;
    };

    const serviceArn = bindings.services?.[service.name]?.serviceArn;
    if (!serviceArn) {
      return {
        success: false,
        message: `Service ${service.name} not found in App Runner bindings`,
      };
    }

    try {
      await this.appRunnerRequest('UpdateService', {
        ServiceArn: serviceArn,
        SourceConfiguration: {
          ImageRepository: {
            ImageConfiguration: {
              RuntimeEnvironmentVariables: this.formatEnvVars(vars),
            },
          },
        },
      });

      return {
        success: true,
        message: `Set ${Object.keys(vars).length} environment variables`,
        data: { variableCount: Object.keys(vars).length },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set environment variables',
        error: String(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.credentials) {
      return { status: 'unknown' };
    }

    try {
      const response = await this.appRunnerRequest<{
        Service: AppRunnerService;
      }>('DescribeService', {
        ServiceArn: deploymentId,
      });

      const statusMap: Record<string, string> = {
        CREATE_FAILED: 'failed',
        RUNNING: 'deployed',
        DELETED: 'deleted',
        DELETE_FAILED: 'failed',
        PAUSED: 'stopped',
        OPERATION_IN_PROGRESS: 'deploying',
      };

      const url = response.Service.ServiceUrl
        ? `https://${response.Service.ServiceUrl}`
        : undefined;

      return {
        status: statusMap[response.Service.Status] || response.Service.Status.toLowerCase(),
        url,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult> {
    return {
      jobId: '',
      status: 'failed',
      receipt: {
        success: false,
        message: 'App Runner does not support one-off jobs. Use ECS tasks or Lambda for this.',
      },
    };
  }

  // Helper methods

  private async appRunnerRequest<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const { accessKeyId, secretAccessKey, region } = this.credentials;
    const host = `apprunner.${region}.amazonaws.com`;
    const endpoint = `https://${host}`;

    const body = JSON.stringify(params);
    const date = new Date();

    // AWS Signature Version 4 signing
    const headers = await this.signRequest({
      method: 'POST',
      host,
      path: '/',
      service: 'apprunner',
      region,
      accessKeyId,
      secretAccessKey,
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `AppRunner.${action}`,
      },
      body,
      date,
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`App Runner API error: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async signRequest(opts: {
    method: string;
    host: string;
    path: string;
    service: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    headers: Record<string, string>;
    body: string;
    date: Date;
  }): Promise<Record<string, string>> {
    // Simplified AWS Signature V4 implementation
    // In production, use @aws-sdk/signature-v4

    const amzDate = opts.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    const headers: Record<string, string> = {
      ...opts.headers,
      Host: opts.host,
      'X-Amz-Date': amzDate,
    };

    // Create canonical request
    const signedHeaders = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort()
      .join(';');

    const canonicalHeaders = Object.entries(headers)
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
      .sort()
      .join('\n');

    const payloadHash = await this.sha256(opts.body);

    const canonicalRequest = [
      opts.method,
      opts.path,
      '', // query string
      canonicalHeaders + '\n',
      signedHeaders,
      payloadHash,
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest),
    ].join('\n');

    // Calculate signature
    const kDate = await this.hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
    const kRegion = await this.hmac(kDate, opts.region);
    const kService = await this.hmac(kRegion, opts.service);
    const kSigning = await this.hmac(kService, 'aws4_request');
    const signature = await this.hmacHex(kSigning, stringToSign);

    // Create authorization header
    headers['Authorization'] = [
      `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', ');

    return headers;
  }

  private async sha256(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async hmac(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyBuffer = typeof key === 'string' ? encoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  }

  private async hmacHex(key: ArrayBuffer, data: string): Promise<string> {
    const result = await this.hmac(key, data);
    return Array.from(new Uint8Array(result))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private formatEnvVars(vars: Record<string, string>): Record<string, string> {
    // Filter out IMAGE_URI and PORT as they're handled specially
    const filtered = { ...vars };
    delete filtered['IMAGE_URI'];
    delete filtered['PORT'];
    return filtered;
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'apprunner',
    displayName: 'AWS App Runner',
    category: 'deployment',
    credentialsSchema: AppRunnerCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  },
  factory: (credentials) => {
    const adapter = new AppRunnerAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
