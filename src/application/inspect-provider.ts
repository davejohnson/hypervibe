import type { CommandContext } from './context.js';
import { HvError } from './results.js';
import { providerRegistry, type ProviderInspectionRequest } from '../domain/registry/provider.registry.js';
import { connectionSetupDetails, formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ObservedState } from '../domain/ports/observe.port.js';

export interface InspectProviderInput {
  provider?: string;
  project?: string;
  env?: string;
  scope?: string;
  resource?: string;
  id?: string;
  name?: string;
  limit?: number;
}

const ENVIRONMENT_INSPECTION_RESOURCES = new Set(['environment', 'database', 'cache', 'storage']);

function advertisedResources(providerName: string): string[] {
  const registered = providerRegistry.get(providerName);
  if (!registered) return [];
  const resources = new Set<string>(['connection']);
  for (const resource of registered.inspection?.resources ?? []) resources.add(resource);
  if (!registered.inspection) {
    if (registered.metadata.category === 'deployment') resources.add('environment');
    if (providerRegistry.supports(providerName, 'database')) resources.add('database');
    if (providerRegistry.supports(providerName, 'cache')) resources.add('cache');
    if (providerRegistry.supports(providerName, 'storage')) resources.add('storage');
  }
  return [...resources];
}

function listProviders(ctx: CommandContext): Record<string, unknown> {
  const connectionStatus = new Map(
    ctx.repos.connections.findAll().map((connection) => [
      `${connection.provider}\u0000${connection.scope ?? ''}`,
      connection.status,
    ])
  );
  return {
    providers: providerRegistry.all().map((registered) => {
      const connections = ctx.repos.connections.findAllByProvider(registered.metadata.name);
      return {
        provider: registered.metadata.name,
        displayName: registered.metadata.displayName,
        category: registered.metadata.category,
        resources: advertisedResources(registered.metadata.name),
        connections: connections.map((connection) => ({
          scope: connection.scope,
          status: connectionStatus.get(`${connection.provider}\u0000${connection.scope ?? ''}`),
        })),
      };
    }),
  };
}

function componentForProvider(
  ctx: CommandContext,
  environment: Environment,
  providerName: string
): Component | null {
  return ctx.repos.components.findByEnvironmentId(environment.id).find((component) => (
    component.bindings.provider === providerName
  )) ?? null;
}

function boundedObservation(observed: ObservedState): Record<string, unknown> {
  return {
    provider: observed.provider,
    observedAt: observed.observedAt,
    projectExists: observed.projectExists,
    projectId: observed.projectId,
    environmentId: observed.environmentId,
    services: observed.services.map((service) => ({
      name: service.name,
      externalId: service.externalId,
      workloadKind: service.workloadKind,
      url: service.url,
      customDomains: service.customDomains,
      customDomainStatus: service.customDomainStatus,
      source: service.source,
      sourceState: service.sourceState,
      envVarKeys: service.envVarKeys,
      status: service.status,
      config: service.config,
    })),
    databases: observed.databases,
    caches: observed.caches ?? [],
    storage: observed.storage ?? [],
    completeness: observed.completeness,
    partial: observed.partial,
    warnings: observed.warnings,
  };
}

export async function inspectProvider(
  ctx: CommandContext,
  input: InspectProviderInput
): Promise<Record<string, unknown>> {
  if (!input.provider) {
    const selectors = Object.entries(input)
      .filter(([field, value]) => field !== 'provider' && value !== undefined)
      .map(([field]) => field);
    if (selectors.length > 0) {
      throw new HvError('VALIDATION', 'provider is required when inspection selectors are supplied.', {
        details: { selectors },
        hint: 'Use hv_inspect({}) with no parameters for provider discovery. Every bounded request requires provider; full live environment inspection requires provider, project, and env.',
      });
    }
    return listProviders(ctx);
  }

  const providerName = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(providerName);
  if (!registered) {
    throw new HvError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Call hv_inspect({}) with no parameters to list registered providers and their supported resource reads.',
    });
  }

  const resources = advertisedResources(providerName);
  if (input.resource && !resources.includes(input.resource)) {
    throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} does not support inspection resource "${input.resource}".`, {
      details: { resources },
      hint: `Call hv_inspect provider="${providerName}" without resource selectors to inspect its default resource, or choose one of the advertised resources.`,
    });
  }
  if (input.env && !input.project) {
    throw new HvError('VALIDATION', 'project is required when env is supplied.', {
      hint: 'Pass both project and env to inspect a Hypervibe environment.',
    });
  }

  const project = input.project
    ? ctx.repos.projects.findById(input.project) ?? ctx.repos.projects.findByName(input.project)
    : null;
  if (input.project && !project) {
    throw new HvError('NOT_FOUND', `Hypervibe project "${input.project}" not found.`, {
      hint: 'Omit project to inspect a provider account directly, or pass an existing Hypervibe project id/name.',
    });
  }
  const environment = input.env && project
    ? ctx.repos.environments.findByProjectAndName(project.id, input.env)
    : null;
  if (input.env && !environment) {
    throw new HvError('NOT_FOUND', `Environment "${input.env}" not found.`, {
      hint: 'Pass both project and an existing environment name.',
    });
  }

  if (input.resource === 'connection') {
    const invalid = [
      input.env !== undefined ? 'env' : undefined,
      input.id !== undefined ? 'id' : undefined,
      input.name !== undefined ? 'name' : undefined,
      input.limit !== undefined ? 'limit' : undefined,
    ].filter((field): field is string => Boolean(field));
    if (invalid.length > 0) {
      throw new HvError('VALIDATION', 'Connection inspection does not accept resource selectors.', {
        details: { invalid },
        hint: 'Use only provider, project, and scope when resource="connection".',
      });
    }
  }

  if (environment && input.resource && !ENVIRONMENT_INSPECTION_RESOURCES.has(input.resource)) {
    throw new HvError('VALIDATION', `env cannot be combined with provider resource "${input.resource}".`, {
      hint: 'Remove env for provider-owned resource inspection, or select environment, database, cache, or storage.',
    });
  }

  if (environment) {
    const invalid = input.resource === 'storage'
      ? []
      : [
        input.id !== undefined ? 'id' : undefined,
        (!input.resource || input.resource === 'environment') && input.name !== undefined ? 'name' : undefined,
        input.limit !== undefined ? 'limit' : undefined,
      ].filter((field): field is string => Boolean(field));
    if (invalid.length > 0) {
      throw new HvError('VALIDATION', 'Live environment inspection received unsupported selectors.', {
        details: { invalid },
        hint: input.resource
          ? 'Use only selectors supported by the selected environment resource.'
          : 'Use provider, project, and env for a full environment observation, or add an explicit resource before filtering it.',
      });
    }
  }

  const projectHints = project ? getProjectScopeHints(project) : [];
  const scopeHints = input.scope
    ? [input.scope, ...projectHints.filter((hint) => hint !== input.scope)]
    : projectHints;
  const resolved = await ctx.adapterFactory.getProviderAdapter(
    providerName,
    project ?? undefined,
    scopeHints
  );
  if (!resolved.success || !resolved.adapter) {
    throw new HvError('MISSING_CONNECTION', resolved.error ?? `No ${providerName} connection configured.`, {
      details: { connectionSetup: connectionSetupDetails(providerName, { scope: input.scope }) },
      hint: formatConnectionGuidance(providerName, { scope: input.scope }),
      next: ['hv_connections'],
    });
  }

  const adapter = resolved.adapter as unknown as Record<string, unknown>;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const request: ProviderInspectionRequest = {
    scope: input.scope ?? projectHints.find((hint) => !hint.includes('://') && !hint.includes('github.com/')),
    resource: input.resource,
    id: input.id,
    name: input.name,
    limit,
  };

  try {
    const providerInspection = registered.inspection;
    const useProviderInspection = input.resource !== 'connection'
      && !environment
      && Boolean(providerInspection)
      && (!input.resource || providerInspection!.resources.includes(input.resource));
    if (useProviderInspection && providerInspection) {
      const inspected = await providerInspection.inspect(resolved.adapter, request);
      if (input.resource && inspected.resource !== input.resource) {
        throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} returned the wrong inspection resource.`, {
          details: { requested: input.resource, returned: inspected.resource ?? null },
          hint: 'Treat this as an adapter contract failure; no provider state was changed.',
        });
      }
      if (inspected.observation === 'ambiguous') {
        throw new HvError('VALIDATION', `Multiple ${registered.metadata.displayName} resources matched "${input.name ?? input.id ?? 'the selector'}".`, {
          details: inspected,
          hint: 'Re-run hv_inspect with the exact durable provider id. Hypervibe will not guess between duplicate resources.',
          next: ['hv_inspect'],
        });
      }
      return {
        provider: providerName,
        category: registered.metadata.category,
        mode: 'provider-resource',
        inspected: true,
        imported: false,
        ...inspected,
      };
    }

    if (environment) {
      const standardResource = input.resource;
      const observe = adapter.observe;
      if ((!standardResource || standardResource === 'environment') && typeof observe === 'function') {
        const observed = await (observe as (environment: Environment) => Promise<ObservedState>)
          .call(resolved.adapter, environment);
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'environment',
          project: project?.name,
          environment: environment.name,
          observed: boundedObservation(observed),
        };
      }

      const component = componentForProvider(ctx, environment, providerName);
      const observeDatabase = adapter.observeDatabase;
      if ((standardResource === 'database' || !standardResource) && typeof observeDatabase === 'function') {
        const observed = await (observeDatabase as (
          environment: Environment,
          component?: Component | null,
          options?: { resourceName?: string }
        ) => Promise<unknown>).call(resolved.adapter, environment, component, { resourceName: input.name });
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'database',
          project: project?.name,
          environment: environment.name,
          observed,
        };
      }

      const observeCache = adapter.observeCache;
      if ((standardResource === 'cache' || !standardResource) && typeof observeCache === 'function') {
        const observed = await (observeCache as (
          environment: Environment,
          component?: Component | null,
          options?: { resourceName?: string }
        ) => Promise<unknown>).call(resolved.adapter, environment, component, { resourceName: input.name });
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'cache',
          project: project?.name,
          environment: environment.name,
          observed,
        };
      }

      if (standardResource === 'storage' && typeof observe === 'function') {
        const observed = await (observe as (environment: Environment) => Promise<ObservedState>)
          .call(resolved.adapter, environment);
        const storage = (observed.storage ?? [])
          .filter((item) => !input.id || item.externalId === input.id)
          .filter((item) => !input.name || item.name === input.name)
          .slice(0, limit);
        return {
          provider: providerName,
          category: registered.metadata.category,
          mode: 'storage',
          project: project?.name,
          environment: environment.name,
          observed: {
            storage,
            completeness: observed.completeness?.storage ?? 'unknown',
            partial: observed.partial,
            warnings: observed.warnings,
          },
        };
      }
      throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} cannot inspect a live Hypervibe environment.`, {
        details: { resources },
        hint: 'Use one of the advertised provider resources without env, or use hv_status for desired-state drift.',
      });
    }

    if (input.resource && input.resource !== 'connection') {
      throw new HvError('VALIDATION', `resource="${input.resource}" requires project and env for environment observation.`, {
        hint: 'Pass an existing Hypervibe project and environment, or choose a provider-owned resource advertised by hv_inspect.',
      });
    }

    if (!registered.inspection) {
      const invalid = [
        input.id !== undefined ? 'id' : undefined,
        input.name !== undefined ? 'name' : undefined,
        input.limit !== undefined ? 'limit' : undefined,
      ].filter((field): field is string => Boolean(field));
      if (invalid.length > 0) {
        throw new HvError('VALIDATION', 'Connection inspection does not accept provider resource selectors.', {
          details: { invalid },
          hint: 'Remove id, name, and limit, or select an advertised provider resource.',
        });
      }
    }

    const verify = adapter.verify;
    if (typeof verify !== 'function') {
      throw new HvError('UNSUPPORTED', `${registered.metadata.displayName} does not expose a read-only inspection contract.`, {
        details: { resources: advertisedResources(providerName) },
        hint: 'Use hv_status for desired-state drift, or add a provider-owned inspection capability before exposing provider-specific reads here.',
      });
    }
    const verification = await (verify as () => Promise<Record<string, unknown>>).call(resolved.adapter);
    if (verification.success === false) {
      throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} connection verification failed.`, {
        details: verification,
        hint: 'Check the recorded connection scope and provider read permissions before retrying.',
        next: ['hv_connections'],
      });
    }
    return {
      provider: providerName,
      category: registered.metadata.category,
      mode: 'connection',
      verification,
      resources: advertisedResources(providerName),
    };
  } catch (error) {
    if (error instanceof HvError) throw error;
    throw new HvError('PROVIDER_ERROR', `${registered.metadata.displayName} inspection failed.`, {
      details: { reason: error instanceof Error ? error.message : String(error) },
      hint: 'Check the recorded connection scope and provider read permissions before retrying.',
    });
  } finally {
    const disconnect = adapter.disconnect;
    if (typeof disconnect === 'function') {
      await (disconnect as () => Promise<void>).call(resolved.adapter);
    }
  }
}
