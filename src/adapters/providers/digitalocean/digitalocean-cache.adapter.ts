import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  DigitalOceanClient,
  type DigitalOceanConnection,
  type DigitalOceanDatabaseCluster,
} from './digitalocean.client.js';
import {
  DigitalOceanCredentialsSchema,
  type DigitalOceanCredentials,
} from './digitalocean.credentials.js';

export class DigitalOceanCacheAdapter implements ICacheAdapter {
  readonly name = 'digitalocean';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
  };

  private client: DigitalOceanClient | null;
  private credentials: DigitalOceanCredentials | null;

  constructor(
    client?: DigitalOceanClient,
    credentials?: DigitalOceanCredentials
  ) {
    this.client = client ?? null;
    this.credentials = credentials ?? null;
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = DigitalOceanCredentialsSchema.parse(credentials);
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
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      resourceName?: string;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return {
        component: this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: `DigitalOcean cache adapter supports Redis-compatible Valkey. Requested engine: ${engine}`,
        },
      };
    }

    const resourceName = options?.resourceName ?? `${environment.name}-redis`;
    let created: DigitalOceanDatabaseCluster | undefined;
    try {
      let matches: DigitalOceanDatabaseCluster[];
      try {
        matches = await this.client.findDatabaseClustersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether DigitalOcean Valkey cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
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
        engine: 'valkey',
        version: this.credentials.valkeyVersion,
        region: options?.region ?? this.credentials.region,
        size: options?.size ?? this.credentials.databaseSize,
      });
      const online = await this.client.waitForDatabaseOnline(created.id);
      const connectionUrl = this.connectionUrl(online.connection);
      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'redis',
        bindings: {
          provider: 'digitalocean',
          instanceId: online.id,
          engine: online.engine,
          connectionString: connectionUrl,
          connectionUrl,
          region: online.region,
        },
        externalId: online.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created DigitalOcean Valkey cluster: ${online.name}`,
          data: {
            clusterId: online.id,
            engine: online.engine,
            region: online.region,
            status: online.status,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: created
          ? this.partialComponent(environment, created)
          : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: created
            ? 'DigitalOcean created the Valkey cluster, but provisioning did not complete'
            : 'Failed to provision DigitalOcean Valkey cluster',
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
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    if (typeof stored === 'string') {
      return stored;
    }
    if (!this.client || !component.externalId) {
      return null;
    }
    const cluster = await this.client.getDatabaseCluster(component.externalId);
    return cluster ? this.connectionUrl(cluster.connection) : null;
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
          ? `DigitalOcean Valkey cluster is already absent: ${component.externalId}`
          : `Deleted DigitalOcean Valkey cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete DigitalOcean Valkey cluster',
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
        return { status: 'stopped', message: 'Cluster is absent' };
      }
      return {
        status: this.normalizedStatus(cluster.status),
        message: cluster.status,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeCache(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedCache | null> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    let cluster: DigitalOceanDatabaseCluster | null;
    if (component?.externalId) {
      cluster = await this.client.getDatabaseCluster(component.externalId);
    } else {
      const resourceName = options?.resourceName ?? `${environment.name}-redis`;
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
    if (!['valkey', 'redis'].includes(cluster.engine)) {
      throw new Error(
        `DigitalOcean resource ${cluster.id} is engine ${cluster.engine}, not Redis-compatible Valkey.`
      );
    }
    return {
      provider: 'digitalocean',
      engine: 'redis',
      externalId: cluster.id,
      name: cluster.name,
      status: this.normalizedStatus(cluster.status),
    };
  }

  private emptyComponent(
    environment: Environment,
    engine: CacheEngine
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: engine,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cluster: DigitalOceanDatabaseCluster
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        provider: 'digitalocean',
        instanceId: cluster.id,
        engine: cluster.engine,
      },
      externalId: cluster.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private connectionUrl(connection: DigitalOceanConnection | undefined): string {
    if (connection?.uri) {
      return connection.uri;
    }
    if (
      connection?.host
      && connection.port
      && connection.user
      && connection.password
    ) {
      const protocol = connection.protocol || 'rediss';
      const auth = `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}`;
      return `${protocol}://${auth}@${connection.host}:${connection.port}`;
    }
    throw new Error('DigitalOcean did not return Valkey connection credentials.');
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
