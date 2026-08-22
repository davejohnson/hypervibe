import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
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
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

export const MemorystoreCredentialsSchema = z.object({
  projectId: z.string().min(1, 'GCP Project ID is required'),
  credentials: z.string().min(1, 'Service account JSON is required'),
  region: z.string().default('us-central1'),
  authorizedNetwork: z.string().optional()
    .describe('Full Compute Engine VPC network resource name; defaults to the project default network'),
  connectMode: z.enum(['DIRECT_PEERING', 'PRIVATE_SERVICE_ACCESS'])
    .default('DIRECT_PEERING'),
  tier: z.enum(['BASIC', 'STANDARD_HA']).default('BASIC'),
  memorySizeGb: z.number().int().min(1).default(1),
});

export type MemorystoreCredentials = z.infer<typeof MemorystoreCredentialsSchema>;

interface ServiceAccountCredentials {
  type: string;
  project_id?: string;
  private_key: string;
  client_email: string;
}

interface MemorystoreInstance {
  name: string;
  displayName?: string;
  locationId?: string;
  alternativeLocationId?: string;
  state?: string;
  host?: string;
  port?: number;
  currentLocationId?: string;
  tier?: string;
  memorySizeGb?: number;
  redisVersion?: string;
  authorizedNetwork?: string;
  connectMode?: string;
  authEnabled?: boolean;
  transitEncryptionMode?: string;
}

interface MemorystoreListResponse {
  instances?: MemorystoreInstance[];
  nextPageToken?: string;
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    message?: string;
  };
}

interface AuthStringResponse {
  authString?: string;
}

class MemorystoreApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'MemorystoreApiError';
  }
}

const API_ROOT = 'https://redis.googleapis.com/v1';
const DEFAULT_ATTEMPTS = 120;
const DEFAULT_DELAY_MS = 5_000;

export class MemorystoreAdapter implements ICacheAdapter {
  readonly name = 'memorystore';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    // The first lifecycle slice deliberately uses private-IP Redis AUTH.
    // Memorystore TLS requires distributing its CA certificate separately
    // from REDIS_URL, which Hypervibe does not yet model.
    supportsTls: false,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: false,
  };

  private credentials: MemorystoreCredentials | null = null;
  private serviceAccount: ServiceAccountCredentials | null = null;
  private auth: GoogleAuth | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = MemorystoreCredentialsSchema.parse(credentials);
    try {
      this.serviceAccount = JSON.parse(
        this.credentials.credentials
      ) as ServiceAccountCredentials;
    } catch {
      throw new Error('Invalid GCP service account JSON');
    }
    if (!this.serviceAccount.client_email || !this.serviceAccount.private_key) {
      throw new Error('GCP service account JSON must include client_email and private_key');
    }
    this.auth = new GoogleAuth({
      credentials: this.serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.serviceAccount) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.listInstances(this.credentials.region, 1);
      return {
        success: true,
        email: this.serviceAccount.client_email,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccount = null;
    this.auth = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
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
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return this.failedProvision(
        environment,
        engine,
        `Google Cloud Memorystore supports Redis. Requested engine: ${engine}`
      );
    }

    const region = options?.region ?? this.credentials.region;
    const resourceName = options?.resourceName ?? `${environment.name}-redis`;
    const instanceId = this.sanitizeId(resourceName);
    const externalId = this.instanceResourceName(region, instanceId);
    let mutationAttempted = false;

    try {
      const matches = await this.findInstancesByName(region, resourceName, instanceId);
      if (matches.length > 0) {
        throw new Error([
          `Google Cloud Memorystore instance "${resourceName}" already exists: ${matches
            .map((instance) => `${instance.displayName ?? this.instanceId(instance.name)} (${instance.name})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended instance or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      mutationAttempted = true;
      const operation = await this.request<GoogleOperation>(
        'POST',
        `/projects/${encodeURIComponent(this.credentials.projectId)}/locations/${encodeURIComponent(region)}/instances`,
        {
          query: { instanceId },
          body: {
            displayName: resourceName,
            tier: this.credentials.tier,
            memorySizeGb: this.memorySize(options?.size),
            redisVersion: 'REDIS_7_2',
            authorizedNetwork: this.credentials.authorizedNetwork
              ?? `projects/${this.credentials.projectId}/global/networks/default`,
            connectMode: this.credentials.connectMode,
            authEnabled: true,
            transitEncryptionMode: 'DISABLED',
            labels: {
              managed_by: 'hypervibe',
              environment: this.sanitizeLabel(environment.name),
            },
          },
        }
      );
      if (!operation.name) {
        throw new Error('Memorystore create response did not include an operation name.');
      }
      await this.waitForOperation(operation.name, 'create');
      const ready = await this.waitForInstance(externalId, 'READY');
      if (!ready.host || !ready.port) {
        throw new Error(
          `Memorystore instance ${ready.name} became READY without a host and port.`
        );
      }
      const authString = await this.getAuthString(ready.name);
      const connectionUrl = this.connectionUrl(ready.host, ready.port, authString);
      const component = this.component(environment, ready, connectionUrl);

      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created and verified Google Cloud Memorystore instance ${instanceId}`,
          data: {
            instanceId: ready.name,
            displayName: ready.displayName,
            region,
            status: ready.state,
            tier: ready.tier,
            privateNetworkOnly: true,
          },
        },
      };
    } catch (error) {
      let live: MemorystoreInstance | null | undefined;
      let observationError: string | undefined;
      if (mutationAttempted) {
        try {
          live = await this.getInstance(externalId);
        } catch (observeError) {
          observationError = this.formatError(observeError);
        }
      }
      return {
        component: mutationAttempted
          ? this.partialComponent(environment, {
            name: externalId,
            displayName: resourceName,
            state: live?.state,
            ...(live ?? {}),
          })
          : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: mutationAttempted
            ? 'Memorystore creation was attempted, but readiness could not be proven'
            : 'Failed to provision Google Cloud Memorystore',
          error: this.formatError(error),
          data: {
            instanceId: externalId,
            mutationAttempted,
            resourceCreated: live === undefined
              ? (mutationAttempted ? 'unknown' : false)
              : Boolean(live),
            ...(live?.state ? { status: live.state } : {}),
            ...(observationError ? { observationError } : {}),
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
    if (!component.externalId) {
      return null;
    }
    const instance = await this.getInstance(component.externalId);
    if (!instance?.host || !instance.port) {
      return null;
    }
    const authString = await this.getAuthString(instance.name);
    return this.connectionUrl(instance.host, instance.port, authString);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.credentials || !component.externalId) {
      return {
        success: false,
        message: 'Memorystore adapter is not connected or the component has no instance ID',
      };
    }
    try {
      const existing = await this.getInstance(component.externalId);
      if (!existing) {
        return {
          success: true,
          message: `Google Cloud Memorystore instance is already absent: ${component.externalId}`,
        };
      }
      const operation = await this.request<GoogleOperation>(
        'DELETE',
        `/${component.externalId}`
      );
      if (!operation.name) {
        throw new Error('Memorystore delete response did not include an operation name.');
      }
      await this.waitForOperation(operation.name, 'delete');
      await this.waitForInstance(component.externalId, 'DELETED');
      return {
        success: true,
        message: `Deleted Google Cloud Memorystore instance ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Google Cloud Memorystore instance ${component.externalId}`,
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) {
      return { status: 'unknown' };
    }
    try {
      const instance = await this.getInstance(component.externalId);
      if (!instance) {
        return { status: 'stopped', message: 'Instance is absent' };
      }
      return {
        status: this.normalizedStatus(instance.state),
        message: instance.state,
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
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    let instance: MemorystoreInstance | null;
    if (component?.externalId) {
      instance = await this.getInstance(component.externalId);
    } else {
      const resourceName = options?.resourceName ?? `${environment.name}-redis`;
      const instanceId = this.sanitizeId(resourceName);
      const matches = await this.findInstancesByName(
        this.credentials.region,
        resourceName,
        instanceId
      );
      if (matches.length > 1) {
        throw new Error(
          `Multiple Google Cloud Memorystore instances match "${resourceName}": ${matches
            .map((candidate) => candidate.name)
            .join(', ')}`
        );
      }
      instance = matches[0] ?? null;
    }
    if (!instance) {
      return null;
    }
    return {
      provider: 'memorystore',
      engine: 'redis',
      externalId: instance.name,
      providerScope: this.providerScope(instance),
      name: instance.displayName ?? this.instanceId(instance.name),
      status: this.normalizedStatus(instance.state),
    };
  }

  async inspectCacheResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const candidates = request.id
      ? [await this.getInstance(request.id)].filter(
        (instance): instance is MemorystoreInstance => Boolean(instance)
      )
      : await this.listInstances(request.region ?? '-');
    const matched = candidates.filter((instance) => {
      if (!request.name) return true;
      const expected = request.name.toLowerCase();
      return instance.name.toLowerCase() === expected
        || this.instanceId(instance.name).toLowerCase() === expected
        || instance.displayName?.toLowerCase() === expected;
    });
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'cache',
      caches: matched.slice(0, request.limit).map((instance) => ({
        id: instance.name,
        name: instance.displayName ?? this.instanceId(instance.name),
        engine: 'redis',
        status: instance.state ?? 'unknown',
        ...(instance.redisVersion ? { engineVersion: instance.redisVersion } : {}),
        providerScope: this.providerScope(instance),
      })),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  private async findInstancesByName(
    region: string,
    displayName: string,
    instanceId: string
  ): Promise<MemorystoreInstance[]> {
    const instances = await this.listInstances(region);
    return instances.filter((instance) =>
      instance.displayName === displayName || this.instanceId(instance.name) === instanceId
    );
  }

  private async listInstances(
    region: string,
    pageSize = 100
  ): Promise<MemorystoreInstance[]> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const instances: MemorystoreInstance[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.request<MemorystoreListResponse>(
        'GET',
        `/projects/${encodeURIComponent(this.credentials.projectId)}/locations/${encodeURIComponent(region)}/instances`,
        {
          query: {
            pageSize,
            pageToken,
          },
        }
      );
      instances.push(...(response.instances ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken);
    return instances;
  }

  private async getInstance(
    resourceName: string
  ): Promise<MemorystoreInstance | null> {
    try {
      return await this.request<MemorystoreInstance>('GET', `/${resourceName}`);
    } catch (error) {
      if (error instanceof MemorystoreApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async getAuthString(resourceName: string): Promise<string> {
    const response = await this.request<AuthStringResponse>(
      'GET',
      `/${resourceName}/authString`
    );
    if (!response.authString) {
      throw new Error(`Memorystore instance ${resourceName} did not return an auth string.`);
    }
    return response.authString;
  }

  private async waitForOperation(name: string, description: string): Promise<void> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const operation = await this.request<GoogleOperation>('GET', `/${name}`);
      if (operation.done) {
        if (operation.error) {
          throw new Error(
            `Memorystore ${description} operation failed: ${operation.error.code ?? ''} ${operation.error.message ?? ''}`.trim()
          );
        }
        return;
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(`Memorystore ${description} operation did not finish before timeout.`);
  }

  private async waitForInstance(
    resourceName: string,
    target: 'READY' | 'DELETED'
  ): Promise<MemorystoreInstance> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_MEMORYSTORE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const instance = await this.getInstance(resourceName);
      if (target === 'DELETED' && !instance) {
        return { name: resourceName, state: 'DELETED' };
      }
      if (target === 'READY' && instance?.state === 'READY') {
        return instance;
      }
      if (instance && /FAILED|SUSPENDED/i.test(instance.state ?? '')) {
        throw new Error(
          `Memorystore instance ${resourceName} entered terminal status ${instance.state}.`
        );
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(
      `Memorystore instance ${resourceName} did not become ${target} before timeout.`
    );
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    }
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      const text = this.safeApiError(await response.text());
      throw new MemorystoreApiError(
        response.status,
        `Google Cloud Memorystore API error: ${response.status} ${text}`
      );
    }
    if (response.status === 204 || response.headers.get('Content-Length') === '0') {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.auth) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }
    const client = await this.auth.getClient();
    const result = await client.getAccessToken();
    const token = typeof result === 'string' ? result : result.token;
    if (!token) {
      throw new Error('Google authentication did not return an access token.');
    }
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return token;
  }

  private component(
    environment: Environment,
    instance: MemorystoreInstance,
    connectionUrl: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: instance.name,
      bindings: {
        provider: 'memorystore',
        instanceId: instance.name,
        providerScope: this.providerScope(instance),
        connectionString: connectionUrl,
        connectionUrl,
        host: instance.host,
        port: instance.port,
        region: instance.currentLocationId ?? instance.locationId,
        authorizedNetwork: instance.authorizedNetwork,
        privateNetworkOnly: true,
        transitEncryptionMode: instance.transitEncryptionMode ?? 'DISABLED',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    instance: MemorystoreInstance
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: instance.name,
      bindings: {
        provider: 'memorystore',
        instanceId: instance.name,
        providerScope: this.providerScope(instance),
        privateNetworkOnly: true,
      },
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
      externalId: null,
      bindings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
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
        message: 'Failed to provision Google Cloud Memorystore',
        error,
      },
    };
  }

  private connectionUrl(host: string, port: number, authString: string): string {
    return `redis://:${encodeURIComponent(authString)}@${host}:${port}`;
  }

  private instanceResourceName(region: string, instanceId: string): string {
    return `projects/${this.credentials!.projectId}/locations/${region}/instances/${instanceId}`;
  }

  private instanceId(resourceName: string): string {
    return resourceName.split('/').at(-1) ?? resourceName;
  }

  private providerScope(instance: MemorystoreInstance): Record<string, string> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const segments = instance.name.split('/');
    const projectId = segments[0] === 'projects' && segments[1]
      ? segments[1]
      : this.credentials.projectId;
    const region = segments[2] === 'locations' && segments[3]
      ? segments[3]
      : instance.currentLocationId ?? instance.locationId ?? this.credentials.region;
    return { projectId, region };
  }

  private sanitizeId(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 40) || 'hypervibe-redis';
  }

  private sanitizeLabel(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 63) || 'environment';
  }

  private memorySize(value?: string): number {
    if (!value) return this.credentials!.memorySizeGb;
    const parsed = Number(value.replace(/gb$/i, ''));
    return Number.isInteger(parsed) && parsed >= 1
      ? parsed
      : this.credentials!.memorySizeGb;
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (status === 'READY') return 'running';
    if (['DELETING', 'MAINTENANCE'].includes(status ?? '')) return 'stopped';
    if (['CREATING', 'UPDATING'].includes(status ?? '')) return 'provisioning';
    if (['FAILED', 'SUSPENDED'].includes(status ?? '')) return 'error';
    return 'unknown';
  }

  private safeApiError(text: string): string {
    return text
      .slice(0, 500)
      .replace(/redis(?:s)?:\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URL]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
}

providerRegistry.register({
  metadata: {
    name: 'memorystore',
    displayName: 'Google Cloud Memorystore',
    category: 'cache',
    credentialsSchema: MemorystoreCredentialsSchema,
    setupHelpUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    lifecycle: {
      cacheEngines: ['redis'],
    },
  },
  factory: (credentials) => {
    const adapter = new MemorystoreAdapter();
    void adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['cache'],
    defaultResource: 'cache',
    selectors: {
      cache: { mode: 'provider-resource', optional: ['id', 'name', 'region', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId', 'region'] },
    },
    inspect: (adapter, request) => (
      adapter as MemorystoreAdapter
    ).inspectCacheResources(request),
  },
});
