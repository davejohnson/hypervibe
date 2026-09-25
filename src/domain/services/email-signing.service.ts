import { parseHostingBindings } from '../ports/hosting.port.js';
import { redactExactValues } from '../../utils/redact-exact-values.js';
import type { SendGridAdapter } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import { hashEnvValue, type ObservedState, type IObservableHosting } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { ActionResult } from '../plan/converge.executor.js';
import { SENDGRID_EVENT_PUBLIC_KEY, type EnvironmentSpec } from '../spec/spec.schema.js';
import { adapterFactory } from './adapter.factory.js';
import { syncHostingEnvVars, removeHostingEnvVars, serviceHasHostingBinding } from './hosting-env.service.js';
import { serviceBindingFor } from './spec.service.js';

export const EMAIL_SIGNING_OPERATIONS = { signing: 'emailEventSigning', key: 'emailEventVerificationKey' } as const;
export type EventSigningState = { status: 'known'; value: Awaited<ReturnType<SendGridAdapter['getEventWebhookSigning']>> } | { status: 'unknown' };
export interface EventSigningReadiness { status: 'configured' | 'needs_attention' | 'unknown'; providerSigning: 'enabled' | 'disabled' | 'unknown'; keyWiring: 'matching' | 'missing' | 'drifted' | 'unknown' | 'not_required' }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const actionId = (kind: 'signing' | 'key') => `email:sendgrid:delivery-${kind}`;
export function signingBinding(environment: Environment | null): Record<string, unknown> { return record(record(environment?.platformBindings.email).eventSigning); }
function hostingIdentity(environment: Environment | null, service: string | undefined): string {
  const binding = parseHostingBindings(environment);
  return hashEnvValue(JSON.stringify({ environment: environment?.id, project: environment?.projectId, provider: binding.provider,
    projectId: binding.projectId, environmentId: binding.environmentId, scope: binding.providerScope,
    service: service ? binding.services?.[service] : undefined }));
}
export function eventSigningUrl(environment: Environment | null, spec: EnvironmentSpec): string | undefined {
  const target = spec.email.deliveryEvents;
  const base = environment && target ? serviceBindingFor(environment, target.service)?.url : undefined;
  try { const url = new URL(target!.path, String(base)); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
function runtimeKey(observed: ObservedState | null, service: string, environment: Environment | null): { known: boolean; present?: boolean; hash?: string } {
  if (!observed || observed.partial || observed.completeness?.services === 'unknown') return { known: false };
  const matches = observed.services.filter(item => item.name === service);
  if (matches.length !== 1) return { known: false };
  const item = matches[0];
  const binding = parseHostingBindings(environment);
  const expectedId = binding.services?.[service]?.serviceId ?? binding.services?.[service]?.jobName;
  if (!expectedId || item.externalId !== expectedId || observed.provider !== binding.provider
    || observed.projectId && binding.projectId && observed.projectId !== binding.projectId
    || observed.environmentId && binding.environmentId && observed.environmentId !== binding.environmentId) return { known: false };
  const present = item.envVarKeys.includes(SENDGRID_EVENT_PUBLIC_KEY);
  const hash = item.envVarHashes[SENDGRID_EVENT_PUBLIC_KEY];
  return { known: !present || typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash), present, hash };
}
export function planEventSigning(params: { spec: EnvironmentSpec; environment: Environment | null; observed: ObservedState | null; state?: EventSigningState; deliveryReady: boolean }): { actions: PlanAction[]; readiness?: EventSigningReadiness } {
  const target = params.spec.email.deliveryEvents;
  const binding = signingBinding(params.environment);
  if (target?.signatureVerification === undefined && (!Object.keys(binding).length || binding.disabled === true)) return { actions: [] };
  const state = params.state?.status === 'known' ? params.state.value : undefined;
  const runtime = target ? runtimeKey(params.observed, target.service, params.environment) : { known: false };
  const url = eventSigningUrl(params.environment, params.spec);
  const hostingHash = hostingIdentity(params.environment, target?.service);
  let blocked = !target || target.signatureVerification === undefined ? 'Restore the managed signatureVerification setting. Set it to false and apply before removing signing intent.'
    : !params.deliveryReady ? 'Converge the delivery-event endpoint, then re-plan signing.'
    : !url ? 'The receiving service needs a durable HTTPS URL.'
    : !state || state.url !== url || !state.enabled ? 'Exact endpoint signing observation is unknown or no longer matches the delivery target.'
    : binding.disabled !== true && binding.hostingHash && binding.hostingHash !== hostingHash ? 'The receiving hosting identity changed; restore it before removing or moving managed signing.'
    : binding.disabled !== true && binding.endpointId && binding.endpointId !== state.id ? 'The bound signing endpoint identity changed; restore it before changing signing.'
    : binding.disabled !== true && binding.service && binding.service !== target.service ? 'Disable managed signing and remove its key before changing the receiving service.' : undefined;
  const desired = target?.signatureVerification;
  const expectedHash = state?.publicKey ? hashEnvValue(state.publicKey) : undefined;
  const readiness: EventSigningReadiness = {
    status: blocked ? 'unknown' : state?.signing !== desired || !runtime.known || (desired && runtime.hash !== expectedHash) ? 'needs_attention' : 'configured',
    providerSigning: state ? state.signing ? 'enabled' : 'disabled' : 'unknown',
    keyWiring: !desired ? 'not_required' : !runtime.known ? 'unknown' : !runtime.present ? 'missing' : runtime.hash === expectedHash ? 'matching' : 'drifted',
  };
  const transition = state?.signing !== desired;
  const make = (kind: 'signing' | 'key', noop: boolean, reason: string, blockedReason?: string): PlanAction => ({
    id: actionId(kind), type: noop ? 'noop' : 'update', resource: { kind: 'email', name: `delivery-${kind}`, provider: kind === 'signing' ? 'sendgrid' : params.spec.hosting.provider },
    reason, verified: !blockedReason && (kind === 'signing' ? Boolean(state) : runtime.known),
    ...(!noop ? { requiresConfirm: true } : {}),
    ...(kind === 'key' ? { dependsOn: [actionId('signing')] } : {}),
    metadata: { hostingHash, environmentId: params.environment?.id, operation: EMAIL_SIGNING_OPERATIONS[kind], endpointId: state?.id, service: target?.service, enabled: desired,
      ...(url ? { expectedUrl: url } : {}), ...(kind === 'key' ? { key: SENDGRID_EVENT_PUBLIC_KEY, expectedHash: desired ? expectedHash : null } : {}),
      ...(blockedReason ? { blockedReason } : {}),
    },
  });
  if (blocked || transition) return { actions: [make('signing', false, 'Review SendGrid delivery-event signing; key publication follows in a fresh plan', blocked)], readiness };
  const actions = [make('signing', true, 'SendGrid signing matches desired state')];
  if (!runtime.known) blocked = 'The receiving service verification-key observation is unknown; preserve existing configuration.';
  if (!desired && runtime.present && (binding.service !== target?.service || binding.keyHash !== runtime.hash)) blocked = 'The current runtime key is not proven owned by this signing binding; preserve it.';
  const keyMatches = desired ? runtime.hash === expectedHash : !runtime.present;
  const bindingMatches = !desired && !Object.keys(binding).length || binding.endpointId === state!.id && binding.service === target?.service && binding.keyHash === (desired ? expectedHash : null);
  actions.push(make('key', !blocked && keyMatches && bindingMatches, desired ? 'Publish and verify the SendGrid public verification key on its receiving service' : 'Remove the owned verification key after signing is disabled', blocked));
  if (blocked) readiness.status = 'unknown';
  return { actions, readiness };
}

async function observeHosting(project: Project, environment: Environment, spec: EnvironmentSpec): Promise<ObservedState | null> {
  const resolved = await adapterFactory.getProviderAdapter(spec.hosting.provider, project);
  const adapter = resolved.adapter as unknown as Partial<IObservableHosting> & { configureTarget?: (target: { region?: string }) => Promise<void> };
  if (!resolved.success || !adapter || typeof adapter.observe !== 'function') return null;
  await adapter.configureTarget?.({ region: spec.hosting.region });
  return adapter.observe(environment);
}

export async function applyEventSigning(params: { project: Project; environment: Environment; spec: EnvironmentSpec; action: PlanAction; adapter: SendGridAdapter; confirmedActionIds?: ReadonlySet<string> }): Promise<ActionResult> {
  if (params.action.type === 'noop') return { success: true, message: 'No signing mutation requested' };
  const fail = (message: string): ActionResult => ({ success: false, status: 'blocked', message });
  const target = params.spec.email.deliveryEvents;
  const metadata = params.action.metadata ?? {};
  const kind = metadata.operation === EMAIL_SIGNING_OPERATIONS.signing ? 'signing' : metadata.operation === EMAIL_SIGNING_OPERATIONS.key ? 'key' : undefined;
  const url = eventSigningUrl(params.environment, params.spec);
  const hostingHash = hostingIdentity(params.environment, target?.service);
  if (!kind || params.action.type !== 'update' || params.action.id !== actionId(kind) || params.action.resource.kind !== 'email'
    || params.action.resource.name !== `delivery-${kind}` || params.action.resource.provider !== (kind === 'signing' ? 'sendgrid' : params.spec.hosting.provider)
    || !target || target.signatureVerification === undefined || !url || metadata.expectedUrl !== url || metadata.service !== target.service
    || metadata.hostingHash !== hostingHash || metadata.environmentId !== params.environment.id
    || metadata.enabled !== target.signatureVerification || typeof metadata.endpointId !== 'string' || metadata.blockedReason) return fail('Signing action changed or is blocked; re-plan.');
  if (params.action.requiresConfirm !== true || !params.confirmedActionIds?.has(params.action.id)) return { success: false, status: 'blocked', message: 'Confirm this exact signing or key-publication action before applying.' };
  const binding = signingBinding(params.environment);
  if (binding.disabled !== true && binding.hostingHash && binding.hostingHash !== hostingHash) return fail('The receiving hosting identity changed; restore the reviewed binding.');
  if (binding.disabled !== true && binding.endpointId && binding.endpointId !== metadata.endpointId || binding.disabled !== true && binding.service && binding.service !== target.service) return fail('The signing binding changed; restore the reviewed endpoint and service.');
  try {
    const endpointId = binding.endpointId ?? record(record(params.environment.platformBindings.email).deliveryEvents).endpointId;
    const live = await params.adapter.resolveEventWebhookSigning(url, typeof endpointId === 'string' ? endpointId : undefined);
    if (live.id !== metadata.endpointId) return fail('The reviewed endpoint candidate changed; re-plan.');
    if (live.url !== url || !live.enabled) return fail('The exact webhook no longer matches the receiving endpoint; re-plan.');
    if (kind === 'signing') {
      const repo = new EnvironmentRepository();
      const latest = repo.findById(params.environment.id);
      if (!latest || !repo.updatePlatformBindings(latest.id, { email: { ...record(latest.platformBindings.email), eventSigning: { ...binding, hostingHash, endpointId: live.id, service: target.service, disabled: false } } })) return fail('Could not persist signing intent; no provider write was attempted.');
      if (live.signing !== target.signatureVerification) await params.adapter.setEventWebhookSigning(live.id, target.signatureVerification);
      for (let attempt = 0; attempt < 3; attempt++) {
        const check = await params.adapter.getEventWebhookSigning(live.id);
        if (check.url !== url || !check.enabled) return fail('Endpoint identity changed during signing verification.');
        if (check.signing === target.signatureVerification) return { success: true, message: 'SendGrid signing verified. Re-plan to publish or remove the runtime verification key.' };
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { success: false, status: 'pending', message: 'SendGrid signing has not converged; re-plan before key publication.' };
    }
    if (metadata.key !== SENDGRID_EVENT_PUBLIC_KEY || live.signing !== target.signatureVerification) return fail('Signing must converge before key publication.');
    const expectedHash = target.signatureVerification && live.publicKey ? hashEnvValue(live.publicKey) : null;
    if (metadata.expectedHash !== expectedHash) return fail('The verification key changed after planning; review a fresh plan.');
    const service = new ServiceRepository().findByProjectAndName(params.project.id, target.service);
    if (!service || !serviceHasHostingBinding(params.environment, target.service)) return fail('The exact receiving service is not durably bound.');
    const current = runtimeKey(await observeHosting(params.project, params.environment, params.spec), target.service, params.environment);
    if (!current.known) return fail('Runtime key observation is unknown; no hosting writes were made.');
    if (!target.signatureVerification && current.present && (binding.service !== target.service || binding.keyHash !== current.hash)) return fail('The live key is not proven owned; it will not be removed.');
    let rollout: Record<string, unknown> = {};
    if (target.signatureVerification ? current.hash !== expectedHash : current.present) {
      const receipt = target.signatureVerification
        ? await syncHostingEnvVars({ project: params.project, environment: params.environment, service, vars: { [SENDGRID_EVENT_PUBLIC_KEY]: live.publicKey! }, deferDeployment: params.spec.deploy?.strategy === 'branch' && params.spec.deploy.trigger === 'ci' })
        : await removeHostingEnvVars({ project: params.project, environment: params.environment, service, keys: [SENDGRID_EVENT_PUBLIC_KEY] });
      const data = record(receipt.data);
      rollout = { ...(data.deploymentDeferred === true ? { deploymentDeferred: true } : {}),
        ...(data.runtimeRolloutRequired === true ? { runtimeRolloutRequired: true } : {}),
        ...(data.runtimeRolloutRequired === true && data.rolloutBaseline ? { rolloutBaselines: { [target.service]: data.rolloutBaseline } } : {}) };
      if (!receipt.success) return { success: false, message: 'Verification-key hosting write failed; re-plan to reconcile. No signing rollback was attempted.' };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const after = runtimeKey(await observeHosting(params.project, params.environment, params.spec), target.service, params.environment);
      const signer = await params.adapter.getEventWebhookSigning(live.id);
      if (signer.url !== url || !signer.enabled || signer.signing !== target.signatureVerification || (signer.publicKey ? hashEnvValue(signer.publicKey) : null) !== expectedHash) return fail('Provider signing changed during key publication; re-plan.');
      if (after.known && (target.signatureVerification ? after.hash === expectedHash : !after.present)) {
        const repo = new EnvironmentRepository();
        const latest = repo.findById(params.environment.id);
        if (!latest) return fail('The receiving environment disappeared before recording key ownership.');
        const saved = repo.updatePlatformBindings(latest.id, { email: { ...record(latest.platformBindings.email), eventSigning: { hostingHash, endpointId: live.id, service: target.service, keyHash: expectedHash, disabled: !target.signatureVerification } } });
        if (!saved) return fail('Key configuration converged but its binding was not saved; re-plan to reconcile.');
        return redactExactValues({ success: true, message: 'SendGrid verification-key configuration observed and recorded. Application signature validation remains unverified.', data: rollout }, live.publicKey ? [live.publicKey] : []);
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { success: false, status: 'pending', message: 'Runtime key write is not yet observable; re-plan without rotating signing.' };
  } catch {
    return { success: false, message: 'Signing or verification-key operation could not be verified. Re-plan to reconcile; verify SendGrid endpoint access and signing permissions. Provider details are withheld.' };
  }
}
