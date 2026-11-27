import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedStorage } from '../../../domain/ports/observe.port.js';
import type { VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IStorageOperations,
  StorageContext,
  StorageEnsureResult,
  StorageObjectClient,
  StorageObservationTarget,
  StorageRuntimeTarget,
} from '../../../domain/ports/storage.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

import { GcsObjectClient, STORAGE_API, rawGcsMediaFetch, gcsResponseError as responseError } from './gcs-object-client.js';
const ENVIRONMENT_LABEL = 'hypervibe_environment_id';
const STORAGE_NAME_LABEL = 'hypervibe_storage_name';

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1),
}).passthrough();

const GcsStorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'serviceAccount']).default('serviceAccount'),
  credentials: z.string().min(1, 'GCP service account JSON is required').optional(),
  runtimeServiceAccountEmail: z.string().trim().email().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'default' || value.credentials) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials'], message: 'GCP service account JSON is required' });
});

export const GcsStorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.type === 'service_account') return { authMode: 'serviceAccount', credentials: JSON.stringify(record) };
  return { authMode: record.authMode ?? (record.credentials ? 'serviceAccount' : undefined),
    credentials: record.credentials, runtimeServiceAccountEmail: record.runtimeServiceAccountEmail };
}, GcsStorageAuthenticationSchema);

export type GcsStorageCredentials = z.infer<typeof GcsStorageCredentialsSchema>;
type ServiceAccount = z.infer<typeof ServiceAccountSchema>;
type TokenProvider = (credentials: GcsStorageCredentials, serviceAccount: ServiceAccount | null) => Promise<{
  token: string;
  email: string;
  expiresAt?: number;
}>;

export interface GcsStorageAdapterOptions {
  fetch?: typeof fetch;
  /** Raw media bytes; the default HTTPS stream does not transparently decompress. */
  mediaFetch?: typeof fetch;
  tokenProvider?: TokenProvider;
  defaultProjectProvider?: () => Promise<string>;
}

interface GcsBucket {
  name?: string;
  location?: string;
  labels?: Record<string, string>;
}

async function defaultTokenProvider(_credentials: GcsStorageCredentials, serviceAccount: ServiceAccount | null) {
  const auth = new GoogleAuth({
    ...(serviceAccount ? { credentials: serviceAccount, projectId: serviceAccount.project_id } : {}),
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Google authentication did not return an access token.');
  return {
    token,
    email: serviceAccount?.client_email ?? 'Google Application Default Credentials',
    expiresAt: client.credentials.expiry_date ?? Date.now() + 50 * 60 * 1_000,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GcsStorageAdapter implements IStorageOperations {
  readonly name = 'gcs';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
    usesWorkloadIdentity: true,
  };

  private credentials: GcsStorageCredentials | null = null;
  private serviceAccount: ServiceAccount | null = null;
  private projectId: string | null = null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly request: typeof fetch;
  private readonly mediaRequest: typeof fetch;
  private readonly tokenProvider: TokenProvider;
  private readonly defaultProjectProvider: () => Promise<string>;

  constructor(options: GcsStorageAdapterOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.mediaRequest = options.mediaFetch ?? options.fetch ?? rawGcsMediaFetch;
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.defaultProjectProvider = options.defaultProjectProvider ?? (() => new GoogleAuth().getProjectId());
  }

  runtimeEnvKeys(_name: string): string[] {
    return [
      'OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_STORAGE_BUCKET', 'GOOGLE_CLOUD_CREDENTIALS_JSON',
    ];
  }

  async connect(credentials: unknown): Promise<void> {
    this.credentials = GcsStorageCredentialsSchema.parse(credentials);
    this.projectId = null;
    if (this.credentials.authMode === 'default') {
      this.serviceAccount = null;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.credentials.credentials!);
    } catch {
      throw new Error('GCP service account credentials must be valid JSON.');
    }
    this.serviceAccount = ServiceAccountSchema.parse(parsed);
    const runtimePrincipal = this.credentials.runtimeServiceAccountEmail;
    if (runtimePrincipal && (runtimePrincipal === this.serviceAccount.client_email
      || !runtimePrincipal.endsWith(`@${this.serviceAccount.project_id}.iam.gserviceaccount.com`))) {
      throw new Error('GCS runtime identity must be distinct from the management identity and belong to the connected GCP project.');
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.serviceAccount = null;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.projectId = null;
  }

  async verify(): Promise<VerifyResult> {
    try {
      this.connectedCredentials();
      const projectId = await this.connectedProjectId();
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b?project=${encodeURIComponent(projectId)}&maxResults=1`);
      if (!response.ok) return { success: false, error: (await responseError(response)).message };
      return { success: true, email: this.serviceAccount?.client_email ?? `Google ADC (${projectId})` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async ensureContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext> = {}
  ): Promise<StorageEnsureResult> {
    return this.resolveGcsContext(projectName, environment, context);
  }

  async resolveObservationContext(
    projectName: string,
    environment: Environment,
    _desiredRegion: string
  ): Promise<StorageEnsureResult> {
    return this.resolveGcsContext(projectName, environment, {});
  }

  private async resolveGcsContext(
    projectName: string,
    environment: Environment,
    context: Partial<StorageContext>
  ): Promise<StorageEnsureResult> {
    try {
      this.connectedCredentials();
      const projectId = await this.connectedProjectId();
      if (context.projectId && context.projectId !== projectId) {
        throw new Error(`Bound GCP project ${context.projectId} does not match connected project ${projectId}.`);
      }
      await this.accessToken();
      const resolved = {
        projectId,
        projectName,
        environmentName: environment.name,
        environmentId: environment.id,
      };
      return {
        receipt: { success: true, message: `Google Cloud Storage context is ready in ${projectId}` },
        context: resolved,
      };
    } catch (error) {
      return { receipt: { success: false, message: 'Failed to resolve Google Cloud Storage context', error: errorMessage(error) } };
    }
  }

  async observe(environment: Environment, context: StorageContext, target?: StorageObservationTarget): Promise<ObservedStorage[]> {
    await this.assertContext(context);
    if (target && !target.externalId) throw new Error('Exact GCS observation requires a bucket identity.');
    const observed: ObservedStorage[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ project: context.projectId });
      if (target) { params.set('prefix', target.externalId); params.set('maxResults', '100'); }
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as { items?: GcsBucket[]; nextPageToken?: string };
      for (const bucket of body.items ?? []) {
        if (target) {
          // The project-scoped list proves native ownership; a direct bucket
          // GET could succeed for a bucket shared from a different project.
          if (bucket.name !== target.externalId) continue;
          if ([context.region, context.location].some(region => region && region.toLowerCase() !== bucket.location?.toLowerCase())) {
            throw new Error('The bound GCS bucket location differs from its provider scope.');
          }
          observed.push({ provider: this.name, kind: 'object', externalId: bucket.name,
            instanceScope: { ...context }, name: bucket.name, region: bucket.location?.toLowerCase(), status: 'ready' });
          continue;
        }
        if (!bucket.name || bucket.labels?.[ENVIRONMENT_LABEL] !== environment.id) continue;
        const name = bucket.labels[STORAGE_NAME_LABEL];
        if (!name) continue;
        const usage = await this.usage(bucket.name);
        observed.push({
          provider: this.name,
          kind: 'object',
          externalId: bucket.name,
          instanceScope: { ...context },
          name,
          region: bucket.location?.toLowerCase(),
          status: 'ready',
          ...usage,
        });
      }
      pageToken = body.nextPageToken;
      if (target && pageToken) {
        if (seenPageTokens.has(pageToken) || seenPageTokens.size >= 100) throw new Error('Exact GCS observation pagination is incomplete.');
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);
    return observed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectStorageResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const projectId = await this.connectedProjectId();
    let buckets: GcsBucket[];
    if (request.id) {
      const bucket = await this.getBucket(request.id);
      buckets = bucket ? [bucket] : [];
    } else {
      buckets = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ project: projectId });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await this.authorized(`${STORAGE_API}/storage/v1/b?${params}`);
        if (!response.ok) throw await responseError(response);
        const body = await response.json() as { items?: GcsBucket[]; nextPageToken?: string };
        buckets.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
      } while (pageToken);
    }
    const matched = buckets
      .filter((bucket) => typeof bucket.name === 'string')
      .filter((bucket) => !request.name || bucket.name?.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'storage',
      storage: matched.slice(0, request.limit).map((bucket) => ({
        id: bucket.name!,
        name: bucket.name!,
        kind: 'object',
        status: 'ready',
        ...(bucket.location ? { region: bucket.location.toLowerCase() } : {}),
        ...(bucket.labels?.[STORAGE_NAME_LABEL]
          ? { logicalName: bucket.labels[STORAGE_NAME_LABEL] }
          : {}),
        providerScope: { projectId },
      })),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  async getRuntimeEnv(
    _environment: Environment,
    context: StorageContext,
    externalId: string,
    _name: string,
    target?: StorageRuntimeTarget
  ): Promise<Record<string, string>> {
    await this.assertContext(context);
    const runtimeEnv = {
      OBJECT_STORAGE_PROVIDER: 'gcs', OBJECT_STORAGE_BUCKET: externalId,
      GOOGLE_CLOUD_PROJECT: context.projectId, GOOGLE_CLOUD_STORAGE_BUCKET: externalId,
    };
    if (target?.hostingProvider === 'cloudrun') {
      const identity = target.identity;
      const configuredPrincipal = this.connectedCredentials().runtimeServiceAccountEmail;
      if (identity?.provider !== 'gcp' || identity.scope.projectId !== context.projectId
        || !identity.principal.endsWith(`@${context.projectId}.iam.gserviceaccount.com`)
        || identity.principal === this.serviceAccount?.client_email
        || (configuredPrincipal && configuredPrincipal !== identity.principal)) {
        throw new Error('GCS runtime access requires the exact distinct Cloud Run workload identity and GCP project scope.');
      }
      // Empty the legacy slot on reviewed runtime synchronization. Leaving an
      // old key installed would override workload ADC in existing consumers.
      return { ...runtimeEnv, GOOGLE_CLOUD_CREDENTIALS_JSON: '' };
    }
    if (!this.serviceAccount) {
      throw new Error(
        'Google Application Default Credentials can manage and migrate storage, but Hypervibe will not copy a local gcloud user session into a deployed service. Reuse the verified Cloud Run connection/workload identity or connect a service-account JSON for cross-cloud runtime access.'
      );
    }
    if (target?.connectionProvider !== 'gcs') {
      throw new Error('GCS runtime access on this host requires an explicitly selected standalone GCS connection; a reused deployment identity cannot be installed in application runtime.');
    }
    return {
      ...runtimeEnv,
      GOOGLE_CLOUD_CREDENTIALS_JSON: this.connectedCredentials().credentials!,
    };
  }

  async openObjectTransfer(
    _environment: Environment,
    context: StorageContext,
    externalId: string
  ): Promise<StorageObjectClient> {
    await this.assertContext(context);
    return new GcsObjectClient(externalId, this.request, () => this.accessToken(), this.mediaRequest);
  }

  private connectedCredentials(): GcsStorageCredentials {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials;
  }

  private async connectedProjectId(): Promise<string> {
    this.connectedCredentials();
    if (this.projectId) return this.projectId;
    const projectId = this.serviceAccount?.project_id ?? await this.defaultProjectProvider();
    if (!projectId?.trim()) {
      throw new Error('Google Application Default Credentials did not resolve a project. Select one with gcloud config set project <project-id>.');
    }
    this.projectId = projectId;
    return projectId;
  }

  private async assertContext(context: StorageContext): Promise<void> {
    if (!context.projectId) throw new Error('Google Cloud Storage project context is missing.');
    if (context.projectId !== await this.connectedProjectId()) throw new Error('Google Cloud Storage context does not match the connected project.');
  }

  private async accessToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiresAt - 60_000) {
      const result = await this.tokenProvider(this.connectedCredentials(), this.serviceAccount);
      this.token = result.token;
      this.tokenExpiresAt = result.expiresAt ?? Date.now() + 50 * 60 * 1_000;
    }
    return this.token;
  }

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    return this.request(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  }

  private async getBucket(name: string): Promise<GcsBucket | null> {
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    const bucket = await response.json() as GcsBucket;
    if (!bucket.name) {
      throw new Error(`Google Cloud Storage returned an invalid bucket response for ${name}; absence was not confirmed.`);
    }
    if (bucket.name !== name) {
      throw new Error(`Google Cloud Storage returned bucket ${bucket.name} for exact bucket lookup ${name}.`);
    }
    return bucket;
  }

  private async usage(bucket: string): Promise<{ objectCount: number; sizeBytes: number }> {
    const transfer = new GcsObjectClient(bucket, this.request, () => this.accessToken());
    const objects = await transfer.list();
    return {
      objectCount: objects.length,
      sizeBytes: objects.reduce((total, object) => total + object.size, 0),
    };
  }
}

providerRegistry.register({
  metadata: {
    name: 'gcs',
    displayName: 'Google Cloud Storage',
    category: 'storage',
    credentialsSchema: GcsStorageCredentialsSchema,
    setupHelpUrl: 'https://cloud.google.com/iam/docs/keys-create-delete',
    credentials: {
      agentManagedKeys: ['runtimeServiceAccountEmail'],
      automationSecretKeys: { GCP_SERVICE_ACCOUNT_JSON: 'credentials' },
      defaultScalarKey: 'credentials',
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['HYPERVIBE_GCP_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON'],
      ],
    },
    connectionAliases: ['cloudrun'],
    storageRuntimeContract: 'gcs-native-adc-v1',
    maturity: {
      lifecycle: {
        storage: {
          status: 'planned',
          reason: 'The OpenTofu engine manages infrastructure. Authentication and operational tools remain available.',
        },
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new GcsStorageAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['storage'],
    defaultResource: 'storage',
    selectors: {
      storage: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['projectId'] },
    },
    inspect: (adapter, request) => (
      adapter as GcsStorageAdapter
    ).inspectStorageResources(request),
  },
});
