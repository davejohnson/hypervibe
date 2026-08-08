import type { Receipt } from '../ports/provider.port.js';

export type DomainAttachParams = {
  projectId?: string;
  serviceId: string;
  environmentId: string;
  domain: string;
};

export type DomainAttachCapableAdapter = {
  attachCustomDomain?: (params: DomainAttachParams) => Promise<Receipt>;
  recreateCustomDomain?: (params: DomainAttachParams) => Promise<Receipt>;
};

export type DomainAttachAdapter = DomainAttachCapableAdapter & {
  attachCustomDomain: (params: DomainAttachParams) => Promise<Receipt>;
};

export type DomainRecreateAdapter = DomainAttachCapableAdapter & {
  recreateCustomDomain: (params: DomainAttachParams) => Promise<Receipt>;
};

const PROVIDERS_REQUIRING_PROVIDER_ATTACH = new Set([
  'cloudrun',
  'railway',
]);

export function providerRequiresCustomDomainAttach(provider: string): boolean {
  return PROVIDERS_REQUIRING_PROVIDER_ATTACH.has(provider.toLowerCase());
}

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
  params: DomainAttachParams
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

export function customDomainAttachUnsupportedMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe does not implement custom-domain attachment for ${provider} yet. DNS was not changed for ${domain}; add an adapter attachCustomDomain implementation for ${provider} or attach the domain in the provider dashboard, then re-run hv_status.`;
}

export function customDomainAttachBindingMissingMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe could not find the provider service/environment binding for ${domain}. Re-run hv_status or hv_plan to refresh repo bindings, then retry.`;
}
