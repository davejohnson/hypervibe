import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IDatabaseAdapter,
  DatabaseCapabilities,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for self-registration
export const CloudSqlCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
});

export type CloudSqlCredentials = z.infer<typeof CloudSqlCredentialsSchema>;

interface CloudSqlInstance {
  name: string;
  state: string;
  databaseVersion: string;
  ipAddresses?: Array<{
    type: string;
    ipAddress: string;
  }>;
  serverCaCert?: {
    cert: string;
    commonName: string;
    expirationTime: string;
  };
}

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

export class CloudSqlAdapter implements IDatabaseAdapter {
  readonly name = 'cloudsql';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres', 'mysql'],
    supportedCaches: [],
    supportsPooling: false, // Cloud SQL Auth Proxy recommended
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
  };

  private credentials: CloudSqlCredentials | null = null;
  private serviceAccountCreds: ServiceAccountCredentials | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as CloudSqlCredentials;
    try {
      this.serviceAccountCreds = JSON.parse(this.credentials.credentials);
    } catch {
      throw new Error('Invalid service account JSON');
    }
  }

  async verify(): Promise<VerifyResult> {
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

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    if (type !== 'postgres' && type !== 'mysql') {
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
          message: `Cloud SQL supports postgres and mysql. Requested type: ${type}`,
        },
      };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId, region } = this.credentials;

      const instanceName = this.sanitizeName(
        options?.databaseName || `${environment.name}-${type}`
      );
      const rootPassword = this.generatePassword();
      const dbName = 'app';

      // Map type to Cloud SQL database version
      const versionMap: Record<string, string> = {
        postgres: 'POSTGRES_15',
        mysql: 'MYSQL_8_0',
      };

      const databaseVersion = versionMap[type];
      const defaultPort = type === 'postgres' ? 5432 : 3306;

      // Create Cloud SQL instance
      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: instanceName,
            region: options?.region || region,
            databaseVersion,
            settings: {
              tier: options?.size || 'db-f1-micro',
              ipConfiguration: {
                ipv4Enabled: true,
                authorizedNetworks: [
                  {
                    name: 'allow-all',
                    value: '0.0.0.0/0', // For development; production should use VPC
                  },
                ],
              },
              backupConfiguration: {
                enabled: true,
                pointInTimeRecoveryEnabled: true,
              },
            },
            rootPassword,
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud SQL API error: ${response.status} ${text}`);
      }

      // Wait for operation to start (instance creation is async)
      const operation = (await response.json()) as { name: string };

      // Get the instance details (may not have IP yet)
      // For now, construct connection string with placeholder
      const host = `${instanceName}.${region}.${projectId}`;
      const rootUser = type === 'postgres' ? 'postgres' : 'root';

      const connectionUrl = type === 'postgres'
        ? `postgresql://${rootUser}:${rootPassword}@${host}:${defaultPort}/${dbName}`
        : `mysql://${rootUser}:${rootPassword}@${host}:${defaultPort}/${dbName}`;

      // Cloud SQL connection name format for Cloud SQL Auth Proxy
      const connectionName = `${projectId}:${region}:${instanceName}`;

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          connectionString: connectionUrl,
          host,
          port: defaultPort,
          username: rootUser,
          password: rootPassword,
          database: dbName,
          provider: 'cloudsql',
          instanceId: instanceName,
          connectionName,
        },
        externalId: instanceName,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created Cloud SQL ${type} instance: ${instanceName} (provisioning may take 5-10 minutes)`,
          data: {
            instanceName,
            operationId: operation.name,
            connectionName,
          },
        },
        connectionUrl,
        envVars: {
          DATABASE_URL: connectionUrl,
          CLOUD_SQL_CONNECTION_NAME: connectionName,
          DB_HOST: host,
          DB_PORT: String(defaultPort),
          DB_USER: rootUser,
          DB_PASSWORD: rootPassword,
          DB_NAME: dbName,
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
          message: 'Failed to provision Cloud SQL instance',
          error: String(error),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.credentials) {
      return null;
    }

    const bindings = component.bindings as { connectionString?: string };
    if (bindings.connectionString) {
      return bindings.connectionString;
    }

    // Fetch from API if not stored
    if (component.externalId) {
      try {
        const instance = await this.getInstance(component.externalId);
        if (instance?.ipAddresses) {
          const publicIp = instance.ipAddresses.find((ip) => ip.type === 'PRIMARY');
          if (publicIp) {
            const { username, password, database } = component.bindings as {
              username?: string;
              password?: string;
              database?: string;
            };
            const port = component.type === 'postgres' ? 5432 : 3306;
            return `postgresql://${username}:${password}@${publicIp.ipAddress}:${port}/${database}`;
          }
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials) {
      return { success: false, message: 'Not connected' };
    }

    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }

    try {
      const token = await this.getAccessToken();
      const { projectId } = this.credentials;

      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${component.externalId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloud SQL API error: ${response.status} ${text}`);
      }

      return {
        success: true,
        message: `Deleted Cloud SQL instance: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Cloud SQL instance',
        error: String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.credentials || !component.externalId) {
      return { status: 'unknown' };
    }

    try {
      const instance = await this.getInstance(component.externalId);
      if (!instance) {
        return { status: 'unknown', message: 'Instance not found' };
      }

      const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error'> = {
        RUNNABLE: 'running',
        PENDING_CREATE: 'provisioning',
        MAINTENANCE: 'running',
        FAILED: 'error',
        SUSPENDED: 'stopped',
        PENDING_DELETE: 'stopped',
        UNKNOWN_STATE: 'unknown' as 'running',
      };

      return {
        status: statusMap[instance.state] || 'unknown',
        message: instance.state,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  // Helper methods

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.serviceAccountCreds) {
      throw new Error('No service account credentials');
    }

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

  private async getInstance(instanceName: string): Promise<CloudSqlInstance | null> {
    if (!this.credentials) {
      return null;
    }

    try {
      const token = await this.getAccessToken();
      const { projectId } = this.credentials;

      const response = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${projectId}/instances/${instanceName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CloudSqlInstance;
    } catch {
      return null;
    }
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-=?';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudsql',
    displayName: 'GCP Cloud SQL',
    category: 'database',
    credentialsSchema: CloudSqlCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  },
  factory: (credentials) => {
    const adapter = new CloudSqlAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
