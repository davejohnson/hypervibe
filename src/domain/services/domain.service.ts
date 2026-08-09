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
import {
  callCustomDomainDetach,
  callCustomDomainAttach,
  callCustomDomainRecreate,
  customDomainAttachBindingMissingMessage,
  customDomainAttachUnsupportedMessage,
  supportsCustomDomainAttach,
  supportsCustomDomainDetach,
  type DomainAttachCapableAdapter,
} from './domain-attach-policy.js';
import {
  normalizeProviderDnsRecord,
  providerDnsRecordShouldBeProxied,
  type NormalizedDnsRecord,
  type ProviderDnsRecord,
} from './domain-dns-records.js';
import { cloudflareScopeHintsForDomain, dnsZoneScopeForDomain, normalizeDomainName } from './domain-scope.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { parseHostingBindings } from '../ports/hosting.port.js';

const connectionRepo = new ConnectionRepository();

type HostingBindings = {
  projectId?: string;
  environmentId?: string;
  services?: Record<string, { serviceId?: string; url?: string }>;
};

export interface DomainDnsRecordResult {
  id: string;
  name: string;
  type: string;
  target: string;
  action: string;
}

export interface DomainTeardownResult {
  success: boolean;
  error?: string;
  hostingDetached?: boolean;
  deletedDnsRecordIds?: string[];
  customDomainId?: string;
}

export interface DomainSetupResult {
  success: boolean;
  pending?: boolean;
  error?: string;
  /** Machine-readable failure reason for error-code mapping. */
  reason?: 'no_connection' | 'no_zone';
  zone?: { id: string; name: string; status: string };
  hostingProvider?: string;
  service?: string;
  customDomainAttached?: boolean;
  customDomainId?: string;
  recreated?: boolean;
  providerVerified?: boolean;
  customDomainError?: string;
  dnsConfigured?: boolean;
  dnsRecords?: DomainDnsRecordResult[];
  dnsError?: string;
  verification?: {
    zoneStatus: string;
    customDomainAttached: boolean;
    dnsConfigured: boolean;
    providerVerified?: boolean;
  };
}

/**
 * One-call custom-domain setup, mirroring the domain orchestration that
 * bootstrap/infra_apply performs: Cloudflare zone check, hosting
 * custom-domain attach, DNS record upsert,
 * then a verification summary.
 */
export async function setupCustomDomain(params: {
  project: Project;
  environment: Environment;
  domain: string;
  serviceName?: string;
  trafficProxied?: boolean;
  recreate?: boolean;
}): Promise<DomainSetupResult> {
  const { project, environment } = params;
  const domain = normalizeDomainName(params.domain);
  const scopeHints = getProjectScopeHints(project);
  const zoneScope = dnsZoneScopeForDomain(domain);
  const cloudflareScopeHints = cloudflareScopeHintsForDomain(domain, scopeHints);

  // Step 1: Cloudflare zone check.
  const cfConnection = connectionRepo.findBestVerifiedMatchFromHints('cloudflare', cloudflareScopeHints);
  if (!cfConnection) {
    return {
      success: false,
      reason: 'no_connection',
      error: `No verified Cloudflare connection available for DNS zone ${zoneScope} (needed by ${domain}). ${formatConnectionGuidance('cloudflare', { scope: zoneScope })}`,
    };
  }
  const cfAdapter = new CloudflareAdapter();
  cfAdapter.connect(getSecretStore().decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted));
  const zone = (await cfAdapter.findZoneByName(domain)) ?? (await cfAdapter.findZoneByName(zoneScope));
  if (!zone) {
    return {
      success: false,
      reason: 'no_zone',
      error: `Cloudflare zone not found for ${zoneScope} (needed by ${domain}). Add the zone to Cloudflare or use a token scoped to it. ${formatConnectionGuidance('cloudflare', { scope: zoneScope })}`,
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

  let providerDnsRecords: ProviderDnsRecord[] = [];
  const adapterResult = await adapterFactory.getProviderAdapter(provider, project);
  const adapter = adapterResult.adapter as DomainAttachCapableAdapter | undefined;

  if (!adapterResult.success) {
    result.customDomainAttached = false;
    result.customDomainError = adapterResult.error || customDomainAttachUnsupportedMessage(provider, domain);
  } else if (serviceName && binding?.serviceId && bindings.environmentId) {
    if (supportsCustomDomainAttach(adapter)) {
      try {
        const receipt = params.recreate
          ? await callCustomDomainRecreate(adapter, {
              projectId: bindings.projectId,
              serviceId: binding.serviceId,
              environmentId: bindings.environmentId,
              domain,
              dnsZone: zone.name,
            })
          : await callCustomDomainAttach(adapter, {
              projectId: bindings.projectId,
              serviceId: binding.serviceId,
              environmentId: bindings.environmentId,
              domain,
              dnsZone: zone.name,
            });
        if (receipt.success) {
          result.customDomainAttached = true;
          if (typeof receipt.data?.customDomainId === 'string') {
            result.customDomainId = receipt.data.customDomainId;
          }
          if (receipt.data?.recreated === true) {
            result.recreated = true;
          }
          if (typeof receipt.data?.providerVerified === 'boolean') {
            result.providerVerified = receipt.data.providerVerified;
          }
          providerDnsRecords = Array.isArray(receipt.data?.dnsRecords)
            ? (receipt.data.dnsRecords as ProviderDnsRecord[])
            : [];
        } else {
          result.customDomainAttached = false;
          result.customDomainError = receipt.error || receipt.message;
        }
      } catch (error) {
        result.customDomainAttached = false;
        result.customDomainError = error instanceof Error ? error.message : String(error);
      }
    } else {
      result.customDomainAttached = false;
      result.customDomainError = customDomainAttachUnsupportedMessage(provider, domain);
    }
  } else {
    result.customDomainAttached = false;
    result.customDomainError = customDomainAttachBindingMissingMessage(provider, domain);
  }

  // Step 3: write only records returned by a successful provider attachment.
  const dnsResults: DomainDnsRecordResult[] = [];
  try {
    if (providerDnsRecords.length > 0) {
      const normalizedRecords = providerDnsRecords
        .map(normalizeProviderDnsRecord)
        .filter((record): record is NormalizedDnsRecord => Boolean(record));
      const recordGroups = new Map<string, NormalizedDnsRecord[]>();
      for (const record of normalizedRecords) {
        const key = `${record.name}\u0000${record.type}`;
        recordGroups.set(key, [...(recordGroups.get(key) ?? []), record]);
      }
      for (const records of recordGroups.values()) {
        const first = records[0]!;
        const proxyModes = new Set(records.map((record) =>
          providerDnsRecordShouldBeProxied(record, params.trafficProxied)
        ));
        if (proxyModes.size !== 1) {
          throw new Error(`${provider} returned conflicting proxy requirements for ${first.type} ${first.name}.`);
        }
        const proxied = [...proxyModes][0]!;
        const values = Array.from(new Set(records.map((record) => record.value)));
        if (values.length === 1) {
          const upsert = await cfAdapter.upsertDnsRecord(
            zone.id,
            first.name,
            first.type,
            values[0]!,
            { proxied }
          );
          dnsResults.push({
            id: upsert.record.id,
            name: first.name,
            type: first.type,
            target: values[0]!,
            action: upsert.action,
          });
          continue;
        }
        const ensured = await cfAdapter.ensureRecords(
          zone.id,
          first.name,
          first.type,
          values,
          { proxied, pruneExtras: false }
        );
        for (const record of ensured.records) {
          dnsResults.push({
            id: record.id,
            name: first.name,
            type: first.type,
            target: record.content,
            action: ensured.created.includes(record.content) ? 'created' : 'updated',
          });
        }
      }
      result.dnsConfigured = dnsResults.length > 0 && dnsResults.length === normalizedRecords.length;
      if (normalizedRecords.length === 0) {
        result.dnsError = `${provider} returned no usable DNS records for ${domain}`;
      } else if (dnsResults.length !== normalizedRecords.length) {
        result.dnsError = `${provider} returned DNS records for ${domain}, but Hypervibe could not write all required records.`;
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
    } else {
      result.dnsConfigured = false;
      result.dnsError = `Custom-domain attachment was not verified on ${provider}; DNS was not changed for ${domain}.`;
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
    ...(typeof result.providerVerified === 'boolean'
      ? { providerVerified: result.providerVerified }
      : {}),
  };
  result.pending = result.dnsConfigured === true
    && result.customDomainAttached === true
    && result.providerVerified !== true;
  result.success = result.dnsConfigured === true && result.pending !== true;
  return result;
}

function dnsTargetMatches(type: string, observed: string, expected: string): boolean {
  if (type.toUpperCase() === 'CNAME') {
    return observed.trim().replace(/\.$/, '').toLowerCase()
      === expected.trim().replace(/\.$/, '').toLowerCase();
  }
  return observed === expected;
}

/**
 * Remove one previously recorded environment domain. The durable provider and
 * Cloudflare ids are validated before the provider attachment is touched;
 * provider absence is then verified before exact managed DNS records are
 * deleted. A partial failure preserves the binding so the same action retries.
 */
export async function teardownCustomDomain(params: {
  project: Project;
  environment: Environment;
  domain: string;
}): Promise<DomainTeardownResult> {
  const domain = normalizeDomainName(params.domain);
  const bindings = parseHostingBindings(params.environment);
  const binding = bindings.domainDns;
  if (
    binding?.name !== domain
    || !bindings.projectId
    || !binding.serviceId
    || !binding.environmentId
    || !binding.providerDomainId
    || !binding.zoneId
    || !Array.isArray(binding.records)
  ) {
    return {
      success: false,
      error: `Cannot detach ${domain}: durable provider and DNS identities are incomplete. Re-run hv_status or restore the reviewed binding before retrying.`,
    };
  }

  const cfConnection = connectionRepo.findBestVerifiedMatchFromHints(
    'cloudflare',
    cloudflareScopeHintsForDomain(domain, getProjectScopeHints(params.project))
  );
  if (!cfConnection) {
    return {
      success: false,
      error: `No verified Cloudflare connection is available to remove the exact managed DNS records for ${domain}.`,
    };
  }
  const cfAdapter = new CloudflareAdapter();
  cfAdapter.connect(getSecretStore().decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted));

  const recordsByType = new Map<string, Awaited<ReturnType<CloudflareAdapter['listDnsRecords']>>>();
  const existingRecordIds: string[] = [];
  for (const expected of binding.records) {
    const type = expected.type.toUpperCase();
    let records = recordsByType.get(type);
    if (!records) {
      records = await cfAdapter.listDnsRecords(binding.zoneId, type);
      recordsByType.set(type, records);
    }
    const observed = records.find((record) => record.id === expected.id);
    if (!observed) continue;
    if (
      normalizeDomainName(observed.name) !== normalizeDomainName(expected.name)
      || observed.type.toUpperCase() !== type
      || !dnsTargetMatches(type, observed.content, expected.target)
    ) {
      return {
        success: false,
        error: `Cloudflare DNS record ${expected.id} no longer matches the reviewed ${type} identity for ${domain}; no provider or DNS mutation was attempted.`,
      };
    }
    existingRecordIds.push(expected.id);
  }

  const provider = hostingProviderForEnvironment(params.project, params.environment);
  const adapterResult = await adapterFactory.getProviderAdapter(provider, params.project);
  const adapter = adapterResult.adapter as DomainAttachCapableAdapter | undefined;
  if (!adapterResult.success || !supportsCustomDomainDetach(adapter)) {
    return {
      success: false,
      error: adapterResult.error
        ?? `${provider} does not implement verified custom-domain detachment for ${domain}.`,
    };
  }
  const detached = await callCustomDomainDetach(adapter, {
    projectId: bindings.projectId,
    serviceId: binding.serviceId,
    environmentId: binding.environmentId,
    domain,
    customDomainId: binding.providerDomainId,
  });
  if (!detached.success) {
    return {
      success: false,
      hostingDetached: false,
      customDomainId: binding.providerDomainId,
      error: detached.error ?? detached.message,
    };
  }

  const deletedDnsRecordIds: string[] = [];
  for (const recordId of existingRecordIds) {
    await cfAdapter.deleteDnsRecord(binding.zoneId, recordId);
    deletedDnsRecordIds.push(recordId);
  }
  return {
    success: true,
    hostingDetached: true,
    customDomainId: binding.providerDomainId,
    deletedDnsRecordIds,
  };
}
