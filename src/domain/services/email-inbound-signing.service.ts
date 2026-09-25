import type { SendGridAdapter, SendGridInboundParseWebhook, SendGridInboundSecurityPolicy } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { SENDGRID_INBOUND_PUBLIC_KEY, type EnvironmentSpec } from '../spec/spec.schema.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import { observeHosting, runtimeKey, type EventSigningReadiness } from './email-signing.service.js';
import { serviceBindingFor } from './spec.service.js';
import { syncHostingEnvVars } from './hosting-env.service.js';
import { parseRuntimeRolloutBindings } from './runtime-rollout.service.js';

export const INBOUND_SIGNING_KEY_OPERATION = 'emailInboundVerificationKey';
const actionId = 'email:sendgrid:inbound-key';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type InboundSigningState = { status: 'known'; route: SendGridInboundParseWebhook; policy: SendGridInboundSecurityPolicy } | { status: 'unknown' };
export function inboundSigningBinding(environment: Environment | null): Record<string, unknown> {
  return record(record(environment?.platformBindings.email).inboundSigning);
}
function hostingIdentity(environment: Environment | null, service: string | undefined): string {
  const binding = parseHostingBindings(environment);
  const target = service ? binding.services?.[service] : undefined;
  // Deployments may change image/source/helper metadata without moving the key's
  // destination. Keep this separate from existing delivery bindings' legacy hash.
  return hashEnvValue(JSON.stringify({environment: environment?.id, project: environment?.projectId, provider: binding.provider,
    projectId: binding.projectId, environmentId: binding.environmentId,
    scope: Object.entries(binding.providerScope ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    service, serviceId: target?.serviceId, jobName: target?.jobName, url: target?.url}));
}
function expectedUrl(environment: Environment | null, spec: EnvironmentSpec): string | undefined {
  const target = spec.email.inbound;
  const base = environment && target ? serviceBindingFor(environment, target.service)?.url : undefined;
  try {
    const url = new URL(target!.path, String(base));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Missing association/signature fields are unknown, never evidence of an unsigned route. */
export async function observeInboundSigning(adapter: SendGridAdapter, hostname: string): Promise<InboundSigningState> {
  try {
    const route = await adapter.getInboundParseWebhook(hostname);
    if (!route.security_policy) return { status: 'unknown' };
    const policy = await adapter.getInboundParseSecurityPolicy(route.security_policy);
    return { status: 'known', route, policy };
  } catch { return { status: 'unknown' }; }
}
export function inboundSigningFingerprint(state?: InboundSigningState): unknown {
  return state?.status === 'known' ? { status: 'known', route: state.route,
    policyId: state.policy.id, keyHash: hashEnvValue(state.policy.publicKey), hasOAuth: state.policy.hasOAuth } : state;
}

/** Run before ordinary route actions so a later blocker cannot permit an earlier target move. */
export function inboundSigningTargetBlock(environment: Environment | null, spec: EnvironmentSpec): string | undefined {
  const binding = inboundSigningBinding(environment);
  if (!Object.keys(binding).length) return undefined;
  const target = spec.email.inbound;
  if (!target || target.signatureVerification !== true) return 'Restore inbound signatureVerification=true. Policy detachment and managed-key retirement are not yet supported by a verified provider contract.';
  if (binding.hostname !== target.hostname.toLowerCase() || binding.service !== target.service
    || binding.hostingHash !== hostingIdentity(environment, target.service)) return 'The managed inbound signing target changed. Restore its hostname and hosting identity; automatic policy migration is not supported.';
  return undefined;
}

export function planInboundSigning(params: {
  spec: EnvironmentSpec; environment: Environment | null; observed: ObservedState | null;
  state?: InboundSigningState; routeReady: boolean;
}): { actions: PlanAction[]; readiness?: EventSigningReadiness } {
  const target = params.spec.email.inbound;
  const binding = inboundSigningBinding(params.environment);
  if (target?.signatureVerification === undefined && !Object.keys(binding).length) return { actions: [] };
  const live = params.state?.status === 'known' ? params.state : undefined;
  const url = expectedUrl(params.environment, params.spec);
  const runtime = target ? runtimeKey(params.observed, target.service, params.environment, SENDGRID_INBOUND_PUBLIC_KEY) : { known: false };
  const keyHash = live ? hashEnvValue(live.policy.publicKey) : undefined;
  const blockedReason = inboundSigningTargetBlock(params.environment, params.spec)
    ?? (target?.signatureVerification !== true ? 'Disabling or detaching Inbound Parse policies is not supported by a verified provider contract; existing policy and runtime keys are preserved.'
      : !params.routeReady ? 'Converge the exact Inbound Parse route, then re-plan its verification key.'
      : !url ? 'The receiving service needs a durable HTTPS URL.'
      : !live || live.route.url !== url ? 'An attached signed policy could not be verified. Missing security fields remain unknown; automatic policy creation or attachment is not supported.'
      : binding.policyId && binding.policyId !== live.policy.id ? 'The managed inbound security policy changed. Restore the reviewed attachment before publishing a key.'
      : binding.status === 'pending' && binding.keyHash !== keyHash ? 'The provider key changed while publication was pending. Restore the reviewed key before reconciling its write.'
      : !runtime.known ? 'The receiving service verification-key observation is unknown; preserve existing configuration.' : undefined);
  const matching = runtime.known && runtime.hash === keyHash;
  const bindingMatches = live && binding.status === 'configured' && binding.policyId === live.policy.id && binding.keyHash === keyHash
    && binding.hostname === target?.hostname.toLowerCase() && binding.service === target?.service
    && binding.hostingHash === hostingIdentity(params.environment, target?.service);
  const noop = !blockedReason && matching && Boolean(bindingMatches)
    && !missingRolloutReceipt(binding, params.environment, params.observed, target!.service, params.spec.hosting.provider);
  return {
    actions: [{ id: actionId, type: noop ? 'noop' : 'update', resource: {kind: 'email', name: 'inbound-key', provider: params.spec.hosting.provider},
      reason: noop ? 'Inbound Parse verification-key configuration is in sync' : 'Adopt the observed signed policy and publish its public key to the receiving service',
      ...(target ? {dependsOn: [`email:sendgrid:inbound:${target.hostname.toLowerCase()}`]} : {}),
      verified: !blockedReason, ...(!noop ? {requiresConfirm: true} : {}),
      metadata: {operation: INBOUND_SIGNING_KEY_OPERATION, environmentId: params.environment?.id, hostname: target?.hostname.toLowerCase(), service: target?.service,
        hostingHash: hostingIdentity(params.environment, target?.service), expectedUrl: url, key: SENDGRID_INBOUND_PUBLIC_KEY,
        policyId: live?.policy.id, expectedHash: keyHash, stateHash: live ? hashEnvValue(JSON.stringify(inboundSigningFingerprint(live))) : undefined,
        ...(blockedReason ? {blockedReason} : {})},
    }],
    readiness: {status: blockedReason ? 'unknown' : noop ? 'configured' : 'needs_attention', providerSigning: live ? 'enabled' : 'unknown',
      keyWiring: !runtime.known ? 'unknown' : !runtime.present ? 'missing' : matching ? 'matching' : 'drifted'},
  };
}

// This is used only after runtimeKey has established the exact hosting identity.
function runningDeployment(observed: ObservedState | null, service: string): string | undefined {
  const matches = observed?.services.filter(item => item.name === service) ?? [];
  const match = matches.length === 1 ? matches[0] : undefined;
  return match?.status === 'running' ? match.deployment?.id ?? match.maintenance?.deploymentId : undefined;
}

function missingRolloutReceipt(binding: Record<string, unknown>, environment: Environment | null, observed: ObservedState | null, service: string, provider: string): boolean {
  const rollout = record(record(binding.write).rollout);
  if (rollout.runtimeRolloutRequired !== true) return false;
  const baseline = record(record(rollout.rolloutBaselines)[service]);
  const deployment = runningDeployment(observed, service);
  if (deployment && (baseline.state === 'absent' || baseline.state === 'present' && deployment !== baseline.deploymentId)) return false;
  return !parseRuntimeRolloutBindings(environment).some(item => item.service === service && item.provider === provider
    && item.actionIds.includes(actionId) && item.baselineDeployment.state === baseline.state
    && (baseline.state !== 'present' || item.baselineDeployment.id === baseline.deploymentId));
}

function rolloutEvidence(data: Record<string, unknown>, service: string): Record<string, unknown> {
  const baseline = record(data.rolloutBaseline);
  return {
    ...(data.deploymentDeferred === true ? {deploymentDeferred: true} : {}),
    ...(data.runtimeRolloutRequired === true ? {runtimeRolloutRequired: true, rolloutBaselines: {[service]: {
      state: baseline.state === 'absent' ? 'absent' : baseline.state === 'present' && typeof baseline.deploymentId === 'string' ? 'present' : 'unknown',
      ...(baseline.state === 'present' && typeof baseline.deploymentId === 'string' ? {deploymentId: baseline.deploymentId} : {}),
    }}} : {}),
  };
}

export async function applyInboundSigningKey(params: {
  project: Project; environment: Environment; spec: EnvironmentSpec; action: PlanAction;
  adapter: SendGridAdapter; confirmedActionIds?: ReadonlySet<string>;
}): Promise<ActionResult> {
  if (params.action.type === 'noop') return {success: true, message: 'No inbound signing mutation requested'};
  const blocked = (message: string): ActionResult => ({success: false, status: 'blocked', message});
  const {action, spec, environment} = params;
  const target = spec.email.inbound;
  const metadata = action.metadata ?? {};
  if (!target || target.signatureVerification !== true || action.type !== 'update' || action.id !== actionId
    || action.resource.kind !== 'email' || action.resource.name !== 'inbound-key' || action.resource.provider !== spec.hosting.provider
    || metadata.operation !== INBOUND_SIGNING_KEY_OPERATION || metadata.key !== SENDGRID_INBOUND_PUBLIC_KEY || metadata.blockedReason
    || metadata.environmentId !== environment.id || metadata.hostname !== target.hostname.toLowerCase() || metadata.service !== target.service
    || metadata.hostingHash !== hostingIdentity(environment, target.service) || !expectedUrl(environment, spec)
    || metadata.expectedUrl !== expectedUrl(environment, spec) || inboundSigningTargetBlock(environment, spec)) return blocked('Inbound signing action or target changed; re-plan.');
  if (action.requiresConfirm !== true || !params.confirmedActionIds?.has(action.id)) return blocked('Confirm this exact inbound key-publication action before applying.');
  const binding = inboundSigningBinding(environment);
  const check = async (): Promise<boolean> => {
    const live = await observeInboundSigning(params.adapter, target.hostname.toLowerCase());
    return live.status === 'known' && live.policy.id === metadata.policyId
      && hashEnvValue(JSON.stringify(inboundSigningFingerprint(live))) === metadata.stateHash;
  };
  try {
    const live = await observeInboundSigning(params.adapter, target.hostname.toLowerCase());
    if (live.status !== 'known' || live.route.url !== metadata.expectedUrl || live.policy.id !== metadata.policyId
      || hashEnvValue(live.policy.publicKey) !== metadata.expectedHash || hashEnvValue(JSON.stringify(inboundSigningFingerprint(live))) !== metadata.stateHash
      || binding.policyId && binding.policyId !== live.policy.id
      || binding.status === 'pending' && binding.keyHash !== metadata.expectedHash) return blocked('The exact inbound policy or verification key changed; review a fresh plan.');
    const service = new ServiceRepository().findByProjectAndName(params.project.id, target.service);
    if (!service) return blocked('The receiving service is not tracked.');
    const before = await observeHosting(params.project, environment, spec);
    const current = runtimeKey(before, target.service, environment, SENDGRID_INBOUND_PUBLIC_KEY);
    if (!current.known) return blocked('Runtime key observation is unknown; no hosting write was attempted.');
    const repo = new EnvironmentRepository();
    const intent = {hostname: target.hostname.toLowerCase(), service: target.service, policyId: live.policy.id,
      keyHash: metadata.expectedHash, hostingHash: metadata.hostingHash};
    const persist = (status: 'pending' | 'configured', write: Record<string, unknown>): boolean => {
      const latest = repo.findById(environment.id);
      return Boolean(latest && repo.updatePlatformBindings(environment.id, {email: {...record(latest.platformBindings.email),
        inboundSigning: {...intent, status, write}}}));
    };
    let write = record(binding.write);
    let rollout = record(write.rollout);
    if (current.hash !== metadata.expectedHash) {
      // Journal ownership before a write can commit. An unavailable receipt cannot
      // release that ownership or silently erase an unobserved rollout requirement.
      write = {acknowledged: false, baselineDeploymentId: runningDeployment(before, target.service)};
      if (!persist('pending', write)) return blocked('Could not persist inbound key-publication intent; no hosting write was attempted.');
      const receipt = await syncHostingEnvVars({project: params.project, environment, service,
        vars: {[SENDGRID_INBOUND_PUBLIC_KEY]: live.policy.publicKey}, deferDeployment: spec.deploy?.strategy === 'branch' && spec.deploy.trigger === 'ci'});
      if (!receipt.success) return {success: false, message: 'Inbound verification-key write was not confirmed; re-plan to reconcile. The provider policy was not changed.'};
      rollout = rolloutEvidence(record(receipt.data), target.service);
      write = {...write, acknowledged: true, rollout};
      if (!persist('pending', write)) return blocked('The hosting write was acknowledged but its receipt could not be saved; re-plan to reconcile.');
    } else if (!Object.keys(binding).length) {
      if (!persist('pending', {})) return blocked('Could not persist inbound key-adoption intent; re-plan.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await observeHosting(params.project, environment, spec);
      const after = runtimeKey(observed, target.service, environment, SENDGRID_INBOUND_PUBLIC_KEY);
      if (!await check()) return blocked('Inbound policy changed during key publication; re-plan.');
      if (after.known && after.hash === metadata.expectedHash) {
        if (write.acknowledged === false) {
          const deployment = runningDeployment(observed, target.service);
          if (!write.baselineDeploymentId || !deployment || deployment === write.baselineDeploymentId) return {
            success: false, status: 'pending', message: 'The key is stored, but the hosting write receipt is unavailable. Verify activation through the deployment lifecycle, then re-plan; the key will not be written again. A distinct running deployment is required for automatic recovery.',
          };
          write = {...write, acknowledged: true, activationDeploymentId: deployment};
        }
        if (!persist('configured', write)) return blocked('Key configuration converged but its binding was not saved; re-plan to reconcile.');
        return redactExactValues({success: true, message: 'Inbound Parse public-key configuration observed and recorded. Application signature validation remains unverified.', data: rollout}, [live.policy.publicKey]);
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {success: false, status: 'pending', message: 'Inbound verification-key write is not yet observable; re-plan.'};
  } catch {
    return {success: false, message: 'Inbound verification-key configuration could not be verified. Re-plan to reconcile; provider details are withheld.'};
  }
}
