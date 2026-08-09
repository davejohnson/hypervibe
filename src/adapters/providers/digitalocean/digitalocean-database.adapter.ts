import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  DatabaseCapabilities,
  IDatabaseAdapter,
  ProvisionableType,
  ProvisionResult,
} from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  DigitalOceanClient,
  type DigitalOceanConnection,
  type DigitalOceanDatabaseCluster,
} from './digitalocean.client.js';
import {
  parseDigitalOceanRuntimeCredentials,
  type DigitalOceanRuntimeCredentials,
} from './digitalocean.credentials.js';
import { DigitalOceanCacheAdapter } from './digitalocean-cache.adapter.js';

export { DigitalOceanCredentialsSchema } from './digitalocean.credentials.js';
export type { DigitalOceanCredentials } from './digitalocean.credentials.js';

export class DigitalOceanDatabaseAdapter implements IDatabaseAdapter {
  readonly name = 'digitalocean';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
  };

  private credentials: DigitalOceanRuntimeCredentials | null = null;
  private client: DigitalOceanClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = parseDigitalOceanRuntimeCredentials(credentials);
    this.client = new DigitalOceanClient(this.credentials.apiToken);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyDatabaseAccess();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  createCacheAdapter(): DigitalOceanCacheAdapter {
    if (!this.client || !this.credentials) {
      throw new Error('DigitalOcean adapter is not connected.');
    }
    return new DigitalOceanCacheAdapter(this.client, this.credentials);
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      databaseName?: string;
      resourceName?: string;
    }
  ): Promise<ProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return {
        component: this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: `DigitalOcean Managed Databases supports PostgreSQL in this adapter. Requested type: ${type}`,
        },
      };
    }

    const resourceName = options?.resourceName ?? `${environment.name}-postgres`;
    const databaseName = options?.databaseName?.trim() || 'app';
    let created: DigitalOceanDatabaseCluster | undefined;

    try {
      let matches: DigitalOceanDatabaseCluster[];
      try {
        matches = await this.client.findDatabaseClustersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether DigitalOcean database cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `DigitalOcean database cluster "${resourceName}" already exists: ${matches
            .map((cluster) => `${cluster.name} (${cluster.id}, ${cluster.engine})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended cluster or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      created = await this.client.createDatabaseCluster({
        name: resourceName,
        engine: 'pg',
        version: this.credentials.postgresVersion,
        region: options?.region ?? this.credentials.region,
        size: options?.size ?? this.credentials.databaseSize,
      });
      const online = await this.client.waitForDatabaseOnline(created.id);
      await this.client.ensurePostgresDatabase(online.id, databaseName);
      const connectionUrl = this.connectionUrl(
        online.connection,
        'postgresql',
        databaseName
      );
      const parsed = this.parseConnectionUrl(connectionUrl);
      const component = this.component(
        environment,
        online,
        databaseName,
        connectionUrl,
        parsed
      );

      return {
        component,
        connectionUrl,
        envVars: {
          DATABASE_URL: connectionUrl,
          DIRECT_URL: connectionUrl,
          DATABASE_SSL: 'true',
          PGHOST: parsed.host,
          PGPORT: String(parsed.port),
          PGUSER: parsed.username,
          PGPASSWORD: parsed.password,
          PGDATABASE: databaseName,
        },
        receipt: {
          success: true,
          message: `Created DigitalOcean PostgreSQL cluster: ${online.name}`,
          data: {
            clusterId: online.id,
            engine: online.engine,
            region: online.region,
            status: online.status,
            databaseName,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: created
          ? this.partialComponent(environment, created, databaseName)
          : this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: created
            ? 'DigitalOcean created the PostgreSQL cluster, but provisioning did not complete'
            : 'Failed to provision DigitalOcean PostgreSQL cluster',
          error: this.formatError(error),
          ...(created ? {
            data: {
              clusterId: created.id,
              engine: created.engine,
              region: created.region,
              status: created.status,
            },
          } : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString;
    if (typeof stored === 'string') {
      return stored;
    }
    if (!this.client || !component.externalId) {
      return null;
    }
    const cluster = await this.client.getDatabaseCluster(component.externalId);
    if (!cluster) {
      return null;
    }
    const database = typeof component.bindings.database === 'string'
      ? component.bindings.database
      : 'app';
    return this.connectionUrl(cluster.connection, 'postgresql', database);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    try {
      const result = await this.client.destroyDatabaseCluster(component.externalId);
      return {
        success: true,
        message: result.alreadyAbsent
          ? `DigitalOcean PostgreSQL cluster is already absent: ${component.externalId}`
          : `Deleted DigitalOcean PostgreSQL cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete DigitalOcean PostgreSQL cluster',
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!this.client || !component.externalId) {
      return { status: 'unknown' };
    }
    try {
      const cluster = await this.client.getDatabaseCluster(component.externalId);
      if (!cluster) {
        return {
          status: 'stopped',
          message: `DigitalOcean cluster ${component.externalId} is absent`,
        };
      }
      return {
        status: this.normalizedStatus(cluster.status),
        message: cluster.status,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    let cluster: DigitalOceanDatabaseCluster | null;
    if (component?.externalId) {
      cluster = await this.client.getDatabaseCluster(component.externalId);
    } else {
      const resourceName = options?.resourceName ?? `${environment.name}-postgres`;
      const matches = await this.client.findDatabaseClustersByName(resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Multiple DigitalOcean database clusters match "${resourceName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cluster = matches[0] ?? null;
    }
    if (!cluster) {
      return null;
    }
    if (!['pg', 'advanced_pg'].includes(cluster.engine)) {
      throw new Error(
        `DigitalOcean resource ${cluster.id} is engine ${cluster.engine}, not PostgreSQL.`
      );
    }
    return {
      provider: 'digitalocean',
      engine: 'postgres',
      externalId: cluster.id,
      name: cluster.name,
      status: this.normalizedStatus(cluster.status),
    };
  }

  private emptyComponent(
    environment: Environment,
    type: ProvisionableType
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cluster: DigitalOceanDatabaseCluster,
    database: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'digitalocean',
        instanceId: cluster.id,
        engine: cluster.engine,
        database,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private component(
    environment: Environment,
    cluster: DigitalOceanDatabaseCluster,
    database: string,
    connectionUrl: string,
    parsed: {
      host: string;
      port: number;
      username: string;
      password: string;
    }
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'digitalocean',
        instanceId: cluster.id,
        engine: cluster.engine,
        connectionString: connectionUrl,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        database,
        region: cluster.region,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private connectionUrl(
    connection: DigitalOceanConnection | undefined,
    fallbackProtocol: string,
    database?: string
  ): string {
    let value: string;
    if (connection?.uri) {
      value = connection.uri;
    } else if (
      connection?.host
      && connection.port
      && connection.user
      && connection.password
    ) {
      const protocol = connection.protocol || fallbackProtocol;
      const auth = `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}`;
      value = `${protocol}://${auth}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database ?? database ?? '')}`;
    } else {
      throw new Error('DigitalOcean did not return database connection credentials.');
    }
    if (!database) {
      return value;
    }
    const parsed = new URL(value);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }

  private parseConnectionUrl(value: string): {
    host: string;
    port: number;
    username: string;
    password: string;
  } {
    const parsed = new URL(value);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const normalized = status?.toLowerCase();
    if (normalized === 'online') return 'running';
    if (['offline', 'stopped'].includes(normalized ?? '')) return 'stopped';
    if (['error', 'failed'].includes(normalized ?? '')) return 'error';
    if (normalized) return 'provisioning';
    return 'unknown';
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
