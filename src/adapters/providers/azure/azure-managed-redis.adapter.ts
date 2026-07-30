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
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import {
  AzureManagedRedisCredentialsSchema,
  type AzureManagedRedisCredentials,
} from './azure-datastore.credentials.js';
import {
  AzureManagedRedisClient,
  type AzureManagedRedisCluster,
  type AzureManagedRedisDatabase,
} from './azure-managed-redis.client.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';

const PROVIDER = 'azure-managed-redis';

export class AzureManagedRedisAdapter implements ICacheAdapter {
  readonly name = PROVIDER;

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
  };

  private credentials: AzureManagedRedisCredentials | null = null;
  private client: AzureManagedRedisClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureManagedRedisCredentialsSchema.parse(credentials);
    this.client = new AzureManagedRedisClient(
      new AzureResourceManagerClient(this.credentials)
    );
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyScope();
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
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
          message: `Azure Managed Redis supports Redis only. Requested engine: ${engine}`,
        },
      };
    }

    const resourceName = this.resourceName(
      options?.resourceName ?? `${environment.name}-redis`
    );
    const resourceId = this.client.clusterResourceId(resourceName);
    let mutationAttempted = false;

    try {
      let matches: AzureManagedRedisCluster[];
      try {
        matches = await this.client.findClustersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Azure Managed Redis cluster "${resourceName}" already exists, so Hypervibe refused to create a cluster that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Azure Managed Redis cluster "${resourceName}" already exists: ${matches
            .map((cluster) => `${cluster.name} (${cluster.id})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Use hv_import for the intended cluster or remove the conflict, then run hv_plan again.',
        ].join(' '));
      }

      mutationAttempted = true;
      await this.client.createCluster(resourceName, {
        location: options?.region ?? this.credentials.location,
        sku: {
          name: options?.size ?? this.credentials.redisSkuName,
        },
        properties: {
          minimumTlsVersion: '1.2',
          highAvailability: 'Enabled',
        },
        tags: this.tags(environment),
      });
      const ready = await this.waitForCluster(resourceId);
      await this.client.createDatabase(ready.id);
      const database = await this.waitForDatabase(ready.id);
      const key = await this.client.listKeys(ready.id);
      const host = ready.properties?.hostName;
      const port = database.properties?.port ?? 10000;
      if (!host) {
        throw new Error(
          'Azure Managed Redis did not return a cluster hostname.'
        );
      }
      const connectionUrl =
        `rediss://:${encodeURIComponent(key)}@${host}:${port}`;
      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'redis',
        bindings: {
          provider: PROVIDER,
          instanceId: ready.id,
          connectionString: connectionUrl,
          connectionUrl,
          host,
          port,
          password: key,
          database: 'default',
          region: ready.location,
        },
        externalId: ready.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created Azure Managed Redis cluster: ${ready.name}`,
          data: {
            clusterId: ready.id,
            location: ready.location,
            state: ready.properties?.resourceState,
            databaseState: database.properties?.resourceState,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: mutationAttempted
          ? this.partialComponent(environment, resourceId)
          : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'Azure created or accepted the Managed Redis cluster, but provisioning did not complete'
            : 'Failed to provision Azure Managed Redis cluster',
          error: this.formatError(error),
          ...(mutationAttempted
            ? {
                data: {
                  clusterId: resourceId,
                  mutationAttempted: true,
                },
              }
            : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    return typeof stored === 'string' ? stored : null;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    try {
      const existing = await this.client.getCluster(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Azure Managed Redis cluster is already absent: ${component.externalId}`,
        };
      }
      await this.client.deleteCluster(component.externalId);
      await this.waitForAbsence(component.externalId);
      return {
        success: true,
        message: `Deleted Azure Managed Redis cluster: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Azure Managed Redis cluster',
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
      const cluster = await this.client.getCluster(component.externalId);
      if (!cluster) {
        return { status: 'stopped', message: 'Cluster is absent' };
      }
      return {
        status: this.normalizedStatus(
          cluster.properties?.resourceState
            ?? cluster.properties?.provisioningState
        ),
        message: cluster.properties?.resourceState
          ?? cluster.properties?.provisioningState,
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
    let cluster: AzureManagedRedisCluster | null;
    if (component?.externalId) {
      cluster = await this.client.getCluster(component.externalId);
    } else {
      const name = this.resourceName(
        options?.resourceName ?? `${environment.name}-redis`
      );
      const matches = await this.client.findClustersByName(name);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Azure Managed Redis clusters match "${name}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cluster = matches[0] ?? null;
    }
    if (!cluster) return null;
    return {
      provider: PROVIDER,
      engine: 'redis',
      externalId: cluster.id,
      name: cluster.name,
      status: this.normalizedStatus(
        cluster.properties?.resourceState
          ?? cluster.properties?.provisioningState
      ),
    };
  }

  private async waitForCluster(
    resourceId: string
  ): Promise<AzureManagedRedisCluster> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const cluster = await this.client!.getCluster(resourceId);
      const state = (
        cluster?.properties?.resourceState
        ?? cluster?.properties?.provisioningState
      )?.toLowerCase();
      if (
        cluster
        && ['running', 'succeeded'].includes(state ?? '')
      ) {
        return cluster;
      }
      if (
        ['failed', 'createfailed', 'deletefailed'].includes(state ?? '')
      ) {
        throw new Error(
          `Azure Managed Redis cluster ${resourceId} entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis cluster ${resourceId} did not become ready.`
    );
  }

  private async waitForDatabase(
    resourceId: string
  ): Promise<AzureManagedRedisDatabase> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const database = await this.client!.getDatabase(resourceId);
      const state = (
        database?.properties?.resourceState
        ?? database?.properties?.provisioningState
      )?.toLowerCase();
      if (
        database
        && ['running', 'succeeded'].includes(state ?? '')
      ) {
        return database;
      }
      if (
        ['failed', 'createfailed', 'deletefailed'].includes(state ?? '')
      ) {
        throw new Error(
          `Azure Managed Redis database entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis database for ${resourceId} did not become ready.`
    );
  }

  private async waitForAbsence(resourceId: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_DELETE_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_REDIS_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.client!.getCluster(resourceId))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure Managed Redis cluster ${resourceId} still exists after deletion.`
    );
  }

  private partialComponent(
    environment: Environment,
    resourceId: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        provider: PROVIDER,
        instanceId: resourceId,
      },
      externalId: resourceId,
      createdAt: new Date(),
      updatedAt: new Date(),
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

  private resourceName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .replace(/-$/g, '');
    return normalized || 'hypervibe-redis';
  }

  private tags(environment: Environment): Record<string, string> {
    return {
      'hypervibe-managed': 'true',
      'hypervibe-environment': environment.name.slice(0, 256),
    };
  }

  private normalizedStatus(
    value?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const state = value?.toLowerCase();
    if (['running', 'succeeded'].includes(state ?? '')) return 'running';
    if (['disabled', 'stopped'].includes(state ?? '')) return 'stopped';
    if (
      ['failed', 'createfailed', 'updatefailed', 'deletefailed'].includes(
        state ?? ''
      )
    ) {
      return 'error';
    }
    if (state) return 'provisioning';
    return 'unknown';
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: PROVIDER,
    displayName: 'Azure Managed Redis',
    category: 'cache',
    credentialsSchema: AzureManagedRedisCredentialsSchema,
    setupHelpUrl:
      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      environmentVariableAliases: [
        ['AZURE_TENANT_ID', 'HYPERVIBE_AZURE_TENANT_ID'],
        ['AZURE_SUBSCRIPTION_ID', 'HYPERVIBE_AZURE_SUBSCRIPTION_ID'],
        ['AZURE_CLIENT_ID', 'HYPERVIBE_AZURE_CLIENT_ID'],
        ['AZURE_CLIENT_SECRET', 'HYPERVIBE_AZURE_CLIENT_SECRET'],
      ],
    },
    lifecycle: {
      cacheEngines: ['redis'],
    },
  },
  factory: (credentials) => {
    const validated = AzureManagedRedisCredentialsSchema.parse(credentials);
    const adapter = new AzureManagedRedisAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
