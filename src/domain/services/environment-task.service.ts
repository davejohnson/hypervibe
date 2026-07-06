import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';
import { adapterFactory } from './adapter.factory.js';
import {
  hostingProviderForEnvironment,
  providerDisplayName,
  serviceHasHostingBinding,
} from './hosting-env.service.js';

const serviceRepo = new ServiceRepository();

export type EnvironmentTaskResult =
  | {
    success: true;
    provider: string;
    service: string;
    command: string;
    jobId: string;
    status: 'completed';
    output?: string;
    receipt: Record<string, unknown>;
  }
  | {
    success: false;
    provider?: string;
    service?: string;
    command: string;
    error: string;
    status?: string;
    output?: string;
    receipt?: Record<string, unknown>;
  };

function preferredTaskService(services: Service[], serviceName?: string): Service | null {
  if (serviceName) {
    return services.find((service) => service.name === serviceName) ?? null;
  }
  return services.find((service) => service.buildConfig.workloadKind === 'web')
    ?? services.find((service) => service.buildConfig.workloadKind !== 'cron')
    ?? services[0]
    ?? null;
}

/**
 * Run a one-off command inside a deployed workload's hosting environment.
 * This is the provider-neutral primitive for tasks that need app image +
 * provider env vars, such as fresh-environment database seeding.
 */
export async function runEnvironmentTask(params: {
  project: Project;
  environment: Environment;
  command: string;
  serviceName?: string;
  purpose?: string;
}): Promise<EnvironmentTaskResult> {
  const command = params.command.trim();
  if (!command) {
    return { success: false, command, error: 'Command is required.' };
  }

  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const displayName = providerDisplayName(provider);
  const services = serviceRepo.findByProjectId(params.project.id);
  const service = preferredTaskService(services, params.serviceName);
  if (!service) {
    return {
      success: false,
      provider,
      command,
      error: params.serviceName
        ? `Service ${params.serviceName} is not tracked locally.`
        : 'No service is tracked locally to run the environment task.',
    };
  }

  if (!serviceHasHostingBinding(params.environment, service.name)) {
    return {
      success: false,
      provider,
      service: service.name,
      command,
      error: `Service ${service.name} is not deployed to ${displayName} in ${params.environment.name}. Apply service convergence first.`,
    };
  }

  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return {
      success: false,
      provider,
      service: service.name,
      command,
      error: adapterResult.error || `No ${displayName} hosting adapter available.`,
    };
  }

  const adapter = adapterResult.adapter as unknown as Partial<IHostingAdapter>;
  if (typeof adapter.runJob !== 'function') {
    return {
      success: false,
      provider,
      service: service.name,
      command,
      error: `${displayName} does not support one-off environment tasks through Hypervibe yet.`,
    };
  }

  const job = await adapter.runJob(params.environment, service, command);
  const receipt = job.receipt as unknown as Record<string, unknown>;
  if (!job.receipt.success || job.status === 'failed') {
    return {
      success: false,
      provider,
      service: service.name,
      command,
      status: job.status,
      output: job.output,
      receipt,
      error: job.receipt.error || job.receipt.message || `${params.purpose ?? 'Environment task'} failed.`,
    };
  }

  if (job.status !== 'completed') {
    return {
      success: false,
      provider,
      service: service.name,
      command,
      status: job.status,
      output: job.output,
      receipt,
      error: `${displayName} started the ${params.purpose ?? 'environment task'} but did not report successful completion. Refusing to mark it complete.`,
    };
  }

  return {
    success: true,
    provider,
    service: service.name,
    command,
    jobId: job.jobId,
    status: 'completed',
    output: job.output,
    receipt,
  };
}
