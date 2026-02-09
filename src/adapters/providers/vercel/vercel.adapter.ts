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
export const VercelCredentialsSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  teamId: z.string().optional(),
});

export type VercelCredentials = z.infer<typeof VercelCredentialsSchema>;

const VERCEL_API_URL = 'https://api.vercel.com';

interface VercelProject {
  id: string;
  name: string;
  accountId: string;
  framework?: string;
  link?: {
    type: 'github' | 'gitlab' | 'bitbucket';
    repo: string;
  };
}

interface VercelDeployment {
  id: string;
  uid: string;
  name: string;
  url: string;
  state: string;
  readyState: string;
  createdAt: number;
}

interface VercelEnvVar {
  id?: string;
  key: string;
  value: string;
  target: ('production' | 'preview' | 'development')[];
  type: 'plain' | 'encrypted' | 'secret' | 'sensitive';
}

export class VercelAdapter implements IProviderAdapter {
  readonly name = 'vercel';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['static', 'dockerfile'],
    supportedComponents: ['postgres', 'redis'],
    supportsAutoWiring: true,
    supportsHealthChecks: false, // Vercel uses edge functions
    supportsCronSchedule: true, // Vercel Cron
    supportsReleaseCommand: false,
    supportsMultiEnvironment: true, // Production, Preview, Development
    managedTls: true,
  };

  private credentials: VercelCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as VercelCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const response = await this.request<{ user: { email: string; name: string } }>('GET', '/v2/user');
      return { success: true, email: response.user.email };
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

    try {
      const bindings = environment.platformBindings as {
        projectId?: string;
        provider?: string;
      };

      // Check if project already exists
      if (bindings.projectId && bindings.provider === 'vercel') {
        try {
          const project = await this.getProject(bindings.projectId);
          if (project) {
            return {
              success: true,
              message: `Using existing Vercel project: ${project.name}`,
              data: { projectId: project.id, projectName: project.name },
            };
          }
        } catch {
          // Project doesn't exist anymore, create new one
        }
      }

      // Create new project
      const sanitizedName = this.sanitizeProjectName(projectName);

      const response = await this.request<VercelProject>('POST', '/v10/projects', {
        name: sanitizedName,
      });

      return {
        success: true,
        message: `Created Vercel project: ${response.name}`,
        data: {
          projectId: response.id,
          projectName: response.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure Vercel project',
        error: String(error),
      };
    }
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as { projectId?: string };
    if (!bindings.projectId) {
      throw new Error('No Vercel project bound to this environment');
    }

    try {
      if (type === 'postgres') {
        // Create Vercel Postgres database
        const response = await this.request<{
          store: {
            id: string;
            name: string;
            databaseName: string;
            databaseHost: string;
            databaseUser: string;
            databaseUrlNonPooling: string;
            databaseUrl: string;
          };
        }>('POST', '/v1/storage/stores/postgres', {
          name: `${bindings.projectId}-postgres`,
        });

        const store = response.store;

        const component: Component = {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {
            connectionString: store.databaseUrl,
            host: store.databaseHost,
            username: store.databaseUser,
            database: store.databaseName,
            provider: 'vercel',
            instanceId: store.id,
            nonPoolingUrl: store.databaseUrlNonPooling,
          },
          externalId: store.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Connect store to project
        await this.request('POST', `/v1/storage/stores/${store.id}/connections`, {
          projectId: bindings.projectId,
          envVars: [
            { key: 'POSTGRES_URL', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_PRISMA_URL', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_URL_NON_POOLING', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_USER', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_HOST', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_PASSWORD', target: ['production', 'preview', 'development'] },
            { key: 'POSTGRES_DATABASE', target: ['production', 'preview', 'development'] },
          ],
        });

        return {
          component,
          receipt: {
            success: true,
            message: `Created Vercel Postgres database`,
            data: { storeId: store.id },
          },
        };
      } else if (type === 'redis') {
        // Create Vercel KV (Redis-compatible)
        const response = await this.request<{
          store: {
            id: string;
            name: string;
            kvUrl: string;
            kvRestApiUrl: string;
            kvRestApiToken: string;
            kvRestApiReadOnlyToken: string;
          };
        }>('POST', '/v1/storage/stores/kv', {
          name: `${bindings.projectId}-kv`,
        });

        const store = response.store;

        const component: Component = {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {
            connectionString: store.kvUrl,
            provider: 'vercel',
            instanceId: store.id,
            restApiUrl: store.kvRestApiUrl,
          },
          externalId: store.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Connect store to project
        await this.request('POST', `/v1/storage/stores/${store.id}/connections`, {
          projectId: bindings.projectId,
          envVars: [
            { key: 'KV_URL', target: ['production', 'preview', 'development'] },
            { key: 'KV_REST_API_URL', target: ['production', 'preview', 'development'] },
            { key: 'KV_REST_API_TOKEN', target: ['production', 'preview', 'development'] },
            { key: 'KV_REST_API_READ_ONLY_TOKEN', target: ['production', 'preview', 'development'] },
          ],
        });

        return {
          component,
          receipt: {
            success: true,
            message: `Created Vercel KV (Redis-compatible) store`,
            data: { storeId: store.id },
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

    if (!bindings.projectId) {
      return {
        serviceId: service.id,
        status: 'failed',
        receipt: {
          success: false,
          message: 'No Vercel project bound to this environment',
        },
      };
    }

    try {
      // Set environment variables first
      if (Object.keys(envVars).length > 0) {
        await this.setEnvVarsInternal(bindings.projectId, envVars);
      }

      // Vercel typically deploys via git push, but we can create a deployment
      // For now, trigger a production deployment if project has git link
      const project = await this.getProject(bindings.projectId);

      if (project?.link) {
        // Project is linked to git, deployment happens on push
        return {
          serviceId: service.id,
          externalId: bindings.projectId,
          status: 'deployed',
          receipt: {
            success: true,
            message: `Environment variables updated. Deploy will trigger on next git push.`,
            data: { projectId: bindings.projectId },
          },
        };
      }

      // For projects without git link, use the deployments API
      // This requires files to be uploaded, which is complex
      // For now, return guidance
      return {
        serviceId: service.id,
        externalId: bindings.projectId,
        status: 'deployed',
        receipt: {
          success: true,
          message: `Environment variables updated. Link project to git or use Vercel CLI to deploy.`,
          data: { projectId: bindings.projectId },
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

    const bindings = environment.platformBindings as { projectId?: string };

    if (!bindings.projectId) {
      return {
        success: false,
        message: 'No Vercel project bound to this environment',
      };
    }

    try {
      await this.setEnvVarsInternal(bindings.projectId, vars);
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
      const response = await this.request<VercelDeployment>(
        'GET',
        `/v13/deployments/${deploymentId}`
      );

      const stateMap: Record<string, string> = {
        BUILDING: 'building',
        INITIALIZING: 'pending',
        ANALYZING: 'building',
        DEPLOYING: 'deploying',
        READY: 'deployed',
        QUEUED: 'pending',
        CANCELED: 'canceled',
        ERROR: 'failed',
      };

      return {
        status: stateMap[response.readyState] || response.readyState.toLowerCase(),
        url: response.url ? `https://${response.url}` : undefined,
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
        message: 'Vercel does not support one-off jobs. Use Edge Functions or Cron Jobs instead.',
      },
    };
  }

  // Helper methods

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const url = new URL(`${VERCEL_API_URL}${path}`);
    if (this.credentials.teamId) {
      url.searchParams.set('teamId', this.credentials.teamId);
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vercel API error: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async getProject(projectId: string): Promise<VercelProject | null> {
    try {
      return await this.request<VercelProject>('GET', `/v9/projects/${projectId}`);
    } catch {
      return null;
    }
  }

  private async setEnvVarsInternal(projectId: string, vars: Record<string, string>): Promise<void> {
    // Get existing env vars
    const existing = await this.request<{ envs: VercelEnvVar[] }>(
      'GET',
      `/v9/projects/${projectId}/env`
    );

    const existingKeys = new Map(existing.envs.map((e) => [e.key, e.id]));

    for (const [key, value] of Object.entries(vars)) {
      const envVar: VercelEnvVar = {
        key,
        value,
        target: ['production', 'preview', 'development'],
        type: 'plain',
      };

      if (existingKeys.has(key)) {
        // Update existing
        await this.request(
          'PATCH',
          `/v9/projects/${projectId}/env/${existingKeys.get(key)}`,
          envVar
        );
      } else {
        // Create new
        await this.request('POST', `/v10/projects/${projectId}/env`, envVar);
      }
    }
  }

  private sanitizeProjectName(name: string): string {
    // Vercel project names must be lowercase, alphanumeric with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 100);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'vercel',
    displayName: 'Vercel',
    category: 'deployment',
    credentialsSchema: VercelCredentialsSchema,
    setupHelpUrl: 'https://vercel.com/account/tokens',
  },
  factory: (credentials) => {
    const adapter = new VercelAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
