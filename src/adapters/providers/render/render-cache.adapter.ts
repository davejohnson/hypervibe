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
  RenderClient,
  type RenderKeyValue,
} from './render.client.js';
import {
  RenderCredentialsSchema,
  type RenderCredentials,
} from './render.credentials.js';

export class RenderCacheAdapter implements ICacheAdapter {
  readonly name = 'render';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
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
      await this.client.listKeyValues(this.credentials.ownerId);
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
    engine: CacheEngine,
    environment: Environment,
    options: {
      size?: string;
      region?: string;
      resourceName?: string;
    } = {}
  ): Promise<CacheProvisionResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return this.failedProvision(
        environment,
        engine,
        `Render does not support ${engine} through this adapter.`
      );
    }
    const resourceName =
      options.resourceName ?? `${environment.name}-redis`;
    let matches: RenderKeyValue[];
    try {
      matches = (await this.client.listKeyValues(this.credentials.ownerId))
        .filter((cache) => cache.name === resourceName);
    } catch (error) {
      return this.failedProvision(
        environment,
        engine,
        `Could not prove Render Key Value "${resourceName}" is absent. ${this.formatError(error)}`
      );
    }
    if (matches.length > 0) {
      return this.failedProvision(
        environment,
        engine,
        [
          `Render Key Value name "${resourceName}" is already present: ${matches
            .map((cache) => cache.id)
            .join(', ')}.`,
          'Hypervibe will not silently adopt a name match. Use hv_import for the intended cache or remove the duplicate, then run hv_plan again.',
        ].join(' ')
      );
    }

    let created: RenderKeyValue;
    try {
      created = await this.client.createKeyValue({
        name: resourceName,
        ownerId: this.credentials.ownerId,
        plan: options.size ?? this.credentials.keyValuePlan,
        region: options.region ?? this.credentials.region,
        maxmemoryPolicy: this.credentials.keyValueMaxmemoryPolicy,
        persistenceMode: this.credentials.keyValuePersistenceMode,
      });
    } catch (error) {
      return this.failedProvision(environment, engine, this.formatError(error));
    }
    const partial = this.partialComponent(environment, created);

    try {
      const ready = await this.waitForAvailable(created.id);
      if (!ready || ready.status !== 'available') {
        return {
          component: partial,
          receipt: {
            success: false,
            message: 'Render Key Value creation is still pending',
            error: `Render Key Value ${created.id} did not become available before the observation deadline.`,
            data: {
              keyValueId: created.id,
              status: ready?.status ?? created.status ?? 'unknown',
            },
          },
        };
      }
      const info = await this.client.getKeyValueConnectionInfo(created.id);
      return {
        component: {
          ...partial,
          bindings: {
            ...partial.bindings,
            connectionString: info.internalConnectionString,
            connectionUrl: info.internalConnectionString,
            externalConnectionString: info.externalConnectionString,
          },
        },
        connectionUrl: info.internalConnectionString,
        envVars: { REDIS_URL: info.internalConnectionString },
        receipt: {
          success: true,
          message: `Provisioned Render Key Value: ${ready.name}`,
          data: {
            keyValueId: ready.id,
            name: ready.name,
            status: ready.status ?? 'available',
            region: ready.region,
            plan: ready.plan,
          },
        },
      };
    } catch (error) {
      return {
        component: partial,
        receipt: {
          success: false,
          message: 'Render Key Value was created but could not be verified',
          error: this.formatError(error),
          data: {
            keyValueId: created.id,
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
    const info = await this.client.getKeyValueConnectionInfo(component.externalId);
    return info.internalConnectionString;
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    if (!component.externalId) {
      return { success: false, message: 'No external ID for component' };
    }
    const keyValueId = component.externalId;
    try {
      const existing = await this.client.getKeyValue(keyValueId);
      if (!existing) {
        return {
          success: true,
          message: `Render Key Value is already absent: ${keyValueId}`,
        };
      }
      await this.client.deleteKeyValue(keyValueId);
      const absent = await this.waitForAbsence(keyValueId);
      return absent
        ? {
            success: true,
            message: `Deleted Render Key Value: ${keyValueId}`,
          }
        : {
            success: false,
            message: 'Render Key Value deletion is still pending',
            error: `Render Key Value ${keyValueId} remained observable after the deletion deadline.`,
          };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Render Key Value',
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
      const cache = await this.client.getKeyValue(component.externalId);
      if (!cache) {
        return { status: 'stopped', message: 'Cache is absent' };
      }
      return {
        status: this.normalizedStatus(cache.status),
        message: cache.status,
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
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    let cache: RenderKeyValue | null;
    if (component?.externalId) {
      cache = await this.client.getKeyValue(component.externalId);
    } else {
      const resourceName =
        options?.resourceName ?? `${environment.name}-redis`;
      const matches = (await this.client.listKeyValues(this.credentials.ownerId))
        .filter((candidate) => candidate.name === resourceName);
      if (matches.length > 1) {
        throw new Error(
          `Multiple Render Key Value instances match "${resourceName}": ${matches
            .map((candidate) => candidate.id)
            .join(', ')}`
        );
      }
      cache = matches[0] ?? null;
    }
    if (!cache) {
      return null;
    }
    return {
      provider: 'render',
      engine: 'redis',
      externalId: cache.id,
      name: cache.name,
      status: this.normalizedStatus(cache.status),
    };
  }

  private async waitForAvailable(
    keyValueId: string
  ): Promise<RenderKeyValue | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_READY_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_READY_DELAY_MS',
      5000
    );
    let last: RenderKeyValue | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.client!.getKeyValue(keyValueId);
      if (!last) {
        throw new Error(`Render Key Value ${keyValueId} disappeared during creation.`);
      }
      if (last.status === 'available') {
        return last;
      }
      if (['unavailable', 'recovery_failed'].includes(last.status ?? '')) {
        throw new Error(
          `Render Key Value ${keyValueId} entered terminal status ${last.status}.`
        );
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
      }
    }
    return last;
  }

  private async waitForAbsence(keyValueId: string): Promise<boolean> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_DELETE_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_RENDER_DATABASE_DELETE_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!await this.client!.getKeyValue(keyValueId)) {
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
    engine: CacheEngine,
    error: string
  ): CacheProvisionResult {
    return {
      component: this.emptyComponent(environment, engine),
      receipt: {
        success: false,
        message: 'Failed to provision Render Key Value',
        error,
      },
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
    cache: RenderKeyValue
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      bindings: {
        provider: 'render',
        instanceId: cache.id,
        region: cache.region,
        plan: cache.plan,
      },
      externalId: cache.id,
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
