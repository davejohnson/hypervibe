import type { CommandContext } from './context.js';
import { commandError, commandSuccess, type CommandEnvelope } from './results.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { inspectProvider } from './inspect-provider.js';

export interface ImportProviderInput {
  provider: string;
  mode?: 'adopt' | 'retained-cleanup';
  project?: string;
  env?: string;
  region?: string;
  name?: string;
  id?: string;
  force?: boolean;
  environmentMappings?: Record<string, string>;
  storageMappings?: Record<string, string>;
  databaseMappings?: Record<string, 'postgres'>;
  cacheMappings?: Record<string, 'redis'>;
  confirm?: boolean;
}

export type ProviderImportDriver = (
  ctx: CommandContext,
  input: ImportProviderInput
) => Promise<CommandEnvelope>;

const importDrivers = new Map<string, ProviderImportDriver>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function retainHostingCleanup(
  ctx: CommandContext,
  input: ImportProviderInput,
  provider: string
): Promise<CommandEnvelope> {
  if (!input.project || !input.env) {
    return commandError('VALIDATION', 'retained-cleanup requires the current Hypervibe project and environment.', {
      hint: 'Pass project and env exactly as used by hv_inspect.',
      next: ['hv_inspect', 'hv_import'],
    });
  }
  if (!providerRegistry.supports(provider, 'hosting')) {
    return commandError('UNSUPPORTED', `${provider} is not a hosting provider and cannot be retained for hosting cleanup.`);
  }
  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const environment = ctx.resolveEnvironmentOrThrow(project, input.env);
  const currentBindings = record(environment.platformBindings) ?? {};
  const currentProvider = stringValue(currentBindings.provider);
  if (!currentProvider || currentProvider === provider) {
    return commandError('VALIDATION', currentProvider
      ? `${provider} is the current hosting provider; use desired-state plan/apply instead of retained cleanup.`
      : `Environment "${environment.name}" has no current hosting-provider binding.`);
  }
  if (record(currentBindings.previousHosting)) {
    return commandError('VALIDATION', 'A previous hosting-provider cleanup binding is already retained.', {
      details: { previousHosting: currentBindings.previousHosting },
      hint: 'Finish or explicitly resolve the existing retained cleanup before recording another provider.',
      next: ['hv_plan'],
    });
  }

  const forensic = await inspectProvider(ctx, {
    provider,
    project: project.name,
    env: environment.name,
    resource: 'environment',
    region: input.region,
    limit: 100,
  });
  const inspected = record(forensic.inspected);
  if (!inspected || inspected.observation !== 'present') {
    return commandError('NOT_FOUND', `No abandoned ${provider} environment resources were verified for ${project.name}/${environment.name}.`, {
      details: forensic,
      next: ['hv_inspect'],
    });
  }
  if (inspected.partial === true) {
    return commandError('PROVIDER_ERROR', `${provider} returned a partial environment inventory; cleanup identity was not retained.`, {
      details: inspected,
      hint: 'Resolve the provider read failure and rerun hv_inspect before importing cleanup identity.',
      next: ['hv_inspect'],
    });
  }
  const cleanupBoundary = providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.teardownBoundary;
  if (!cleanupBoundary) {
    return commandError('UNSUPPORTED', `${provider} does not declare a complete hosting teardown boundary.`);
  }
  if (cleanupBoundary === 'project' && inspected.managedByHypervibe === false) {
    return commandError('VALIDATION', `${provider} reported that the matched project boundary is not Hypervibe-managed.`, {
      details: inspected,
      hint: 'Hypervibe will not retain an unowned project as a deletion target.',
    });
  }

  const inspectedProject = record(inspected.project);
  const inspectedEnvironment = record(inspected.environment);
  const projectId = stringValue(inspectedProject?.id);
  const environmentId = stringValue(inspectedEnvironment?.id) ?? stringValue(inspectedEnvironment?.region);
  if (!projectId || (cleanupBoundary === 'environment' && !environmentId)) {
    return commandError('PROVIDER_ERROR', `${provider} did not return the durable ${cleanupBoundary} identity required for cleanup.`, {
      details: inspected,
      next: ['hv_inspect'],
    });
  }

  const services: Record<string, Record<string, string>> = {};
  for (const rawService of Array.isArray(inspected.services) ? inspected.services : []) {
    const service = record(rawService);
    const name = stringValue(service?.name);
    const serviceId = stringValue(service?.id);
    if (!name || !serviceId) {
      return commandError('PROVIDER_ERROR', `${provider} returned a service without a durable name and id.`, {
        details: { service: rawService },
      });
    }
    if (services[name]) {
      return commandError('VALIDATION', `${provider} returned multiple cleanup resources named "${name}".`, {
        hint: 'Resolve the ambiguous provider identity before retaining cleanup state.',
        next: ['hv_inspect'],
      });
    }
    if (service?.managedByHypervibe === false) {
      return commandError('VALIDATION', `${provider} reported that service "${name}" is not Hypervibe-managed.`, {
        hint: 'Hypervibe will not retain an unowned service as a deletion target.',
      });
    }
    services[name] = {
      serviceId,
      ...(['jobName', 'schedulerJobName', 'resourceType'] as const).reduce<Record<string, string>>((fields, key) => {
        const value = stringValue(service?.[key]);
        return value ? { ...fields, [key]: value } : fields;
      }, {}),
    };
  }
  if (cleanupBoundary === 'services' && Object.keys(services).length === 0) {
    return commandError('NOT_FOUND', `${provider} returned no managed services to retain for cleanup.`, {
      details: inspected,
      next: ['hv_inspect'],
    });
  }

  const previousHosting = {
    provider,
    projectId,
    ...(environmentId ? { environmentId } : {}),
    services,
  };
  if (!input.confirm) {
    return commandError('CONFIRM_REQUIRED', `This will retain the inspected ${provider} ${cleanupBoundary} as the exact deletion target for ${project.name}/${environment.name}. No provider resource will be changed yet.`, {
      details: { previousHosting, cleanupBoundary },
      hint: 'Re-run hv_import with confirm=true, then review the confirm-gated destroy actions from hv_plan.',
      next: ['hv_import'],
    });
  }

  ctx.repos.environments.updatePlatformBindings(environment.id, { previousHosting });
  ctx.repos.audit.create({
    action: 'hosting.previous.retained',
    resourceType: 'environment',
    resourceId: environment.id,
    details: { project: project.name, environment: environment.name, provider, cleanupBoundary },
  });
  return commandSuccess({
    retainedCleanup: {
      provider,
      project: project.name,
      environment: environment.name,
      cleanupBoundary,
      serviceCount: Object.keys(services).length,
    },
  }, {
    hint: 'Run hv_plan for this environment and explicitly confirm only the reviewed previous-provider destroy actions after the current deployment is healthy.',
    next: ['hv_plan'],
  });
}

export function registerProviderImport(provider: string, driver: ProviderImportDriver): void {
  if (importDrivers.has(provider)) throw new Error(`Provider import driver already registered: ${provider}`);
  importDrivers.set(provider, driver);
}

export async function importProvider(
  ctx: CommandContext,
  input: ImportProviderInput
): Promise<CommandEnvelope> {
  const provider = input.provider.trim().toLowerCase();
  const registered = providerRegistry.get(provider);
  if (!registered) {
    return commandError('VALIDATION', `Unknown provider "${input.provider}".`, {
      details: { providers: providerRegistry.names() },
      hint: 'Use hv_inspect without provider to list registered providers.',
      next: ['hv_inspect'],
    });
  }
  if (input.mode === 'retained-cleanup') {
    return retainHostingCleanup(ctx, input, provider);
  }
  const driver = importDrivers.get(provider);
  if (!registered.adoption?.project || !driver) {
    return commandError('UNSUPPORTED', `${registered.metadata.displayName} does not yet expose a tested project adoption driver.`, {
      details: { importProviders: [...importDrivers.keys()] },
      hint: 'Use hv_inspect for read-only provider state. Do not adopt by editing bindings manually.',
      next: ['hv_inspect'],
    });
  }
  if (!input.name && !input.id) {
    return commandError('VALIDATION', 'hv_import is adoption-only and requires name or id.', {
      hint: `Use hv_inspect provider="${provider}" to list/read provider projects. Use hv_import only when adopting a selected provider project into Hypervibe.`,
      next: ['hv_inspect'],
    });
  }
  return driver(ctx, { ...input, provider });
}
