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
export const HerokuCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

export type HerokuCredentials = z.infer<typeof HerokuCredentialsSchema>;

const HEROKU_API_URL = 'https://api.heroku.com';

interface HerokuApp {
  id: string;
  name: string;
  web_url: string;
  git_url: string;
  stack?: {
    id: string;
    name: string;
  };
}

interface HerokuAddon {
  id: string;
  name: string;
  addon_service: {
    id: string;
    name: string;
  };
  plan: {
    id: string;
    name: string;
  };
  config_vars: string[];
}

interface HerokuBuild {
  id: string;
  status: string;
  output_stream_url?: string;
}

interface HerokuRelease {
  id: string;
  version: number;
  status: string;
  description: string;
}

export class HerokuAdapter implements IProviderAdapter {
  readonly name = 'heroku';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['buildpack', 'dockerfile'],
    supportedComponents: ['postgres', 'redis'],
    supportsAutoWiring: true, // Addons auto-inject config vars
    supportsHealthChecks: false,
    supportsCronSchedule: false, // Requires Heroku Scheduler addon
    supportsReleaseCommand: true, // release phase in Procfile
    supportsMultiEnvironment: false, // Pipelines exist but separate apps
    managedTls: true,
  };

  private credentials: HerokuCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as HerokuCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      const response = await this.request<{ email: string; id: string }>('GET', '/account');
      return { success: true, email: response.email };
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
      if (bindings.projectId && bindings.provider === 'heroku') {
        try {
          const app = await this.getApp(bindings.projectId);
          if (app) {
            return {
              success: true,
              message: `Using existing Heroku app: ${app.name}`,
              data: { projectId: app.id, projectName: app.name },
            };
          }
        } catch {
          // App doesn't exist anymore, create new one
        }
      }

      // Create new app with environment suffix
      const appName = this.sanitizeAppName(`${projectName}-${environment.name}`);

      const response = await this.request<HerokuApp>('POST', '/apps', {
        name: appName,
        region: 'us',
        stack: 'heroku-22',
      });

      return {
        success: true,
        message: `Created Heroku app: ${response.name}`,
        data: {
          projectId: response.id,
          projectName: response.name,
          webUrl: response.web_url,
          gitUrl: response.git_url,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure Heroku app',
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
      throw new Error('No Heroku app bound to this environment');
    }

    try {
      // Map component type to Heroku addon
      const addonMap: Record<string, { service: string; plan: string }> = {
        postgres: { service: 'heroku-postgresql', plan: 'essential-0' },
        redis: { service: 'heroku-redis', plan: 'mini' },
      };

      const addon = addonMap[type];
      if (!addon) {
        throw new Error(`Unsupported component type: ${type}`);
      }

      // Get app name
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        throw new Error('App not found');
      }

      // Check if addon already exists
      const existingAddons = await this.request<HerokuAddon[]>(
        'GET',
        `/apps/${app.name}/addons`
      );

      const existing = existingAddons.find(
        (a) => a.addon_service.name === addon.service
      );

      if (existing) {
        const component: Component = {
          id: '',
          environmentId: environment.id,
          type,
          bindings: {
            provider: 'heroku',
            instanceId: existing.id,
            configVars: existing.config_vars,
          },
          externalId: existing.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        return {
          component,
          receipt: {
            success: true,
            message: `Using existing ${type} addon: ${existing.name}`,
            data: { addonId: existing.id },
          },
        };
      }

      // Create new addon
      const response = await this.request<HerokuAddon>(
        'POST',
        `/apps/${app.name}/addons`,
        {
          plan: `${addon.service}:${addon.plan}`,
        }
      );

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          provider: 'heroku',
          instanceId: response.id,
          configVars: response.config_vars,
        },
        externalId: response.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created ${type} addon: ${response.name}`,
          data: {
            addonId: response.id,
            configVars: response.config_vars,
          },
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
          message: 'No Heroku app bound to this environment',
        },
      };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        throw new Error('App not found');
      }

      // Set config vars (env vars)
      if (Object.keys(envVars).length > 0) {
        await this.request('PATCH', `/apps/${app.name}/config-vars`, envVars);
      }

      // Heroku deployments are typically git-based
      // Return success with git URL for deployment
      return {
        serviceId: service.id,
        externalId: app.id,
        url: app.web_url,
        status: 'deployed',
        receipt: {
          success: true,
          message: `Config vars updated. Deploy via: git push heroku main`,
          data: {
            appId: app.id,
            gitUrl: app.git_url,
            webUrl: app.web_url,
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

    const bindings = environment.platformBindings as { projectId?: string };

    if (!bindings.projectId) {
      return {
        success: false,
        message: 'No Heroku app bound to this environment',
      };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        return { success: false, message: 'App not found' };
      }

      await this.request('PATCH', `/apps/${app.name}/config-vars`, vars);

      return {
        success: true,
        message: `Set ${Object.keys(vars).length} config vars`,
        data: { variableCount: Object.keys(vars).length },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to set config vars',
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

    const bindings = environment.platformBindings as { projectId?: string };
    if (!bindings.projectId) {
      return { status: 'unknown' };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        return { status: 'unknown' };
      }

      // Get latest release
      const releases = await this.request<HerokuRelease[]>(
        'GET',
        `/apps/${app.name}/releases`,
        undefined,
        { Range: 'version ..; max=1, order=desc' }
      );

      if (releases.length === 0) {
        return { status: 'pending', url: app.web_url };
      }

      const latest = releases[0];
      const statusMap: Record<string, string> = {
        pending: 'pending',
        succeeded: 'deployed',
        failed: 'failed',
      };

      return {
        status: statusMap[latest.status] || latest.status,
        url: app.web_url,
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
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const bindings = environment.platformBindings as { projectId?: string };
    if (!bindings.projectId) {
      return {
        jobId: '',
        status: 'failed',
        receipt: { success: false, message: 'No Heroku app bound' },
      };
    }

    try {
      const app = await this.getApp(bindings.projectId);
      if (!app) {
        return {
          jobId: '',
          status: 'failed',
          receipt: { success: false, message: 'App not found' },
        };
      }

      // Create one-off dyno
      const response = await this.request<{
        id: string;
        state: string;
        attach_url?: string;
      }>('POST', `/apps/${app.name}/dynos`, {
        command,
        type: 'run',
        time_to_live: 1800, // 30 minutes max
      });

      return {
        jobId: response.id,
        status: 'running',
        receipt: {
          success: true,
          message: `Started one-off dyno: ${response.id}`,
          data: { dynoId: response.id, attachUrl: response.attach_url },
        },
      };
    } catch (error) {
      return {
        jobId: '',
        status: 'failed',
        receipt: {
          success: false,
          message: 'Failed to run job',
          error: String(error),
        },
      };
    }
  }

  // Helper methods

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${HEROKU_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.heroku+json; version=3',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Heroku API error: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async getApp(appIdOrName: string): Promise<HerokuApp | null> {
    try {
      return await this.request<HerokuApp>('GET', `/apps/${appIdOrName}`);
    } catch {
      return null;
    }
  }

  private sanitizeAppName(name: string): string {
    // Heroku app names must be lowercase, alphanumeric with hyphens, max 30 chars
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'heroku',
    displayName: 'Heroku',
    category: 'deployment',
    credentialsSchema: HerokuCredentialsSchema,
    setupHelpUrl: 'https://dashboard.heroku.com/account/applications',
  },
  factory: (credentials) => {
    const adapter = new HerokuAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
