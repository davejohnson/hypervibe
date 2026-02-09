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
export const CloudRunCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
});

export type CloudRunCredentials = z.infer<typeof CloudRunCredentialsSchema>;

interface CloudRunService {
  name: string;
  uid: string;
  generation: number;
  uri?: string;
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

export class CloudRunAdapter implements IProviderAdapter {
  readonly name = 'cloudrun';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [], // Cloud SQL is separate
    supportsAutoWiring: false, // Manual connection needed
    supportsHealthChecks: true,
    supportsCronSchedule: true, // Cloud Scheduler
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false, // Separate services per env
    managedTls: true,
  };

  private credentials: CloudRunCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as CloudRunCredentials;
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    if (!this.credentials || !this.serviceAccountCreds) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      await this.getAccessToken();
      return {
        success: true,
        email: this.serviceAccountCreds.client_email,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccountCreds = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async ensureProject(projectName: string, environment: Environment): Promise<Receipt> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Cloud Run doesn't have "projects" in the deployment sense
    // The GCP project is the container
    const bindings = environment.platformBindings as {
      projectId?: string;
      provider?: string;
    };

    const projectId = bindings.projectId || `${projectName}-${environment.name}`;

    return {
      success: true,
      message: `Using GCP project: ${this.credentials.projectId}`,
      data: {
        projectId,
        gcpProjectId: this.credentials.projectId,
        region: this.credentials.region,
      },
    };
  }

  async ensureComponent(type: ComponentType, environment: Environment): Promise<ComponentResult> {
    // Cloud Run doesn't provision databases
    // Users should use Cloud SQL separately
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
        message: `Cloud Run does not provision databases. Use the Cloud SQL adapter separately, then pass DATABASE_URL as an env var.`,
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
      services?: Record<string, { serviceId: string }>;
    };

    const prefix = bindings.projectId || 'infraprint';
    const serviceName = this.sanitizeName(`${prefix}-${service.name}`);

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      // Check if service exists
      let cloudRunService: CloudRunService | null = null;
      try {
        cloudRunService = await this.getService(serviceName);
      } catch {
        // Service doesn't exist
      }

      // Build environment variables config
      const env = Object.entries(envVars).map(([name, value]) => ({ name, value }));

      // Build container spec
      const containerSpec = {
        image: envVars['IMAGE_URI'] || `gcr.io/${projectId}/${service.name}:latest`,
        ports: [{ containerPort: parseInt(envVars['PORT'] || '8080', 10) }],
        env,
        resources: {
          limits: {
            cpu: envVars['CPU'] || '1',
            memory: envVars['MEMORY'] || '512Mi',
          },
        },
      };

      // Service spec
      const serviceSpec = {
        apiVersion: 'serving.knative.dev/v1',
        kind: 'Service',
        metadata: {
          name: serviceName,
          namespace: projectId,
          labels: {
            'infraprint.io/environment': environment.name,
          },
        },
        spec: {
          template: {
            spec: {
              containers: [containerSpec],
              serviceAccountName: this.serviceAccountCreds?.client_email,
            },
          },
        },
      };

      const baseUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`;

      if (cloudRunService) {
        // Update existing service
        await fetch(`${baseUrl}/${serviceName}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });
      } else {
        // Create new service
        const response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(serviceSpec),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Cloud Run API error: ${response.status} ${text}`);
        }

        cloudRunService = (await response.json()) as CloudRunService;
      }

      // Get service URL
      const serviceInfo = await this.getService(serviceName);
      const url = serviceInfo?.uri;

      return {
        serviceId: service.id,
        externalId: serviceName,
        url,
        status: 'deploying',
        receipt: {
          success: true,
          message: `Deployed ${serviceName} to Cloud Run`,
          data: { serviceName, url },
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
      services?: Record<string, { serviceId: string }>;
    };

    const prefix = bindings.projectId || 'infraprint';
    const serviceName = this.sanitizeName(`${prefix}-${service.name}`);

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      // Get current service
      const currentService = await this.getService(serviceName);
      if (!currentService) {
        return { success: false, message: `Service ${serviceName} not found` };
      }

      // Update with new env vars
      const env = Object.entries(vars).map(([name, value]) => ({ name, value }));

      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [{ env }],
                },
              },
            },
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud Run API error: ${response.status} ${text}`);
      }

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
      const service = await this.getService(deploymentId);
      if (!service) {
        return { status: 'unknown' };
      }

      // Check conditions
      const readyCondition = service.conditions?.find((c) => c.type === 'Ready');
      const status = readyCondition?.status === 'True' ? 'deployed' : 'deploying';

      return { status, url: service.uri };
    } catch {
      return { status: 'unknown' };
    }
  }

  async runJob(
    environment: Environment,
    service: Service,
    command: string
  ): Promise<JobResult> {
    // Cloud Run Jobs are separate from Cloud Run Services
    // For now, placeholder
    return {
      jobId: '',
      status: 'failed',
      receipt: {
        success: false,
        message: 'Cloud Run Jobs support not yet implemented. Use Cloud Run Jobs API directly.',
      },
    };
  }

  // Helper methods

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.serviceAccountCreds.client_email,
      sub: this.serviceAccountCreds.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    };

    const jwt = await this.createJwt(header, payload, this.serviceAccountCreds.private_key);

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 60) * 1000);

    return this.accessToken!;
  }

  private async createJwt(
    header: Record<string, string>,
    payload: Record<string, unknown>,
    privateKey: string
  ): Promise<string> {
    const encoder = new TextEncoder();

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    // Import private key
    const pemContents = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\n/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(unsignedToken)
    );

    const signatureB64 = this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    return `${unsignedToken}.${signatureB64}`;
  }

  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private async getService(serviceName: string): Promise<CloudRunService | null> {
    if (!this.credentials) {
      return null;
    }

    const token = await this.getAccessToken();
    const { projectId, region } = this.credentials;

    try {
      const response = await fetch(
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CloudRunService;
    } catch {
      return null;
    }
  }

  private sanitizeName(name: string): string {
    // Cloud Run service names must be lowercase, alphanumeric with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudrun',
    displayName: 'GCP Cloud Run',
    category: 'deployment',
    credentialsSchema: CloudRunCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  },
  factory: (credentials) => {
    const adapter = new CloudRunAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
