import { createHash } from 'crypto';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import {
  TwilioAdapter,
  type TwilioCredentials,
  type TwilioMessagingService,
} from '../../adapters/providers/twilio/twilio.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { ActionResult } from '../plan/converge.executor.js';
import type { PlanAction } from '../plan/plan.types.js';
import {
  MESSAGING_MANAGED_ENV_KEYS,
  type EnvironmentSpec,
  type TwilioMessagingSpec,
} from '../spec/spec.schema.js';
import { removeHostingEnvVars, syncHostingEnvVars } from './hosting-env.service.js';
import { getProjectScopeHints } from './project-scope.js';
import { serviceBindingFor } from './spec.service.js';

export const MESSAGING_OPERATIONS = {
  serviceEnsure: 'twilioMessagingServiceEnsure',
  serviceAdopt: 'twilioMessagingServiceAdopt',
  senderAttach: 'twilioMessagingSenderAttach',
  senderMove: 'twilioMessagingSenderMove',
  runtimeSync: 'twilioMessagingRuntimeSync',
} as const;

type UnknownObservation = { status: 'unknown'; error: string };
type KnownObservation<T> = { status: 'known'; value: T };
type Observation<T> = KnownObservation<T> | UnknownObservation;

export interface TwilioPhoneOwner {
  phoneNumberSid: string;
  serviceSid: string;
}

export interface TwilioMessagingState {
  credentialHash: Observation<string>;
  services: Observation<TwilioMessagingService[]>;
  phoneOwners: Observation<TwilioPhoneOwner[]>;
  warnings: string[];
}

export interface TwilioMessagingPlanResult {
  actions: PlanAction[];
  warnings: string[];
  fingerprint?: string;
}

const connectionRepo = new ConnectionRepository();
const environmentRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function credentialsHash(credentials: TwilioCredentials): string {
  return hash([
    credentials.accountSid,
    credentials.apiKeySid,
    credentials.apiKeySecret,
    credentials.authToken,
  ]);
}

function messagingBindings(environment: Environment | null): Record<string, unknown> {
  return asRecord(asRecord(environment?.platformBindings.messaging)?.twilio) ?? {};
}

function updateMessagingBinding(
  environment: Environment,
  key: 'service' | 'sender' | 'runtime',
  value: Record<string, unknown>
): Environment | null {
  const latest = environmentRepo.findById(environment.id) ?? environment;
  const messaging = asRecord(latest.platformBindings.messaging) ?? {};
  const twilio = asRecord(messaging.twilio) ?? {};
  return environmentRepo.updatePlatformBindings(environment.id, {
    messaging: {
      ...messaging,
      twilio: { ...twilio, [key]: value },
    },
  });
}

function twilioConnection(project: Project):
  | { adapter: TwilioAdapter; credentials: TwilioCredentials }
  | { error: string } {
  const connection = connectionRepo.findBestVerifiedMatchFromHints('twilio', getProjectScopeHints(project));
  if (!connection) return { error: 'No verified Twilio connection matches this project.' };
  const credentials = getSecretStore().decryptObject<TwilioCredentials>(connection.credentialsEncrypted);
  const adapter = new TwilioAdapter();
  adapter.connect(credentials);
  return { adapter, credentials };
}

function serviceUrl(environment: Environment | null, serviceName: string): string | undefined {
  if (!environment) return undefined;
  const value = stringValue(serviceBindingFor(environment, serviceName), 'url');
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function webhookUrl(
  environment: Environment | null,
  target: { service: string; path: string } | undefined
): string | undefined {
  if (!target) return undefined;
  const base = serviceUrl(environment, target.service);
  return base ? new URL(target.path, base).toString() : undefined;
}

function normalizeService(service: TwilioMessagingService | null): Record<string, unknown> | null {
  if (!service) return null;
  return {
    sid: service.sid,
    friendlyName: service.friendly_name,
    inboundRequestUrl: service.inbound_request_url || null,
    inboundMethod: service.inbound_method,
    statusCallback: service.status_callback || null,
    useInboundWebhookOnNumber: service.use_inbound_webhook_on_number,
  };
}

function serviceConfigHash(spec: TwilioMessagingSpec): string {
  return hash(spec.service);
}

function runtimeConfigHash(spec: TwilioMessagingSpec): string {
  return hash({ services: [...spec.services].sort(), sender: spec.sender ?? null });
}

function desiredRuntimeKeys(spec: TwilioMessagingSpec): string[] {
  return MESSAGING_MANAGED_ENV_KEYS
    .filter((key) => key !== 'TWILIO_PHONE_NUMBER_SID' || Boolean(spec.sender))
    .sort();
}

function desiredServiceConfig(
  spec: TwilioMessagingSpec,
  environment: Environment | null
): { friendlyName: string; inboundRequestUrl: string | null; statusCallback: string | null } {
  return {
    friendlyName: spec.service.name,
    inboundRequestUrl: webhookUrl(environment, spec.service.inbound) ?? null,
    statusCallback: webhookUrl(environment, spec.service.deliveryStatus) ?? null,
  };
}

function missingWebhookBinding(spec: TwilioMessagingSpec, config: ReturnType<typeof desiredServiceConfig>): string | undefined {
  if (spec.service.inbound && !config.inboundRequestUrl) return spec.service.inbound.service;
  if (spec.service.deliveryStatus && !config.statusCallback) return spec.service.deliveryStatus.service;
  return undefined;
}

function serviceMatches(service: TwilioMessagingService, desired: ReturnType<typeof desiredServiceConfig>): boolean {
  return service.friendly_name === desired.friendlyName
    && (service.inbound_request_url || null) === desired.inboundRequestUrl
    && service.inbound_method === 'POST'
    && (service.status_callback || null) === desired.statusCallback
    && service.use_inbound_webhook_on_number === false;
}

type ServiceSelection =
  | { status: 'selected'; service: TwilioMessagingService; adoption: boolean }
  | { status: 'absent' }
  | { status: 'duplicate'; services: TwilioMessagingService[] }
  | UnknownObservation;

function selectService(
  state: TwilioMessagingState,
  environment: Environment | null,
  friendlyName: string
): ServiceSelection {
  if (state.services.status === 'unknown') return state.services;
  const services = state.services.value;
  const boundSid = stringValue(asRecord(messagingBindings(environment).service), 'sid');
  const bound = boundSid ? services.find((service) => service.sid === boundSid) : undefined;
  if (bound) return { status: 'selected', service: bound, adoption: false };
  const matches = services.filter((service) => service.friendly_name === friendlyName);
  if (matches.length > 1) return { status: 'duplicate', services: matches };
  if (matches.length === 1) return { status: 'selected', service: matches[0], adoption: true };
  return { status: 'absent' };
}

export async function resolveTwilioMessagingState(params: {
  project: Project;
  spec: TwilioMessagingSpec;
}): Promise<TwilioMessagingState> {
  const connection = twilioConnection(params.project);
  if ('error' in connection) {
    const unknown = { status: 'unknown' as const, error: connection.error };
    return { credentialHash: unknown, services: unknown, phoneOwners: unknown, warnings: [connection.error] };
  }
  const credentialHash: Observation<string> = { status: 'known', value: credentialsHash(connection.credentials) };
  let services: Observation<TwilioMessagingService[]>;
  try {
    services = { status: 'known', value: await connection.adapter.listMessagingServices() };
  } catch (error) {
    services = { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
  let phoneOwners: Observation<TwilioPhoneOwner[]> = { status: 'known', value: [] };
  if (params.spec.sender && services.status === 'known') {
    try {
      const perService = await Promise.all(services.value.map(async (service) => (
        (await connection.adapter.listMessagingPhoneNumbers(service.sid)).map((phone) => ({
          phoneNumberSid: phone.sid,
          serviceSid: service.sid,
        }))
      )));
      phoneOwners = { status: 'known', value: perService.flat() };
    } catch (error) {
      phoneOwners = { status: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
  } else if (services.status === 'unknown') {
    phoneOwners = services;
  }
  const warnings = [services, phoneOwners]
    .filter((observation): observation is UnknownObservation => observation.status === 'unknown')
    .map((observation) => `Twilio messaging observation is unknown: ${observation.error}`);
  return { credentialHash, services, phoneOwners, warnings: [...new Set(warnings)] };
}

export function twilioMessagingFingerprint(state: TwilioMessagingState): string {
  return hash({
    credentialHash: state.credentialHash,
    services: state.services.status === 'unknown'
      ? state.services
      : state.services.value.map(normalizeService).sort((a, b) => String(a?.sid).localeCompare(String(b?.sid))),
    phoneOwners: state.phoneOwners.status === 'unknown'
      ? state.phoneOwners
      : [...state.phoneOwners.value].sort((a, b) => `${a.phoneNumberSid}:${a.serviceSid}`.localeCompare(`${b.phoneNumberSid}:${b.serviceSid}`)),
  });
}

export async function planTwilioMessaging(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment: Environment | null;
  observed: ObservedState | null;
  serviceDependencies?: string[];
  integrationState?: TwilioMessagingState;
}): Promise<TwilioMessagingPlanResult> {
  const spec = params.environmentSpec.messaging;
  if (!spec) return { actions: [], warnings: [] };
  const state = params.integrationState ?? await resolveTwilioMessagingState({ project: params.project, spec });
  const actions: PlanAction[] = [];
  const bindings = messagingBindings(params.environment);
  const desired = desiredServiceConfig(spec, params.environment);
  const selection = selectService(state, params.environment, spec.service.name);
  const missingBinding = missingWebhookBinding(spec, desired);
  const serviceBlockedReason = missingBinding
    ? 'twilio_webhook_service_url_missing'
    : selection.status === 'unknown'
      ? 'twilio_service_observation_unknown'
      : selection.status === 'duplicate'
        ? 'twilio_service_identity_ambiguous'
        : undefined;
  const selected = selection.status === 'selected' ? selection.service : null;
  const serviceInSync = Boolean(selected)
    && serviceMatches(selected!, desired)
    && selection.status === 'selected'
    && !selection.adoption;
  const serviceAction: PlanAction = {
    id: 'messaging:twilio:service',
    type: serviceInSync ? 'noop' : selection.status === 'absent' ? 'create' : 'update',
    resource: { kind: 'messaging', name: spec.service.name, provider: 'twilio' },
    verified: selection.status !== 'unknown' && !missingBinding,
    reason: serviceInSync
      ? `Twilio Messaging Service ${spec.service.name} is in sync`
      : selection.status === 'duplicate'
        ? `Multiple Twilio Messaging Services match ${spec.service.name}`
        : missingBinding
          ? `Twilio webhook target ${missingBinding} has no durable public URL`
          : selection.status === 'selected' && selection.adoption
            ? `Adopt and reconcile the existing Twilio Messaging Service ${spec.service.name}`
            : `Create or reconcile Twilio Messaging Service ${spec.service.name}`,
    ...(params.serviceDependencies?.length ? { dependsOn: [...new Set(params.serviceDependencies)] } : {}),
    metadata: {
      operation: selection.status === 'selected' && selection.adoption
        ? MESSAGING_OPERATIONS.serviceAdopt
        : MESSAGING_OPERATIONS.serviceEnsure,
      configHash: serviceConfigHash(spec),
      expectedInboundUrl: desired.inboundRequestUrl,
      expectedStatusCallback: desired.statusCallback,
      observedService: normalizeService(selected),
      ...(serviceBlockedReason ? { blockedReason: serviceBlockedReason } : {}),
      ...(selection.status === 'duplicate' ? { duplicateServiceSids: selection.services.map((service) => service.sid).sort() } : {}),
    },
  };
  actions.push(serviceAction);

  if (spec.sender) {
    const phoneSid = spec.sender.phoneNumberSid;
    const owners = state.phoneOwners.status === 'known'
      ? state.phoneOwners.value.filter((owner) => owner.phoneNumberSid === phoneSid)
      : [];
    const owner = owners.length === 1 ? owners[0] : undefined;
    const targetSid = selected?.sid;
    const attached = Boolean(owner && targetSid && owner.serviceSid === targetSid);
    const senderUnknown = state.phoneOwners.status === 'unknown';
    const senderDuplicate = owners.length > 1;
    const senderBlockedReason = senderUnknown
      ? 'twilio_sender_observation_unknown'
      : senderDuplicate
        ? 'twilio_sender_identity_ambiguous'
        : serviceBlockedReason
          ? 'twilio_service_unavailable'
          : undefined;
    const moving = Boolean(owner && targetSid && owner.serviceSid !== targetSid)
      || Boolean(owner && selection.status === 'absent');
    actions.push({
      id: `messaging:twilio:sender:${phoneSid}`,
      type: attached ? 'noop' : moving ? 'replace' : 'create',
      resource: { kind: 'messaging', name: phoneSid, provider: 'twilio' },
      verified: !senderBlockedReason,
      reason: attached
        ? `${phoneSid} is attached to the declared Twilio Messaging Service`
        : senderDuplicate
          ? `${phoneSid} appears in multiple Twilio Messaging Service sender pools`
          : moving
            ? `Move existing Twilio phone number ${phoneSid} to ${spec.service.name}`
            : `Attach existing Twilio phone number ${phoneSid} to ${spec.service.name}`,
      ...(moving ? { requiresConfirm: true } : {}),
      ...(serviceAction.type !== 'noop' ? { dependsOn: [serviceAction.id] } : {}),
      metadata: {
        operation: moving ? MESSAGING_OPERATIONS.senderMove : MESSAGING_OPERATIONS.senderAttach,
        configHash: serviceConfigHash(spec),
        serviceName: spec.service.name,
        phoneNumberSid: phoneSid,
        observedOwnerServiceSid: owner?.serviceSid ?? null,
        ...(senderBlockedReason ? { blockedReason: senderBlockedReason } : {}),
      },
    });
  }

  const runtimeBinding = asRecord(bindings.runtime);
  const runtimeServices = [...spec.services].sort();
  const keys = desiredRuntimeKeys(spec);
  const selectedSid = selected?.sid;
  const credentialHash = state.credentialHash.status === 'known' ? state.credentialHash.value : undefined;
  const bindingMatches = stringValue(runtimeBinding, 'configHash') === runtimeConfigHash(spec)
    && stringValue(runtimeBinding, 'credentialHash') === credentialHash
    && stringValue(runtimeBinding, 'serviceSid') === selectedSid;
  const servicesKnown = params.observed !== null && params.observed.completeness?.services !== 'unknown';
  const runtimePresent = servicesKnown && runtimeServices.every((serviceName) => {
    const live = params.observed?.services.find((service) => service.name === serviceName);
    return keys.every((key) => live?.envVarKeys.includes(key));
  });
  const runtimePreserved = (!servicesKnown || !credentialHash || !selectedSid) && bindingMatches;
  actions.push({
    id: 'messaging:twilio:runtime',
    type: runtimePresent && bindingMatches || runtimePreserved ? 'noop' : 'update',
    resource: { kind: 'messaging', name: params.environmentName, provider: params.environmentSpec.hosting.provider },
    verified: runtimePresent && bindingMatches,
    reason: runtimePresent && bindingMatches
      ? 'Twilio runtime configuration is present on every declared service'
      : runtimePreserved
        ? 'Preserving recorded Twilio runtime configuration because observation is incomplete'
        : 'Sync Twilio runtime configuration to declared services',
    ...(serviceAction.type !== 'noop' ? { dependsOn: [serviceAction.id] } : {}),
    metadata: {
      operation: MESSAGING_OPERATIONS.runtimeSync,
      configHash: runtimeConfigHash(spec),
      services: runtimeServices,
      managedKeys: [...MESSAGING_MANAGED_ENV_KEYS],
      ...(credentialHash ? { credentialHash } : {}),
      ...((!servicesKnown || !credentialHash || Boolean(serviceBlockedReason)) && !bindingMatches
        ? { blockedReason: 'twilio_runtime_observation_unknown' }
        : {}),
    },
  });

  return {
    actions,
    warnings: state.warnings,
    fingerprint: twilioMessagingFingerprint(state),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stale(message: string): ActionResult {
  return { success: false, status: 'blocked', message: 'Twilio messaging action is stale', error: `${message} Re-run hv_plan.` };
}

async function applyService(params: {
  project: Project;
  environment: Environment;
  spec: TwilioMessagingSpec;
  action: PlanAction;
  adapter: TwilioAdapter;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const desired = desiredServiceConfig(params.spec, params.environment);
  if (
    params.action.resource.name !== params.spec.service.name
    || stringValue(metadata, 'configHash') !== serviceConfigHash(params.spec)
    || metadata?.expectedInboundUrl !== desired.inboundRequestUrl
    || metadata?.expectedStatusCallback !== desired.statusCallback
  ) return stale('The service name, callback URLs, or desired configuration changed.');
  if (metadata?.blockedReason) {
    return { success: false, status: 'blocked', message: 'Twilio Messaging Service cannot be reconciled', error: params.action.reason };
  }
  const state = await resolveTwilioMessagingState({ project: params.project, spec: params.spec });
  const selection = selectService(state, params.environment, params.spec.service.name);
  if (selection.status === 'unknown' || selection.status === 'duplicate') {
    return stale('The provider identity can no longer be resolved uniquely.');
  }
  const current = selection.status === 'selected' ? selection.service : null;
  if (!sameJson(normalizeService(current), metadata?.observedService ?? null)) {
    return stale('The observed Messaging Service changed after planning.');
  }
  let service = current;
  if (!service) {
    service = await params.adapter.createMessagingService(desired);
  } else {
    await params.adapter.updateMessagingService(service.sid, desired);
  }
  const verified = await params.adapter.getMessagingService(service.sid);
  if (!verified || !serviceMatches(verified, desired)) {
    return { success: false, message: 'Twilio Messaging Service update was not verified', error: 'Provider read-back differs from the reviewed configuration.' };
  }
  updateMessagingBinding(params.environment, 'service', {
    sid: verified.sid,
    name: params.spec.service.name,
    configHash: serviceConfigHash(params.spec),
  });
  return {
    success: true,
    message: `${current ? 'Configured' : 'Created'} Twilio Messaging Service ${params.spec.service.name}`,
    data: { serviceSid: verified.sid, adopted: Boolean(selection.status === 'selected' && selection.adoption) },
  };
}

async function currentPhoneOwners(adapter: TwilioAdapter): Promise<TwilioPhoneOwner[]> {
  const services = await adapter.listMessagingServices();
  const owners = await Promise.all(services.map(async (service) => (
    (await adapter.listMessagingPhoneNumbers(service.sid)).map((phone) => ({
      phoneNumberSid: phone.sid,
      serviceSid: service.sid,
    }))
  )));
  return owners.flat();
}

async function applySender(params: {
  environment: Environment;
  spec: TwilioMessagingSpec;
  action: PlanAction;
  adapter: TwilioAdapter;
}): Promise<ActionResult> {
  const sender = params.spec.sender;
  const metadata = asRecord(params.action.metadata);
  if (
    !sender
    || params.action.resource.name !== sender.phoneNumberSid
    || stringValue(metadata, 'phoneNumberSid') !== sender.phoneNumberSid
    || stringValue(metadata, 'serviceName') !== params.spec.service.name
    || stringValue(metadata, 'configHash') !== serviceConfigHash(params.spec)
  ) return stale('The sender or target Messaging Service changed.');
  if (metadata?.blockedReason) {
    return { success: false, status: 'blocked', message: 'Twilio sender cannot be reconciled', error: params.action.reason };
  }
  const latest = environmentRepo.findById(params.environment.id) ?? params.environment;
  const targetServiceSid = stringValue(asRecord(messagingBindings(latest).service), 'sid');
  if (!targetServiceSid) return stale('The target Messaging Service has no durable binding.');
  const owners = (await currentPhoneOwners(params.adapter))
    .filter((owner) => owner.phoneNumberSid === sender.phoneNumberSid);
  if (owners.length > 1) return stale('The phone number appears in multiple sender pools.');
  const owner = owners[0];
  if ((owner?.serviceSid ?? null) !== (metadata?.observedOwnerServiceSid ?? null)) {
    return stale('The phone number sender-pool association changed after planning.');
  }
  if (owner?.serviceSid && owner.serviceSid !== targetServiceSid) {
    await params.adapter.detachMessagingPhoneNumber(owner.serviceSid, sender.phoneNumberSid);
    const stillAttached = (await params.adapter.listMessagingPhoneNumbers(owner.serviceSid))
      .some((phone) => phone.sid === sender.phoneNumberSid);
    if (stillAttached) {
      return { success: false, message: 'Twilio phone number detachment was not verified', error: `${sender.phoneNumberSid} remains attached to ${owner.serviceSid}.` };
    }
  }
  if (owner?.serviceSid !== targetServiceSid) {
    await params.adapter.attachMessagingPhoneNumber(targetServiceSid, sender.phoneNumberSid);
  }
  const verified = (await params.adapter.listMessagingPhoneNumbers(targetServiceSid))
    .some((phone) => phone.sid === sender.phoneNumberSid);
  if (!verified) {
    return { success: false, message: 'Twilio phone number attachment was not verified', error: 'The sender is absent from the target Messaging Service.' };
  }
  updateMessagingBinding(latest, 'sender', { phoneNumberSid: sender.phoneNumberSid, serviceSid: targetServiceSid });
  return { success: true, message: `Attached ${sender.phoneNumberSid} to ${params.spec.service.name}`, data: { phoneNumberSid: sender.phoneNumberSid, serviceSid: targetServiceSid } };
}

function runtimeValues(
  credentials: TwilioCredentials,
  serviceSid: string,
  spec: TwilioMessagingSpec
): Record<string, string> {
  return {
    TWILIO_ACCOUNT_SID: credentials.accountSid,
    TWILIO_API_KEY_SID: credentials.apiKeySid,
    TWILIO_API_KEY_SECRET: credentials.apiKeySecret,
    TWILIO_AUTH_TOKEN: credentials.authToken,
    TWILIO_MESSAGING_SERVICE_SID: serviceSid,
    ...(spec.sender ? { TWILIO_PHONE_NUMBER_SID: spec.sender.phoneNumberSid } : {}),
  };
}

async function applyRuntime(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  spec: TwilioMessagingSpec;
  action: PlanAction;
  credentials: TwilioCredentials;
}): Promise<ActionResult> {
  const metadata = asRecord(params.action.metadata);
  const targetServices = [...params.spec.services].sort();
  if (
    params.action.resource.name !== params.environment.name
    || params.action.resource.provider !== params.environmentSpec.hosting.provider
    || stringValue(metadata, 'configHash') !== runtimeConfigHash(params.spec)
    || !sameJson(stringArray(metadata, 'services').sort(), targetServices)
    || stringValue(metadata, 'credentialHash') !== credentialsHash(params.credentials)
  ) return stale('The runtime targets, hosting provider, or credentials changed.');
  if (metadata?.blockedReason) {
    return { success: false, status: 'blocked', message: 'Twilio runtime configuration cannot be reconciled', error: params.action.reason };
  }
  const latest = environmentRepo.findById(params.environment.id) ?? params.environment;
  const bindings = messagingBindings(latest);
  const serviceSid = stringValue(asRecord(bindings.service), 'sid');
  if (!serviceSid) return stale('The Messaging Service binding is missing.');
  const desiredKeys = desiredRuntimeKeys(params.spec);
  const previousKeys = asRecord(asRecord(bindings.runtime)?.perServiceKeys) ?? {};
  const failures: string[] = [];
  for (const serviceName of [...new Set([...Object.keys(previousKeys), ...targetServices])].sort()) {
    const service = serviceRepo.findByProjectAndName(params.project.id, serviceName);
    if (!service) {
      failures.push(`${serviceName}: service is not tracked locally`);
      break;
    }
    const shouldSync = targetServices.includes(serviceName);
    if (shouldSync) {
      const result = await syncHostingEnvVars({
        project: params.project,
        environment: latest,
        service,
        vars: runtimeValues(params.credentials, serviceSid, params.spec),
        deferDeployment: params.environmentSpec.deploy?.strategy === 'branch'
          && params.environmentSpec.deploy.trigger === 'ci',
      });
      if (!result.success) {
        failures.push(`${serviceName}: ${result.error ?? result.message}`);
        break;
      }
    }
    const staleKeys = stringArray(previousKeys, serviceName)
      .filter((key) => !shouldSync || !desiredKeys.includes(key));
    if (staleKeys.length > 0) {
      const removed = await removeHostingEnvVars({ project: params.project, environment: latest, service, keys: staleKeys });
      if (!removed.success) {
        failures.push(`${serviceName}: ${removed.error ?? removed.message}`);
        break;
      }
    }
  }
  if (failures.length > 0) {
    return { success: false, message: 'Twilio runtime configuration was only partially synchronized', error: failures.join('; ') };
  }
  updateMessagingBinding(latest, 'runtime', {
    configHash: runtimeConfigHash(params.spec),
    credentialHash: credentialsHash(params.credentials),
    serviceSid,
    perServiceKeys: Object.fromEntries(targetServices.map((service) => [service, desiredKeys])),
  });
  return { success: true, message: `Synced Twilio runtime configuration to ${targetServices.join(', ')}`, data: { services: targetServices, keys: desiredKeys } };
}

export function isTwilioMessagingAction(action: PlanAction): boolean {
  return Object.values(MESSAGING_OPERATIONS).includes(
    action.metadata?.operation as typeof MESSAGING_OPERATIONS[keyof typeof MESSAGING_OPERATIONS]
  );
}

export async function applyTwilioMessagingAction(params: {
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const spec = params.environmentSpec.messaging;
  if (!spec) return stale('Messaging desired state was removed.');
  const environment = environmentRepo.findByProjectAndName(params.project.id, params.environmentName);
  if (!environment) return stale('The environment is not tracked locally.');
  const connection = twilioConnection(params.project);
  if ('error' in connection) {
    return { success: false, status: 'blocked', message: 'Twilio connection unavailable', error: connection.error };
  }
  switch (params.action.metadata?.operation) {
    case MESSAGING_OPERATIONS.serviceEnsure:
    case MESSAGING_OPERATIONS.serviceAdopt:
      return applyService({ project: params.project, environment, spec, action: params.action, adapter: connection.adapter });
    case MESSAGING_OPERATIONS.senderAttach:
    case MESSAGING_OPERATIONS.senderMove:
      return applySender({ environment, spec, action: params.action, adapter: connection.adapter });
    case MESSAGING_OPERATIONS.runtimeSync:
      return applyRuntime({ project: params.project, environment, environmentSpec: params.environmentSpec, spec, action: params.action, credentials: connection.credentials });
    default:
      return stale('The operation is not a supported Twilio messaging action.');
  }
}
