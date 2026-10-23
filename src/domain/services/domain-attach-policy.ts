import type { Receipt } from '../ports/provider.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import type { ObservedState, ObservedService } from '../ports/observe.port.js';
import { z } from 'zod';

export const DOMAIN_DETACH_OPERATION = 'customDomainDetach';
export const DOMAIN_ADOPT_OPERATION = 'customDomainAdopt';
export const DOMAIN_RETARGET_OPERATION = 'customDomainRetarget';

/** The reviewed spec, never a binding's insertion order, owns public traffic. */
export function desiredDomainServiceName(spec: Pick<EnvironmentSpec, 'services'>): string | undefined {
  const candidates = Object.entries(spec.services).filter(([, service]) => (
    service.workloadKind === 'web' && service.public !== false
  ));
  return candidates.length === 1 ? candidates[0]![0] : undefined;
}

export const domainRetargetBindingSchema = z.object({
  name: z.string().min(1),
  providerDomainId: z.string().min(1),
  serviceName: z.string().min(1),
  serviceId: z.string().min(1),
  environmentId: z.string().min(1),
  zoneId: z.string().min(1),
  records: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), type: z.string().min(1), target: z.string().min(1),
  }).strict()),
}).passthrough();

/** A complete scoped observation must identify one exact bound service. */
export function observedDomainService(
  observed: ObservedState | null | undefined,
  target: { projectId?: string; environmentId?: string; serviceName?: string; serviceId?: string }
): ObservedService | undefined {
  if (!observed || observed.partial || observed.completeness?.services === 'unknown'
    || !target.projectId || !target.environmentId || !target.serviceName || !target.serviceId
    || observed.projectId !== target.projectId || observed.environmentId !== target.environmentId) return undefined;
  const matches = observed.services.filter(service => service.name === target.serviceName || service.externalId === target.serviceId);
  return matches.length === 1 && matches[0]!.name === target.serviceName && matches[0]!.externalId === target.serviceId
    ? matches[0] : undefined;
}

export type DomainAttachParams = {
  projectId?: string;
  serviceId: string;
  environmentId: string;
  domain: string;
  dnsZone?: string;
  /** A bound attachment refresh must not create or adopt a replacement identity. */
  customDomainId?: string;
};

export type DomainDetachParams = DomainAttachParams;

export type DomainRecreateParams = DomainAttachParams;

export type DomainAttachCapableAdapter = {
  attachCustomDomain?: (params: DomainAttachParams) => Promise<Receipt>;
  recreateCustomDomain?: (params: DomainRecreateParams) => Promise<Receipt>;
  detachCustomDomain?: (params: DomainDetachParams) => Promise<Receipt>;
};

export type DomainAttachAdapter = DomainAttachCapableAdapter & {
  attachCustomDomain: (params: DomainAttachParams) => Promise<Receipt>;
};

export type DomainRecreateAdapter = DomainAttachCapableAdapter & {
  recreateCustomDomain: (params: DomainRecreateParams) => Promise<Receipt>;
};

export type DomainDetachAdapter = DomainAttachCapableAdapter & {
  detachCustomDomain: (params: DomainDetachParams) => Promise<Receipt>;
};

export function supportsCustomDomainAttach(adapter: unknown): adapter is DomainAttachAdapter {
  return Boolean(adapter)
    && typeof adapter === 'object'
    && typeof (adapter as DomainAttachCapableAdapter).attachCustomDomain === 'function';
}

export async function callCustomDomainAttach(
  adapter: DomainAttachCapableAdapter,
  params: DomainAttachParams
): Promise<Receipt> {
  if (!supportsCustomDomainAttach(adapter)) {
    return {
      success: false,
      message: 'Custom-domain attachment is not supported',
      error: customDomainAttachUnsupportedMessage('provider', params.domain),
    };
  }
  const attachCustomDomain = adapter.attachCustomDomain;
  return attachCustomDomain.call(adapter, params);
}

export function supportsCustomDomainRecreate(adapter: unknown): adapter is DomainRecreateAdapter {
  return Boolean(adapter)
    && typeof adapter === 'object'
    && typeof (adapter as DomainAttachCapableAdapter).recreateCustomDomain === 'function';
}

export async function callCustomDomainRecreate(
  adapter: DomainAttachCapableAdapter,
  params: DomainRecreateParams
): Promise<Receipt> {
  if (!supportsCustomDomainRecreate(adapter)) {
    return {
      success: false,
      message: 'Custom-domain recreation is not supported',
      error: `${params.domain} cannot be recreated because the hosting provider adapter does not implement confirmation-gated custom-domain replacement.`,
    };
  }
  const recreateCustomDomain = adapter.recreateCustomDomain;
  return recreateCustomDomain.call(adapter, params);
}

export function supportsCustomDomainDetach(adapter: unknown): adapter is DomainDetachAdapter {
  return Boolean(adapter)
    && typeof adapter === 'object'
    && typeof (adapter as DomainAttachCapableAdapter).detachCustomDomain === 'function';
}

export async function callCustomDomainDetach(
  adapter: DomainAttachCapableAdapter,
  params: DomainDetachParams
): Promise<Receipt> {
  if (!supportsCustomDomainDetach(adapter)) {
    return {
      success: false,
      message: 'Custom-domain detachment is not supported',
      error: `${params.domain} cannot be detached because the hosting provider adapter does not implement verified custom-domain deletion.`,
    };
  }
  return adapter.detachCustomDomain.call(adapter, params);
}

export function customDomainAttachUnsupportedMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe does not implement that lifecycle for ${provider}. DNS was not changed for ${domain}.`;
}

export function customDomainAttachBindingMissingMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe could not find the provider service/environment binding for ${domain}. Re-run hv_status or hv_plan to refresh repo bindings, then retry.`;
}
