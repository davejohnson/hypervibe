import { z } from 'zod';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { diffEnvironment } from '../../domain/plan/diff.engine.js';
import { withMigrationReleaseCommand } from '../../domain/spec/spec-bootstrap.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import type { ObservedService, ObservedState } from '../../domain/ports/observe.port.js';
import type { EnvironmentSpec, ServiceSpec } from '../../domain/spec/spec.schema.js';
import { customDomainOrigin, endpointProjection, MAX_PUBLIC_ENDPOINTS, publicOrigin, type HostedPublicEndpointV1 } from './public-endpoints.js';
import {
  parseCommittedProjectSpecV1,
  type CommittedSpecInspectionInputV1, type CommittedSpecInspectionReceiptV1,
} from './committed-spec-inspection.js';
import {
  HostedInspectionError, inspectCommittedBindingsV1, sameCommittedSource,
  type CommittedBindingsInspectionInputV1, type CommittedBindingsInspectionReceiptV1,
  type HostedEnvironmentBindingsV1,
} from './committed-bindings-inspection.js';

export interface HostedEnvironmentInspectionInputV1 {
  schemaVersion: 1;
  source: CommittedSpecInspectionInputV1;
  environment: string;
  /** Exact binding-file bytes from the same repository and revision as source. */
  bindings?: CommittedBindingsInspectionInputV1;
  /** The trusted host authorizes this scope independently of repository content. */
  connection?: {
    provider: string;
    scope: { projectId: string; environmentId: string };
    credentials: unknown;
  };
  limits?: { maxRequests?: number; maxResources?: number; timeoutMs?: number };
}

export type HostedResourceStatusV1 = 'matching' | 'drifted' | 'missing' | 'unmanaged' | 'unknown' | 'unsupported';
export interface HostedResourceFieldV1 {
  field: string;
  status: 'matching' | 'drifted' | 'unknown' | 'unsupported';
  /** Sensitive configuration uses presence markers, never values or hashes. */
  desired: string | boolean | null;
  current: string | boolean | null;
}
export interface HostedResourceInspectionV1 {
  id: string;
  kind: string;
  name: string;
  provider: string;
  externalId?: string;
  status: HostedResourceStatusV1;
  desired: { exists: boolean };
  current: { exists: boolean | null };
  fields: HostedResourceFieldV1[];
  reasonCode?: string;
}
export interface HostedEnvironmentInspectionReceiptV1 {
  schemaVersion: 1;
  source: CommittedSpecInspectionReceiptV1['source'];
  bindingSource: CommittedBindingsInspectionReceiptV1['source'] | null;
  environment: string;
  scope: { provider: string; projectId?: string; environmentId?: string };
  attemptedAt: string;
  completedAt: string;
  /** Only set when an exact provider scope was successfully observed. */
  observedAt: string | null;
  coverage: {
    /** Completeness concerns the declared scope below, never application health. */
    scope: 'hosting-configuration';
    status: 'complete' | 'partial' | 'unknown' | 'unsupported';
    supportedResourceKinds: string[];
    unsupportedCapabilities: string[];
    checkedResources: number;
    totalDeclaredResources: number;
    omittedResources: number;
    requests: number;
  };
  resources: HostedResourceInspectionV1[];
  publicEndpoints: HostedPublicEndpointV1[];
  publicEndpointsTruncated?: boolean;
}

const limitsSchema = z.object({
  maxRequests: z.number().int().min(1).max(200).default(80),
  maxResources: z.number().int().min(1).max(200).default(100),
  timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
}).strict();
const MAX_ENV_FIELDS = 100;
const CONFIG_FIELDS = ['startCommand', 'releaseCommand', 'healthCheckPath', 'cronSchedule', 'public'] as const;
const OUTSIDE_SCOPE = ['runtime-health', 'release-revision', 'managed-secret-values', 'workload-kind'];

function resource(kind: string, name: string, provider: string): HostedResourceInspectionV1 {
  return { id: `${kind}:${name}`, kind, name, provider, status: 'unknown',
    desired: { exists: true }, current: { exists: null }, fields: [] };
}

function declaredResources(spec: EnvironmentSpec, environment: string, hasRuntime: boolean): HostedResourceInspectionV1[] {
  const provider = spec.hosting.provider;
  const environmentResource = resource('environment', environment, provider);
  for (const [field, declared] of Object.entries({
    region: Boolean(spec.hosting.region), runtime: hasRuntime, deploy: spec.deploy !== undefined,
    envFile: spec.envFile !== undefined && spec.envFile.mode !== 'off',
    migrations: spec.migrations !== undefined && spec.migrations.mode !== 'none',
  })) {
    if (declared) environmentResource.fields.push({ field, status: 'unsupported', desired: 'configured', current: null });
  }
  const resources = [environmentResource,
    ...Object.keys(spec.services).sort().map(name => resource('service', name, provider))];
  const unsupported = (kind: string, name: string, owner = provider) => {
    resources.push({ ...resource(kind, name, owner), status: 'unsupported', reasonCode: 'capability_unsupported' });
  };
  if (spec.database) unsupported('database', 'database', spec.database.provider);
  if (spec.cache) unsupported('cache', 'cache', spec.cache.provider);
  for (const [name, storage] of Object.entries(spec.storage ?? {})) unsupported('storage', name, storage.provider);
  for (const name of Object.keys(spec.queues ?? {})) unsupported('queue', name);
  if (spec.domain) unsupported('domain', 'domain');
  if (spec.domainRegistration) unsupported('domain-registration', 'domain-registration', spec.domainRegistration.provider);
  if (spec.loadBalancer) unsupported('load-balancer', 'load-balancer', spec.loadBalancer.provider);
  if (spec.email.enabled) unsupported('email', 'email', 'unverified');
  if (spec.messaging) unsupported('messaging', 'messaging', spec.messaging.provider);
  if (spec.payments?.stripe) unsupported('payment', 'payment', 'stripe');
  if (spec.maintenance) unsupported('maintenance', 'maintenance');
  if (spec.dataMigration) unsupported('data-migration', 'data-migration');
  if (spec.ios) unsupported('ios', 'ios');
  return resources;
}

function markUnknown(resources: HostedResourceInspectionV1[], reason: string): void {
  for (const row of resources) {
    if (row.status !== 'unsupported') {
      row.status = 'unknown'; row.reasonCode = reason;
    }
  }
}

function safeProviderIdentity(value: string): string | undefined {
  // Provider response labels may be attacker controlled. Do not echo arbitrary text.
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,511}$/.test(value) ? value : undefined;
}

function configFields(service: ServiceSpec, observed: ObservedService | undefined,
  variables: Record<string, string>, differences: Set<string>, complete: boolean,
  retiredKeys: string[], removalDifferences: Set<string>): HostedResourceFieldV1[] {
  const fields: HostedResourceFieldV1[] = [];
  for (const field of CONFIG_FIELDS) {
    if (service[field] === undefined) continue;
    fields.push({ field, status: !complete ? 'unknown' : !observed || differences.has(field) ? 'drifted' : 'matching',
      desired: field === 'public' ? service.public! : 'configured',
      current: !complete ? null : field === 'public' ? observed?.config.public ?? null
        : observed?.config[field] ? 'configured' : 'not configured' });
  }
  for (const key of Object.keys(variables)) {
    const field = `env:${key}`;
    fields.push({ field, status: !complete ? 'unknown' : !observed || differences.has(field) ? 'drifted' : 'matching',
      desired: 'configured', current: !complete ? null : observed?.envVarKeys.includes(key) ? 'configured' : 'not configured' });
  }
  for (const key of retiredKeys) {
    const field = `env:${key}`;
    fields.push({ field, status: !complete ? 'unknown' : removalDifferences.has(field) ? 'drifted' : 'matching',
      desired: 'not configured', current: !complete ? null : observed?.envVarKeys.includes(key) ? 'configured' : 'not configured' });
  }
  return fields;
}

function compareHosting(input: {
  spec: EnvironmentSpec; environment: string; bindings: HostedEnvironmentBindingsV1;
  observed: ObservedState; resources: HostedResourceInspectionV1[]; maxResources: number;
}): number {
  const { environment, bindings, observed, resources } = input;
  // Bound work before pure comparison, as well as before provider reads. Any
  // omitted desired fields remain explicit incomplete coverage.
  const services = Object.fromEntries(resources.filter(row => row.kind === 'service')
    .map(row => {
      const service = input.spec.services[row.name];
      return [row.name, { ...service, public: service.public ?? service.workloadKind === 'web' }];
    }));
  const envVars = Object.fromEntries(Object.entries(input.spec.envVars).slice(0, MAX_ENV_FIELDS));
  const removeEnvVars = (input.spec.removeEnvVars ?? []).slice(0, MAX_ENV_FIELDS - Object.keys(envVars).length);
  const spec = withMigrationReleaseCommand({ ...input.spec, services, envVars, removeEnvVars });
  const metadata = providerRegistry.getMetadata(spec.hosting.provider);
  const differences = diffEnvironment({
    spec, envName: environment, observed,
    local: { projectExists: true, environmentExists: true, services: [], components: [], bindings },
    providerBehavior: metadata?.orchestration?.diff,
    customDomainManagement: metadata?.lifecycle?.hosting?.customDomains,
    customDomainTrafficProxy: metadata?.lifecycle?.hosting?.domainTrafficProxy,
    // Runtime and deploy provenance are deliberately excluded: current engine
    // may derive them from local records rather than provider-observed values.
  });
  const serviceComplete = observed.completeness?.services === 'complete';
  const envComplete = observed.completeness?.environment === 'complete';
  for (const row of resources) {
    if (row.kind === 'environment') {
      const complete = observed.completeness?.project === 'complete' && envComplete;
      row.current.exists = complete ? observed.projectExists && Boolean(observed.environmentId) : null;
      row.status = !complete ? 'unknown' : row.current.exists ? 'matching' : 'missing';
      continue;
    }
    if (row.kind !== 'service') continue;
    const binding = bindings.services[row.name];
    const candidates = binding ? observed.services.filter(service => service.externalId === binding.serviceId) : [];
    const live = candidates.length === 1 ? candidates[0] : undefined;
    const action = differences.actions.find(candidate => candidate.id === row.id);
    const fields = new Set(action?.diff?.map(field => field.field) ?? []);
    const removal = differences.actions.find(candidate => candidate.id === `${row.id}:env-remove`);
    const removalFields = new Set(removal?.diff?.map(field => field.field) ?? []);
    const blocked = action?.metadata?.blockedReason;
    const complete = serviceComplete && candidates.length <= 1 && !blocked && Boolean(binding);
    row.fields = configFields(spec.services[row.name], live, envVars, fields, complete, removeEnvVars, removalFields);
    if (binding) row.externalId = binding.serviceId;
    if (!complete) {
      row.status = 'unknown';
      row.reasonCode = !binding ? 'binding_missing' : candidates.length > 1 ? 'ambiguous_identity' : 'observation_incomplete';
    } else if (!live || live.identityOnly) {
      row.current.exists = false; row.status = 'missing';
    } else {
      row.current.exists = true;
      row.status = row.fields.some(field => field.status === 'drifted') ? 'drifted' : 'matching';
    }
    if (Object.keys(input.spec.envVars).length + (input.spec.removeEnvVars?.length ?? 0) > MAX_ENV_FIELDS) {
      row.fields.push({ field: 'additional-variables', status: 'unknown', desired: 'configured', current: null });
      row.status = row.status === 'drifted' ? 'drifted' : 'unknown'; row.reasonCode = 'field_budget_exhausted';
    }
    for (const key of ['volume', 'timeZone', 'databaseEnvAliases'] as const) {
      if (spec.services[row.name][key] !== undefined) row.fields.push({ field: key, status: 'unsupported', desired: 'configured', current: null });
    }
  }
  const boundNames = new Map(Object.entries(bindings.services).map(([name, binding]) => [binding.serviceId, name]));
  let omittedResources = 0;
  for (const live of observed.services) {
    const boundName = boundNames.get(live.externalId);
    if (boundName && Object.hasOwn(input.spec.services, boundName)) continue;
    if (resources.length >= input.maxResources) { omittedResources += 1; continue; }
    const externalId = safeProviderIdentity(live.externalId);
    if (!externalId) continue;
    resources.push({ id: boundName ? `service:${boundName}` : `unmanaged:${externalId}`, kind: 'service',
      name: boundName ?? safeProviderIdentity(live.name) ?? 'Unmanaged service',
      provider: spec.hosting.provider, externalId, status: boundName ? 'drifted' : 'unmanaged', desired: { exists: false },
      current: { exists: true }, fields: [], reasonCode: boundName ? 'undesired_managed_resource' : 'not_bound' });
  }
  return omittedResources;
}

/** Observe only: no local state, provider mutations, persisted plans or secret output. */
export async function inspectHostedEnvironmentV1(
  input: HostedEnvironmentInspectionInputV1,
  dependencies: { now?: () => Date; signal?: AbortSignal } = {}
): Promise<HostedEnvironmentInspectionReceiptV1> {
  if (!input || input.schemaVersion !== 1 || typeof input.environment !== 'string') {
    throw new HostedInspectionError('INVALID_INPUT', 'Hosted environment inspection requires schemaVersion 1 and an environment.');
  }
  const parsedLimits = limitsSchema.safeParse(input.limits ?? {});
  if (!parsedLimits.success) throw new HostedInspectionError('INVALID_INPUT', 'Hosted inspection limits are invalid.');
  const limits = parsedLimits.data;
  const now = dependencies.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const { spec, receipt } = parseCommittedProjectSpecV1(input.source);
  const environment = Object.hasOwn(spec.environments, input.environment) ? spec.environments[input.environment] : undefined;
  if (!environment) throw new HostedInspectionError('INVALID_INPUT', 'The committed spec does not declare this environment.');
  const bound = input.bindings ? inspectCommittedBindingsV1(input.bindings) : undefined;
  if (bound && (!sameCommittedSource(input.source, input.bindings!) || bound.project !== spec.project)) {
    throw new HostedInspectionError('SOURCE_MISMATCH', 'Committed bindings and desired state must identify the same repository, revision and project.');
  }
  const bindings = bound?.environments[input.environment];
  const allResources = declaredResources(environment, input.environment, spec.runtime !== undefined);
  const resources = allResources.slice(0, limits.maxResources);
  const provider = environment.hosting.provider;
  const report: HostedEnvironmentInspectionReceiptV1 = {
    schemaVersion: 1, source: receipt.source, bindingSource: bound?.source ?? null,
    environment: input.environment,
    scope: { provider, ...(bindings?.projectId ? { projectId: bindings.projectId } : {}),
      ...(bindings?.environmentId ? { environmentId: bindings.environmentId } : {}) },
    attemptedAt, completedAt: attemptedAt, observedAt: null,
    coverage: { scope: 'hosting-configuration', status: 'unknown', supportedResourceKinds: [],
      unsupportedCapabilities: [...OUTSIDE_SCOPE, ...new Set(allResources.filter(row => row.status === 'unsupported').map(row => row.kind))],
      checkedResources: 0, totalDeclaredResources: allResources.length,
      omittedResources: Math.max(0, allResources.length - resources.length), requests: 0 }, resources, publicEndpoints: [],
  };
  await import('./providers.js');
  const capability = providerRegistry.get(provider)?.hostedObservation;
  if (!capability) {
    for (const row of resources) { row.status = 'unsupported'; row.reasonCode = 'provider_unsupported'; }
    report.coverage.status = 'unsupported';
  } else if (!bindings?.provider || !bindings.projectId || !bindings.environmentId) {
    markUnknown(resources, 'binding_missing');
  } else if (!input.connection) {
    markUnknown(resources, 'connection_missing');
  } else if (bindings.provider !== provider || input.connection.provider !== provider
    || bindings.projectId !== input.connection.scope?.projectId || bindings.environmentId !== input.connection.scope?.environmentId) {
    markUnknown(resources, 'scope_mismatch');
  } else {
    report.coverage.supportedResourceKinds = ['environment', 'service'];
    const result = await capability.observe({
      environment: { id: input.environment, projectId: spec.project, name: input.environment,
        platformBindings: { ...bindings }, createdAt: now(), updatedAt: now() },
      credentials: input.connection.credentials, scope: input.connection.scope, limits, signal: dependencies.signal,
    });
    report.coverage.requests = result.requests;
    if (!result.scopeVerified || !result.observed || result.observed.provider !== provider
      || result.observed.projectId !== bindings.projectId
      || (result.observed.environmentId && result.observed.environmentId !== bindings.environmentId)) {
      markUnknown(resources, result.reason ?? 'observation_incomplete');
    } else {
      report.coverage.omittedResources += compareHosting({ spec: environment, environment: input.environment, bindings,
        observed: result.observed, resources, maxResources: limits.maxResources });
      const endpoints = endpointProjection<HostedPublicEndpointV1>();
      for (const row of resources) {
        if (row.kind !== 'service' || !row.desired.exists || row.current.exists !== true) continue;
        const declared = environment.services[row.name];
        if (!declared || declared.workloadKind !== 'web' || declared.public === false) continue;
        const live = result.observed.services.find(service => service.externalId === bindings.services[row.name]?.serviceId);
        if (!live || live.workloadKind !== 'web' || live.config.public !== true) continue;
        for (const domain of live.customDomains.slice(0, MAX_PUBLIC_ENDPOINTS)) {
          const url = customDomainOrigin(domain);
          if (url) endpoints.add({ url, services: [row.name], kind: 'custom' });
        }
        if (live.customDomains.length > MAX_PUBLIC_ENDPOINTS) report.publicEndpointsTruncated = true;
        const url = publicOrigin(live.url);
        if (url) endpoints.add({ url, services: [row.name], kind: 'provider' });
      }
      Object.assign(report, endpoints.result());
      // Acquisition time comes from the injected host clock. Provider event or
      // deployment timestamps are not evidence that a new observation succeeded.
      report.observedAt = now().toISOString();
      report.coverage.checkedResources = resources.filter(row => row.desired.exists && row.current.exists !== null).length;
      const incomplete = resources.some(row => row.status === 'unknown' || row.status === 'unsupported'
        || row.fields.some(field => field.status === 'unknown' || field.status === 'unsupported'))
        || result.observed.partial || report.coverage.omittedResources > 0;
      report.coverage.status = incomplete ? 'partial' : 'complete';
    }
  }
  report.completedAt = now().toISOString();
  const credentials = input.connection?.credentials;
  const suppliedValues = credentials && typeof credentials === 'object'
    ? Object.values(credentials).filter((value): value is string => typeof value === 'string') : [];
  return redactExactValues(report, suppliedValues);
}
