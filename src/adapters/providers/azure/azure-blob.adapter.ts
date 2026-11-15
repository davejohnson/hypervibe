import { azureEnvironmentResourceGroupScope, legacyAzureEnvironmentResourceGroupScope } from './azure-environment-scope.js';
import { Readable } from 'node:stream';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  type StoragePipelineOptions,
} from '@azure/storage-blob';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedStorage } from '../../../domain/ports/observe.port.js';
import type { VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IStorageOperations,
  StorageContext,
  StorageEnsureResult,
  StorageObjectClient,
  StorageObjectPayload,
  StorageObjectRecord,
  StorageObjectRevision,
  StorageObservationTarget,
} from '../../../domain/ports/storage.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import {
  AzureResourceManagerClient,
  resolveAzureDefaultSubscription,
  type AzureResourceManagerCredentials,
} from './azure-resource-manager.client.js';

const ACCOUNT_API_VERSION = '2025-06-01';
const CONTAINER_API_VERSION = '2025-08-01';
const ENVIRONMENT_TAG = 'hypervibe-environment-id';
const STORAGE_NAME_TAG = 'hypervibe-storage-name';

const AzureBlobStorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'servicePrincipal']).default('servicePrincipal'),
  tenantId: z.string().uuid('Azure tenant ID must be a UUID').optional(),
  subscriptionId: z.string().uuid('Azure subscription ID must be a UUID').optional(),
  clientId: z.string().uuid('Azure service principal client ID must be a UUID').optional(),
  clientSecret: z.string().min(8, 'Azure service principal client secret is required').optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default') return;
  for (const field of ['tenantId', 'subscriptionId', 'clientId', 'clientSecret'] as const) {
    if (!value[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Azure ${field} is required` });
  }
});

export const AzureBlobStorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { resourceGroup: _legacyResourceGroup, location: _legacyLocation, ...authentication } = input as Record<string, unknown>;
  if (!authentication.authMode && (authentication.tenantId || authentication.clientId || authentication.clientSecret)) {
    authentication.authMode = 'servicePrincipal';
  }
  return authentication;
}, AzureBlobStorageAuthenticationSchema);

export type AzureBlobStorageCredentials = z.infer<typeof AzureBlobStorageCredentialsSchema>;
export type ConnectedAzureBlobStorageCredentials = AzureResourceManagerCredentials;

export interface AzureStorageAccount {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
}

export interface AzureBlobContainer {
  id: string;
  name: string;
}

export interface AzureStorageControlPlane {
  verifySubscription(): Promise<void>;
  listAccounts(): Promise<AzureStorageAccount[]>;
  listContainers(account: AzureStorageAccount): Promise<AzureBlobContainer[]>;
  getAccount(name: string): Promise<AzureStorageAccount | null>;
  getContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer | null>;
  listKeys(account: AzureStorageAccount): Promise<string>;
}

export interface AzureBlobDataPlane extends StorageObjectClient {
  deleteAll(): Promise<void>;
}

export interface AzureBlobStorageAdapterOptions {
  controlPlaneFactory?: (credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) => AzureStorageControlPlane;
  dataPlaneFactory?: (account: string, key: string, container: string) => AzureBlobDataPlane;
  storageHttpClient?: StoragePipelineOptions['httpClient'];
  defaultCredentialProvider?: (preferredSubscriptionId?: string) => Promise<{ authMode: 'default'; subscriptionId: string }>;
}

interface AzureStorageKeys {
  keys?: Array<{ value?: string; permissions?: string }>;
}

class ArmStorageControlPlane implements AzureStorageControlPlane {
  private readonly arm: AzureResourceManagerClient;

  constructor(credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) {
    this.arm = new AzureResourceManagerClient({ ...credentials, ...(resourceGroup ? { resourceGroup } : {}) });
  }

  async verifySubscription(): Promise<void> {
    await this.arm.verifySubscription();
  }

  async listAccounts(): Promise<AzureStorageAccount[]> {
    const resourceGroup = this.arm.credentials.resourceGroup;
    if (resourceGroup && !await this.arm.getNullable(
      `/subscriptions/${encodeURIComponent(this.arm.credentials.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}`,
      '2024-11-01'
    )) return [];
    return this.arm.listAll<AzureStorageAccount>(
      resourceGroup
        ? this.arm.resourceGroupProviderPath('Microsoft.Storage', 'storageAccounts')
        : `/subscriptions/${encodeURIComponent(this.arm.credentials.subscriptionId)}/providers/Microsoft.Storage/storageAccounts`,
      ACCOUNT_API_VERSION
    );
  }

  async listContainers(account: AzureStorageAccount): Promise<AzureBlobContainer[]> {
    return this.arm.listAll<AzureBlobContainer>(
      `${account.id}/blobServices/default/containers`,
      CONTAINER_API_VERSION
    );
  }

  async getAccount(name: string): Promise<AzureStorageAccount | null> {
    return this.arm.getNullable<AzureStorageAccount>(
      this.arm.resourcePath('Microsoft.Storage', 'storageAccounts', name),
      ACCOUNT_API_VERSION
    );
  }

  async getContainer(account: AzureStorageAccount, container: string): Promise<AzureBlobContainer | null> {
    const result = await this.arm.getNullable<AzureBlobContainer>(
      this.containerPath(account, container),
      CONTAINER_API_VERSION
    );
    if (!result) return null;
    if (!result.id) throw new Error(`Azure Blob container ${container} returned no ARM resource ID.`);
    return { id: result.id, name: container };
  }

  async listKeys(account: AzureStorageAccount): Promise<string> {
    const response = await this.arm.request<AzureStorageKeys>('POST', `${account.id}/listKeys`, ACCOUNT_API_VERSION);
    const key = response.keys?.find((item) => item.permissions?.toLowerCase() === 'full')?.value
      ?? response.keys?.find((item) => item.value)?.value;
    if (!key) throw new Error(`Azure Storage account ${account.name} did not return an account key.`);
    return key;
  }

  private containerPath(account: AzureStorageAccount, container: string): string {
    return `${account.id}/blobServices/default/containers/${encodeURIComponent(container)}`;
  }
}

function readable(payload: StorageObjectPayload): Readable {
  if (payload.body instanceof Readable) return payload.body;
  if (payload.body instanceof Blob) {
    return Readable.fromWeb(payload.body.stream() as ReadableStream<Uint8Array>);
  }
  return Readable.fromWeb(payload.body as ReadableStream<Uint8Array>);
}

class AzureSdkBlobDataPlane implements AzureBlobDataPlane {
  private readonly service: BlobServiceClient;

  constructor(account: string, key: string, private readonly container: string, httpClient?: StoragePipelineOptions['httpClient']) {
    const credential = new StorageSharedKeyCredential(account, key);
    this.service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, { ...(httpClient ? { httpClient } : {}) });
  }

  async list(options?: { prefix?: string; maxObjects?: number }): Promise<StorageObjectRecord[]> {
    const output: StorageObjectRecord[] = [];
    const tokens = new Set<string>();
    for await (const page of this.containerClient().listBlobsFlat(options).byPage()) {
      for (const blob of page.segment.blobItems) {
        if (typeof blob.name !== 'string' || !blob.name || !Number.isSafeInteger(blob.properties.contentLength)
          || blob.properties.contentLength! < 0) throw new Error('Azure object listing contains an incomplete object identity or size.');
        output.push({ key: blob.name, size: blob.properties.contentLength!, revision: {
          ...(blob.properties.etag ? { etag: blob.properties.etag } : {}),
          ...(blob.properties.lastModified ? { lastModified: blob.properties.lastModified.toISOString() } : {}),
        } });
        if (options?.maxObjects !== undefined && output.length > options.maxObjects) throw new Error('Azure object listing exceeds its count limit.');
      }
      if (page.continuationToken) {
        if (tokens.has(page.continuationToken)) throw new Error('Azure object listing pagination did not advance.');
        tokens.add(page.continuationToken);
      }
    }
    return output;
  }

  async get(key: string, revision?: StorageObjectRevision): Promise<StorageObjectPayload> {
    if (revision?.generation || revision?.metageneration) throw new Error('Azure Blob reads require a native ETag or version.');
    const client = this.containerClient().getBlobClient(key);
    const response = await (revision?.versionId ? client.withVersion(revision.versionId) : client).download(0, undefined,
      { ...(revision?.etag ? { conditions: { ifMatch: revision.etag } } : {}) });
    if (!response.readableStreamBody) throw new Error(`Azure Blob object ${key} returned no body.`);
    return {
      body: response.readableStreamBody as Readable,
      size: response.contentLength ?? 0,
      revision: { ...(response.etag ? { etag: response.etag } : {}), ...(response.versionId ? { versionId: response.versionId } : {}),
        ...(response.lastModified ? { lastModified: response.lastModified.toISOString() } : {}) },
      contentType: response.contentType,
      contentEncoding: response.contentEncoding,
      cacheControl: response.cacheControl,
      contentDisposition: response.contentDisposition,
      metadata: response.metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }): Promise<void> {
    await this.containerClient().getBlockBlobClient(key).uploadStream(
      readable(payload),
      4 * 1024 * 1024,
      2,
      {
        blobHTTPHeaders: {
          blobContentType: payload.contentType,
          blobContentEncoding: payload.contentEncoding,
          blobCacheControl: payload.cacheControl,
          blobContentDisposition: payload.contentDisposition,
        },
        metadata: payload.metadata,
        ...(options?.ifAbsent ? { conditions: { ifNoneMatch: '*' } } : {}),
      }
    );
  }

  async remove(key: string, revision?: StorageObjectRevision): Promise<void> {
    if (revision?.generation || revision?.metageneration) throw new Error('Azure Blob deletion requires a native ETag or version.');
    const client = this.containerClient().getBlobClient(key);
    await (revision?.versionId ? client.withVersion(revision.versionId) : client).delete({
      ...(revision?.etag ? { conditions: { ifMatch: revision.etag } } : {}),
    });
  }

  async deleteAll(): Promise<void> {
    for await (const blob of this.containerClient().listBlobsFlat()) {
      await this.containerClient().deleteBlob(blob.name, { deleteSnapshots: 'include' });
    }
  }

  destroy(): void {}

  private containerClient() {
    return this.service.getContainerClient(this.container);
  }
}



function parseExternalId(externalId: string, context: StorageContext): { account: string; container: string } {
  const identity = parseStorageResourceIdentity(externalId);
  if (
    identity.subscriptionId.toLowerCase() !== context.subscriptionId?.toLowerCase()
    || identity.resourceGroup.toLowerCase() !== context.resourceGroup?.toLowerCase()
  ) {
    throw new Error('Azure Blob container is outside the configured subscription/resource group.');
  }
  return { account: identity.account, container: identity.container };
}

function parseStorageResourceIdentity(externalId: string): {
  subscriptionId: string;
  resourceGroup: string;
  account: string;
  container: string;
} {
  const segments = externalId.split('/').filter(Boolean).map(decodeURIComponent);
  if (
    segments.length !== 12
    || segments[0]?.toLowerCase() !== 'subscriptions'
    || segments[2]?.toLowerCase() !== 'resourcegroups'
    || segments[4]?.toLowerCase() !== 'providers'
    || segments[5]?.toLowerCase() !== 'microsoft.storage'
    || segments[6]?.toLowerCase() !== 'storageaccounts'
    || segments[8]?.toLowerCase() !== 'blobservices'
    || segments[9]?.toLowerCase() !== 'default'
    || segments[10]?.toLowerCase() !== 'containers'
  ) {
    throw new Error('Invalid Azure Blob container ARM resource ID.');
  }
  return {
    subscriptionId: segments[1]!,
    resourceGroup: segments[3]!,
    account: segments[7]!,
    container: segments[11]!,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AzureBlobStorageAdapter implements IStorageOperations {
  readonly name = 'azureblob';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
  };

  private credentials: AzureBlobStorageCredentials | null = null;
  private resolvedCredentials: ConnectedAzureBlobStorageCredentials | null = null;
  private control: AzureStorageControlPlane | null = null;
  private readonly controlPlaneFactory: (credentials: ConnectedAzureBlobStorageCredentials, resourceGroup?: string) => AzureStorageControlPlane;
  private readonly dataPlaneFactory: (account: string, key: string, container: string) => AzureBlobDataPlane;
  private readonly defaultCredentialProvider: (preferredSubscriptionId?: string) => Promise<{ authMode: 'default'; subscriptionId: string }>;

  constructor(options: AzureBlobStorageAdapterOptions = {}) {
    this.controlPlaneFactory = options.controlPlaneFactory ?? ((credentials, resourceGroup) => new ArmStorageControlPlane(credentials, resourceGroup));
    this.dataPlaneFactory = options.dataPlaneFactory ?? ((account, key, container) => new AzureSdkBlobDataPlane(account, key, container, options.storageHttpClient));
    this.defaultCredentialProvider = options.defaultCredentialProvider ?? resolveAzureDefaultSubscription;
  }

  runtimeEnvKeys(_name: string): string[] {
    return [
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'AZURE_STORAGE_ACCOUNT_NAME',
      'AZURE_STORAGE_CONTAINER_NAME', 'AZURE_STORAGE_CONNECTION_STRING',
    ];
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureBlobStorageCredentialsSchema.parse(credentials);
    this.resolvedCredentials = null;
    this.control = null;
  }

  async disconnect(): Promise<void> {
    this.control = null;
    this.credentials = null;
    this.resolvedCredentials = null;
  }

  async verify(): Promise<VerifyResult> {
    try {
      await this.controlPlaneFactory(await this.connectedCredentials()).verifySubscription();
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async ensureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext> = {},
    desiredRegion?: string
  ): Promise<StorageEnsureResult> {
    return this.resolveAzureContext(projectName, environment, context, desiredRegion);
  }

  async resolveObservationContext(
    projectName: string,
    environment: Environment,
    desiredRegion: string
  ): Promise<StorageEnsureResult> {
    return this.resolveAzureContext(projectName, environment, {}, desiredRegion);
  }

  private async resolveAzureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext>,
    desiredRegion?: string
  ): Promise<StorageEnsureResult> {
    try {
      const credentials = await this.connectedCredentials();
      if (context.subscriptionId && context.subscriptionId.toLowerCase() !== credentials.subscriptionId.toLowerCase()) {
        throw new Error(`Bound Azure subscription ${context.subscriptionId} does not match the connected subscription.`);
      }
      const scope = { subscriptionId: credentials.subscriptionId, projectName,
        environmentId: environment.projectId, environmentName: environment.name };
      const resourceGroup = context.resourceGroup ?? azureEnvironmentResourceGroupScope(scope).resourceGroup;
      if (!context.resourceGroup) {
        const legacyGroup = legacyAzureEnvironmentResourceGroupScope(scope).resourceGroup;
        const accounts = await this.controlPlaneFactory(credentials, legacyGroup).listAccounts();
        if (accounts.length > 0) throw new Error(`Legacy Azure storage in ${legacyGroup} requires explicit scoped import before creating new storage.`);
      }
      const location = context.location ?? desiredRegion;
      if (!location) throw new Error('A desired Azure location is required in the storage spec.');
      this.control = this.controlPlaneFactory(credentials, resourceGroup);
      await this.controlPlane().verifySubscription();
      return {
        receipt: { success: true, message: `Azure Blob Storage context is ready in ${credentials.subscriptionId}/${resourceGroup}` },
        context: {
          subscriptionId: credentials.subscriptionId,
          resourceGroup,
          location,
          projectName,
          environmentName: environment.name,
          environmentId: environment.id,
        },
      };
    } catch (error) {
      return { receipt: { success: false, message: 'Failed to resolve Azure Blob Storage context', error: errorMessage(error) } };
    }
  }

  async observe(environment: Environment, context: StorageContext, target?: StorageObservationTarget): Promise<ObservedStorage[]> {
    await this.assertContext(context);
    if (target) {
      const identity = parseExternalId(target.externalId, context);
      const account = await this.controlPlane().getAccount(identity.account);
      if (!account) return [];
      const expectedAccount = `/subscriptions/${context.subscriptionId}/resourceGroups/${context.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${identity.account}`;
      if (account.id.toLowerCase() !== expectedAccount.toLowerCase() || account.name !== identity.account
        || [context.location, context.region].some(region => region && region.toLowerCase() !== account.location?.toLowerCase())) {
        throw new Error('The bound Azure Storage account differs from its provider scope.');
      }
      const container = await this.controlPlane().getContainer(account, identity.container);
      if (!container) return [];
      if (container.id.toLowerCase() !== target.externalId.toLowerCase()) throw new Error('The bound Azure Blob container identity differs.');
      return [{ provider: this.name, kind: 'object', externalId: target.externalId,
        instanceScope: { ...context }, name: identity.container, region: account.location, status: 'ready' }];
    }
    const observed: ObservedStorage[] = [];
    for (const account of await this.controlPlane().listAccounts()) {
      if (account.tags?.[ENVIRONMENT_TAG] !== environment.id) continue;
      const name = account.tags[STORAGE_NAME_TAG];
      if (!name) continue;
      // Each managed account owns one logical bucket. Observe its native
      // container identity; never regenerate a retained name from new defaults.
      const containers = await this.controlPlane().listContainers(account);
      if (containers.length > 1) throw new Error(`Multiple containers in managed Azure account ${account.name} require explicit identity selection.`);
      const container = containers[0];
      if (!container) continue;
      const key = await this.controlPlane().listKeys(account);
      const plane = this.dataPlaneFactory(account.name, key, container.name);
      try {
        const objects = await plane.list();
        observed.push({
          provider: this.name,
          kind: 'object',
          externalId: container.id,
          instanceScope: { ...context },
          name,
          region: account.location,
          status: 'ready',
          objectCount: objects.length,
          sizeBytes: objects.reduce((total, object) => total + object.size, 0),
        });
      } finally {
        plane.destroy();
      }
    }
    return observed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectStorageResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const credentials = await this.connectedCredentials();
    this.control = this.controlPlaneFactory(credentials);
    const resources: Array<{
      account: AzureStorageAccount;
      container: AzureBlobContainer;
    }> = [];
    for (const account of await this.control.listAccounts()) {
      for (const container of await this.control.listContainers(account)) {
        if (request.id && container.id.toLowerCase() !== request.id.toLowerCase()) continue;
        if (request.name && container.name.toLowerCase() !== request.name.toLowerCase()) continue;
        resources.push({ account, container });
      }
    }
    const ambiguous = Boolean(request.name && resources.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : resources.length > 0 ? 'present' : 'absent',
      resource: 'storage',
      storage: resources.slice(0, request.limit).map(({ account, container }) => {
        const identity = parseStorageResourceIdentity(container.id);
        return {
          id: container.id,
          name: container.name,
          kind: 'object',
          status: 'ready',
          account: { id: account.id, name: account.name },
          region: account.location,
          ...(account.tags?.[STORAGE_NAME_TAG]
            ? { logicalName: account.tags[STORAGE_NAME_TAG] }
            : {}),
          providerScope: {
            subscriptionId: identity.subscriptionId,
            resourceGroup: identity.resourceGroup,
          },
        };
      }),
      ...(resources.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: resources.length > request.limit,
      partial: false,
    };
  }

  async getRuntimeEnv(
    _environment: Environment,
    context: StorageContext,
    externalId: string,
    _name: string
  ): Promise<Record<string, string>> {
    await this.assertContext(context);
    const identity = parseExternalId(externalId, context);
    const account = await this.requiredAccount(identity.account);
    const key = await this.controlPlane().listKeys(account);
    return {
      OBJECT_STORAGE_PROVIDER: 'azureblob',
      OBJECT_STORAGE_BUCKET: identity.container,
      AZURE_STORAGE_ACCOUNT_NAME: account.name,
      AZURE_STORAGE_CONTAINER_NAME: identity.container,
      AZURE_STORAGE_CONNECTION_STRING: `DefaultEndpointsProtocol=https;AccountName=${account.name};AccountKey=${key};EndpointSuffix=core.windows.net`,
    };
  }

  async openObjectTransfer(
    _environment: Environment,
    context: StorageContext,
    externalId: string
  ): Promise<StorageObjectClient> {
    await this.assertContext(context);
    const identity = parseExternalId(externalId, context);
    const account = await this.requiredAccount(identity.account);
    return this.dataPlaneFactory(account.name, await this.controlPlane().listKeys(account), identity.container);
  }

  private async connectedCredentials(): Promise<ConnectedAzureBlobStorageCredentials> {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    if (this.resolvedCredentials) return this.resolvedCredentials;
    if (this.credentials.authMode === 'default') {
      this.resolvedCredentials = await this.defaultCredentialProvider(this.credentials.subscriptionId);
      return this.resolvedCredentials;
    }
    this.resolvedCredentials = {
      authMode: 'servicePrincipal',
      tenantId: this.credentials.tenantId!,
      subscriptionId: this.credentials.subscriptionId!,
      clientId: this.credentials.clientId!,
      clientSecret: this.credentials.clientSecret!,
    };
    return this.resolvedCredentials;
  }

  private controlPlane(): AzureStorageControlPlane {
    if (!this.control) throw new Error('Not connected. Call connect() first.');
    return this.control;
  }

  private async assertContext(context: StorageContext): Promise<void> {
    const credentials = await this.connectedCredentials();
    if (!context.subscriptionId || !context.resourceGroup) throw new Error('Azure subscription/resource-group context is missing.');
    if (context.subscriptionId.toLowerCase() !== credentials.subscriptionId.toLowerCase()) {
      throw new Error('Azure Blob Storage context does not match the connected subscription.');
    }
    this.control = this.controlPlaneFactory(credentials, context.resourceGroup);
  }

  private async requiredAccount(name: string): Promise<AzureStorageAccount> {
    const account = await this.controlPlane().getAccount(name);
    if (!account) throw new Error(`Azure Storage account ${name} was not found.`);
    return account;
  }
}

providerRegistry.register({
  metadata: {
    name: 'azureblob',
    displayName: 'Azure Blob Storage',
    category: 'storage',
    credentialsSchema: AzureBlobStorageCredentialsSchema,
    setupHelpUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      automationSecretKeys: { AZURE_TENANT_ID: 'tenantId', AZURE_SUBSCRIPTION_ID: 'subscriptionId',
        AZURE_CLIENT_ID: 'clientId', AZURE_CLIENT_SECRET: 'clientSecret' },
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['AZURE_TENANT_ID', 'HYPERVIBE_AZURE_TENANT_ID'],
        ['AZURE_SUBSCRIPTION_ID', 'HYPERVIBE_AZURE_SUBSCRIPTION_ID'],
        ['AZURE_CLIENT_ID', 'HYPERVIBE_AZURE_CLIENT_ID'],
        ['AZURE_CLIENT_SECRET', 'HYPERVIBE_AZURE_CLIENT_SECRET'],
      ],
    },
    connectionAliases: ['azure-container-apps'],
    maturity: {
      lifecycle: {
        storage: { status: 'planned', reason: 'Resource lifecycle is moving to OpenTofu; this adapter provides connections and existing-resource operations only.' },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new AzureBlobStorageAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['storage'],
    defaultResource: 'storage',
    selectors: {
      storage: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['subscriptionId', 'resourceGroup'] },
    },
    inspect: (adapter, request) => (
      adapter as AzureBlobStorageAdapter
    ).inspectStorageResources(request),
  },
});
