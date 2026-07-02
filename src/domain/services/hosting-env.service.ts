import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import type { Receipt } from '../ports/provider.port.js';
import { adapterFactory } from './adapter.factory.js';

type PlatformBindings = {
  provider?: string;
  projectId?: string;
  environmentId?: string;
  services?: Record<string, {
    serviceId?: string;
    jobName?: string;
  }>;
};

type EnvReadableHostingAdapter = IHostingAdapter & {
  getServiceVariables?: (
    environmentOrProjectId: Environment | string,
    serviceNameOrServiceId: string,
    environmentId?: string
  ) => Promise<Record<string, string>>;
};

export function hostingProviderForEnvironment(project: Project, environment: Environment): string {
  const bindings = environment.platformBindings as PlatformBindings;
  if (bindings.provider) return bindings.provider.toLowerCase();
  return project.defaultPlatform?.toLowerCase() || 'cloudrun';
}

export function providerDisplayName(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'cloudrun':
      return 'Cloud Run';
    case 'railway':
      return 'Railway';
    default:
      return provider;
  }
}

export function serviceHasHostingBinding(environment: Environment, serviceName: string): boolean {
  const bindings = environment.platformBindings as PlatformBindings;
  const serviceBinding = bindings.services?.[serviceName];
  return Boolean(serviceBinding?.serviceId || serviceBinding?.jobName);
}

export async function syncHostingEnvVars(params: {
  project: Project;
  environment: Environment;
  service: Service;
  vars: Record<string, string>;
}): Promise<Receipt & { provider?: string }> {
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);

  if (!serviceHasHostingBinding(params.environment, params.service.name)) {
    return {
      success: false,
      message: `${params.service.name} is not deployed to ${displayName} in ${params.environment.name}`,
      error: `Service ${params.service.name} is not bound in environment ${params.environment.name}`,
      provider,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      message: `No ${displayName} hosting adapter available`,
      error: adapterResult.error || `No ${provider} hosting adapter available`,
      provider,
    };
  }

  const adapter = adapterResult.adapter as unknown as Partial<IHostingAdapter>;
  if (typeof adapter.setEnvVars !== 'function') {
    return {
      success: false,
      message: `${displayName} does not support environment variable sync`,
      error: `${provider} adapter does not implement setEnvVars`,
      provider,
    };
  }

  const receipt = await adapter.setEnvVars(params.environment, params.service, params.vars);
  return {
    ...receipt,
    provider,
    data: {
      ...(receipt.data ?? {}),
      provider,
      service: params.service.name,
      variableCount: Object.keys(params.vars).length,
    },
  };
}

export async function readHostingEnvVars(params: {
  project: Project;
  environment: Environment;
  service: Service;
}): Promise<{ success: true; provider: string; variables: Record<string, string> } | { success: false; provider: string; error: string }> {
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);
  const bindings = params.environment.platformBindings as PlatformBindings;

  if (!serviceHasHostingBinding(params.environment, params.service.name)) {
    return {
      success: false,
      provider,
      error: `Service ${params.service.name} is not deployed to ${displayName} in ${params.environment.name}`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      provider,
      error: adapterResult.error || `No ${provider} hosting adapter available`,
    };
  }

  const adapter = adapterResult.adapter as unknown as EnvReadableHostingAdapter;
  if (typeof adapter.getServiceVariables !== 'function') {
    return {
      success: false,
      provider,
      error: `${displayName} env var reads are not supported by this adapter version`,
    };
  }

  if (provider === 'railway') {
    const projectId = bindings.projectId;
    const environmentId = bindings.environmentId;
    const serviceId = bindings.services?.[params.service.name]?.serviceId;
    if (!projectId || !environmentId || !serviceId) {
      return {
        success: false,
        provider,
        error: `Service ${params.service.name} is missing Railway bindings in ${params.environment.name}`,
      };
    }
    return {
      success: true,
      provider,
      variables: await adapter.getServiceVariables(projectId, serviceId, environmentId),
    };
  }

  return {
    success: true,
    provider,
    variables: await adapter.getServiceVariables(params.environment, params.service.name),
  };
}
