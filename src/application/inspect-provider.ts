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
  if (!input.provider) return listProviders(ctx);

  const providerName = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(providerName);
  if (!registered) {
    throw new HvError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Call hv_inspect without provider to list registered providers and their supported resource reads.',
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
  const hasStandardObservation = Boolean(environment) && [
    adapter.observe,
    adapter.observeDatabase,
    adapter.observeCache,
  ].some((operation) => typeof operation === 'function');
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const request: ProviderInspectionRequest = {
    scope: input.scope ?? projectHints.find((hint) => !hint.includes('://') && !hint.includes('github.com/')),
    resource: input.resource,
    id: input.id,
    name: input.name,
    limit,
  };

  try {
    if (registered.inspection && input.resource !== 'connection' && !hasStandardObservation) {
      const inspected = await registered.inspection.inspect(resolved.adapter, request);
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
      const observe = adapter.observe;
      if (typeof observe === 'function') {
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
      if (typeof observeDatabase === 'function') {
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
      if (typeof observeCache === 'function') {
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
