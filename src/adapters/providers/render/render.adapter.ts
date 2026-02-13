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
export const RenderCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  ownerId: z.string().optional(),
});

export type RenderCredentials = z.infer<typeof RenderCredentialsSchema>;

const RENDER_API_URL = 'https://api.render.com/v1';

interface RenderService {
  id: string;
  name: string;
  slug: string;
  type: 'web_service' | 'private_service' | 'background_worker' | 'static_site' | 'cron_job';
  serviceDetails: {
    url?: string;
    pullRequestPreviewsEnabled?: boolean;
    buildCommand?: string;
    startCommand?: string;
  };
  rootDir?: string;
  repo?: string;
  branch?: string;
  autoDeploy?: 'yes' | 'no';
  envVars?: RenderEnvVar[];
}

interface RenderEnvVar {
  key: string;
  value?: string;
  generateValue?: boolean;
}

interface RenderDatabase {
  id: string;
  name: string;
  databaseName: string;
  databaseUser: string;
  region: string;
  status: string;
  version: string;
  plan: string;
}

interface RenderDeploy {
  id: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
}

export class RenderAdapter implements IProviderAdapter {
  readonly name = 'render';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile', 'buildpack'],
    supportedComponents: ['postgres', 'redis'],
    supportsAutoWiring: true,
    supportsHealthChecks: true,
    supportsCronSchedule: true,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per environment
    managedTls: true,
  };

  private credentials: RenderCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as RenderCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const response = await this.request<{ owner: { email?: string; name: string } }[]>('GET', '/owners');
      if (response.length > 0) {
        return { success: true, email: response[0].owner.email || response[0].owner.name };
      }
      return { success: false, error: 'No owners found' };
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

    // Render doesn't have "projects" - services are top-level
    // We'll use a naming convention to group services
    const bindings = environment.platformBindings as {
      projectId?: string;
      provider?: string;
    };

    // For Render, "projectId" is just our naming prefix
    const projectId = bindings.projectId || `${projectName}-${environment.name}`;

    return {
      success: true,
      message: `Using Render project prefix: ${projectId}`,
      data: { projectId, projectName },
    };
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as { projectId?: string };
    const prefix = bindings.projectId || 'hypervibe';

    try {
      // Get owner ID
      const ownerId = await this.getOwnerId();

      if (type === 'postgres') {
        const dbName = `${prefix}-postgres`;

        // Create PostgreSQL database
        const response = await this.request<{ postgres: RenderDatabase }>(
          'POST',
          '/postgres',
          {
            name: dbName,
            ownerId,
            plan: 'starter', // starter, standard, pro
            region: 'oregon',
            version: '15',
          }
        );

        const db = response.postgres;

        const component: Component = {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {
            provider: 'render',
            instanceId: db.id,
          },
          externalId: db.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return {
          component,
          receipt: {
            success: true,
            message: `Created PostgreSQL database: ${db.name}`,
            data: { databaseId: db.id },
          },
        };
      } else if (type === 'redis') {
        const cacheName = `${prefix}-redis`;

        // Create Redis instance
        const response = await this.request<{ redis: { id: string; name: string } }>(
          'POST',
          '/redis',
          {
            name: cacheName,
            ownerId,
            plan: 'starter',
            region: 'oregon',
          }
        );

        const redis = response.redis;

        const component: Component = {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {
            provider: 'render',
            instanceId: redis.id,
          },
          externalId: redis.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return {
          component,
          receipt: {
            success: true,
            message: `Created Redis instance: ${redis.name}`,
            data: { redisId: redis.id },
          },
        };
      }

      throw new Error(`Unsupported component type: ${type}`);
    } catch (error) {
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
          message: `Failed to create ${type} component`,
          error: String(error),
        },
      };
    }
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
      services?: Record<string, { serviceId: string }>;
    };

    const prefix = bindings.projectId || 'hypervibe';

    try {
      const ownerId = await this.getOwnerId();

      // Check if service already exists
      let renderServiceId = bindings.services?.[service.name]?.serviceId;
      let renderService: RenderService | null = null;

      if (renderServiceId) {
        renderService = await this.getService(renderServiceId);
      }

      if (!renderService) {
        // Create new service
        const serviceName = `${prefix}-${service.name}`;

        const createPayload: {
          name: string;
          ownerId: string;
          type: string;
          autoDeploy: string;
          envVars: RenderEnvVar[];
          serviceDetails: {
            envSpecificDetails?: { envType: string };
          };
        } = {
          name: serviceName,
          ownerId,
          type: 'web_service',
          autoDeploy: 'yes',
          envVars: Object.entries(envVars).map(([key, value]) => ({ key, value })),
          serviceDetails: {
            envSpecificDetails: {
              envType: 'docker',
            },
          },
        };

        const response = await this.request<{ service: RenderService }>(
          'POST',
          '/services',
          createPayload
        );

        renderService = response.service;
        renderServiceId = renderService.id;
      } else {
        // Update env vars on existing service
        await this.setEnvVars(environment, service, envVars);
      }

      // Trigger deploy
      const deployResponse = await this.request<{ deploy: RenderDeploy }>(
        'POST',
        `/services/${renderServiceId}/deploys`,
        {}
      );

      const url = renderService.serviceDetails?.url;

      return {
        serviceId: service.id,
        externalId: renderServiceId,
        url,
        status: 'deploying',
        receipt: {
          success: true,
          message: `Deployment triggered for ${service.name}`,
          data: { serviceId: renderServiceId, deployId: deployResponse.deploy.id },
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
      services?: Record<string, { serviceId: string }>;
    };

    const renderServiceId = bindings.services?.[service.name]?.serviceId;
    if (!renderServiceId) {
      return {
        success: false,
        message: `Service ${service.name} not found in Render bindings`,
      };
    }

    try {
      // Render uses PUT to replace all env vars
      const envVars = Object.entries(vars).map(([key, value]) => ({ key, value }));

      await this.request('PUT', `/services/${renderServiceId}/env-vars`, envVars);

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
      // deploymentId format: serviceId:deployId
      const [serviceId, deployId] = deploymentId.split(':');

      const response = await this.request<{ deploy: RenderDeploy }>(
        'GET',
        `/services/${serviceId}/deploys/${deployId}`
      );

      const statusMap: Record<string, string> = {
        created: 'pending',
        build_in_progress: 'building',
        update_in_progress: 'deploying',
        live: 'deployed',
        deactivated: 'stopped',
        build_failed: 'failed',
        update_failed: 'failed',
        canceled: 'canceled',
      };

      const service = await this.getService(serviceId);

      return {
        status: statusMap[response.deploy.status] || response.deploy.status,
        url: service?.serviceDetails?.url,
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
    // Render supports one-off jobs through the API
    // For now, placeholder
    return {
      jobId: '',
      status: 'failed',
      receipt: {
        success: false,
        message: 'Job execution not yet implemented for Render',
      },
    };
  }

  // Helper methods

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${RENDER_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Render API error: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async getOwnerId(): Promise<string> {
    if (this.credentials?.ownerId) {
      return this.credentials.ownerId;
    }

    const owners = await this.request<{ owner: { id: string } }[]>('GET', '/owners');
    if (owners.length === 0) {
      throw new Error('No owners found');
    }
    return owners[0].owner.id;
  }

  private async getService(serviceId: string): Promise<RenderService | null> {
    try {
      const response = await this.request<{ service: RenderService }>(
        'GET',
        `/services/${serviceId}`
      );
      return response.service;
    } catch {
      return null;
    }
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'render',
    displayName: 'Render',
    category: 'deployment',
    credentialsSchema: RenderCredentialsSchema,
    setupHelpUrl: 'https://dashboard.render.com/u/settings#api-keys',
  },
  factory: (credentials) => {
    const adapter = new RenderAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
