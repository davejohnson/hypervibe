import { createHash } from 'node:crypto';
import { normalizeGitRemoteIdentity } from '../../lib/git-remote.js';
import {
  projectSpecSchema,
  type EnvironmentSpec,
  type ProjectSpec,
} from '../../domain/spec/spec.schema.js';

export const MAX_COMMITTED_SPEC_BYTES = 1024 * 1024;
export const COMMITTED_SPEC_PATH = '.hypervibe/spec.json' as const;

export type CommittedSpecInspectionErrorCode =
  | 'INVALID_INPUT'
  | 'SOURCE_TOO_LARGE'
  | 'DIGEST_MISMATCH'
  | 'INVALID_ENCODING'
  | 'INVALID_JSON'
  | 'INVALID_SPEC'
  | 'REPOSITORY_MISMATCH'
  | 'SECRET_CONTENT';

export class CommittedSpecInspectionError extends Error {
  readonly code: CommittedSpecInspectionErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CommittedSpecInspectionErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CommittedSpecInspectionError';
    this.code = code;
    this.details = details;
  }
}

export interface CommittedSpecInspectionInputV1 {
  schemaVersion: 1;
  /** Registered code-host provider id that verified this source. */
  provider: string;
  repository: {
    /** Durable provider-owned repository id. */
    id: string;
    /** Canonical provider repository path, such as owner/repository. */
    path: string;
    /** Credential-free host/path identity, such as github.com/owner/repository. */
    remoteIdentity: string;
  };
  /** Exact full Git object revision from which the spec bytes were read. */
  revision: string;
  /** Exact bytes fetched for .hypervibe/spec.json at revision. */
  content: Uint8Array;
  /** Lowercase or uppercase SHA-256 of content. */
  contentSha256: string;
}

export interface DeclaredProviderCapabilityV1 {
  capability: string;
  provider: string;
  resource?: string;
}

export interface CommittedSpecInspectionReceiptV1 {
  schemaVersion: 1;
  status: 'accepted';
  source: {
    provider: string;
    repository: {
      id: string;
      path: string;
    };
    revision: string;
    specPath: typeof COMMITTED_SPEC_PATH;
    sha256: string;
    byteLength: number;
  };
  project: {
    name: string;
    specVersion: 1;
    remoteIdentityVerified: boolean;
    declaredProviders: DeclaredProviderCapabilityV1[];
  };
  environments: Array<{
    name: string;
    hosting: {
      provider: string;
      region?: string;
    };
    services: Array<{
      name: string;
      workloadKind: 'web' | 'worker' | 'cron';
      public: boolean;
    }>;
    publicEndpoints: Array<{
      url: string;
      services: string[];
    }>;
    features: string[];
    declaredProviders: DeclaredProviderCapabilityV1[];
  }>;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const FULL_GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SENSITIVE_ENV_NAME_PATTERN = /(?:^|_)(?:API_KEY|AUTH_TOKEN|CONNECTION_URL|DATABASE_URL|DIRECT_URL|PASSWORD|PRIVATE_KEY|SECRET|SECRET_KEY|TOKEN)(?:$|_)/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [^-]+PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bwhsec_[A-Za-z0-9]{16,}\b/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{16,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

function inspectionError(
  code: CommittedSpecInspectionErrorCode,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new CommittedSpecInspectionError(code, message, details);
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
  ) {
    inspectionError('INVALID_INPUT', `Committed spec inspection requires a valid ${field}.`, { field });
  }
  return value;
}

function validateInput(input: CommittedSpecInspectionInputV1): {
  provider: string;
  repositoryId: string;
  repositoryPath: string;
  remoteIdentity: string;
  revision: string;
  expectedSha256: string;
} {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires schemaVersion 1.', {
      field: 'schemaVersion',
    });
  }

  const provider = requireBoundedString(input.provider, 'provider', 128);
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires a canonical provider id.', {
      field: 'provider',
    });
  }
  if (!input.repository || typeof input.repository !== 'object') {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires verified repository context.', {
      field: 'repository',
    });
  }

  const repositoryId = requireBoundedString(input.repository.id, 'repository.id', 512);
  const repositoryPath = requireBoundedString(input.repository.path, 'repository.path', 2_048);
  if (
    repositoryPath.startsWith('/')
    || repositoryPath.endsWith('/')
    || repositoryPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires a canonical repository path.', {
      field: 'repository.path',
    });
  }

  const remoteIdentity = requireBoundedString(
    input.repository.remoteIdentity,
    'repository.remoteIdentity',
    2_048
  );
  const canonicalRemoteIdentity = normalizeGitRemoteIdentity(`https://${remoteIdentity}`);
  if (canonicalRemoteIdentity !== remoteIdentity) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires a canonical credential-free remote identity.', {
      field: 'repository.remoteIdentity',
    });
  }
  if (remoteIdentity.slice(remoteIdentity.indexOf('/') + 1) !== repositoryPath) {
    inspectionError('INVALID_INPUT', 'Verified repository path and remote identity do not match.', {
      field: 'repository',
    });
  }

  const revision = requireBoundedString(input.revision, 'revision', 64).toLowerCase();
  if (!FULL_GIT_REVISION_PATTERN.test(revision)) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires an exact full Git revision.', {
      field: 'revision',
    });
  }
  const expectedSha256 = requireBoundedString(
    input.contentSha256,
    'contentSha256',
    64
  ).toLowerCase();
  if (!SHA256_PATTERN.test(expectedSha256)) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires a SHA-256 content digest.', {
      field: 'contentSha256',
    });
  }
  if (!(input.content instanceof Uint8Array)) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires source bytes.', {
      field: 'content',
    });
  }
  if (input.content.byteLength === 0) {
    inspectionError('INVALID_INPUT', 'Committed spec inspection requires a non-empty source file.', {
      field: 'content',
    });
  }
  if (input.content.byteLength > MAX_COMMITTED_SPEC_BYTES) {
    inspectionError(
      'SOURCE_TOO_LARGE',
      `Committed spec exceeds the ${MAX_COMMITTED_SPEC_BYTES}-byte inspection limit.`,
      { maxBytes: MAX_COMMITTED_SPEC_BYTES }
    );
  }

  return {
    provider,
    repositoryId,
    repositoryPath,
    remoteIdentity,
    revision,
    expectedSha256,
  };
}

function decodeJsonSource(content: Uint8Array): unknown {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    inspectionError('INVALID_ENCODING', 'Committed spec must use valid UTF-8 encoding.');
  }

  try {
    return JSON.parse(raw);
  } catch {
    inspectionError('INVALID_JSON', 'Committed spec is not valid JSON.');
  }
}

function secretValueLooksPresent(value: string): boolean {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function secretShapedPaths(document: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, path: string[]): void => {
    if (found.size >= 11) return;
    if (typeof value === 'string') {
      const key = path.at(-1) ?? '';
      const inEnvironmentVariables = path.length >= 4
        && path[0] === 'environments'
        && path[2] === 'envVars';
      if (
        secretValueLooksPresent(value)
        || (inEnvironmentVariables && value.length > 0 && SENSITIVE_ENV_NAME_PATTERN.test(key))
      ) {
        found.add(safeDocumentPath(path));
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...path, String(index)]));
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      walk(entry, [...path, key]);
    }
  };
  walk(document, []);
  return Array.from(found).sort();
}

function safeDocumentPath(path: Array<string | number>): string {
  return path
    .map((segment) => String(segment).replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 80))
    .join('.')
    .slice(0, 512);
}

function requireSafeReceiptLabel(value: string, path: string): string {
  if (
    value.length > 255
    || value.trim() !== value
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    inspectionError('INVALID_SPEC', 'Committed spec contains a field that is unsafe for a hosted receipt.', {
      issues: [{ path, code: 'unsafe_receipt_value' }],
    });
  }
  return value;
}

function normalizedSpecScope(scope: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/]+@[^:/]+[:/])/i.test(scope)) {
    return normalizeGitRemoteIdentity(scope) ?? scope;
  }
  return scope;
}

function verifyRepositoryClaims(
  spec: ProjectSpec,
  source: {
    provider: string;
    repositoryPath: string;
    remoteIdentity: string;
  }
): boolean {
  let remoteIdentityVerified = false;
  if (spec.gitRemoteUrl) {
    const claimedIdentity = normalizeGitRemoteIdentity(spec.gitRemoteUrl);
    if (!claimedIdentity || claimedIdentity !== source.remoteIdentity) {
      inspectionError(
        'REPOSITORY_MISMATCH',
        'Committed spec gitRemoteUrl does not match the verified source repository.'
      );
    }
    remoteIdentityVerified = true;
  }

  if (spec.devops) {
    if (spec.devops.code.provider !== source.provider) {
      inspectionError(
        'REPOSITORY_MISMATCH',
        'Committed spec code provider does not match the verified source provider.'
      );
    }
    const scope = normalizedSpecScope(spec.devops.code.scope);
    if (scope !== source.repositoryPath && scope !== source.remoteIdentity) {
      inspectionError(
        'REPOSITORY_MISMATCH',
        'Committed spec code scope does not match the verified source repository.'
      );
    }
  }

  if (source.provider === 'github') {
    for (const repository of [spec.github?.repository, spec.collaboration?.repository]) {
      if (repository && repository.toLowerCase() !== source.repositoryPath.toLowerCase()) {
        inspectionError(
          'REPOSITORY_MISMATCH',
          'Committed spec GitHub repository does not match the verified source repository.'
        );
      }
    }
  }

  return remoteIdentityVerified;
}

function safeHttpsEndpoint(domain?: string): string | null {
  if (!domain || domain !== domain.trim() || /[/:?#@]/.test(domain)) return null;
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  const labels = normalized.split('.');
  if (
    labels.length < 2
    || labels.some((label) => (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    return null;
  }
  return `https://${normalized}`;
}

function sortCapabilities(
  capabilities: DeclaredProviderCapabilityV1[]
): DeclaredProviderCapabilityV1[] {
  return capabilities.sort((a, b) => (
    a.capability.localeCompare(b.capability)
    || a.provider.localeCompare(b.provider)
    || (a.resource ?? '').localeCompare(b.resource ?? '')
  ));
}

function projectProviders(spec: ProjectSpec): DeclaredProviderCapabilityV1[] {
  const providers: DeclaredProviderCapabilityV1[] = [];
  if (spec.devops) {
    providers.push({ capability: 'code', provider: spec.devops.code.provider });
    if (spec.devops.ci) {
      providers.push({ capability: 'ci', provider: spec.devops.ci.provider });
    }
  }
  if (spec.github?.enabled) {
    providers.push({ capability: 'repository-automation', provider: 'github' });
  }
  return sortCapabilities(providers);
}

function environmentProviders(environment: EnvironmentSpec): DeclaredProviderCapabilityV1[] {
  const providers: DeclaredProviderCapabilityV1[] = [
    { capability: 'hosting', provider: environment.hosting.provider },
  ];
  if (environment.database) {
    providers.push({ capability: 'database', provider: environment.database.provider });
  }
  if (environment.cache) {
    providers.push({ capability: 'cache', provider: environment.cache.provider });
  }
  if (environment.loadBalancer) {
    providers.push({ capability: 'load-balancer', provider: environment.loadBalancer.provider });
  }
  if (environment.domainRegistration) {
    providers.push({ capability: 'domain-registration', provider: environment.domainRegistration.provider });
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    providers.push({ capability: 'storage', provider: storage.provider, resource: name });
  }
  if (environment.messaging) {
    providers.push({ capability: 'messaging', provider: environment.messaging.provider });
  }
  return sortCapabilities(providers);
}

function environmentFeatures(environment: EnvironmentSpec): string[] {
  const features = new Set<string>();
  const services = Object.values(environment.services);
  if (services.some((service) => (service.public ?? service.workloadKind === 'web'))) {
    features.add('public-service');
  }
  if (services.some((service) => service.workloadKind === 'worker')) features.add('worker');
  if (services.some((service) => service.workloadKind === 'cron')) features.add('cron');
  if (environment.database) features.add('database');
  if (environment.cache) features.add('cache');
  if (environment.domain) features.add('custom-domain');
  if (environment.domainRegistration) features.add('domain-registration');
  if (environment.loadBalancer) features.add('load-balancer');
  if (environment.email.enabled) features.add('email');
  if (environment.messaging) features.add('messaging');
  if (Object.keys(environment.queues ?? {}).length > 0) features.add('queue');
  if (Object.keys(environment.storage ?? {}).length > 0) features.add('storage');
  if (environment.dataMigration) features.add('data-migration');
  if (environment.maintenance) features.add('maintenance');
  if (environment.payments?.stripe) features.add('payments');
  if (environment.ios) features.add('ios-release');
  return Array.from(features).sort();
}

function environmentReceipt(
  name: string,
  environment: EnvironmentSpec
): CommittedSpecInspectionReceiptV1['environments'][number] {
  const receiptName = requireSafeReceiptLabel(name, 'environments');
  const services = Object.entries(environment.services)
    .map(([serviceName, service]) => ({
      name: requireSafeReceiptLabel(serviceName, `environments.${receiptName}.services`),
      workloadKind: service.workloadKind,
      public: service.public ?? service.workloadKind === 'web',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const publicServices = services
    .filter((service) => service.public && service.workloadKind === 'web')
    .map((service) => service.name);
  const endpoint = publicServices.length > 0 ? safeHttpsEndpoint(environment.domain) : null;

  return {
    name: receiptName,
    hosting: {
      provider: environment.hosting.provider,
      ...(environment.hosting.region
        ? { region: requireSafeReceiptLabel(environment.hosting.region, `environments.${receiptName}.hosting.region`) }
        : {}),
    },
    services,
    publicEndpoints: endpoint ? [{ url: endpoint, services: publicServices }] : [],
    features: environmentFeatures(environment),
    declaredProviders: environmentProviders(environment),
  };
}

/**
 * Inspect one exact committed project spec without touching local state or any
 * provider. The hosting service owns repository authentication and exact-SHA
 * reads; this boundary owns schema, identity, secret, and receipt validation.
 */
export function inspectCommittedProjectSpecV1(
  input: CommittedSpecInspectionInputV1
): CommittedSpecInspectionReceiptV1 {
  const source = validateInput(input);
  const actualSha256 = createHash('sha256').update(input.content).digest('hex');
  if (actualSha256 !== source.expectedSha256) {
    inspectionError('DIGEST_MISMATCH', 'Committed spec bytes do not match the supplied SHA-256 digest.');
  }

  const document = decodeJsonSource(input.content);
  const parsed = projectSpecSchema.safeParse(document);
  if (!parsed.success) {
    inspectionError('INVALID_SPEC', 'Committed spec does not match the Hypervibe project schema.', {
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({
        path: safeDocumentPath(issue.path) || '(root)',
        code: issue.code,
      })),
    });
  }

  const secretPaths = secretShapedPaths(document);
  if (secretPaths.length > 0) {
    inspectionError('SECRET_CONTENT', 'Committed spec contains secret-shaped content.', {
      paths: secretPaths.slice(0, 10),
      ...(secretPaths.length > 10 ? { omittedCount: secretPaths.length - 10 } : {}),
    });
  }

  const remoteIdentityVerified = verifyRepositoryClaims(parsed.data, source);
  return {
    schemaVersion: 1,
    status: 'accepted',
    source: {
      provider: source.provider,
      repository: {
        id: source.repositoryId,
        path: source.repositoryPath,
      },
      revision: source.revision,
      specPath: COMMITTED_SPEC_PATH,
      sha256: actualSha256,
      byteLength: input.content.byteLength,
    },
    project: {
      name: requireSafeReceiptLabel(parsed.data.project, 'project'),
      specVersion: 1,
      remoteIdentityVerified,
      declaredProviders: projectProviders(parsed.data),
    },
    environments: Object.entries(parsed.data.environments)
      .map(([name, environment]) => environmentReceipt(name, environment))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
