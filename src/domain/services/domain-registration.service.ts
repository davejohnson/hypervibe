import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type {
  RegistrarDomainCandidate,
  RegistrarWorkflowStatus,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { getCloudflareAdapter } from './cloudflare-ops.service.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';

const OPERATION = 'cloudflareRegistrarRegistration';

interface DomainRegistrationBinding {
  provider?: string;
  accountId?: string;
  state?: string;
  completed?: boolean;
  links?: { self?: string; resource?: string };
  updatedAt?: string;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, '').toLowerCase();
}

function apexOf(domain: string): string {
  const parts = domain.split('.');
  return parts.length <= 2 ? domain : parts.slice(-2).join('.');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function summarizeRegistrarDomain(domain: RegistrarDomainCandidate) {
  return {
    name: domain.name,
    registrable: domain.registrable,
    tier: domain.tier ?? null,
    reason: domain.reason ?? null,
    pricing: domain.pricing
      ? {
        currency: domain.pricing.currency,
        registrationCost: domain.pricing.registration_cost,
        renewalCost: domain.pricing.renewal_cost,
      }
      : null,
  };
}

function registrationOptions(environmentSpec: EnvironmentSpec): Record<string, unknown> {
  const spec = environmentSpec.domainRegistration;
  return {
    years: spec?.years ?? 'default',
    autoRenew: spec?.autoRenew ?? false,
    privacyMode: spec?.privacyMode ?? 'redaction',
  };
}

function registrationBinding(environment: Environment | null, domain: string): DomainRegistrationBinding | null {
  const registrations = asRecord(environment?.platformBindings?.domainRegistrations);
  return asRecord(registrations?.[domain]) as DomainRegistrationBinding | null;
}

function registrationAction(params: {
  domain: string;
  accountId: string;
  type: 'create' | 'update';
  reason: string;
  candidate?: RegistrarDomainCandidate;
  binding?: DomainRegistrationBinding;
  environmentSpec: EnvironmentSpec;
}): PlanAction {
  return {
    id: `domain:${params.domain}:register`,
    type: params.type,
    resource: { kind: 'domain', name: params.domain, provider: 'cloudflare' },
    verified: true,
    reason: params.reason,
    ...(params.type === 'create' ? { billable: true, requiresConfirm: true } : {}),
    metadata: {
      operation: OPERATION,
      accountId: params.accountId,
      registration: registrationOptions(params.environmentSpec),
      ...(params.candidate ? { candidate: summarizeRegistrarDomain(params.candidate) } : {}),
      ...(params.binding ? { workflow: params.binding } : {}),
    },
  };
}

export function isCloudflareDomainRegistrationAction(action: PlanAction): boolean {
  return action.metadata?.operation === OPERATION;
}

export function addDomainRegistrationDependency(actions: PlanAction[], registrationActionId: string): PlanAction[] {
  return actions.map((action) => {
    if (action.id === registrationActionId || action.type === 'noop') {
      return action;
    }
    if (!['project', 'environment', 'service', 'domain'].includes(action.resource.kind)) {
      return action;
    }
    const dependsOn = Array.from(new Set([...(action.dependsOn ?? []), registrationActionId]));
    return { ...action, dependsOn };
  });
}

export async function planCloudflareDomainRegistration(params: {
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
}): Promise<{ action?: PlanAction; warnings: string[] }> {
  const { environmentSpec, environment } = params;
  const warnings: string[] = [];
  const registrationSpec = environmentSpec.domainRegistration;
  if (!registrationSpec?.register || !environmentSpec.domain) {
    return { warnings };
  }

  const domain = normalizeDomain(environmentSpec.domain);
  const adapterResult = getCloudflareAdapter(domain);
  if ('error' in adapterResult) {
    warnings.push(`Cannot plan Cloudflare Registrar for ${domain}: ${adapterResult.error}`);
    return { warnings };
  }
  const { adapter } = adapterResult;

  let accountId: string;
  try {
    accountId = await adapter.resolveAccountId(registrationSpec.accountId);
  } catch (error) {
    warnings.push(`Cannot plan Cloudflare Registrar for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }

  const binding = registrationBinding(environment, domain);
  try {
    const zone = (await adapter.findZoneByName(domain)) ?? (await adapter.findZoneByName(apexOf(domain)));
    if (zone) {
      return { warnings };
    }
  } catch (error) {
    warnings.push(`Cloudflare zone check failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }

  if (binding?.state && !binding.completed && binding.state !== 'failed') {
    return {
      action: registrationAction({
        domain,
        accountId: binding.accountId ?? accountId,
        type: 'update',
        reason: `Cloudflare registration workflow for ${domain} is ${binding.state}; apply will poll it before continuing.`,
        binding,
        environmentSpec,
      }),
      warnings,
    };
  }

  let candidate: RegistrarDomainCandidate | undefined;
  try {
    const checked = await adapter.checkRegistrarDomains(accountId, [domain]);
    candidate = checked.find((entry) => entry.name.toLowerCase() === domain) ?? checked[0];
  } catch (error) {
    warnings.push(`Cloudflare Registrar availability check failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }

  if (!candidate) {
    warnings.push(`Cloudflare did not return an availability result for ${domain}; domain registration cannot be planned.`);
    return { warnings };
  }
  if (!candidate.registrable) {
    warnings.push(`Cloudflare reports ${domain} is not registrable through the Registrar API${candidate.reason ? ` (${candidate.reason})` : ''}.`);
    return { warnings };
  }
  if (candidate.tier === 'premium') {
    warnings.push(`Cloudflare reports ${domain} is premium priced; Registrar API registration is not supported for premium domains.`);
    return { warnings };
  }

  const pricing = candidate.pricing
    ? ` (${candidate.pricing.currency} ${candidate.pricing.registration_cost} registration, ${candidate.pricing.renewal_cost} renewal)`
    : '';
  return {
    action: registrationAction({
      domain,
      accountId,
      type: 'create',
      reason: `Domain ${domain} is available for Cloudflare registration${pricing}. This is billable and successful registrations are non-refundable.`,
      candidate,
      environmentSpec,
    }),
    warnings,
  };
}

export async function applyCloudflareDomainRegistration(params: {
  project: Project;
  envName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{ success: boolean; message: string; error?: string; data?: Record<string, unknown> }> {
  const { project, envName, environmentSpec, action } = params;
  const domain = normalizeDomain(action.resource.name);
  const registrationSpec = environmentSpec.domainRegistration;
  if (!registrationSpec?.register) {
    return { success: true, message: `No registration requested for ${domain}` };
  }

  const adapterResult = getCloudflareAdapter(domain);
  if ('error' in adapterResult) {
    return { success: false, message: 'Cloudflare adapter unavailable', error: adapterResult.error };
  }
  const { adapter } = adapterResult;

  let accountId: string;
  try {
    accountId = await adapter.resolveAccountId(registrationSpec.accountId);
  } catch (error) {
    return {
      success: false,
      message: 'Cloudflare account could not be resolved',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, envName);
  const binding = registrationBinding(environment, domain);

  if (binding?.state && !binding.completed && binding.state !== 'failed') {
    try {
      const workflow = await adapter.getRegistrarRegistrationStatus(binding.accountId ?? accountId, domain);
      persistWorkflow(envRepo, project, envName, domain, binding.accountId ?? accountId, workflow);
      return workflow.state === 'succeeded'
        ? { success: true, message: `Cloudflare registration for ${domain} succeeded`, data: { workflow } }
        : {
          success: false,
          message: `Cloudflare registration for ${domain} is ${workflow.state}`,
          error: workflow.error?.message ?? `Registration workflow is ${workflow.state}; re-run hv_plan after it changes.`,
          data: { workflow },
        };
    } catch (error) {
      return {
        success: false,
        message: `Failed to poll Cloudflare registration for ${domain}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let candidate: RegistrarDomainCandidate | undefined;
  try {
    const checked = await adapter.checkRegistrarDomains(accountId, [domain]);
    candidate = checked.find((entry) => entry.name.toLowerCase() === domain) ?? checked[0];
  } catch (error) {
    return {
      success: false,
      message: `Cloudflare availability check failed for ${domain}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!candidate?.registrable) {
    return {
      success: false,
      message: `${domain} is not registrable through Cloudflare Registrar API`,
      error: candidate?.reason ?? 'No registrable availability result returned',
      data: candidate ? { candidate: summarizeRegistrarDomain(candidate) } : undefined,
    };
  }
  if (candidate.tier === 'premium') {
    return {
      success: false,
      message: `${domain} is premium priced`,
      error: 'Cloudflare Registrar API does not support premium domain registration.',
      data: { candidate: summarizeRegistrarDomain(candidate) },
    };
  }

  try {
    const workflow = await adapter.createRegistrarRegistration(accountId, {
      domainName: domain,
      ...(registrationSpec.autoRenew !== undefined ? { autoRenew: registrationSpec.autoRenew } : {}),
      ...(registrationSpec.privacyMode ? { privacyMode: registrationSpec.privacyMode } : {}),
      ...(registrationSpec.years !== undefined ? { years: registrationSpec.years } : {}),
    });
    persistWorkflow(envRepo, project, envName, domain, accountId, workflow);
    return workflow.state === 'succeeded'
      ? { success: true, message: `Cloudflare registration for ${domain} succeeded`, data: { workflow } }
      : {
        success: false,
        message: `Cloudflare registration for ${domain} started and is ${workflow.state}`,
        error: `Registration workflow is ${workflow.state}; re-run hv_plan after it completes.`,
        data: { workflow },
      };
  } catch (error) {
    return {
      success: false,
      message: `Cloudflare registration failed for ${domain}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function persistWorkflow(
  envRepo: EnvironmentRepository,
  project: Project,
  envName: string,
  domain: string,
  accountId: string,
  workflow: RegistrarWorkflowStatus
): void {
  const environment = envRepo.findByProjectAndName(project.id, envName)
    ?? envRepo.create({ projectId: project.id, name: envName });
  const existing = asRecord(environment.platformBindings.domainRegistrations) ?? {};
  envRepo.updatePlatformBindings(environment.id, {
    domainRegistrations: {
      ...existing,
      [domain]: {
        provider: 'cloudflare',
        accountId,
        state: workflow.state,
        completed: workflow.completed,
        links: workflow.links,
        updatedAt: workflow.updated_at,
      },
    },
  });
}
