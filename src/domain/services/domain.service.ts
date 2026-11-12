import { adapterFactory } from './adapter.factory.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { callCustomDomainAttach, callCustomDomainDetach, callCustomDomainRecreate,
  customDomainAttachBindingMissingMessage, customDomainAttachUnsupportedMessage,
  supportsCustomDomainAttach, supportsCustomDomainDetach, type DomainAttachCapableAdapter } from './domain-attach-policy.js';
import { dnsZoneScopeForDomain, normalizeDomainName } from './domain-scope.js';
import { normalizeProviderDnsRecord, type NormalizedDnsRecord } from './domain-dns-records.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { parseHostingBindings } from '../ports/hosting.port.js';

export interface DomainDnsRecordResult { id: string; name: string; type: string; target: string; action: string }
export interface DomainTeardownResult {
  success: boolean; error?: string; hostingDetached?: boolean; deletedDnsRecordIds?: string[]; customDomainId?: string;
}
export interface DomainSetupResult {
  success: boolean; pending?: boolean; error?: string; reason?: 'no_connection' | 'no_zone';
  zone?: { id: string; name: string; status: string };
  hostingProvider?: string; service?: string; customDomainAttached?: boolean; customDomainId?: string;
  recreated?: boolean; providerVerified?: boolean; customDomainError?: string; dnsConfigured?: boolean;
  dnsRecords?: DomainDnsRecordResult[]; requiredDnsRecords?: NormalizedDnsRecord[]; dnsError?: string;
  verification?: { zoneStatus: string; customDomainAttached: boolean; dnsConfigured: boolean; providerVerified?: boolean };
}

/**
 * Hosting attachment only. DNS requirements are an observation for the next
 * saved OpenTofu plan, never authority to write DNS during this action.
 */
export async function setupCustomDomain(params: {
  project: Project; environment: Environment; domain: string; serviceName?: string;
  trafficProxied?: boolean; recreate?: boolean; dnsZone?: string;
}): Promise<DomainSetupResult> {
  const domain = normalizeDomainName(params.domain);
  const bindings = parseHostingBindings(params.environment);
  const services = bindings.services ?? {};
  const serviceName = params.serviceName ?? (Object.keys(services).length === 1 ? Object.keys(services)[0] : bindings.domainDns?.serviceName);
  const service = serviceName ? services[serviceName] : undefined;
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const result: DomainSetupResult = { success: false, hostingProvider: provider, service: serviceName, dnsConfigured: false, dnsRecords: [] };
  const failed = (error: string): DomainSetupResult => ({ ...result, customDomainAttached: false, customDomainError: error,
    dnsError: `Custom-domain attach failed on ${provider}: ${error}` });
  if (!serviceName || !service?.serviceId || !bindings.projectId || !bindings.environmentId) {
    return failed(customDomainAttachBindingMissingMessage(provider, domain));
  }
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  const adapter = adapterResult.adapter as DomainAttachCapableAdapter | undefined;
  if (!adapterResult.success || !supportsCustomDomainAttach(adapter)) {
    return failed(adapterResult.error ?? customDomainAttachUnsupportedMessage(provider, domain));
  }
  try {
    const target = { projectId: bindings.projectId, serviceId: service.serviceId,
      environmentId: bindings.environmentId, domain, dnsZone: params.dnsZone ?? dnsZoneScopeForDomain(domain) };
    const receipt = params.recreate ? await callCustomDomainRecreate(adapter, target) : await callCustomDomainAttach(adapter, target);
    if (!receipt.success || typeof receipt.data?.customDomainId !== 'string' || !receipt.data.customDomainId) {
      return failed(receipt.error ?? (receipt.success ? 'The provider did not return the exact custom-domain identity.' : receipt.message));
    }
    const records = Array.isArray(receipt.data.dnsRecords) ? receipt.data.dnsRecords : [];
    return { ...result, customDomainAttached: true, customDomainId: receipt.data.customDomainId,
      ...(receipt.data.recreated === true ? { recreated: true } : {}),
      ...(typeof receipt.data.providerVerified === 'boolean' ? { providerVerified: receipt.data.providerVerified } : {}),
      requiredDnsRecords: records.map(normalizeProviderDnsRecord).filter((record): record is NormalizedDnsRecord => !!record),
      pending: true,
      dnsError: 'The hosting attachment is recorded. Run hv_plan to review its DNS records through OpenTofu.',
      verification: { zoneStatus: 'not_observed', customDomainAttached: true, dnsConfigured: false,
        ...(typeof receipt.data.providerVerified === 'boolean' ? { providerVerified: receipt.data.providerVerified } : {}) },
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** DNS must be removed by its saved engine plan before releasing the hosting claim. */
export async function teardownCustomDomain(params: {
  project: Project; environment: Environment; domain: string;
  /** Fresh application-level check of the retained exact zone and public traffic absence. */
  verifiedDnsAbsence?: { zoneFingerprint: string; connectionId: string };
}): Promise<DomainTeardownResult> {
  const domain = normalizeDomainName(params.domain);
  const bindings = parseHostingBindings(params.environment);
  const binding = bindings.domainDns;
  if (binding?.name !== domain || !bindings.projectId || !binding.serviceId || !binding.environmentId || !binding.providerDomainId) {
    return { success: false, error: `Cannot detach ${domain}: durable provider identities are incomplete. Refresh the exact binding before retrying.` };
  }
  const cancelledBeforeDns = binding.dnsStagePending === true && binding.dnsSelection && !binding.zoneId
    && Array.isArray(binding.records) && binding.records.length === 0
    && params.verifiedDnsAbsence?.zoneFingerprint && params.verifiedDnsAbsence.connectionId;
  if (binding.dnsEngineRemoved !== true && !cancelledBeforeDns) {
    return { success: false, error: `Preserve the hosting claim for ${domain} until its owned DNS is removed by a reviewed OpenTofu plan. Existing records need explicit engine adoption before teardown.` };
  }
  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  const adapter = adapterResult.adapter as DomainAttachCapableAdapter | undefined;
  if (!adapterResult.success || !supportsCustomDomainDetach(adapter)) {
    return { success: false, error: adapterResult.error ?? `${provider} does not implement verified custom-domain detachment for ${domain}.` };
  }
  const detached = await callCustomDomainDetach(adapter, { projectId: bindings.projectId, serviceId: binding.serviceId,
    environmentId: binding.environmentId, domain, customDomainId: binding.providerDomainId });
  return detached.success
    ? { success: true, hostingDetached: true, customDomainId: binding.providerDomainId, deletedDnsRecordIds: [] }
    : { success: false, hostingDetached: false, customDomainId: binding.providerDomainId, error: detached.error ?? detached.message };
}
