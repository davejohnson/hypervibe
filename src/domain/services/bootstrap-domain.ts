import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import {
  callCustomDomainAttach,
  customDomainAttachBindingMissingMessage,
  customDomainAttachUnsupportedMessage,
  supportsCustomDomainAttach,
  type DomainAttachCapableAdapter,
} from './domain-attach-policy.js';
import {
  normalizeProviderDnsRecord,
  providerDnsRecordShouldBeProxied,
  type NormalizedDnsRecord,
} from './domain-dns-records.js';
import { cloudflareScopeHintsForDomain, dnsZoneScopeForDomain, normalizeDomainName } from './domain-scope.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import { parseHostingBindings, type IHostingAdapter } from '../ports/hosting.port.js';

const envRepo = new EnvironmentRepository();
const connectionRepo = new ConnectionRepository();

/**
 * Custom-domain leg of executeBootstrap: attach the domain on the provider
 * (required for managed hosts), write the provider's required DNS records to
 * Cloudflare. Mutates `summary` in place, matching the inline behavior this
 * was extracted from.
 */
export async function attachBootstrapDomain(args: {
  domain: string;
  environment: Environment;
  hostingAdapter: IHostingAdapter;
  serviceWorkloads: Service[];
  scopeHints: string[];
  targetPlatform: string;
  summary: Record<string, unknown>;
}): Promise<void> {
  const { domain, environment, hostingAdapter, serviceWorkloads, scopeHints, targetPlatform, summary } = args;
  const secretStore = getSecretStore();
  const normalizedDomain = normalizeDomainName(domain);
  const zoneScope = dnsZoneScopeForDomain(normalizedDomain);
  const cloudflareScopeHints = cloudflareScopeHintsForDomain(normalizedDomain, scopeHints);

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

    if (targetService && targetServiceId && boundEnvironmentId && supportsCustomDomainAttach(domainAdapter)) {
      const receipt = await callCustomDomainAttach(domainAdapter, {
        projectId: boundProjectId,
        serviceId: targetServiceId,
        environmentId: boundEnvironmentId,
        domain,
      });

      if (!receipt.success) {
        summary.customDomainAttached = false;
        summary.customDomainError = receipt.error || receipt.message;
      } else {
        summary.customDomainAttached = true;
        summary.customDomain = {
          domain,
          service: targetService.name,
          created: receipt.data?.created === true,
        };

        const dnsRecords = Array.isArray(receipt.data?.dnsRecords)
          ? receipt.data.dnsRecords as Array<Record<string, unknown>>
          : [];
        const cfConnection = connectionRepo.findBestVerifiedMatchFromHints('cloudflare', cloudflareScopeHints);

        if (!cfConnection) {
          summary.domainDnsConfigured = false;
          summary.domainDnsError = `No verified Cloudflare connection available for DNS zone ${zoneScope} (needed by ${normalizedDomain}). ${formatConnectionGuidance('cloudflare', { scope: zoneScope })}`;
        } else {
          const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
          const cfAdapter = new CloudflareAdapter();
          cfAdapter.connect(cfCreds);
          const zone = (await cfAdapter.findZoneByName(normalizedDomain)) ?? (await cfAdapter.findZoneByName(zoneScope));
          if (!zone) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `Cloudflare zone not found for ${zoneScope} (needed by ${normalizedDomain})`;
          } else if (dnsRecords.length === 0) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `${domainProvider} did not return required DNS records for ${domain}`;
          } else {
            const normalizedRecords = dnsRecords
              .map(normalizeProviderDnsRecord)
              .filter((record): record is NormalizedDnsRecord => Boolean(record));
            const results: Array<{ name: string; type: string; target: string; action: string }> = [];
            for (const record of normalizedRecords) {
              const { name, type, value } = record;
              const upsert = await cfAdapter.upsertDnsRecord(zone.id, name, type, value, {
                proxied: providerDnsRecordShouldBeProxied(record),
              });
              results.push({ name, type, target: value, action: upsert.action });
            }
            summary.domainDnsConfigured = results.length > 0 && results.length === normalizedRecords.length;
            summary.domainDnsRecords = results;
            if (normalizedRecords.length === 0) {
              summary.domainDnsError = `${domainProvider} returned no usable DNS records for ${domain}`;
            } else if (results.length !== normalizedRecords.length) {
              summary.domainDnsError = `${domainProvider} returned DNS records for ${domain}, but Hypervibe could not write all required records.`;
            }
          }
        }
      }
    } else {
      summary.customDomainAttached = false;
      summary.customDomainError = targetService && targetServiceId && boundEnvironmentId
        ? customDomainAttachUnsupportedMessage(domainProvider, domain)
        : customDomainAttachBindingMissingMessage(domainProvider, domain);
    }
  } catch (error) {
    summary.customDomainAttached = false;
    summary.customDomainError = error instanceof Error ? error.message : String(error);
    summary.domainDnsConfigured = false;
  }
}
