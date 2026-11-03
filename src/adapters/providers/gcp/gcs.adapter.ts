import { gcpGithubRecoveryAuthentication } from './gcp-github-automation.js';
import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import { GoogleAuth } from 'google-auth-library';
import { GcpGithubWorkloadAuthentication, gcpGithubWorkloadIdentitySchema } from './gcp-github-workload-identity.js';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { ObservedStorage } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import type {
  IStorageAdapter,
  StorageContext,
  StorageEnsureResult,
  StorageObjectClient,
  StorageObjectPayload,
  StorageObjectRevision,
  StorageObservationTarget,
  StorageRuntimeTarget,
  StorageDestroyOptions,
  StorageDeletionSnapshot,
} from '../../../domain/ports/storage.port.js';
import { storageDeletionEvidenceSchema, storageDeletionSnapshotSchema } from '../../../domain/ports/storage.port.js';
import { GcsRuntimeAccess } from './gcs-runtime-access.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

const STORAGE_API = 'https://storage.googleapis.com';
const ENVIRONMENT_LABEL = 'hypervibe_environment_id';
const STORAGE_NAME_LABEL = 'hypervibe_storage_name';
const PROJECT_LABEL = 'hypervibe_project';

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1),
}).passthrough();

const GcsStorageAuthenticationSchema = z.object({
  authMode: z.enum(['default', 'serviceAccount', 'github-workload-identity']).default('serviceAccount'),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional(),
  workloadIdentity: gcpGithubWorkloadIdentitySchema.optional(),
  credentials: z.string().min(1, 'GCP service account JSON is required').optional(),
  runtimeServiceAccountEmail: z.string().trim().email().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMode === 'github-workload-identity') {
    if (!value.workloadIdentity || value.workloadIdentity.projectId !== value.projectId || value.credentials !== undefined)
      ctx.addIssue({ code: 'custom', path: ['workloadIdentity'], message: 'GitHub federation requires the exact nonsecret project identity and no private key.' });
    return;
  }
  if (value.workloadIdentity !== undefined) ctx.addIssue({ code: 'custom', path: ['workloadIdentity'], message: 'A workload identity requires its explicit authentication mode.' });
  if (value.authMode === 'default' || value.credentials) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials'], message: 'GCP service account JSON is required' });
});

export const GcsStorageCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.type === 'service_account') return { authMode: 'serviceAccount', credentials: JSON.stringify(record) };
  return { authMode: record.authMode ?? (record.credentials ? 'serviceAccount' : undefined),
    ...(record.workloadIdentity !== undefined ? { workloadIdentity: record.workloadIdentity, projectId: record.projectId } : {}),
    ...(record.authMode === 'default' && record.projectId !== undefined ? { projectId: record.projectId } : {}),
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

const nativeNumber = z.string().regex(/^\d+$/);
const nativeTime = z.string().datetime({ offset: true });
const deletionBucketSchema = z.object({
  name: z.string().min(1), generation: nativeNumber, metageneration: nativeNumber,
  projectNumber: nativeNumber, timeCreated: nativeTime,
  labels: z.record(z.string(), z.string()),
  softDeletePolicy: z.object({ retentionDurationSeconds: nativeNumber }).passthrough().optional(),
  softDeleteTime: nativeTime.optional(), hardDeleteTime: nativeTime.optional(),
}).passthrough();
type DeletionBucket = z.infer<typeof deletionBucketSchema>;
const deletionObjectSchema = z.object({
  name: z.string().min(1), size: nativeNumber, generation: nativeNumber, metageneration: nativeNumber,
  temporaryHold: z.boolean().optional(), eventBasedHold: z.boolean().optional(),
  retentionExpirationTime: nativeTime.optional(),
  retention: z.object({ retainUntilTime: nativeTime, mode: z.enum(['Locked', 'Unlocked']) }).passthrough().optional(),
  softDeleteTime: nativeTime.optional(), hardDeleteTime: nativeTime.optional(),
  restoreToken: z.string().uuid().optional(),
}).passthrough();
type DeletionObject = z.infer<typeof deletionObjectSchema>;
const deletionListSchema = z.object({
  kind: z.literal('storage#objects'), items: z.array(deletionObjectSchema).optional(),
  nextPageToken: z.string().min(1).optional(), prefixes: z.array(z.string()).max(0).optional(),
}).passthrough();

interface GcsObject {
  name?: string;
  size?: string;
  generation?: string;
  metageneration?: string;
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

/** JSON API gzip objects must retain their stored representation. Global fetch
 * decodes Content-Encoding, so object bodies use an undecoded HTTPS stream. */
const rawGcsMediaFetch: typeof fetch = async (input, init) => new Promise((resolve, reject) => {
  const request = httpsRequest(String(input), { method: 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) }, response => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }));
  });
  request.once('error', reject); request.end();
});

async function defaultTokenProvider(credentials: GcsStorageCredentials, serviceAccount: ServiceAccount | null) {
  const auth = credentials.authMode === 'github-workload-identity'
    ? new GcpGithubWorkloadAuthentication(credentials.workloadIdentity!).auth : new GoogleAuth({
    ...(serviceAccount ? { credentials: serviceAccount, projectId: serviceAccount.project_id } : {}),
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === 'string' ? result : result.token;
  if (!token) throw new Error('Google authentication did not return an access token.');
  return {
    token,
    email: credentials.workloadIdentity?.serviceAccountEmail ?? serviceAccount?.client_email ?? 'Google Application Default Credentials',
    expiresAt: client.credentials.expiry_date ?? Date.now() + 50 * 60 * 1_000,
  };
}

function slug(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function bucketName(context: StorageContext, environment: Environment, name: string): string {
  return resourceName(name, { minLength: 3, scope: [context.projectId, environment.projectId, environment.name],
    reservedPrefixes: ['goog'] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  const detail = `Google Cloud Storage API ${response.status}: ${text.slice(0, 1_000)}`;
  if (response.status === 403) {
    return new Error(
      `${detail}. When GCS reuses the Cloud Run connection, preview hv_connections provider="cloudrun" action="prepare" gcsAccess="inspect" for read-only inventory; `
      + 'for GCS create, transfer, or teardown, preview it with gcsAccess="lifecycle". Both paths require explicit confirmation and may use existing Google Application Default Credentials through adminAuth="default". A standalone GCS connection must grant the equivalent role to its own identity.'
    );
  }
  return new Error(detail);
}

function requestBody(payload: StorageObjectPayload): RequestInit['body'] {
  if (payload.body instanceof Blob) return payload.body;
  if (payload.body instanceof Readable) return Readable.toWeb(payload.body) as ReadableStream;
  return payload.body;
}

class GcsObjectClient implements StorageObjectClient {
  constructor(
    private readonly bucket: string,
    private readonly request: typeof fetch,
    private readonly getToken: () => Promise<string>,
    private readonly mediaRequest: typeof fetch = request,
  ) {}

  async list(options?: { prefix?: string; maxObjects?: number }) {
    const objects: Array<{ key: string; size: number; revision?: StorageObjectRevision }> = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams();
      if (options?.prefix) params.set('prefix', options.prefix);
      if (options?.maxObjects !== undefined) params.set('maxResults', String(Math.min(1000, options.maxObjects + 1)));
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = await response.json() as { items?: GcsObject[]; nextPageToken?: string };
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body.items !== undefined && !Array.isArray(body.items))
        || (body.nextPageToken !== undefined && (typeof body.nextPageToken !== 'string' || !body.nextPageToken))) {
        throw new Error('GCS object listing completeness is unknown.');
      }
      for (const object of body.items ?? []) {
        if (!object || typeof object.name !== 'string' || !object.name || typeof object.size !== 'string'
          || !/^\d+$/.test(object.size) || !Number.isSafeInteger(Number(object.size))) {
          throw new Error('GCS object listing contains an incomplete object identity or size.');
        }
        objects.push({ key: object.name, size: Number(object.size),
          ...(object.generation ? { revision: { generation: object.generation,
            ...(object.metageneration ? { metageneration: object.metageneration } : {}) } } : {}) });
        if (options?.maxObjects !== undefined && objects.length > options.maxObjects) throw new Error('GCS object listing exceeds its count limit.');
      }
      pageToken = body.nextPageToken;
      if (pageToken && tokens.has(pageToken)) throw new Error('GCS object listing pagination did not advance.');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return objects;
  }

  async get(key: string, expected?: StorageObjectRevision): Promise<StorageObjectPayload> {
    if (expected?.etag || expected?.versionId || expected?.lastModified) throw new Error('GCS recovery reads require a native generation.');
    const base = `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
    const conditions = new URLSearchParams();
    if (expected?.generation) conditions.set('ifGenerationMatch', expected.generation);
    if (expected?.metageneration) conditions.set('ifMetagenerationMatch', expected.metageneration);
    const metadataResponse = await this.authorized(`${base}?${conditions}`);
    if (!metadataResponse.ok) throw await responseError(metadataResponse);
    const object = await metadataResponse.json() as GcsObject;
    if (!object.generation || !object.metageneration || object.size === undefined
      || (expected?.generation && object.generation !== expected.generation)
      || (expected?.metageneration && object.metageneration !== expected.metageneration)) throw new Error('GCS did not identify the exact object generation.');
    conditions.set('generation', object.generation); conditions.set('ifGenerationMatch', object.generation);
    conditions.set('ifMetagenerationMatch', object.metageneration); conditions.set('alt', 'media');
    const response = await this.mediaRequest(`${base}?${conditions}`, { headers: {
      Authorization: `Bearer ${await this.getToken()}`, 'Accept-Encoding': 'gzip',
    } });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error(`Google Cloud Storage object ${key} returned no body.`);
    if (response.headers.get('x-goog-generation') !== object.generation
      || response.headers.get('x-goog-metageneration') !== object.metageneration
      || Number(response.headers.get('content-length')) !== Number(object.size)) {
      await response.body.cancel(); throw new Error('GCS media response does not match the reviewed stored representation.');
    }
    return {
      body: response.body,
      size: Number(object.size), revision: { generation: object.generation, metageneration: object.metageneration },
      contentType: object.contentType, contentEncoding: object.contentEncoding,
      cacheControl: object.cacheControl, contentDisposition: object.contentDisposition, metadata: object.metadata,
    };
  }

  async put(key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }): Promise<void> {
    const params = new URLSearchParams({ uploadType: 'media', name: key });
    if (options?.ifAbsent) params.set('ifGenerationMatch', '0');
    const headers: Record<string, string> = {};
    if (payload.contentType) headers['content-type'] = payload.contentType;
    const response = await this.authorized(
      `${STORAGE_API}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params}`,
      { method: 'POST', body: requestBody(payload), headers, duplex: 'half' } as RequestInit
    );
    if (!response.ok) throw await responseError(response);
    const uploaded = await response.json() as GcsObject;
    if (options?.ifAbsent && !uploaded.generation) throw new Error('GCS did not acknowledge the exact new object generation.');
    if (
      payload.contentType
      || payload.contentEncoding
      || payload.cacheControl
      || payload.contentDisposition
      || Object.keys(payload.metadata ?? {}).length > 0
    ) {
      const metadataResponse = await this.authorized(
        `${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}${uploaded.generation
          ? `?ifGenerationMatch=${encodeURIComponent(uploaded.generation)}${uploaded.metageneration ? `&ifMetagenerationMatch=${encodeURIComponent(uploaded.metageneration)}` : ''}` : ''}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(payload.contentType ? { contentType: payload.contentType } : {}),
            ...(payload.contentEncoding ? { contentEncoding: payload.contentEncoding } : {}),
            ...(payload.cacheControl ? { cacheControl: payload.cacheControl } : {}),
            ...(payload.contentDisposition ? { contentDisposition: payload.contentDisposition } : {}),
            ...(payload.metadata ? { metadata: payload.metadata } : {}),
          }),
        }
      );
      if (!metadataResponse.ok) throw await responseError(metadataResponse);
    }
  }

  async remove(key: string, revision?: StorageObjectRevision): Promise<void> {
    if (revision?.etag || revision?.versionId || revision?.lastModified) throw new Error('GCS deletion requires a native generation.');
    const conditions = new URLSearchParams();
    if (revision?.generation) {
      conditions.set('generation', revision.generation);
      conditions.set('ifGenerationMatch', revision.generation);
    }
    if (revision?.metageneration) conditions.set('ifMetagenerationMatch', revision.metageneration);
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?${conditions}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw await responseError(response);
  }

  destroy(): void {}

  private async authorized(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    return this.request(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  }
}

/** Selected native worker data plane: no account key or local credential export. */
export function createGcsWorkloadObjectClient(bucket: string, getToken: () => Promise<string>, options: { fetch?: typeof fetch; mediaFetch?: typeof fetch } = {}): StorageObjectClient {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('The selected GCS bucket name is invalid.');
  return new GcsObjectClient(bucket, options.fetch ?? fetch, getToken, options.mediaFetch ?? options.fetch ?? rawGcsMediaFetch);
}

export class GcsStorageAdapter implements IStorageAdapter {
  readonly name = 'gcs';
  readonly capabilities = {
    kind: 'object' as const,
    regions: [],
    privateOnly: true,
    supportsUsageObservation: true,
    supportsObjectTransfer: true,
    usesWorkloadIdentity: true,
    supportsDeletionRecovery: true,
    supportsConditionalObjectDeletionRetry: true,
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
  readonly runtimeAccess: GcsRuntimeAccess;

  constructor(options: GcsStorageAdapterOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.mediaRequest = options.mediaFetch ?? options.fetch ?? rawGcsMediaFetch;
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.defaultProjectProvider = options.defaultProjectProvider ?? (() => new GoogleAuth().getProjectId());
    this.runtimeAccess = new GcsRuntimeAccess(async () => ({ projectId: await this.connectedProjectId(),
      managementEmail: this.credentials?.workloadIdentity?.serviceAccountEmail ?? this.serviceAccount?.client_email,
      token: await this.accessToken() }), this.request);
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
    if (this.credentials.authMode === 'github-workload-identity') {
      this.serviceAccount = null;
      this.projectId = this.credentials.workloadIdentity!.projectId;
      return;
    }
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
      return { success: true, email: this.credentials?.workloadIdentity?.serviceAccountEmail ?? this.serviceAccount?.client_email ?? `Google ADC (${projectId})` };
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
      const hosting = parseHostingBindings(environment);
      const requestedProject = context.projectId ?? (this.credentials?.authMode === 'default'
        && !this.credentials.projectId && hosting.provider === 'cloudrun' ? hosting.projectId : undefined);
      const projectId = await this.connectedProjectId(requestedProject);
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

  async ensureBucket(
    environment: Environment,
    context: StorageContext,
    name: string,
    region: string
  ): Promise<StorageEnsureResult> {
    try {
      await this.assertContext(context);
      const externalId = bucketName(context, environment, name);
      const existing = await this.getBucket(externalId);
      if (existing) {
        if (existing.labels?.[ENVIRONMENT_LABEL] !== environment.id || existing.labels?.[STORAGE_NAME_LABEL] !== name) {
          throw new Error(`Google Cloud Storage bucket ${externalId} exists but is not owned by this Hypervibe storage binding.`);
        }
        if (existing.location?.toLowerCase() !== region.toLowerCase()) {
          throw new Error(`Google Cloud Storage bucket ${externalId} exists in immutable location ${existing.location}, not ${region}.`);
        }
        return {
          receipt: { success: true, message: `Using existing Google Cloud Storage bucket "${externalId}"`, data: { created: false } },
          externalId,
          context,
        };
      }

      const response = await this.authorized(
        `${STORAGE_API}/storage/v1/b?project=${encodeURIComponent(context.projectId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: externalId,
            location: region,
            labels: {
              [ENVIRONMENT_LABEL]: environment.id,
              [STORAGE_NAME_LABEL]: name,
              [PROJECT_LABEL]: slug(context.projectName ?? environment.projectId).slice(0, 63),
            },
            iamConfiguration: {
              uniformBucketLevelAccess: { enabled: true },
              publicAccessPrevention: 'enforced',
            },
          }),
        }
      );
      if (!response.ok) throw await responseError(response);
      const created = await this.getBucket(externalId);
      if (!created) {
        throw new Error(`Google Cloud Storage bucket ${externalId} did not become observable after creation.`);
      }
      if (
        created.labels?.[ENVIRONMENT_LABEL] !== environment.id
        || created.labels?.[STORAGE_NAME_LABEL] !== name
        || created.location?.toLowerCase() !== region.toLowerCase()
      ) {
        throw new Error(`Google Cloud Storage bucket ${externalId} did not converge to the reviewed labels and location.`);
      }
      return {
        receipt: { success: true, message: `Created private Google Cloud Storage bucket "${externalId}"`, data: { created: true } },
        externalId,
        context,
      };
    } catch (error) {
      return { receipt: { success: false, message: `Failed to ensure Google Cloud Storage bucket "${name}"`, error: errorMessage(error) } };
    }
  }

  async getRuntimeEnv(
    environment: Environment,
    context: StorageContext,
    externalId: string,
    name: string,
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
      if (!target.serviceName || !target.runtimeAccessBinding) throw new Error('GCS workload access preparation requires its exact reviewed bucket grant before runtime wiring.');
      const grant = await this.runtimeAccess.observe({ environment, context, externalId, storageName: name, serviceName: target.serviceName, identity }, target.runtimeAccessBinding);
      if (grant.state !== 'present') throw new Error('GCS workload access grant is missing or unverified; apply its exact permission action before runtime wiring.');
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

  async destroyBucket(environment: Environment, context: StorageContext, externalId: string, options?: StorageDestroyOptions): Promise<Receipt> {
    try {
      await this.assertContext(context);
      if (!options?.persistRecovery) throw new Error('GCS bucket deletion requires durable recovery identity from the storage lifecycle.');
      let snapshot: StorageDeletionSnapshot;
      let retrying = false;
      if (options.recovery) {
        snapshot = storageDeletionSnapshotSchema.parse(options.recovery);
        if (snapshot.provider !== this.name || snapshot.externalId !== externalId
          || JSON.stringify(Object.entries(snapshot.instanceScope).sort()) !== JSON.stringify(Object.entries(context).sort())) throw new Error('The retained deletion scope does not match this bucket.');
        if (snapshot.phase !== 'ready') {
          const step = snapshot.steps[snapshot.nextStep];
          // An uncertain bucket has no generation-match DELETE condition. Its
          // same-name replacement risk is not resolved by object retry rules.
          if (step.kind === 'bucket' && snapshot.phase === 'uncertain') return await this.verifyDeletionCompletion(snapshot);
          const present = await this.observeRetryTarget(snapshot);
          if (present) {
            if (!options.retryAttempt) {
              await options.persistRecovery(storageDeletionSnapshotSchema.parse({ ...snapshot, retryObservedAt: new Date().toISOString() }));
              return { success: false, message: `The prior deletion remains ${snapshot.phase}. The exact target is still present; run hv_plan to review a separate conditional retry.`,
                data: { storageDeletionContinuation: true } };
            }
            if (!options.allowMutation || !snapshot.retryObservedAt) throw new Error('A conditional deletion retry requires a fresh reviewed plan and native presence observation.');
            retrying = true;
          } else {
            if (step.kind === 'bucket') return await this.verifyDeletionCompletion(snapshot);
            const next = await this.verifyDeletedObject(snapshot);
            await options.persistRecovery(next);
            return this.deletionContinuation();
          }
        }
      } else {
        if (!options.allowMutation) return this.deletionContinuation();
        const observed = await this.getBucket(externalId);
        if (!observed) throw new Error('The bucket is not active, but its prior deletion and retained data are unverified. No deletion was sent.');
        const bucket = deletionBucketSchema.parse(observed);
        if (bucket.labels[ENVIRONMENT_LABEL] !== environment.id) throw new Error(`Google Cloud Storage bucket ${externalId} is not owned by this Hypervibe environment.`);
        await this.verifyDeletionProject(context, bucket);
        const versions = await this.deletionObjects(externalId, false);
        // Disabled policy does not prove old retained data is absent. Its native
        // invalidArgument/400 remains unsupported inventory, before any write.
        const retained = await this.deletionObjects(externalId, true);
        if (versions.length + retained.length > 20_000) throw new Error('The complete deletion inventory exceeds the supported bounded size.');
        if (versions.some(object => object.temporaryHold || object.eventBasedHold
          || Date.parse(object.retentionExpirationTime ?? '') > Date.now()
          || Date.parse(object.retention?.retainUntilTime ?? '') > Date.now())) throw new Error('Object holds or native retention protect this bucket. No holds or retention policy were changed.');
        snapshot = storageDeletionSnapshotSchema.parse({ provider: this.name, externalId, instanceScope: context,
          nativeIdentity: { generation: bucket.generation, metageneration: bucket.metageneration,
            projectNumber: bucket.projectNumber, timeCreated: bucket.timeCreated },
          requestedAt: new Date().toISOString(), phase: 'ready', nextStep: 0,
          steps: [...versions.map(item => ({ kind: 'object', name: item.name, generation: item.generation, metageneration: item.metageneration })),
            { kind: 'bucket', name: externalId, generation: bucket.generation, metageneration: bucket.metageneration }],
          retention: { policySeconds: bucket.softDeletePolicy?.retentionDurationSeconds ?? '0', resources: retained.map(item => this.retainedObject(item)) } });
        await options.persistRecovery(snapshot);
      }
      if (!options.allowMutation) return this.deletionContinuation();
      while (snapshot.phase === 'ready' || retrying) {
        const retryDispatch = retrying;
        const bucket = this.deletionBucketIdentity(snapshot);
        const step = snapshot.steps[snapshot.nextStep];
        await this.assertDeletionBucketUnchanged(bucket);
        let resources = snapshot.retention.resources;
        if (step.kind === 'bucket') {
          // Never sweep a concurrent write into the original selected program.
          if ((await this.deletionObjects(externalId, false)).length) throw new Error('Live or noncurrent objects remain or were written during cleanup. The exact original deletion program was retained; no new objects were deleted.');
          resources = this.mergeRetainedObjects(resources, (await this.deletionObjects(externalId, true)).map(item => this.retainedObject(item)));
          await this.assertDeletionBucketUnchanged(bucket);
        }
        const priorAttempts = retrying ? [...snapshot.priorAttempts ?? [], { step: snapshot.nextStep, attemptedAt: snapshot.attemptedAt!,
          outcome: snapshot.phase, ...(snapshot.rejectionStatus ? { rejectionStatus: snapshot.rejectionStatus } : {}) }] : snapshot.priorAttempts;
        const { attemptedAt: _attemptedAt, retryObservedAt: _retryObservedAt, rejectionStatus: _rejectionStatus, ...dispatch } = snapshot;
        snapshot = storageDeletionSnapshotSchema.parse({ ...dispatch, phase: 'uncertain', attemptedAt: new Date().toISOString(),
          ...(priorAttempts ? { priorAttempts } : {}),
          retention: { ...snapshot.retention, resources } });
        await options.persistRecovery(snapshot);
        retrying = false;
        await this.assertDeletionBucketUnchanged(bucket);
        const params = new URLSearchParams({ ifMetagenerationMatch: step.metageneration });
        if (step.kind === 'object') { params.set('generation', step.generation); params.set('ifGenerationMatch', step.generation); }
        const path = `${STORAGE_API}/storage/v1/b/${encodeURIComponent(externalId)}`
          + (step.kind === 'object' ? `/o/${encodeURIComponent(step.name)}` : '');
        const response = await this.authorized(`${path}?${params}`, { method: 'DELETE' });
        if (response.status === 403 || response.status === 412) {
          await options.persistRecovery(storageDeletionSnapshotSchema.parse({ ...snapshot, phase: 'rejected', rejectionStatus: response.status }));
        }
        if (!response.ok && response.status !== 404) throw await responseError(response);
        if (step.kind === 'bucket') return await this.verifyDeletionCompletion(snapshot);
        snapshot = await this.verifyDeletedObject(snapshot);
        await options.persistRecovery(snapshot);
        if (retryDispatch) return this.deletionContinuation();
      }
      throw new Error('Deletion progress is unresolved; no additional delete was sent.');
    } catch (error) {
      return { success: false, message: `Failed to delete Google Cloud Storage bucket "${externalId}"`, error: errorMessage(error) };
    }
  }

  private deletionContinuation(): Receipt {
    return { success: false, message: 'Deletion is paused. Run hv_plan to review the remaining exact deletions.',
      data: { storageDeletionContinuation: true } };
  }

  /** Native exact presence permits review, not automatic retry authorization. */
  private async observeRetryTarget(snapshot: StorageDeletionSnapshot): Promise<boolean> {
    const step = snapshot.steps[snapshot.nextStep];
    if (step.kind === 'bucket') {
      const active = await this.getBucket(snapshot.externalId);
      if (!active) return false;
      if (!this.sameDeletionBucket(this.deletionBucketIdentity(snapshot), deletionBucketSchema.parse(active))) throw new Error('The original bucket lifetime or metadata changed; no retry was sent.');
      return true;
    }
    await this.assertDeletionBucketUnchanged(this.deletionBucketIdentity(snapshot));
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(snapshot.externalId)}/o/${encodeURIComponent(step.name)}?${new URLSearchParams({ generation: step.generation })}`);
    if (response.status === 404) return false;
    if (!response.ok) throw await responseError(response);
    const object = deletionObjectSchema.parse(await response.json());
    if (object.name !== step.name || object.generation !== step.generation || object.metageneration !== step.metageneration
      || object.softDeleteTime || object.hardDeleteTime || object.temporaryHold || object.eventBasedHold
      || Date.parse(object.retentionExpirationTime ?? '') > Date.now()
      || Date.parse(object.retention?.retainUntilTime ?? '') > Date.now()) throw new Error('The original object generation, metadata, or retention changed; no retry was sent.');
    await this.assertDeletionBucketUnchanged(this.deletionBucketIdentity(snapshot));
    return true;
  }

  private deletionBucketIdentity(snapshot: StorageDeletionSnapshot): DeletionBucket {
    const identity = z.object({ generation: nativeNumber, metageneration: nativeNumber,
      projectNumber: nativeNumber, timeCreated: nativeTime }).strict().parse(snapshot.nativeIdentity);
    return { ...identity, name: snapshot.externalId, labels: {} };
  }

  private retainedObject(item: DeletionObject): StorageDeletionSnapshot['retention']['resources'][number] {
    if (!item.softDeleteTime || !item.hardDeleteTime) throw new Error('Native object retention metadata is incomplete.');
    return { kind: 'object', name: item.name, generation: item.generation, metageneration: item.metageneration,
      softDeleteTime: item.softDeleteTime, hardDeleteTime: item.hardDeleteTime,
      ...(item.restoreToken ? { restoreToken: item.restoreToken } : {}) };
  }

  private mergeRetainedObjects(previous: StorageDeletionSnapshot['retention']['resources'], next: StorageDeletionSnapshot['retention']['resources']) {
    const records = new Map(previous.map(item => [JSON.stringify([item.name, item.generation, item.restoreToken ?? '']), item]));
    for (const item of next) {
      const key = JSON.stringify([item.name, item.generation, item.restoreToken ?? '']);
      const old = records.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('Previously observed native retention changed; preserve its evidence for inspection.');
      records.set(key, item);
    }
    return [...records.values()];
  }

  /** Exact metadata-only GETs settle an uncertain child without replaying it. */
  private async verifyDeletedObject(snapshot: StorageDeletionSnapshot): Promise<StorageDeletionSnapshot> {
    const step = snapshot.steps[snapshot.nextStep];
    await this.assertDeletionBucketUnchanged(this.deletionBucketIdentity(snapshot));
    const path = `${STORAGE_API}/storage/v1/b/${encodeURIComponent(snapshot.externalId)}/o/${encodeURIComponent(step.name)}`;
    const params = new URLSearchParams({ generation: step.generation });
    const active = await this.authorized(`${path}?${params}`);
    if (active.status !== 404) {
      if (!active.ok) throw await responseError(active);
      throw new Error('The attempted object generation is still active. Its prior deletion is unresolved; no delete was replayed.');
    }
    params.set('softDeleted', 'true');
    const retained = await this.authorized(`${path}?${params}`);
    let resources = snapshot.retention.resources;
    if (retained.ok) {
      const object = deletionObjectSchema.parse(await retained.json());
      if (object.name !== step.name || object.generation !== step.generation || object.metageneration !== step.metageneration) throw new Error('Deleted object identity could not be verified.');
      resources = this.mergeRetainedObjects(resources, [this.retainedObject(object)]);
    } else {
      const earliestExpiry = Date.parse(snapshot.attemptedAt!) + Number(snapshot.retention.policySeconds) * 1000;
      if (retained.status !== 404 || !Number.isSafeInteger(Number(snapshot.retention.policySeconds)) || Date.now() < earliestExpiry) throw await responseError(retained);
    }
    await this.assertDeletionBucketUnchanged(this.deletionBucketIdentity(snapshot));
    const { attemptedAt: _attemptedAt, retryObservedAt: _retryObservedAt, rejectionStatus: _rejectionStatus, ...ready } = snapshot;
    return storageDeletionSnapshotSchema.parse({ ...ready, phase: 'ready', nextStep: snapshot.nextStep + 1,
      retention: { ...snapshot.retention, resources } });
  }

  /** Both first completion and restart use these metadata-only native reads. */
  private async verifyDeletionCompletion(snapshot: StorageDeletionSnapshot): Promise<Receipt> {
    const externalId = snapshot.externalId;
    const identity = z.object({ generation: nativeNumber, metageneration: nativeNumber,
      projectNumber: nativeNumber, timeCreated: nativeTime }).strict().parse(snapshot.nativeIdentity);
    const expected = { ...identity, name: externalId, labels: {} };
    const active = await this.getBucket(externalId);
    if (active) {
      const current = deletionBucketSchema.parse(active);
      throw new Error(this.sameDeletionBucket(expected, current, false)
        ? 'The original bucket is still active. Its prior deletion is unresolved; recovery did not send another delete.'
        : 'A different bucket now uses this name. It was preserved; recovery did not send a delete.');
    }
    const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(externalId)}?${new URLSearchParams({ generation: identity.generation, softDeleted: 'true' })}`);
    let retainedBucket: DeletionBucket | undefined;
    if (response.ok) {
      retainedBucket = deletionBucketSchema.parse(await response.json());
      if (!this.sameDeletionBucket(expected, retainedBucket, false) || !retainedBucket.softDeleteTime || !retainedBucket.hardDeleteTime
        || snapshot.retention.resources.some(item => Date.parse(item.hardDeleteTime) > Date.parse(retainedBucket!.hardDeleteTime!))) {
        throw new Error('The exact deleted bucket generation and retention deadline could not be verified.');
      }
    } else {
      const earliestExpiry = Math.max(Date.parse(snapshot.attemptedAt!) + Number(snapshot.retention.policySeconds) * 1000,
        ...snapshot.retention.resources.map(item => Date.parse(item.hardDeleteTime)));
      if (response.status !== 404 || !Number.isSafeInteger(Number(snapshot.retention.policySeconds)) || Date.now() < earliestExpiry) throw await responseError(response);
      // Exact active and soft-deleted GET absence is native metadata evidence.
      // Elapsed retention time alone is never accepted as erasure proof.
    }
    const evidence = storageDeletionEvidenceSchema.parse({ provider: this.name, externalId, instanceScope: snapshot.instanceScope,
      nativeIdentity: identity, observedAt: new Date().toISOString(), activeState: 'absent',
      deletedObjects: snapshot.steps.filter(step => step.kind === 'object').map(({ name, generation, metageneration }) => ({ name, generation, metageneration })),
      ...(snapshot.priorAttempts ? { priorAttempts: snapshot.priorAttempts } : {}),
      retention: { state: retainedBucket ? 'recoverable' : 'not-observed', resources: retainedBucket ? [
        { kind: 'bucket', name: externalId, generation: retainedBucket.generation,
          softDeleteTime: retainedBucket.softDeleteTime, hardDeleteTime: retainedBucket.hardDeleteTime },
        ...snapshot.retention.resources,
      ] : [] } });
    return { success: true, message: retainedBucket
      ? `Removed Google Cloud Storage bucket "${externalId}" from active use. Google retains the recoverable bucket until ${retainedBucket.hardDeleteTime}; retained objects have their own recorded deadlines.`
      : `Google Cloud Storage bucket "${externalId}" is absent from active and soft-deleted metadata.`,
      data: { storageDeletion: evidence } };
  }

  private sameDeletionBucket(left: DeletionBucket, right: DeletionBucket, metadata = true): boolean {
    return left.name === right.name && left.generation === right.generation
      && left.projectNumber === right.projectNumber && left.timeCreated === right.timeCreated
      && (!metadata || left.metageneration === right.metageneration);
  }

  private async assertDeletionBucketUnchanged(expected: DeletionBucket): Promise<void> {
    const current = deletionBucketSchema.parse(await this.getBucket(expected.name));
    if (!this.sameDeletionBucket(expected, current)) throw new Error('The bucket lifetime or metadata changed during cleanup; no further deletion was sent.');
  }

  private async verifyDeletionProject(context: StorageContext, bucket: DeletionBucket): Promise<void> {
    const schema = z.object({ kind: z.literal('storage#buckets'), items: z.array(deletionBucketSchema).optional(),
      nextPageToken: z.string().min(1).optional(), unreachable: z.array(z.string()).max(0).optional() }).passthrough();
    const tokens = new Set<string>();
    let pageToken: string | undefined, matched = false;
    do {
      const params = new URLSearchParams({ project: context.projectId, prefix: bucket.name, maxResults: '100', returnPartialSuccess: 'false' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = schema.parse(await response.json());
      for (const item of body.items ?? []) if (item.name === bucket.name) {
        if (matched || !this.sameDeletionBucket(bucket, item)) throw new Error('The exact bucket project or lifetime is ambiguous.');
        matched = true;
      }
      pageToken = body.nextPageToken;
      if (pageToken && (tokens.has(pageToken) || tokens.size >= 100)) throw new Error('Bucket project inventory is incomplete.');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    if (!matched) throw new Error('The bucket was not verified in the connected project; no deletion was sent.');
  }

  private async deletionObjects(bucket: string, softDeleted: boolean): Promise<DeletionObject[]> {
    const objects: DeletionObject[] = [], tokens = new Set<string>(), identities = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ [softDeleted ? 'softDeleted' : 'versions']: 'true', maxResults: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.authorized(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`);
      if (!response.ok) throw await responseError(response);
      const body = deletionListSchema.parse(await response.json());
      for (const item of body.items ?? []) {
        const identity = JSON.stringify([item.name, item.generation, item.restoreToken ?? '']);
        if (identities.has(identity) || objects.length >= 20_000 || !Number.isSafeInteger(Number(item.size))
          || (softDeleted && (!item.softDeleteTime || !item.hardDeleteTime || Date.parse(item.hardDeleteTime) < Date.parse(item.softDeleteTime)))
          || (!softDeleted && (item.softDeleteTime || item.hardDeleteTime))) {
          throw new Error('Object generation or retention inventory is incomplete or inconsistent.');
        }
        identities.add(identity); objects.push(item);
      }
      pageToken = body.nextPageToken;
      if (pageToken && (tokens.has(pageToken) || tokens.size >= 1000)) throw new Error('Object generation inventory pagination did not complete.');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return objects;
  }

  private connectedCredentials(): GcsStorageCredentials {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials;
  }

  private async connectedProjectId(requestedProject?: string): Promise<string> {
    const credentials = this.connectedCredentials();
    const projectId = this.projectId ?? this.serviceAccount?.project_id ?? credentials.projectId
      ?? (credentials.authMode === 'default' ? requestedProject : undefined) ?? await this.defaultProjectProvider();
    if (!projectId?.trim()) {
      throw new Error('Google Cloud Storage has no target project. Connect the app’s exact GCP project or retain its reviewed storage context before planning storage.');
    }
    if (requestedProject && requestedProject !== projectId) throw new Error('Google Cloud Storage context does not match the connected project.');
    this.projectId = projectId;
    return projectId;
  }

  private async assertContext(context: StorageContext): Promise<void> {
    if (!context.projectId) throw new Error('Google Cloud Storage project context is missing.');
    if (context.projectId !== await this.connectedProjectId(context.projectId)) throw new Error('Google Cloud Storage context does not match the connected project.');
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
      automationAuthentication: gcpGithubRecoveryAuthentication,
      agentManagedKeys: ['runtimeServiceAccountEmail', 'projectId', 'workloadIdentity'],
      agentManagedChoices: { authMode: ['github-workload-identity'] },
      automationSecretKeys: { GCP_SERVICE_ACCOUNT_JSON: 'credentials' },
      canUseForAutomation: credentials => credentials.authMode !== 'default'
        && GcsStorageCredentialsSchema.safeParse(credentials).success,
      defaultScalarKey: 'credentials',
      supportsNativeCliAuth: true,
      environmentVariableAliases: [
        ['HYPERVIBE_GCP_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON'],
      ],
    },
    connectionAliases: ['cloudrun'],
    storageRuntimeContract: 'gcs-native-adc-v2',
    storageRuntimeAccess: { hostingProviders: ['cloudrun'] },
    maturity: {
      lifecycle: {
        storage: { status: 'ready-for-live' },
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
