import { parseHostingBindings, parseHostingServiceCreateRecovery } from '../ports/hosting.port.js';
import { providerRegistry } from '../registry/provider.registry.js';

type ProviderScope = Record<string, string>;

export interface HostingBindingTarget {
  provider: string;
  projectId?: string;
  environmentId?: string;
  providerBindings?: Record<string, unknown>;
  created?: boolean;
}

export type HostingBindingTransition =
  | { ok: true; changed: boolean; patch: Record<string, unknown> }
  | { ok: false; error: string };

const RESERVED_PROVIDER_BINDINGS = new Set([
  'provider',
  'projectId',
  'environmentId',
  'services',
  'serviceCreateRecovery',
  'previousHosting',
  'maintenance',
  'runtimeRollouts',
]);

function sameScope(left: ProviderScope | undefined, right: ProviderScope | undefined): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b)))
    === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
}

function exactServiceId(binding: Record<string, unknown>): string | undefined {
  for (const key of ['serviceId', 'jobName'] as const) {
    const value = binding[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function recoveryScopeMatchesCurrent(params: {
  recoveryScope: ProviderScope;
  currentScope?: ProviderScope;
  projectId?: string;
  environmentId?: string;
}): boolean {
  if (params.currentScope) return sameScope(params.recoveryScope, params.currentScope);
  if (params.projectId && params.recoveryScope.projectId !== params.projectId) return false;
  if (params.environmentId && params.recoveryScope.environmentId !== params.environmentId) return false;
  return Boolean(params.projectId || params.environmentId);
}

/**
 * Build one fail-closed patch when a provider's canonical hosting scope changes.
 * Old identities move into the existing previousHosting cleanup boundary before
 * active bindings are reset; state that cannot be cleaned through that boundary
 * blocks the rebind instead of being discarded or reused in the new scope.
 */
export function prepareHostingBindingTransition(params: {
  current: Record<string, unknown>;
  target: HostingBindingTarget;
}): HostingBindingTransition {
  const provider = params.target.provider.trim();
  const projectId = params.target.projectId?.trim() || undefined;
  const environmentId = params.target.environmentId?.trim() || undefined;
  if (!provider) return { ok: false, error: 'Hosting provider identity is missing.' };

  const providerBindings = params.target.providerBindings ?? {};
  const reserved = Object.keys(providerBindings).find((key) => RESERVED_PROVIDER_BINDINGS.has(key));
  if (reserved) {
    return {
      ok: false,
      error: `Provider-owned project bindings cannot replace reserved hosting key ${reserved}.`,
    };
  }

  let current;
  let target;
  try {
    current = parseHostingBindings({ platformBindings: params.current });
    target = parseHostingBindings({
      platformBindings: {
        provider,
        ...(projectId ? { projectId } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...providerBindings,
        services: {},
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `Hosting binding identity is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const hadCanonicalIdentity = Boolean(current.provider || current.projectId || current.providerScope);
  const changed = hadCanonicalIdentity && (
    current.provider !== target.provider
    || current.projectId !== target.projectId
    || !sameScope(current.providerScope, target.providerScope)
  );
  const resetActiveScope = changed || params.target.created === true;
  const patch: Record<string, unknown> = {
    ...providerBindings,
    provider,
    ...(projectId ? { projectId } : { projectId: undefined }),
    ...(environmentId ? { environmentId } : {}),
  };

  if (!resetActiveScope) return { ok: true, changed: false, patch };

  if (current.maintenance !== undefined) {
    return {
      ok: false,
      error: 'The current hosting scope has an active maintenance recovery boundary. Finish or explicitly repair maintenance before changing provider scope.',
    };
  }

  if (!changed && params.target.created === true) {
    if (Object.keys(current.serviceCreateRecovery ?? {}).length > 0) {
      return {
        ok: false,
        error: 'The current hosting scope has service-create recovery state. Resolve it before accepting a newly created provider boundary.',
      };
    }
    patch.services = {};
    patch.serviceCreateRecovery = undefined;
    patch.runtimeRollouts = undefined;
    if (!Object.prototype.hasOwnProperty.call(providerBindings, 'providerScope')) {
      patch.providerScope = undefined;
    }
    if (!environmentId) patch.environmentId = undefined;
    return { ok: true, changed: false, patch };
  }

  const cleanupBoundary = current.provider
    ? providerRegistry.getMetadata(current.provider)?.lifecycle?.hosting?.teardownBoundary
    : undefined;
  if (changed && current.provider === provider && cleanupBoundary === 'project') {
    const oldProjectId = current.providerScope?.projectId ?? current.projectId;
    const newProjectId = target.providerScope?.projectId ?? target.projectId;
    if (!oldProjectId || !newProjectId || oldProjectId === newProjectId) {
      return {
        ok: false,
        error: 'The earlier and new scopes share the same provider-owned project boundary. Hypervibe cannot retain one for cleanup without risking the other.',
      };
    }
  }
  if (changed && current.provider === provider && cleanupBoundary === 'environment') {
    const oldProjectId = current.providerScope?.projectId ?? current.projectId;
    const newProjectId = target.providerScope?.projectId ?? target.projectId;
    const oldEnvironmentId = current.providerScope?.environmentId ?? current.environmentId;
    const newEnvironmentId = target.providerScope?.environmentId ?? target.environmentId;
    if (
      !oldProjectId
      || !newProjectId
      || !oldEnvironmentId
      || !newEnvironmentId
      || (oldProjectId === newProjectId && oldEnvironmentId === newEnvironmentId)
    ) {
      return {
        ok: false,
        error: 'The earlier and new scopes do not prove distinct provider environment boundaries. Hypervibe will not risk cleaning up the active environment.',
      };
    }
  }
  const retainedServices = Object.fromEntries(
    Object.entries(current.services ?? {}).map(([name, binding]) => [name, { ...binding }])
  );
  const recoveries = current.serviceCreateRecovery ?? {};
  let retainedScope = current.providerScope;

  for (const [name, rawRecovery] of Object.entries(recoveries)) {
    const recovery = parseHostingServiceCreateRecovery(rawRecovery);
    if (!recovery || recovery.state === 'unresolved') {
      return {
        ok: false,
        error: `Service ${name} has an unresolved create outcome. Resolve that exact provider resource before changing provider scope.`,
      };
    }
    if (
      recovery.provider !== current.provider
      || !recoveryScopeMatchesCurrent({
        recoveryScope: recovery.providerScope,
        currentScope: current.providerScope,
        projectId: current.projectId,
        environmentId: current.environmentId,
      })
      || (retainedScope && !sameScope(retainedScope, recovery.providerScope))
    ) {
      return {
        ok: false,
        error: `Service ${name} recovery belongs to a different or ambiguous provider scope. Repair it before changing the active hosting scope.`,
      };
    }
    retainedScope ??= recovery.providerScope;
    const existing = retainedServices[name] as Record<string, unknown> | undefined;
    const existingId = existing ? exactServiceId(existing) : undefined;
    if (existingId && existingId !== recovery.serviceId) {
      return {
        ok: false,
        error: `Service ${name} has conflicting bound and recovery identities. Resolve both exact provider resources before changing provider scope.`,
      };
    }
    retainedServices[name] = {
      ...(existing ?? {}),
      serviceId: recovery.serviceId,
      createRecovery: recovery,
    };
  }

  const serviceEntries = Object.entries(retainedServices);
  const incompleteServices = serviceEntries
    .filter(([, binding]) => !exactServiceId(binding as Record<string, unknown>))
    .map(([name]) => name);
  if ((cleanupBoundary === 'services' || cleanupBoundary === 'project') && incompleteServices.length > 0) {
    return {
      ok: false,
      error: `The current hosting scope has service bindings without exact provider ids: ${incompleteServices.join(', ')}. Repair them before changing provider scope.`,
    };
  }

  const retainsBoundary = cleanupBoundary === 'services'
    ? serviceEntries.length > 0
    : cleanupBoundary === 'environment'
      ? Boolean(current.projectId && current.environmentId)
      : cleanupBoundary === 'project'
        ? Boolean(current.projectId)
        : false;
  const hasProviderState = Boolean(current.projectId || current.environmentId || retainedScope || serviceEntries.length > 0);
  if (hasProviderState && !cleanupBoundary) {
    return {
      ok: false,
      error: `${current.provider ?? 'The current provider'} has no safe hosting teardown boundary. Hypervibe will not discard its scoped identities.`,
    };
  }
  if ((cleanupBoundary === 'environment' || cleanupBoundary === 'project') && !retainsBoundary) {
    return {
      ok: false,
      error: `The current ${current.provider} ${cleanupBoundary} cleanup identity is incomplete. Repair it before changing provider scope.`,
    };
  }

  const existingPrevious = params.current.previousHosting;
  if (retainsBoundary && existingPrevious !== undefined && existingPrevious !== null) {
    return {
      ok: false,
      error: 'A prior hosting cleanup boundary is already retained. Finish or explicitly resolve it before changing provider scope again.',
    };
  }

  if (retainsBoundary) {
    patch.previousHosting = {
      provider: current.provider,
      ...(current.projectId ? { projectId: current.projectId } : {}),
      ...(current.environmentId ? { environmentId: current.environmentId } : {}),
      ...(retainedScope ? { providerScope: retainedScope } : {}),
      services: retainedServices,
      ...(Object.keys(recoveries).length > 0 ? { serviceCreateRecovery: recoveries } : {}),
    };
  }

  patch.services = {};
  patch.serviceCreateRecovery = undefined;
  patch.runtimeRollouts = undefined;
  if (!Object.prototype.hasOwnProperty.call(providerBindings, 'providerScope')) {
    patch.providerScope = undefined;
  }
  if (!environmentId) patch.environmentId = undefined;
  return { ok: true, changed, patch };
}
