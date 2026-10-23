import type { Environment } from '../entities/environment.entity.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { desiredDomainServiceName } from './domain-attach-policy.js';
import { serviceBindingFor } from './spec.service.js';

export interface EmailCallbackTarget {
  url?: string;
  domainActionId?: string;
  blockedReason?: string;
}

function callbackUrl(base: unknown, path: string): string | undefined {
  if (typeof base !== 'string' || /[\s\\]/u.test(base) || !/^\/(?!\/)/u.test(path) || /[\s\\?#]/u.test(path)) return undefined;
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) return undefined;
    const url = new URL(path, origin);
    return url.origin === origin.origin ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Selects callback ownership only; the domain action owns live readiness. */
export function resolveEmailCallbackTarget(
  environment: Environment | null,
  spec: EnvironmentSpec,
  target: { service: string; path: string }
): EmailCallbackTarget {
  if (spec.domain && !spec.loadBalancer) {
    const owner = desiredDomainServiceName(spec);
    if (!owner || owner === target.service) {
      const domainActionId = `domain:${spec.domain}`;
      const pending = { domainActionId, blockedReason: 'email_callback_domain_pending' };
      const bindings = parseHostingBindings(environment);
      const domain = bindings.domainDns;
      const service = bindings.services?.[target.service];
      if (!owner || bindings.provider !== spec.hosting.provider || !bindings.projectId || !bindings.environmentId
        || !service?.serviceId || domain?.name !== spec.domain || domain.serviceName !== target.service
        || domain.serviceId !== service.serviceId || domain.environmentId !== bindings.environmentId
        || !domain.providerDomainId?.trim() || domain.creationAcknowledged === true) return pending;
      const url = callbackUrl(`https://${spec.domain}`, target.path);
      return url ? { url, domainActionId } : pending;
    }
  }
  const base = environment ? serviceBindingFor(environment, target.service)?.url : undefined;
  const url = callbackUrl(base, target.path);
  return url ? { url } : {};
}
