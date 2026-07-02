import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import {
  callCustomDomainAttach,
  customDomainAttachBindingMissingMessage,
  customDomainAttachUnsupportedMessage,
  providerRequiresCustomDomainAttach,
  supportsCustomDomainAttach,
  type DomainAttachCapableAdapter,
} from './domain-attach-policy.js';
import { normalizeProviderDnsRecord, type NormalizedDnsRecord } from './domain-dns-records.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import { parseHostingBindings, type IHostingAdapter } from '../ports/hosting.port.js';

const envRepo = new EnvironmentRepository();
const connectionRepo = new ConnectionRepository();

/**
 * Custom-domain leg of executeBootstrap: attach the domain on the provider
 * (required for managed hosts), write the provider's required DNS records to
 * Cloudflare, and fall back to a plain CNAME only for providers that do not
 * require provider-side attachment. Mutates `summary` in place, matching the
 * inline behavior this was extracted from.
 */
export async function attachBootstrapDomain(args: {
  domain: string;
  environment: Environment;
  hostingAdapter: IHostingAdapter;
  serviceWorkloads: Service[];
  scopeHints: string[];
  targetPlatform: string;
  deployUrls: string[];
  summary: Record<string, unknown>;
}): Promise<void> {
  const { domain, environment, hostingAdapter, serviceWorkloads, scopeHints, targetPlatform, deployUrls, summary } = args;
  const secretStore = getSecretStore();

  let providerDomainConfigured = false;
  let providerDomainAttachFailed = false;

  try {
    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const latestBindings = parseHostingBindings(latestEnvironment);
    const boundServices = latestBindings.services ?? {};
    const boundProjectId = latestBindings.projectId;
    const boundEnvironmentId = latestBindings.environmentId ?? null;
    const domainAdapter = hostingAdapter as IHostingAdapter & DomainAttachCapableAdapter;
    const targetService = serviceWorkloads[0];
    const targetServiceId = targetService ? boundServices[targetService.name]?.serviceId : undefined;
    const domainProvider = hostingAdapter.name || targetPlatform;
    const requiresProviderAttach = providerRequiresCustomDomainAttach(domainProvider);

    if (targetService && targetServiceId && boundEnvironmentId && supportsCustomDomainAttach(domainAdapter)) {
      const receipt = await callCustomDomainAttach(domainAdapter, {
        projectId: boundProjectId,
        serviceId: targetServiceId,
        environmentId: boundEnvironmentId,
        domain,
      });

      if (!receipt.success) {
        providerDomainAttachFailed = true;
        summary.customDomainAttached = false;
        summary.customDomainError = receipt.error || receipt.message;
      } else {
        providerDomainConfigured = true;
        summary.customDomainAttached = true;
        summary.customDomain = {
          domain,
          service: targetService.name,
          created: receipt.data?.created === true,
        };

        const dnsRecords = Array.isArray(receipt.data?.dnsRecords)
          ? receipt.data.dnsRecords as Array<Record<string, unknown>>
          : [];
        const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [domain, ...scopeHints]);

        if (!cfConnection) {
          summary.domainDnsConfigured = false;
          summary.domainDnsError = `No Cloudflare connection available for ${domain}. ${formatConnectionGuidance('cloudflare', { scope: domain })}`;
        } else {
          const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
          const cfAdapter = new CloudflareAdapter();
          cfAdapter.connect(cfCreds);
          const zone = await cfAdapter.findZoneByName(domain);
          if (!zone) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `Cloudflare zone not found for ${domain}`;
          } else if (dnsRecords.length === 0) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `Railway did not return required DNS records for ${domain}`;
          } else {
            const normalizedRecords = dnsRecords
              .map(normalizeProviderDnsRecord)
              .filter((record): record is NormalizedDnsRecord => Boolean(record));
            const results: Array<{ name: string; type: string; target: string; action: string }> = [];
            for (const { name, type, value } of normalizedRecords) {
              const upsert = await cfAdapter.upsertDnsRecord(zone.id, name, type, value, {
                proxied: false,
              });
              results.push({ name, type, target: value, action: upsert.action });
            }
            summary.domainDnsConfigured = results.length > 0 && results.length === normalizedRecords.length;
            summary.domainDnsRecords = results;
            if (normalizedRecords.length === 0) {
              summary.domainDnsError = `Railway returned no usable DNS records for ${domain}`;
            } else if (results.length !== normalizedRecords.length) {
              summary.domainDnsError = `Railway returned DNS records for ${domain}, but Hypervibe could not write all required records.`;
            }
          }
        }
      }
    } else if (requiresProviderAttach) {
      providerDomainAttachFailed = true;
      summary.customDomainAttached = false;
      summary.customDomainError = targetService && targetServiceId && boundEnvironmentId
        ? customDomainAttachUnsupportedMessage(domainProvider, domain)
        : customDomainAttachBindingMissingMessage(domainProvider, domain);
    }
  } catch (error) {
    providerDomainAttachFailed = true;
    summary.customDomainAttached = false;
    summary.customDomainError = error instanceof Error ? error.message : String(error);
    summary.domainDnsConfigured = false;
  }

  if (!providerDomainConfigured && !providerDomainAttachFailed && deployUrls[0]) {
    try {
      const targetHost = new URL(deployUrls[0]).hostname;
      const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [domain, ...scopeHints]);
      if (cfConnection) {
        const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
        const cfAdapter = new CloudflareAdapter();
        cfAdapter.connect(cfCreds);
        const zone = await cfAdapter.findZoneByName(domain);
        if (zone) {
          const result = await cfAdapter.upsertDnsRecord(zone.id, domain, 'CNAME', targetHost, { proxied: true });
          summary.domainDnsConfigured = true;
          summary.domainDns = { name: domain, type: 'CNAME', target: targetHost, action: result.action };
        } else {
          summary.domainDnsConfigured = false;
          summary.domainDnsError = `Cloudflare zone not found for ${domain}`;
        }
      } else {
        summary.domainDnsConfigured = false;
        summary.domainDnsError = `No Cloudflare connection available for ${domain}. ${formatConnectionGuidance('cloudflare', { scope: domain })}`;
      }
    } catch {
      summary.domainDnsConfigured = false;
    }
  }
}
