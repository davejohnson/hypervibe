import type { LocalSnapshot, PlanAction } from '../plan/plan.types.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';

export const CACHE_OPERATIONS = {
  ensure: 'cacheEnsure',
  unwire: 'cacheUnwire',
  destroy: 'cacheDestroy',
} as const;

const CACHE_OPERATION_SET = new Set<string>(Object.values(CACHE_OPERATIONS));

function bindingProvider(component: LocalSnapshot['components'][number] | undefined): string | undefined {
  const provider = (component?.bindings as Record<string, unknown> | undefined)?.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined;
}

function cacheAction(params: {
  id: string;
  type: PlanAction['type'];
  provider: string;
  operation: string;
  reason: string;
  verified: boolean;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  billable?: boolean;
  requiresConfirm?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'cache', name: 'redis', provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true, dataBearing: true } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

export interface CachePlanResult {
  actions: PlanAction[];
  warnings: string[];
  unmanaged: Array<{ kind: 'cache'; name: string; detail?: string }>;
  /** A new cache must exist before service bootstrap can inject REDIS_URL. */
  serviceDependency?: string;
}

export function planCache(params: {
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
  local: LocalSnapshot;
  projectDependency?: string[];
}): CachePlanResult {
  const desired = params.environmentSpec.cache;
  const local = params.local.components.find((component) => component.type === 'redis');
  const localProvider = bindingProvider(local);
  const previousProvider = typeof (local?.bindings as Record<string, unknown> | undefined)?.previousProvider === 'string'
    ? String((local?.bindings as Record<string, unknown>).previousProvider)
    : undefined;
  const observationKnown = params.observed === null
    || params.observed.completeness?.caches !== 'unknown';
  const observedCaches = observationKnown
    ? (params.observed?.caches ?? []).filter((cache) => cache.engine === 'redis')
    : [];
  const boundObserved = local?.externalId
    ? observedCaches.find((cache) => cache.externalId === local.externalId)
    : undefined;
  const observed = boundObserved ?? (observedCaches.length === 1 ? observedCaches[0] : undefined);
  const currentProvider = params.observed && observationKnown ? observed?.provider : localProvider;
  const verified = Boolean(params.observed && observationKnown);
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const unmanaged: CachePlanResult['unmanaged'] = [];

  if (desired) {
    const wanted = desired.provider;
    const ensureId = `cache:${wanted}`;
    if (observedCaches.length > 1 && !boundObserved) {
      const externalIds = observedCaches.map((cache) => cache.externalId).sort();
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: 'Multiple Redis caches were observed; Hypervibe cannot safely select one',
        metadata: { blockedReason: 'ambiguous_cache_identity', externalIds },
      }));
      warnings.push(`Multiple Redis caches were observed (${externalIds.join(', ')}). Cache mutations are blocked until one identity is explicitly adopted.`);
      for (const cache of observedCaches) {
        if (cache.externalId === local?.externalId) continue;
        unmanaged.push({
          kind: 'cache',
          name: cache.name ?? cache.engine,
          detail: `${cache.provider} cache ${cache.externalId} is an additional Redis candidate`,
        });
      }
      return { actions, warnings, unmanaged };
    }
    for (const cache of observedCaches) {
      if (cache.externalId === boundObserved?.externalId) continue;
      unmanaged.push({
        kind: 'cache',
        name: cache.name ?? cache.engine,
        detail: `${cache.provider} Redis cache ${cache.externalId} is not bound to this environment`,
      });
    }

    if (params.observed && !observationKnown) {
      actions.push(cacheAction({
        id: ensureId,
        type: localProvider === wanted ? 'noop' : 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: false,
        reason: localProvider === wanted
          ? 'Preserving the locally bound Redis cache because live cache observation is unknown'
          : `Cannot verify whether the desired ${wanted} Redis cache exists`,
        ...(localProvider === wanted
          ? {}
          : { metadata: { blockedReason: 'cache_observation_unknown' } }),
      }));
      return { actions, warnings, unmanaged };
    }

    if (!currentProvider) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'create',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: 'No Redis cache exists',
        billable: true,
        dependsOn: params.projectDependency,
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (currentProvider !== wanted) {
      warnings.push(
        `Cache provider change from ${currentProvider} to ${wanted} is staged: this plan creates the new Redis cache and rewires services before a later confirm-gated old-cache deletion.`
      );
      actions.push(cacheAction({
        id: ensureId,
        type: 'create',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified,
        reason: `Redis provider changes from ${currentProvider} to ${wanted}`,
        billable: true,
        dependsOn: params.projectDependency,
      }));
      return { actions, warnings, unmanaged, serviceDependency: ensureId };
    }

    if (observed && !local) {
      actions.push(cacheAction({
        id: ensureId,
        type: 'update',
        provider: wanted,
        operation: CACHE_OPERATIONS.ensure,
        verified: true,
        reason: `A live ${wanted} Redis cache exists but is not adopted into Hypervibe state`,
        metadata: {
          blockedReason: 'cache_adoption_required',
          externalId: observed.externalId,
          observedName: observed.name,
        },
      }));
      unmanaged.push({
        kind: 'cache',
        name: observed.name ?? observed.engine,
        detail: `${observed.provider} cache ${observed.externalId} requires explicit hv_import adoption`,
      });
      return { actions, warnings, unmanaged };
    }

    actions.push(cacheAction({
      id: ensureId,
      type: 'noop',
      provider: wanted,
      operation: CACHE_OPERATIONS.ensure,
      verified,
      reason: 'Redis cache in sync',
    }));
    if (previousProvider && previousProvider !== wanted) {
      actions.push(cacheAction({
        id: `cache:${previousProvider}:destroy`,
        type: 'destroy',
        provider: previousProvider,
        operation: CACHE_OPERATIONS.destroy,
        verified,
        reason: `Previous ${previousProvider} Redis cache is no longer active`,
        requiresConfirm: true,
      }));
    }
    return { actions, warnings, unmanaged };
  }

  if (params.observed && !observationKnown && local) {
    actions.push(cacheAction({
      id: `cache:${localProvider ?? 'redis'}:observation-blocked`,
      type: 'update',
      provider: localProvider ?? 'unknown',
      operation: CACHE_OPERATIONS.destroy,
      verified: false,
      reason: 'Redis was removed from the spec, but live cache observation is unknown; refusing to destroy it',
      metadata: { blockedReason: 'cache_observation_unknown' },
    }));
    return { actions, warnings, unmanaged };
  }

  const destroyProvider = currentProvider ?? localProvider;
  if (local && destroyProvider) {
    const boundServiceNames = Object.keys(params.local.bindings?.services ?? {});
    const serviceNames = boundServiceNames.length > 0
      ? boundServiceNames
      : Object.keys(params.environmentSpec.services);
    const destroyDependencies: string[] = [];
    for (const serviceName of serviceNames) {
      if (!params.environmentSpec.services[serviceName]) {
        destroyDependencies.push(`service:${serviceName}`);
        continue;
      }
      const id = `cache:redis:unwire:${serviceName}`;
      actions.push(cacheAction({
        id,
        type: 'update',
        provider: destroyProvider,
        operation: CACHE_OPERATIONS.unwire,
        verified,
        reason: `Remove REDIS_URL from service "${serviceName}" before deleting Redis`,
        metadata: { serviceName, envKeys: ['REDIS_URL'] },
      }));
      destroyDependencies.push(id);
    }
    actions.push(cacheAction({
      id: `cache:${destroyProvider}:destroy`,
      type: 'destroy',
      provider: destroyProvider,
      operation: CACHE_OPERATIONS.destroy,
      verified,
      reason: 'Redis was removed from the spec. Cached or persisted data may be lost — confirm to destroy.',
      dependsOn: destroyDependencies,
      requiresConfirm: true,
    }));
  } else if (observed) {
    unmanaged.push({
      kind: 'cache',
      name: observed.name ?? observed.engine,
      detail: `${observed.provider} Redis cache exists but is not managed by the spec`,
    });
  }

  return { actions, warnings, unmanaged };
}

export function isCacheAction(action: PlanAction): boolean {
  return action.resource.kind === 'cache'
    && typeof action.metadata?.operation === 'string'
    && CACHE_OPERATION_SET.has(action.metadata.operation);
}
