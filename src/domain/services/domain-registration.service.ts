import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { cloudflareTokenKind } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type {
  RegistrarDomainCandidate,
  RegistrarWorkflowStatus,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { getCloudflareAdapter } from './cloudflare-ops.service.js';
import { cloudflareScopeHintsForDomain } from './domain-scope.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { CLOUDFLARE_TOKEN_URLS, connectionSetupUrl } from './connection-guidance.js';

const OPERATION = 'cloudflareRegistrarRegistration';

interface DomainRegistrationBinding {
  provider?: string;
  accountId?: string;
  state?: string;
  completed?: boolean;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function summarizeRegistrarDomain(domain: RegistrarDomainCandidate) {
  return {
    name: normalizeDomain(domain.name),
    registrable: domain.registrable,
    tier: domain.tier ?? null,
    reason: null,
    pricing: domain.pricing
      ? {
        currency: domain.pricing.currency,
        registrationCost: domain.pricing.registration_cost,
        renewalCost: domain.pricing.renewal_cost,
      }
      : null,
  };
}

function exactCandidate(checked: RegistrarDomainCandidate[], domain: string): RegistrarDomainCandidate | undefined {
  const matches = checked.filter(entry => typeof entry.name === 'string' && normalizeDomain(entry.name) === domain);
  return matches.length === 1 ? matches[0] : undefined;
}

function hasStandardQuote(candidate: RegistrarDomainCandidate): boolean {
  const price = candidate.pricing;
  return candidate.tier === 'standard' && !!price && /^[A-Z]{3}$/.test(price.currency)
    && /^\d+(?:\.\d+)?$/.test(price.registration_cost) && /^\d+(?:\.\d+)?$/.test(price.renewal_cost);
}

function registrationOptions(environmentSpec: EnvironmentSpec): Record<string, unknown> {
  const spec = environmentSpec.domainRegistration;
  return {
    years: spec?.years ?? 1,
    autoRenew: spec?.autoRenew ?? false,
    privacyMode: spec?.privacyMode ?? 'redaction',
  };
}

function safeState(value: unknown): string {
  return typeof value === 'string' && ['submitted', 'pending', 'in_progress', 'action_required', 'blocked', 'succeeded', 'failed'].includes(value)
    ? value : 'unknown';
}

function registrationBinding(environment: Environment | null, domain: string): DomainRegistrationBinding | null {
  const registrations = asRecord(environment?.platformBindings?.domainRegistrations);
  const binding = asRecord(registrations?.[domain]);
  return binding ? { provider: 'cloudflare', accountId: typeof binding.accountId === 'string' ? binding.accountId : undefined,
    state: safeState(binding.state), completed: binding.completed === true } : null;
}

export interface CloudflareRegistrarCredentialRequirement {
  reason: string;
  requiredCredentialKeys: Array<'apiToken' | 'accountId' | 'registrarApiToken'>;
}

/**
 * Return the value-free credential roles needed to replace a Cloudflare
 * connection without dropping the already-working DNS identity. Connection
 * adds replace the complete credential object, so a Registrar-only map is not
 * executable even though registrarApiToken is the newly missing role.
 */
export function cloudflareRegistrarCredentialRequirement(
  domain: string
): CloudflareRegistrarCredentialRequirement | null {
  const connection = new ConnectionRepository().findBestVerifiedMatchFromHints(
    'cloudflare',
    cloudflareScopeHintsForDomain(domain)
  );
  if (!connection) return null;

  const credentials = getSecretStore().decryptObject<{
    apiToken?: string;
    apiTokenKind?: 'user' | 'account' | 'unknown';
    accountId?: string;
    registrarApiToken?: string;
  }>(connection.credentialsEncrypted);
  const apiTokenIsAccountOwned = Boolean(credentials.apiToken) && (
    cloudflareTokenKind(credentials.apiToken!) === 'account'
    || credentials.apiTokenKind === 'account'
  );
  const requiredCredentialKeys: CloudflareRegistrarCredentialRequirement['requiredCredentialKeys'] = [
    'apiToken',
    ...(apiTokenIsAccountOwned && credentials.accountId?.trim() ? ['accountId' as const] : []),
    'registrarApiToken',
  ];
  const registrarToken = credentials.registrarApiToken?.trim();
  const registrarSetupUrl = connectionSetupUrl(CLOUDFLARE_TOKEN_URLS.user, { scope: domain, accountId: credentials.accountId });
  if (registrarToken) {
    if (cloudflareTokenKind(registrarToken) === 'account') {
      return {
        reason: `Cloudflare domain registration for ${domain} requires a Cloudflare User API Token (usually cfut_), but the stored registrarApiToken is an Account API Token (usually cfat_). Start from the pre-filled Hypervibe User API Token template at ${registrarSetupUrl}, narrow it to the target account/zone, and add Registrar write permissions before creating it. Then either use it as apiToken/CLOUDFLARE_API_TOKEN for a single-token setup, or keep the Account API Token as apiToken and store the User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN.`,
        requiredCredentialKeys,
      };
    }
    return null;
  }

  if (apiTokenIsAccountOwned) {
    return {
      reason: `Cloudflare domain registration for ${domain} cannot use the stored apiToken because it is an Account API Token (usually cfat_). Account API Tokens are correct for durable DNS/custom-domain/email automation, but Cloudflare Registrar requires a User API Token (usually cfut_). Start from the pre-filled Hypervibe User API Token template at ${registrarSetupUrl}, narrow it to the target account/zone, and add Registrar write permissions before creating it. Then either use it as apiToken/CLOUDFLARE_API_TOKEN for a single-token setup, or keep the Account API Token as apiToken and store the User API Token as registrarApiToken/CLOUDFLARE_REGISTRAR_API_TOKEN.`,
      requiredCredentialKeys,
    };
  }

  return null;
}

export function cloudflareRegistrarCredentialProblem(domain: string): string | null {
  return cloudflareRegistrarCredentialRequirement(domain)?.reason ?? null;
}

function workflowActionResult(domain: string, workflow: RegistrarWorkflowStatus, action: 'started' | 'polled'): ActionResult {
  const state = safeState(workflow.state);
  const data = { workflow: { state, completed: workflow.completed === true } };
  if (state === 'succeeded' && workflow.completed === true) {
    return { success: true, message: `Cloudflare registration for ${domain} succeeded`, data };
  }
  if (state === 'failed') {
    return {
      success: false,
      message: `Cloudflare registration for ${domain} failed`,
      error: `Registration workflow reached terminal state ${state}.`,
      data,
    };
  }
  if (state === 'action_required') {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration for ${domain} requires user action`,
      error: 'Cloudflare paused the registration workflow and requires user action before Hypervibe can continue.',
      data,
    };
  }

  const verb = action === 'started' ? 'started and is' : 'is';
  const extra = state === 'blocked'
    ? 'Cloudflare says progress is blocked by a third party such as the registry; re-run hv_plan/hv_apply later to poll it.'
    : 'Re-run hv_plan/hv_apply later to poll it.';
  return {
    success: false,
    status: 'pending',
    message: `Cloudflare registration for ${domain} ${verb} ${state}. ${extra}`,
    data,
  };
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
  } catch {
    warnings.push(`Cannot resolve the Cloudflare registrar account for ${domain}. Check the verified registrar connection.`);
    return { warnings };
  }

  const binding = registrationBinding(environment, domain);
  if (binding && binding.accountId !== accountId) {
    return { warnings: [`The registration for ${domain} belongs to a different or unknown Cloudflare account. Check the registrar connection before continuing.`] };
  }
  if (binding?.completed && binding.state === 'succeeded') {
    return { warnings };
  }
  if (binding && !(binding.state === 'failed' && binding.completed === true)) {
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
    candidate = exactCandidate(checked, domain);
  } catch {
    warnings.push(`Cloudflare could not confirm availability for ${domain}. Check the verified registrar connection and try again.`);
    return { warnings };
  }

  if (!candidate) {
    warnings.push(`Cloudflare did not return an availability result for ${domain}; domain registration cannot be planned.`);
    return { warnings };
  }
  if (candidate.registrable !== true) {
    warnings.push(`Cloudflare reports ${domain} is not registrable through the Registrar API.`);
    return { warnings };
  }
  if (candidate.tier === 'premium') {
    warnings.push(`Cloudflare reports ${domain} is premium priced; Registrar API registration is not supported for premium domains.`);
    return { warnings };
  }

  if (!hasStandardQuote(candidate)) {
    return { warnings: [`Cloudflare did not return complete standard registration and renewal prices for ${domain}. Check again before purchasing.`] };
  }
  const price = candidate.pricing!;
  const years = registrationSpec.years ?? 1;
  const renewal = registrationSpec.autoRenew ? 'on' : 'off';
  // Cloudflare quotes the first year and each further year separately.
  const terms = `${years} ${years === 1 ? 'year' : 'years'}, ${price.currency} ${price.registration_cost} for year one and ${price.currency} ${price.renewal_cost} per additional year or annual renewal`;
  return {
    action: registrationAction({
      domain,
      accountId,
      type: 'create',
      reason: `Register ${domain} on Cloudflare account ${accountId} for ${terms}, auto-renew ${renewal}, privacy ${registrationSpec.privacyMode ?? 'redaction'}. Successful purchases are non-refundable.`,
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
}): Promise<ActionResult> {
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
  } catch {
    return {
      success: false,
      message: 'Cloudflare account could not be resolved',
      error: 'The registrar could not confirm the requested information. Check the connection and retry the status read.',
    };
  }

  const envRepo = new EnvironmentRepository();
  const environment = envRepo.findByProjectAndName(project.id, envName);
  const binding = registrationBinding(environment, domain);
  const plannedAccountId = typeof action.metadata?.accountId === 'string'
    ? action.metadata.accountId
    : undefined;
  if (!plannedAccountId || plannedAccountId !== accountId || (binding && binding.accountId !== accountId)) {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration action for ${domain} has stale account authority`,
      error: `The reviewed account is ${plannedAccountId ?? 'missing'}, but the current registration target is ${accountId}. Re-run hv_plan.`,
    };
  }

  if (binding?.completed && binding.state === 'succeeded') {
    return { success: true, message: `The registration for ${domain} already completed.` };
  }
  if (binding && !(binding.state === 'failed' && binding.completed === true)) {
    try {
      const workflow = await adapter.getRegistrarRegistrationStatus(accountId, domain);
      persistWorkflow(envRepo, project, envName, domain, accountId, workflow);
      return workflowActionResult(domain, workflow, 'polled');
    } catch {
      return {
        success: false,
        message: `Failed to poll Cloudflare registration for ${domain}`,
        error: 'The registrar could not confirm the requested information. Check the connection and retry the status read.',
      };
    }
  }

  if (action.type !== 'create' || !action.requiresConfirm || !action.billable) {
    return { success: false, status: 'blocked', message: 'This status check cannot start a registration. Run hv_plan to review current terms.' };
  }

  let candidate: RegistrarDomainCandidate | undefined;
  try {
    const checked = await adapter.checkRegistrarDomains(accountId, [domain]);
    candidate = exactCandidate(checked, domain);
  } catch {
    return {
      success: false,
      message: `Cloudflare availability check failed for ${domain}`,
      error: 'The registrar could not confirm the requested information. Check the connection and retry the status read.',
    };
  }
  if (candidate?.registrable !== true) {
    return {
      success: false,
      message: `${domain} is not registrable through Cloudflare Registrar API`,
      error: 'No registrable availability result returned',

    };
  }
  if (candidate.tier === 'premium') {
    return {
      success: false,
      message: `${domain} is premium priced`,
      error: 'Cloudflare Registrar API does not support premium domain registration.',
    };
  }

  const reviewedCandidate = asRecord(action.metadata?.candidate);
  const reviewedRegistration = asRecord(action.metadata?.registration);
  const currentCandidate = summarizeRegistrarDomain(candidate);
  const currentRegistration = registrationOptions(environmentSpec);
  if (
    !hasStandardQuote(candidate)
    || !reviewedCandidate
    || !reviewedRegistration
    || JSON.stringify(reviewedCandidate) !== JSON.stringify(currentCandidate)
    || JSON.stringify(reviewedRegistration) !== JSON.stringify(currentRegistration)
  ) {
    return {
      success: false,
      status: 'blocked',
      message: `Cloudflare registration terms for ${domain} changed after planning`,
      error: 'Availability, pricing, tier, or registration options no longer match the explicitly confirmed plan. Re-run hv_plan and review the new billable action.',
      ...(hasStandardQuote(candidate) ? { data: { candidate: currentCandidate } } : {}),
    };
  }

  // Save the attempt before the billable POST. A lost acknowledgement must only
  // lead to a status read for this account and domain, even after a restart.
  const target = environment ?? envRepo.create({ projectId: project.id, name: envName });
  const registrations = asRecord(target.platformBindings.domainRegistrations) ?? {};
  const submitted = { ...target.platformBindings, domainRegistrations: {
    ...registrations, [domain]: { provider: 'cloudflare', accountId, state: 'submitted', completed: false },
  } };
  if (!envRepo.replacePlatformBindingsIfUnchanged(target, submitted)) {
    return { success: false, status: 'blocked', message: 'The environment changed while preparing the purchase. Run hv_plan again.' };
  }
  try {
    envRepo.syncRepoBindingsForId(target.id);
  } catch {
    // This process has not dispatched the purchase. Undo only its exact local write.
    const restored = envRepo.replacePlatformBindingsIfUnchanged({ ...target, platformBindings: submitted }, target.platformBindings);
    return { success: false, status: 'blocked', message: restored
      ? 'The purchase was not sent because the registration record could not be saved. Restore access to repository bindings and review a new plan.'
      : 'The purchase was not sent by this attempt. The registration record changed. Reconcile its current status before continuing.' };
  }
  try {
    const workflow = await adapter.createRegistrarRegistration(accountId, {
      domainName: domain,
      autoRenew: registrationSpec.autoRenew ?? false,
      privacyMode: registrationSpec.privacyMode ?? 'redaction',
      years: registrationSpec.years ?? 1,
    });
    persistWorkflow(envRepo, project, envName, domain, accountId, workflow);
    return workflowActionResult(domain, workflow, 'started');
  } catch {
    return {
      success: false, status: 'pending',
      message: `The registration outcome for ${domain} is unknown. Run hv_plan and hv_apply to check the existing request.`,
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
        state: safeState(workflow.state),
        completed: workflow.completed === true,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}
