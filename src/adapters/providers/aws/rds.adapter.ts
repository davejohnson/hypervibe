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
export const RdsCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, 'Access key ID is required'),
  secretAccessKey: z.string().min(1, 'Secret access key is required'),
  region: z.string().default('us-east-1'),
});

export type RdsCredentials = z.infer<typeof RdsCredentialsSchema>;

interface RdsInstance {
  DBInstanceIdentifier: string;
  DBInstanceArn: string;
  DBInstanceStatus: string;
  Engine: string;
  Endpoint?: {
    Address: string;
    Port: number;
  };
  MasterUsername: string;
  DBName?: string;
}

export class RdsAdapter implements IDatabaseAdapter {
  readonly name = 'rds';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres', 'mysql'],
    supportedCaches: [],
    supportsPooling: false,
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false, // Aurora Serverless is, but standard RDS is not
  };

  private credentials: RdsCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as RdsCredentials;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      await this.rdsRequest('DescribeDBInstances', {});
      return { success: true, email: `AWS RDS (${this.credentials.region})` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
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
          message: `RDS supports postgres and mysql. Requested type: ${type}`,
        },
      };
    }

    try {
      const dbIdentifier = this.sanitizeName(
        options?.databaseName || `${environment.name}-${type}`
      );
      const masterUsername = 'admin';
      const masterPassword = this.generatePassword();
      const dbName = 'app';

      // Map type to RDS engine
      const engineMap: Record<string, string> = {
        postgres: 'postgres',
        mysql: 'mysql',
      };

      const engine = engineMap[type];
      const defaultPort = type === 'postgres' ? 5432 : 3306;

      // Create RDS instance
      const response = await this.rdsRequest<{ DBInstance: RdsInstance }>(
        'CreateDBInstance',
        {
          DBInstanceIdentifier: dbIdentifier,
          DBInstanceClass: options?.size || 'db.t3.micro',
          Engine: engine,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
          AllocatedStorage: 20,
          DBName: dbName,
          PubliclyAccessible: true, // For development; production should use VPC
          BackupRetentionPeriod: 7,
          MultiAZ: false,
          StorageType: 'gp2',
          Tags: [
            { Key: 'Environment', Value: environment.name },
            { Key: 'ManagedBy', Value: 'Hypervibe' },
          ],
        }
      );

      const instance = response.DBInstance;

      // Note: Instance won't have endpoint immediately - it takes a few minutes
      const host = instance.Endpoint?.Address || `${dbIdentifier}.${this.credentials.region}.rds.amazonaws.com`;
      const port = instance.Endpoint?.Port || defaultPort;

      const connectionUrl = type === 'postgres'
        ? `postgresql://${masterUsername}:${masterPassword}@${host}:${port}/${dbName}`
        : `mysql://${masterUsername}:${masterPassword}@${host}:${port}/${dbName}`;

      const component: Component = {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {
          connectionString: connectionUrl,
          host,
          port,
          username: masterUsername,
          password: masterPassword,
          database: dbName,
          provider: 'rds',
          instanceId: instance.DBInstanceIdentifier,
          instanceArn: instance.DBInstanceArn,
        },
        externalId: instance.DBInstanceIdentifier,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        component,
        receipt: {
          success: true,
          message: `Created RDS ${type} instance: ${dbIdentifier} (provisioning may take 5-10 minutes)`,
          data: {
            instanceId: instance.DBInstanceIdentifier,
            status: instance.DBInstanceStatus,
          },
        },
        connectionUrl,
        envVars: {
          DATABASE_URL: connectionUrl,
          DB_HOST: host,
          DB_PORT: String(port),
          DB_USER: masterUsername,
          DB_PASSWORD: masterPassword,
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
          message: 'Failed to provision RDS instance',
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
        const response = await this.rdsRequest<{
          DBInstances: RdsInstance[];
        }>('DescribeDBInstances', {
          DBInstanceIdentifier: component.externalId,
        });

        if (response.DBInstances.length > 0) {
          const instance = response.DBInstances[0];
          if (instance.Endpoint) {
            const { host, port, username, password, database } = component.bindings as {
              host?: string;
              port?: number;
              username?: string;
              password?: string;
              database?: string;
            };
            return `postgresql://${username}:${password}@${instance.Endpoint.Address}:${instance.Endpoint.Port}/${database}`;
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
      await this.rdsRequest('DeleteDBInstance', {
        DBInstanceIdentifier: component.externalId,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      });

      return {
        success: true,
        message: `Deleted RDS instance: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete RDS instance',
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
      const response = await this.rdsRequest<{
        DBInstances: RdsInstance[];
      }>('DescribeDBInstances', {
        DBInstanceIdentifier: component.externalId,
      });

      if (response.DBInstances.length === 0) {
        return { status: 'unknown', message: 'Instance not found' };
      }

      const instance = response.DBInstances[0];
      const statusMap: Record<string, 'running' | 'stopped' | 'provisioning' | 'error'> = {
        available: 'running',
        backing_up: 'running',
        creating: 'provisioning',
        deleting: 'stopped',
        failed: 'error',
        'incompatible-credentials': 'error',
        'incompatible-network': 'error',
        'incompatible-option-group': 'error',
        'incompatible-parameters': 'error',
        'incompatible-restore': 'error',
        maintenance: 'running',
        modifying: 'provisioning',
        'moving-to-vpc': 'provisioning',
        rebooting: 'provisioning',
        renaming: 'provisioning',
        'resetting-master-credentials': 'provisioning',
        'restore-error': 'error',
        starting: 'provisioning',
        stopped: 'stopped',
        stopping: 'stopped',
        'storage-full': 'error',
        'storage-optimization': 'running',
        upgrading: 'provisioning',
      };

      return {
        status: statusMap[instance.DBInstanceStatus] || 'unknown',
        message: instance.DBInstanceStatus,
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  // Helper methods

  private async rdsRequest<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const { accessKeyId, secretAccessKey, region } = this.credentials;
    const host = `rds.${region}.amazonaws.com`;
    const endpoint = `https://${host}`;

    // Build query string for RDS API (uses query string, not JSON body)
    const queryParams = new URLSearchParams({
      Action: action,
      Version: '2014-10-31',
    });

    // Flatten params to query string
    this.flattenParams(params, '', queryParams);

    const body = queryParams.toString();
    const date = new Date();

    const headers = await this.signRequest({
      method: 'POST',
      host,
      path: '/',
      service: 'rds',
      region,
      accessKeyId,
      secretAccessKey,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      date,
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`RDS API error: ${response.status} ${text}`);
    }

    // Parse XML response
    return this.parseXmlResponse<T>(text, action);
  }

  private flattenParams(
    obj: Record<string, unknown>,
    prefix: string,
    params: URLSearchParams
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            this.flattenParams(item as Record<string, unknown>, `${newKey}.member.${index + 1}`, params);
          } else {
            params.append(`${newKey}.member.${index + 1}`, String(item));
          }
        });
      } else if (typeof value === 'object' && value !== null) {
        this.flattenParams(value as Record<string, unknown>, newKey, params);
      } else if (value !== undefined && value !== null) {
        params.append(newKey, String(value));
      }
    }
  }

  private parseXmlResponse<T>(xml: string, action: string): T {
    // Simple XML parser for RDS responses
    // In production, use a proper XML parser

    // Check for error
    if (xml.includes('<Error>')) {
      const codeMatch = xml.match(/<Code>([^<]+)<\/Code>/);
      const messageMatch = xml.match(/<Message>([^<]+)<\/Message>/);
      throw new Error(`${codeMatch?.[1] || 'Unknown'}: ${messageMatch?.[1] || 'Unknown error'}`);
    }

    // Extract the result
    const resultTag = `${action}Result`;
    const resultMatch = xml.match(new RegExp(`<${resultTag}>([\\s\\S]*?)</${resultTag}>`));

    if (!resultMatch) {
      return {} as T;
    }

    // Parse DBInstance if present
    const dbInstanceMatch = resultMatch[1].match(/<DBInstance>([\s\S]*?)<\/DBInstance>/);
    if (dbInstanceMatch) {
      const instanceXml = dbInstanceMatch[1];
      const instance: Partial<RdsInstance> = {};

      const getValue = (tag: string) => {
        const match = instanceXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return match?.[1];
      };

      instance.DBInstanceIdentifier = getValue('DBInstanceIdentifier');
      instance.DBInstanceArn = getValue('DBInstanceArn');
      instance.DBInstanceStatus = getValue('DBInstanceStatus');
      instance.Engine = getValue('Engine');
      instance.MasterUsername = getValue('MasterUsername');
      instance.DBName = getValue('DBName');

      // Parse Endpoint
      const endpointMatch = instanceXml.match(/<Endpoint>([\s\S]*?)<\/Endpoint>/);
      if (endpointMatch) {
        const address = endpointMatch[1].match(/<Address>([^<]+)<\/Address>/);
        const port = endpointMatch[1].match(/<Port>([^<]+)<\/Port>/);
        if (address || port) {
          instance.Endpoint = {
            Address: address?.[1] || '',
            Port: parseInt(port?.[1] || '5432', 10),
          };
        }
      }

      return { DBInstance: instance } as T;
    }

    // Parse DBInstances list
    const dbInstancesMatch = resultMatch[1].match(/<DBInstances>([\s\S]*?)<\/DBInstances>/);
    if (dbInstancesMatch) {
      const instances: RdsInstance[] = [];
      const instanceMatches = dbInstancesMatch[1].matchAll(/<DBInstance>([\s\S]*?)<\/DBInstance>/g);

      for (const match of instanceMatches) {
        const instanceXml = match[1];
        const getValue = (tag: string) => {
          const m = instanceXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
          return m?.[1];
        };

        const instance: RdsInstance = {
          DBInstanceIdentifier: getValue('DBInstanceIdentifier') || '',
          DBInstanceArn: getValue('DBInstanceArn') || '',
          DBInstanceStatus: getValue('DBInstanceStatus') || '',
          Engine: getValue('Engine') || '',
          MasterUsername: getValue('MasterUsername') || '',
          DBName: getValue('DBName'),
        };

        const endpointMatch = instanceXml.match(/<Endpoint>([\s\S]*?)<\/Endpoint>/);
        if (endpointMatch) {
          const address = endpointMatch[1].match(/<Address>([^<]+)<\/Address>/);
          const port = endpointMatch[1].match(/<Port>([^<]+)<\/Port>/);
          if (address || port) {
            instance.Endpoint = {
              Address: address?.[1] || '',
              Port: parseInt(port?.[1] || '5432', 10),
            };
          }
        }

        instances.push(instance);
      }

      return { DBInstances: instances } as T;
    }

    return {} as T;
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
    const amzDate = opts.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    const headers: Record<string, string> = {
      ...opts.headers,
      Host: opts.host,
      'X-Amz-Date': amzDate,
    };

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
      '',
      canonicalHeaders + '\n',
      signedHeaders,
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest),
    ].join('\n');

    const kDate = await this.hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
    const kRegion = await this.hmac(kDate, opts.region);
    const kService = await this.hmac(kRegion, opts.service);
    const kSigning = await this.hmac(kService, 'aws4_request');
    const signature = await this.hmacHex(kSigning, stringToSign);

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
    name: 'rds',
    displayName: 'AWS RDS',
    category: 'database',
    credentialsSchema: RdsCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  },
  factory: (credentials) => {
    const adapter = new RdsAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
