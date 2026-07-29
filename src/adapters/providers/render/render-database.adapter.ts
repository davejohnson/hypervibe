import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  DatabaseCapabilities,
  IDatabaseAdapter,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import type { ObservedDatabase } from '../../../domain/ports/observe.port.js';
import type {
  Receipt,
  TemporaryDatabaseAccess,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import {
  RenderClient,
  type RenderPostgres,
  type RenderPostgresConnectionInfo,
} from './render.client.js';
import {
  RenderCredentialsSchema,
  type RenderCredentials,
} from './render.credentials.js';

export class RenderDatabaseAdapter implements IDatabaseAdapter {
  readonly name = 'render';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: true,
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: RenderCredentials | null = null;
  private client: RenderClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = RenderCredentialsSchema.parse(credentials);
    this.client = new RenderClient(this.credentials.apiKey);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const owner = await this.client.getOwner(this.credentials.ownerId);
      if (!owner) {
        return {
          success: false,
          error: `Render workspace ${this.credentials.ownerId} was not found.`,
        };
      }
      await this.client.listPostgres(this.credentials.ownerId);
      return { success: true, email: owner.email };
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
    options: {
      size?: string;
      region?: string;
      databaseName?: string;
      resourceName?: string;
    } = {}
  ): Promise<ProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return {
        component: this.emptyComponent(environment),
        receipt: {
          success: false,
          message: `Render does not support ${type} through this adapter.`,
        },
      };
    }

    const resourceName =
      options.resourceName ?? `${environment.name}-postgres`;
    let matches: RenderPostgres[];
    try {
      matches = (await this.client.listPostgres(this.credentials.ownerId))
        .filter((database) => database.name === resourceName);
    } catch (error) {
      return this.failedProvision(
        environment,
        `Could not prove Render Postgres "${resourceName}" is absent. ${this.formatError(error)}`
      );
    }
    if (matches.length > 0) {
      return this.failedProvision(
        environment,
        [
          `Render Postgres name "${resourceName}" is already present: ${matches
            .map((database) => database.id)
            .join(', ')}.`,
          'Hypervibe will not silently adopt a name match. Use hv_import for the intended database or remove the duplicate, then run hv_plan again.',
        ].join(' ')
      );
    }

    let created: RenderPostgres;
    try {
      created = await this.client.createPostgres({
        name: resourceName,
        ownerId: this.credentials.ownerId,
        plan: options.size ?? this.credentials.postgresPlan,
        version: this.credentials.postgresVersion,
        region: options.region ?? this.credentials.region,
        databaseName: options.databaseName ?? 'app',
        connectionPool: 'pgbouncer',
      });
    } catch (error) {
      return this.failedProvision(environment, this.formatError(error));
    }
    const partial = this.partialComponent(environment, created);

    try {
      const ready = await this.waitForAvailable(created.id);
      if (!ready || ready.status !== 'available') {
        return {
          component: partial,
          receipt: {
            success: false,
            message: 'Render Postgres creation is still pending',
            error: `Render Postgres ${created.id} did not become available before the observation deadline.`,
            data: {
              postgresId: created.id,
              status: ready?.status ?? created.status ?? 'unknown',
            },
          },
        };
      }
      const connection = await this.client.getPostgresConnectionInfo(created.id);
      return this.provisionedResult(environment, ready, connection);
    } catch (error) {
      return {
        component: partial,
        receipt: {
          success: false,
          message: 'Render Postgres was created but could not be verified',
          error: this.formatError(error),
          data: {
            postgresId: created.id,
            status: created.status ?? 'unknown',
          },
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
    const info = await this.client.getPostgresConnectionInfo(component.externalId);
    return info.internalConnectionString;
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    _applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    const stored = component.bindings.externalConnectionString;
    if (typeof stored === 'string' && stored.length > 0) {
      return {
        connectionUrl: stored,
        source: 'direct',
        temporary: false,
      };
    }
    if (!this.client || !component.externalId) {
      throw new Error('Render Postgres has no durable provider identity.');
    }
    const info = await this.client.getPostgresConnectionInfo(component.externalId);
    return {
      connectionUrl: info.externalConnectionString,
      source: 'direct',
      temporary: false,
    };
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    const postgresId = component.externalId;
    try {
      const existing = await this.client.getPostgres(postgresId);
      if (!existing) {
        return {
          success: true,
          message: `Render Postgres is already absent: ${postgresId}`,
        };
      }
      await this.client.deletePostgres(postgresId);
      const absent = await this.waitForAbsence(postgresId);
      return absent
        ? {
            success: true,
            message: `Deleted Render Postgres: ${postgresId}`,
          }
        : {
            success: false,
            message: 'Render Postgres deletion is still pending',
            error: `Render Postgres ${postgresId} remained observable after the deletion deadline.`,
          };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Render Postgres',
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
      const database = await this.client.getPostgres(component.externalId);
      if (!database) {
        return { status: 'stopped', message: 'Database is absent' };
      }
      return {
        status: this.normalizedStatus(database.status),
        message: database.status,
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
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    let database: RenderPostgres | null;
    if (component?.externalId) {
      database = await this.client.getPostgres(component.externalId);
    } else {
      const resourceName =
        options?.resourceName ?? `${environment.name}-postgres`;
      const matches = (await this.client.listPostgres(this.credentials.ownerId))
        .filter((candidate) => candidate.name === resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Render Postgres instances match "${resourceName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      database = matches[0] ?? null;
    }
    if (!database) {
      return null;
    }
    return {
      provider: 'render',
      engine: 'postgres',
      externalId: database.id,
      name: database.name,
      status: this.normalizedStatus(database.status),
    };
  }

  private provisionedResult(
    environment: Environment,
    database: RenderPostgres,
    info: RenderPostgresConnectionInfo
  ): ProvisionResult {
    const internal = new URL(info.internalConnectionString);
    const component: Component = {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      externalId: database.id,
      bindings: {
        provider: 'render',
        instanceId: database.id,
        connectionString: info.internalConnectionString,
        connectionUrl: info.internalConnectionString,
        externalConnectionString: info.externalConnectionString,
        ...(info.internalConnectionPoolString
          ? { pooledUrl: info.internalConnectionPoolString }
          : {}),
        ...(info.externalConnectionPoolString
          ? { externalPooledUrl: info.externalConnectionPoolString }
          : {}),
        host: internal.hostname,
        port: Number(internal.port || 5432),
        username: decodeURIComponent(internal.username),
        password: decodeURIComponent(internal.password),
        database: internal.pathname.replace(/^\//, ''),
        region: database.region,
        plan: database.plan,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return {
      component,
      connectionUrl: info.internalConnectionString,
      envVars: {
        DATABASE_URL: info.internalConnectionString,
        DIRECT_URL: info.internalConnectionString,
        ...(info.internalConnectionPoolString
          ? { DATABASE_POOLER_URL: info.internalConnectionPoolString }
          : {}),
      },
      receipt: {
        success: true,
        message: `Provisioned Render Postgres: ${database.name}`,
        data: {
          postgresId: database.id,
          name: database.name,
          status: database.status ?? 'available',
          region: database.region,
          plan: database.plan,
        },
      },
    };
  }

  private async waitForAvailable(
    postgresId: string
  ): Promise<RenderPostgres | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_READY_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_READY_DELAY_MS',
      5000
    );
    let last: RenderPostgres | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.client!.getPostgres(postgresId);
      if (!last) {
        throw new Error(`Render Postgres ${postgresId} disappeared during creation.`);
      }
      if (last.status === 'available') {
        return last;
      }
      if (['unavailable', 'recovery_failed'].includes(last.status ?? '')) {
        throw new Error(
          `Render Postgres ${postgresId} entered terminal status ${last.status}.`
        );
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }
    return last;
  }

  private async waitForAbsence(postgresId: string): Promise<boolean> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_DELETE_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_DELETE_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.client!.getPostgres(postgresId)) {
        return true;
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }
    return false;
  }

  private failedProvision(
    environment: Environment,
    error: string
  ): ProvisionResult {
    return {
      component: this.emptyComponent(environment),
      receipt: {
        success: false,
        message: 'Failed to provision Render Postgres',
        error,
      },
    };
  }

  private emptyComponent(environment: Environment): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    database: RenderPostgres
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'postgres',
      bindings: {
        provider: 'render',
        instanceId: database.id,
        region: database.region,
        plan: database.plan,
      },
      externalId: database.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (status === 'available') return 'running';
    if (status === 'suspended') return 'stopped';
    if (['unavailable', 'recovery_failed'].includes(status ?? '')) {
      return 'error';
    }
    if (status) return 'provisioning';
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
