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
export const DigitalOceanCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
});

export type DigitalOceanCredentials = z.infer<typeof DigitalOceanCredentialsSchema>;

const DO_API_URL = 'https://api.digitalocean.com/v2';

interface DOApp {
  id: string;
  spec: DOAppSpec;
  default_ingress?: string;
  live_url?: string;
  active_deployment?: {
    id: string;
    phase: string;
  };
}

interface DOAppSpec {
  name: string;
  region?: string;
  services?: DOServiceSpec[];
  databases?: DODatabaseSpec[];
}

interface DOServiceSpec {
  name: string;
  git?: {
    repo_clone_url: string;
    branch: string;
  };
  github?: {
    repo: string;
    branch: string;
    deploy_on_push: boolean;
  };
  dockerfile_path?: string;
  build_command?: string;
  run_command?: string;
  envs?: Array<{ key: string; value: string; scope?: string; type?: string }>;
  instance_count?: number;
  instance_size_slug?: string;
  http_port?: number;
  health_check?: {
    http_path?: string;
    initial_delay_seconds?: number;
    period_seconds?: number;
  };
}

interface DODatabaseSpec {
  name: string;
  engine: 'PG' | 'MYSQL' | 'REDIS' | 'MONGODB';
  version?: string;
  size?: string;
  num_nodes?: number;
}

export class DigitalOceanAdapter implements IProviderAdapter {
  readonly name = 'digitalocean';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile', 'buildpack'],
    supportedComponents: ['postgres', 'redis', 'mysql', 'mongodb'],
    supportsAutoWiring: true,
    supportsHealthChecks: true,
    supportsCronSchedule: false, // DO Apps doesn't have built-in cron
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate apps per environment
    managedTls: true,
  };

  private credentials: DigitalOceanCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as DigitalOceanCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const response = await this.request<{ account: { email: string } }>('GET', '/account');
      return { success: true, email: response.account.email };
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

      // Check if app already exists
      if (bindings.projectId && bindings.provider === 'digitalocean') {
        try {
          const app = await this.getApp(bindings.projectId);
          if (app) {
            return {
              success: true,
              message: `Using existing DigitalOcean App: ${app.spec.name}`,
              data: { projectId: app.id, projectName: app.spec.name },
            };
          }
        } catch {
          // App doesn't exist anymore, create new one
        }
      }

      // Create new App Platform app with empty spec
      const appName = this.sanitizeAppName(`${projectName}-${environment.name}`);
      const spec: DOAppSpec = {
        name: appName,
        region: 'nyc', // Default to NYC, can be made configurable
        services: [],
      };

      const response = await this.request<{ app: DOApp }>('POST', '/apps', { spec });

      return {
        success: true,
        message: `Created DigitalOcean App: ${response.app.spec.name}`,
        data: {
          projectId: response.app.id,
          projectName: response.app.spec.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure DigitalOcean App',
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
      throw new Error('No DigitalOcean App bound to this environment');
    }

    try {
      // Get current app spec
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        throw new Error('App not found');
      }

      // Map component type to DO database engine
      const engineMap: Record<string, 'PG' | 'MYSQL' | 'REDIS' | 'MONGODB'> = {
        postgres: 'PG',
        mysql: 'MYSQL',
        redis: 'REDIS',
        mongodb: 'MONGODB',
      };

      const engine = engineMap[type];
      if (!engine) {
        throw new Error(`Unsupported component type: ${type}`);
      }

      // Add database to app spec
      const databases = app.spec.databases ?? [];
      const dbName = `${type}-db`;
      databases.push({
        name: dbName,
        engine,
      });

      // Update app spec
      await this.request('PUT', `/apps/${bindings.projectId}`, {
        spec: { ...app.spec, databases },
      });

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: dbName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Added ${type} database to DigitalOcean App`,
          data: { databaseName: dbName },
        },
      };
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
          message: 'No DigitalOcean App bound to this environment',
        },
      };
    }

    try {
      // Get current app
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        throw new Error('App not found');
      }

      // Build service spec
      const serviceSpec: DOServiceSpec = {
        name: service.name,
        instance_count: 1,
        instance_size_slug: 'basic-xxs',
        http_port: 8080,
      };

      // Add dockerfile path if specified
      if (service.buildConfig?.dockerfilePath) {
        serviceSpec.dockerfile_path = service.buildConfig.dockerfilePath;
      }

      // Convert envVars to DO format with auto-wiring for databases
      const envs: Array<{ key: string; value: string; scope?: string; type?: string }> = [];

      // Auto-wire database connections if databases exist
      const databases = app.spec.databases ?? [];
      for (const db of databases) {
        if (db.engine === 'PG') {
          envs.push({ key: 'DATABASE_URL', value: '${' + db.name + '.DATABASE_URL}', type: 'SECRET' });
        } else if (db.engine === 'REDIS') {
          envs.push({ key: 'REDIS_URL', value: '${' + db.name + '.REDIS_URL}', type: 'SECRET' });
        } else if (db.engine === 'MYSQL') {
          envs.push({ key: 'DATABASE_URL', value: '${' + db.name + '.DATABASE_URL}', type: 'SECRET' });
        } else if (db.engine === 'MONGODB') {
          envs.push({ key: 'DATABASE_URL', value: '${' + db.name + '.DATABASE_URL}', type: 'SECRET' });
        }
      }

      // Add user-provided env vars (these override auto-wired ones)
      for (const [key, value] of Object.entries(envVars)) {
        envs.push({ key, value });
      }

      serviceSpec.envs = envs;

      // Update or add service in app spec
      const services = app.spec.services ?? [];
      const existingIndex = services.findIndex((s) => s.name === service.name);
      if (existingIndex >= 0) {
        services[existingIndex] = { ...services[existingIndex], ...serviceSpec };
      } else {
        services.push(serviceSpec);
      }

      // Update app
      const response = await this.request<{ app: DOApp }>('PUT', `/apps/${bindings.projectId}`, {
        spec: { ...app.spec, services },
      });

      // Trigger deployment
      await this.request('POST', `/apps/${bindings.projectId}/deployments`, {});

      const url = response.app.live_url || response.app.default_ingress;

      return {
        serviceId: service.id,
        externalId: service.name,
        url,
        status: 'deploying',
        receipt: {
          success: true,
          message: `Deployment triggered for ${service.name}`,
          data: { appId: bindings.projectId },
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
      projectId?: string;
    };

    if (!bindings.projectId) {
      return {
        success: false,
        message: 'No DigitalOcean App bound to this environment',
      };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        return { success: false, message: 'App not found' };
      }

      const services = app.spec.services ?? [];
      const serviceIndex = services.findIndex((s) => s.name === service.name);
      if (serviceIndex < 0) {
        return { success: false, message: `Service ${service.name} not found in app` };
      }

      // Merge new vars with existing
      const existingEnvs = services[serviceIndex].envs ?? [];
      const envMap = new Map(existingEnvs.map((e) => [e.key, e]));
      for (const [key, value] of Object.entries(vars)) {
        envMap.set(key, { key, value });
      }
      services[serviceIndex].envs = [...envMap.values()];

      await this.request('PUT', `/apps/${bindings.projectId}`, {
        spec: { ...app.spec, services },
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
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as { projectId?: string };
    if (!bindings.projectId) {
      return { status: 'unknown' };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        return { status: 'unknown' };
      }

      const phase = app.active_deployment?.phase || 'UNKNOWN';
      const phaseMap: Record<string, string> = {
        PENDING_BUILD: 'building',
        BUILDING: 'building',
        PENDING_DEPLOY: 'deploying',
        DEPLOYING: 'deploying',
        ACTIVE: 'deployed',
        SUPERSEDED: 'superseded',
        ERROR: 'failed',
        CANCELED: 'canceled',
      };

      return {
        status: phaseMap[phase] || phase.toLowerCase(),
        url: app.live_url || app.default_ingress,
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
    // DO App Platform doesn't have a direct job API
    return {
      jobId: '',
      status: 'failed',
      receipt: {
        success: false,
        message: 'Job execution not yet implemented for DigitalOcean',
      },
    };
  }

  // Helper methods

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${DO_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DigitalOcean API error: ${response.status} ${text}`);
    }

    // Handle empty responses
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async getApp(appId: string): Promise<DOApp | null> {
    try {
      const response = await this.request<{ app: DOApp }>('GET', `/apps/${appId}`);
      return response.app;
    } catch {
      return null;
    }
  }

  private sanitizeAppName(name: string): string {
    // DO app names must be lowercase, alphanumeric with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 32);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'digitalocean',
    displayName: 'DigitalOcean App Platform',
    category: 'deployment',
    credentialsSchema: DigitalOceanCredentialsSchema,
    setupHelpUrl: 'https://cloud.digitalocean.com/account/api/tokens',
  },
  factory: (credentials) => {
    const adapter = new DigitalOceanAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
