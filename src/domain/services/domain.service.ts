import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import {
  CloudflareAdapter,
  type CloudflareCredentials,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { adapterFactory } from './adapter.factory.js';
import { getProjectScopeHints } from './project-scope.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Receipt } from '../ports/provider.port.js';

const connectionRepo = new ConnectionRepository();

/** Hosting adapters that can attach a custom domain to a deployed service (e.g. Railway). */
type DomainCapableAdapter = {
  attachCustomDomain?: (params: { projectId?: string; serviceId: string; environmentId: string; domain: string }) => Promise<Receipt>;
};

type HostingBindings = {
  projectId?: string;
  environmentId?: string;
  services?: Record<string, { serviceId?: string; url?: string }>;
};

export interface DomainDnsRecordResult {
  name: string;
  type: string;
  target: string;
  action: string;
}

export interface DomainSetupResult {
  success: boolean;
  error?: string;
  /** Machine-readable failure reason for error-code mapping. */
  reason?: 'no_connection' | 'no_zone';
  zone?: { id: string; name: string; status: string };
  hostingProvider?: string;
  service?: string;
  customDomainAttached?: boolean;
  customDomainError?: string;
  dnsConfigured?: boolean;
  dnsRecords?: DomainDnsRecordResult[];
  dnsError?: string;
  verification?: {
    zoneStatus: string;
    customDomainAttached: boolean;
    dnsConfigured: boolean;
  };
}

function apexOf(domain: string): string {
  const parts = domain.split('.');
  return parts.length <= 2 ? domain : parts.slice(-2).join('.');
}

/**
 * One-call custom-domain setup, mirroring the domain orchestration that
 * bootstrap/infra_apply performs: Cloudflare zone check, hosting
 * custom-domain attach (when the adapter supports it), DNS record upsert,
 * then a verification summary.
 */
export async function setupCustomDomain(params: {
  project: Project;
  environment: Environment;
  domain: string;
  serviceName?: string;
}): Promise<DomainSetupResult> {
  const { project, environment } = params;
  const domain = params.domain.trim().toLowerCase();
  const scopeHints = getProjectScopeHints(project);

  // Step 1: Cloudflare zone check.
  const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [domain, apexOf(domain), ...scopeHints]);
  if (!cfConnection) {
    return {
      success: false,
      reason: 'no_connection',
      error: `No Cloudflare connection available for ${domain}. ${formatConnectionGuidance('cloudflare', { scope: domain })}`,
    };
  }
  const cfAdapter = new CloudflareAdapter();
  cfAdapter.connect(getSecretStore().decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted));
  const zone = (await cfAdapter.findZoneByName(domain)) ?? (await cfAdapter.findZoneByName(apexOf(domain)));
  if (!zone) {
    return {
      success: false,
      reason: 'no_zone',
      error: `Cloudflare zone not found for ${domain}. Add the domain to Cloudflare or use a token scoped to it. ${formatConnectionGuidance('cloudflare', { scope: domain })}`,
    };
  }

  const result: DomainSetupResult = {
    success: false,
    zone: { id: zone.id, name: zone.name, status: zone.status },
  };

  // Step 2: Attach the custom domain on the hosting provider when supported.
  const bindings = (environment.platformBindings ?? {}) as HostingBindings;
  const services = bindings.services ?? {};
  const serviceName = params.serviceName ?? Object.keys(services)[0];
  const binding = serviceName ? services[serviceName] : undefined;
  const provider = hostingProviderForEnvironment(project, environment);
  result.hostingProvider = provider;
  result.service = serviceName;

  let providerDnsRecords: Array<Record<string, unknown>> = [];
  if (serviceName && binding?.serviceId && bindings.environmentId) {
    const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
    const adapter = adapterResult.adapter as DomainCapableAdapter | undefined;
    if (adapterResult.success && adapter && typeof adapter.attachCustomDomain === 'function') {
      try {
        const receipt = await adapter.attachCustomDomain({
          projectId: bindings.projectId,
          serviceId: binding.serviceId,
          environmentId: bindings.environmentId,
          domain,
        });
        if (receipt.success) {
          result.customDomainAttached = true;
          providerDnsRecords = Array.isArray(receipt.data?.dnsRecords)
            ? (receipt.data.dnsRecords as Array<Record<string, unknown>>)
            : [];
        } else {
          result.customDomainAttached = false;
          result.customDomainError = receipt.error || receipt.message;
        }
      } catch (error) {
        result.customDomainAttached = false;
        result.customDomainError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // Step 3: DNS records — provider-required records when the attach returned
  // them, otherwise a proxied CNAME to the deployed service URL.
  const dnsResults: DomainDnsRecordResult[] = [];
  try {
    if (providerDnsRecords.length > 0) {
      for (const record of providerDnsRecords) {
        const name = typeof record.name === 'string' ? record.name : '';
        const type = typeof record.type === 'string' ? record.type : '';
        const value = typeof record.value === 'string' ? record.value : '';
        if (!name || !type || !value) continue;
        const upsert = await cfAdapter.upsertDnsRecord(zone.id, name, type, value, { proxied: false });
        dnsResults.push({ name, type, target: value, action: upsert.action });
      }
      result.dnsConfigured = dnsResults.length > 0;
      if (dnsResults.length === 0) {
        result.dnsError = `${provider} returned no usable DNS records for ${domain}`;
      }
    } else if (result.customDomainAttached) {
      // Attached but the provider reported no records to create.
      result.dnsConfigured = false;
      result.dnsError = `${provider} did not return DNS records for ${domain}; check the provider dashboard for required records.`;
    } else if (result.customDomainAttached === false) {
      result.dnsConfigured = false;
      result.dnsError = result.customDomainError
        ? `Custom-domain attach failed on ${provider}: ${result.customDomainError}`
        : `Custom-domain attach failed on ${provider}; DNS was not changed because the provider has not accepted ${domain}.`;
    } else if (binding?.url) {
      const targetHost = new URL(binding.url).hostname;
      const upsert = await cfAdapter.upsertDnsRecord(zone.id, domain, 'CNAME', targetHost, { proxied: true });
      dnsResults.push({ name: domain, type: 'CNAME', target: targetHost, action: upsert.action });
      result.dnsConfigured = true;
    } else {
      result.dnsConfigured = false;
      result.dnsError = serviceName
        ? `Service "${serviceName}" has no deployed URL in ${environment.name}; deploy it first, then retry.`
        : `No services are bound in ${environment.name}; deploy first, then retry.`;
    }
  } catch (error) {
    result.dnsConfigured = false;
    result.dnsError = error instanceof Error ? error.message : String(error);
  }
  result.dnsRecords = dnsResults;

  // Step 4: Verification status.
  result.verification = {
    zoneStatus: zone.status,
    customDomainAttached: result.customDomainAttached ?? false,
    dnsConfigured: result.dnsConfigured ?? false,
  };
  result.success = result.dnsConfigured === true;
  return result;
}
