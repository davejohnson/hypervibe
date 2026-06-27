import type { Receipt } from '../ports/provider.port.js';

export type DomainAttachParams = {
  projectId?: string;
  serviceId: string;
  environmentId: string;
  domain: string;
};

export type DomainAttachCapableAdapter = {
  attachCustomDomain?: (params: DomainAttachParams) => Promise<Receipt>;
};

const PROVIDERS_REQUIRING_PROVIDER_ATTACH = new Set([
  'apprunner',
  'cloudrun',
  'digitalocean',
  'heroku',
  'railway',
  'render',
  'vercel',
]);

export function providerRequiresCustomDomainAttach(provider: string): boolean {
  return PROVIDERS_REQUIRING_PROVIDER_ATTACH.has(provider.toLowerCase());
}

export function supportsCustomDomainAttach(adapter: unknown): adapter is DomainAttachCapableAdapter {
  return Boolean(adapter)
    && typeof adapter === 'object'
    && typeof (adapter as DomainAttachCapableAdapter).attachCustomDomain === 'function';
}

export function customDomainAttachUnsupportedMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe does not implement custom-domain attachment for ${provider} yet. DNS was not changed for ${domain}; add an adapter attachCustomDomain implementation for ${provider} or attach the domain in the provider dashboard, then re-run hv_status.`;
}

export function customDomainAttachBindingMissingMessage(provider: string, domain: string): string {
  return `${provider} requires provider-side custom-domain attachment before DNS is changed, but Hypervibe could not find the provider service/environment binding for ${domain}. Re-run hv_status or hv_plan to refresh repo bindings, then retry.`;
}
