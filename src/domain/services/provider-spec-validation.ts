import type { ProjectSpec } from '../spec/spec.schema.js';
import {
  providerRegistry,
  type ProviderLifecycleCapability,
} from '../registry/provider.registry.js';
import { devOpsProviderRegistry } from '../registry/devops.registry.js';

export interface ProviderSpecIssue {
  environment: string;
  field: 'hosting.provider' | 'database.provider' | 'database.engine' | 'cache.provider' | 'cache.engine' | 'devops.code.provider' | 'devops.ci.provider';
  provider: string;
  engine?: string;
  capability: ProviderLifecycleCapability | 'code-host' | 'ci';
  available: string[];
}

/**
 * Validate installed provider capabilities after structural Zod parsing.
 * Keeping registry lookup out of the schema lets vendor modules self-register
 * without editing a central enum while still rejecting specs that cannot be
 * executed by this Hypervibe installation.
 */
export function validateProjectSpecProviders(spec: ProjectSpec): ProviderSpecIssue[] {
  const issues: ProviderSpecIssue[] = [];
  if (spec.devops && !devOpsProviderRegistry.codeHost(spec.devops.code.provider)) {
    issues.push({
      environment: 'project',
      field: 'devops.code.provider',
      provider: spec.devops.code.provider,
      capability: 'code-host',
      available: devOpsProviderRegistry.codeHostIds(),
    });
  }
  if (spec.devops?.ci && !devOpsProviderRegistry.ciProvider(spec.devops.ci.provider)) {
    issues.push({
      environment: 'project',
      field: 'devops.ci.provider',
      provider: spec.devops.ci.provider,
      capability: 'ci',
      available: devOpsProviderRegistry.ciProviderIds(),
    });
  } else if (
    spec.devops?.ci
    && !devOpsProviderRegistry.compatible(spec.devops.code.provider, spec.devops.ci.provider)
  ) {
    issues.push({
      environment: 'project',
      field: 'devops.ci.provider',
      provider: spec.devops.ci.provider,
      capability: 'ci',
      available: devOpsProviderRegistry.ciProviderIds()
        .filter((provider) => devOpsProviderRegistry.compatible(spec.devops!.code.provider, provider)),
    });
  }
  for (const [environment, environmentSpec] of Object.entries(spec.environments)) {
    if (!providerRegistry.supports(environmentSpec.hosting.provider, 'hosting')) {
      issues.push({
        environment,
        field: 'hosting.provider',
        provider: environmentSpec.hosting.provider,
        capability: 'hosting',
        available: providerRegistry.namesFor('hosting'),
      });
    }
    if (
      environmentSpec.database
      && !providerRegistry.supports(environmentSpec.database.provider, 'database')
    ) {
      issues.push({
        environment,
        field: 'database.provider',
        provider: environmentSpec.database.provider,
        capability: 'database',
        available: providerRegistry.namesFor('database'),
      });
    } else if (
      environmentSpec.database
      && !providerRegistry.supportsEngine(
        environmentSpec.database.provider,
        'database',
        environmentSpec.database.engine
      )
    ) {
      issues.push({
        environment,
        field: 'database.engine',
        provider: environmentSpec.database.provider,
        engine: environmentSpec.database.engine,
        capability: 'database',
        available: providerRegistry.getMetadata(environmentSpec.database.provider)
          ?.lifecycle?.databaseEngines ?? [],
      });
    }
    if (
      environmentSpec.cache
      && !providerRegistry.supports(environmentSpec.cache.provider, 'cache')
    ) {
      issues.push({
        environment,
        field: 'cache.provider',
        provider: environmentSpec.cache.provider,
        capability: 'cache',
        available: providerRegistry.namesFor('cache'),
      });
    } else if (
      environmentSpec.cache
      && !providerRegistry.supportsEngine(
        environmentSpec.cache.provider,
        'cache',
        environmentSpec.cache.engine
      )
    ) {
      issues.push({
        environment,
        field: 'cache.engine',
        provider: environmentSpec.cache.provider,
        engine: environmentSpec.cache.engine,
        capability: 'cache',
        available: providerRegistry.getMetadata(environmentSpec.cache.provider)
          ?.lifecycle?.cacheEngines ?? [],
      });
    }
  }
  return issues;
}
