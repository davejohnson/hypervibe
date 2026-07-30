import { randomBytes } from 'crypto';
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
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import {
  AzurePostgresCredentialsSchema,
  type AzurePostgresCredentials,
} from './azure-datastore.credentials.js';
import {
  AzurePostgresClient,
  type AzurePostgresServer,
} from './azure-postgres.client.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';

const PROVIDER = 'azure-postgres';
const ADMIN_USERNAME = 'hypervibeadmin';

export class AzurePostgresAdapter implements IDatabaseAdapter {
  readonly name = PROVIDER;

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
  };

  private credentials: AzurePostgresCredentials | null = null;
  private client: AzurePostgresClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzurePostgresCredentialsSchema.parse(credentials);
    this.client = new AzurePostgresClient(
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
          message: `Azure PostgreSQL supports PostgreSQL only. Requested type: ${type}`,
        },
      };
    }

    const resourceName = this.resourceName(
      options?.resourceName ?? `${environment.name}-postgres`
    );
    const databaseName = options?.databaseName?.trim() || 'app';
    const resourceId = this.client.serverResourceId(resourceName);
    const password = this.generatePassword();
    let mutationAttempted = false;

    try {
      let matches: AzurePostgresServer[];
      try {
        matches = await this.client.findServersByName(resourceName);
      } catch (error) {
        throw new Error([
          `Could not check whether Azure PostgreSQL server "${resourceName}" already exists, so Hypervibe refused to create a server that might be a duplicate.`,
          this.formatError(error),
        ].join(' '));
      }
      if (matches.length > 0) {
        throw new Error([
          `Azure PostgreSQL server "${resourceName}" already exists: ${matches
            .map((server) => `${server.name} (${server.id})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Use hv_import for the intended server or remove the conflict, then run hv_plan again.',
        ].join(' '));
      }

      mutationAttempted = true;
      await this.client.createServer(resourceName, {
        location: options?.region ?? this.credentials.location,
        sku: {
          name: options?.size ?? this.credentials.postgresSkuName,
          tier: this.credentials.postgresSkuTier,
        },
        properties: {
          administratorLogin: ADMIN_USERNAME,
          administratorLoginPassword: password,
          version: this.credentials.postgresVersion,
          createMode: 'Create',
          storage: {
            storageSizeGB: this.credentials.postgresStorageSizeGb,
            autoGrow: 'Enabled',
          },
          backup: {
            backupRetentionDays: 7,
            geoRedundantBackup: 'Disabled',
          },
          highAvailability: { mode: 'Disabled' },
          network: { publicNetworkAccess: 'Enabled' },
          authConfig: {
            activeDirectoryAuth: 'Disabled',
            passwordAuth: 'Enabled',
          },
        },
        tags: this.tags(environment),
      });
      const ready = await this.waitForReady(resourceId);
      await this.client.createAzureServicesFirewallRule(ready.id);
      await this.waitForFirewallRule(ready.id);
      await this.client.createDatabase(ready.id, databaseName);
      await this.waitForDatabase(ready.id, databaseName);

      const host = ready.properties?.fullyQualifiedDomainName;
      if (!host) {
        throw new Error(
          'Azure PostgreSQL did not return a fully qualified domain name.'
        );
      }
      const connectionUrl = this.connectionUrl(
        host,
        ADMIN_USERNAME,
        password,
        databaseName
      );
      const component = this.component(
        environment,
        ready,
        databaseName,
        connectionUrl,
        password
      );
      return {
        component,
        connectionUrl,
        envVars: {
          DATABASE_URL: connectionUrl,
          DIRECT_URL: connectionUrl,
          DATABASE_SSL: 'true',
          PGHOST: host,
          PGPORT: '5432',
          PGUSER: ADMIN_USERNAME,
          PGPASSWORD: password,
          PGDATABASE: databaseName,
        },
        receipt: {
          success: true,
          message: `Created Azure PostgreSQL Flexible Server: ${ready.name}`,
          data: {
            serverId: ready.id,
            location: ready.location,
            state: ready.properties?.state,
            databaseName,
            azureServicesFirewall: true,
            ready: true,
          },
        },
      };
    } catch (error) {
      return {
        component: mutationAttempted
          ? this.partialComponent(environment, resourceId, databaseName)
          : this.emptyComponent(environment, type),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'Azure created or accepted the PostgreSQL server, but provisioning did not complete'
            : 'Failed to provision Azure PostgreSQL server',
          error: this.formatError(error),
          ...(mutationAttempted
            ? {
                data: {
                  serverId: resourceId,
                  mutationAttempted: true,
                },
              }
            : {}),
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString;
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
      const existing = await this.client.getServer(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Azure PostgreSQL server is already absent: ${component.externalId}`,
        };
      }
      await this.client.deleteServer(component.externalId);
      await this.waitForAbsence(component.externalId);
      return {
        success: true,
        message: `Deleted Azure PostgreSQL server: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Azure PostgreSQL server',
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
      const server = await this.client.getServer(component.externalId);
      if (!server) {
        return { status: 'stopped', message: 'Server is absent' };
      }
      return {
        status: this.normalizedStatus(server.properties?.state),
        message: server.properties?.state,
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
    let server: AzurePostgresServer | null;
    if (component?.externalId) {
      server = await this.client.getServer(component.externalId);
    } else {
      const name = this.resourceName(
        options?.resourceName ?? `${environment.name}-postgres`
      );
      const matches = await this.client.findServersByName(name);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Azure PostgreSQL servers match "${name}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      server = matches[0] ?? null;
    }
    if (!server) return null;
    return {
      provider: PROVIDER,
      engine: 'postgres',
      externalId: server.id,
      name: server.name,
      status: this.normalizedStatus(server.properties?.state),
    };
  }

  private async waitForReady(resourceId: string): Promise<AzurePostgresServer> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const server = await this.client!.getServer(resourceId);
      const state = server?.properties?.state?.toLowerCase();
      if (server && state === 'ready') return server;
      if (['failed', 'disabled'].includes(state ?? '')) {
        throw new Error(
          `Azure PostgreSQL server ${resourceId} entered state ${state}.`
        );
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL server ${resourceId} did not become Ready.`
    );
  }

  private async waitForDatabase(
    resourceId: string,
    databaseName: string
  ): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await this.client!.getDatabase(resourceId, databaseName)) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL database ${databaseName} did not become observable.`
    );
  }

  private async waitForFirewallRule(resourceId: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const rule =
        await this.client!.getAzureServicesFirewallRule(resourceId);
      if (
        rule?.properties?.startIpAddress === '0.0.0.0'
        && rule.properties.endIpAddress === '0.0.0.0'
      ) {
        return;
      }
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL firewall rule for ${resourceId} did not become observable.`
    );
  }

  private async waitForAbsence(resourceId: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_DELETE_ATTEMPTS',
      180
    );
    const interval = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_POSTGRES_POLL_INTERVAL_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!(await this.client!.getServer(resourceId))) return;
      if (attempt < attempts) await this.delay(interval);
    }
    throw new Error(
      `Azure PostgreSQL server ${resourceId} still exists after deletion.`
    );
  }

  private component(
    environment: Environment,
    server: AzurePostgresServer,
    database: string,
    connectionUrl: string,
    password: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: PROVIDER,
        instanceId: server.id,
        connectionString: connectionUrl,
        host: server.properties?.fullyQualifiedDomainName,
        port: 5432,
        username: ADMIN_USERNAME,
        password,
        database,
        region: server.location,
      },
      externalId: server.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    resourceId: string,
    database: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: PROVIDER,
        instanceId: resourceId,
        database,
      },
      externalId: resourceId,
      createdAt: new Date(),
      updatedAt: new Date(),
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

  private connectionUrl(
    host: string,
    username: string,
    password: string,
    database: string
  ): string {
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/${encodeURIComponent(database)}?sslmode=require`;
  }

  private resourceName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63)
      .replace(/-$/g, '');
    return normalized.length >= 3 ? normalized : `hv-${normalized || 'db'}`;
  }

  private tags(environment: Environment): Record<string, string> {
    return {
      'hypervibe-managed': 'true',
      'hypervibe-environment': environment.name.slice(0, 256),
    };
  }

  private generatePassword(): string {
    return `Hv1!${randomBytes(24).toString('base64url')}`;
  }

  private normalizedStatus(
    value?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const state = value?.toLowerCase();
    if (state === 'ready') return 'running';
    if (['stopped', 'disabled'].includes(state ?? '')) return 'stopped';
    if (['failed', 'inaccessible'].includes(state ?? '')) return 'error';
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
    displayName: 'Azure Database for PostgreSQL',
    category: 'database',
    credentialsSchema: AzurePostgresCredentialsSchema,
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
      databaseEngines: ['postgres'],
    },
  },
  factory: (credentials) => {
    const validated = AzurePostgresCredentialsSchema.parse(credentials);
    const adapter = new AzurePostgresAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
