import type { Environment } from '../entities/environment.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { serviceBindingFor } from './spec.service.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Preserve an accepted callback, without choosing a new custom-domain default. */
export function resolveInboundCallback(params: {
  environment: Environment | null;
  spec: EnvironmentSpec;
  observed?: ObservedState | null;
}): { url?: string; blockedReason?: string } {
  const { environment, spec, observed } = params;
  const target = spec.email.inbound;
  if (!environment || !target) return {};
  const service = serviceBindingFor(environment, target.service);
  let providerUrl: string | undefined;
  try {
    const url = new URL(target.path, String(service?.url));
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) providerUrl = url.toString();
  } catch { /* A new service may not have a URL until its reviewed action runs. */ }

  const accepted = record(record(environment.platformBindings.email).inbound);
  if (typeof accepted.url !== 'string' || accepted.url === providerUrl
    || accepted.hostname !== target.hostname.toLowerCase()
    || accepted.service !== target.service || accepted.path !== target.path) return { url: providerUrl };

  const blocked = { blockedReason: 'The accepted inbound callback cannot be verified against its bound public service. Preserve the existing route and re-plan after its exact attachment is observable.' };
  let url: URL;
  try { url = new URL(accepted.url); } catch { return blocked; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== target.path || url.hostname !== spec.domain?.toLowerCase()
    || !Array.isArray(service?.customDomains) || !service.customDomains.includes(url.hostname)) return blocked;

  const bindings = environment.platformBindings;
  if (!observed || !observed.projectExists || observed.partial || observed.completeness?.services !== 'complete'
    || observed.provider !== bindings.provider
    || typeof bindings.projectId !== 'string' || !bindings.projectId || observed.projectId !== bindings.projectId
    || bindings.environmentId && observed.environmentId !== bindings.environmentId) return blocked;
  const matches = observed.services.filter(item => item.name === target.service);
  const attachments = observed.services.filter(item => item.customDomains.includes(url.hostname));
  const live = matches[0];
  if (matches.length !== 1 || attachments.length !== 1 || attachments[0] !== live
    || !service?.serviceId || live.externalId !== service.serviceId
    || live.workloadKind !== 'web' || live.config.public === false
    || live.customDomainStatus?.[url.hostname]?.providerVerified !== true) return blocked;
  return { url: url.toString() };
}
