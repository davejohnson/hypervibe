import type { DnsZoneIdentity } from '../ports/dns.port.js';
import { dnsHostnameBelongsToZone, dnsSpecSchema, type DnsSecurityPolicy, type DnsSpec } from '../spec/dns.schema.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';

export type ResolvedDnsPolicy = Required<DnsSecurityPolicy>;
export type DnsPolicyCheck = 'satisfied' | 'preserved' | 'pending' | 'unknown' | 'blocked';

/** Observations must come from exact scoped provider reads, never desired state. */
export interface DnsSecurityObservation {
  dnssec?: 'enabled' | 'disabled' | 'unknown';
  dnssecValidation?: 'validated' | 'not_validated' | 'unknown';
  /** Effective issuer restrictions, including inherited CAA and wildcard applicability. */
  caa?: { state: 'known'; issuers: string[] } | { state: 'unknown' };
  tls?: 'ready' | 'pending' | 'unknown';
  /** Exact existing traffic record observation; verification records remain unproxied. */
  proxy?: boolean;
}

export interface DnsPolicyInput {
  environmentSpec: EnvironmentSpec;
  /** A historical binding is only eligible after exact current ownership is verified. */
  legacyOwnership?: { state: 'unknown' } | {
    state: 'verified'; hostname: string; identity: DnsZoneIdentity; recordIds: string[]; connectionScope?: string;
  };
  /** Existing owned DNS cannot silently move to another provider, account or zone. */
  existingIdentity?: DnsZoneIdentity;
  securityObservation?: DnsSecurityObservation;
  /** Capabilities of the complete selected workflow, not just the provider API. */
  capabilities?: { privateZones?: boolean; wildcard?: boolean; proxy?: boolean; plaintext?: boolean };
}

export interface DnsPolicyResult {
  state: 'unmanaged' | 'ready' | 'blocked';
  source?: 'explicit' | 'legacy-owned';
  dns?: DnsSpec;
  identity?: DnsZoneIdentity;
  policy?: ResolvedDnsPolicy;
  checks?: { tls: DnsPolicyCheck; dnssec: DnsPolicyCheck; caa: DnsPolicyCheck };
  blockers: Array<{ code: string; reason: string }>;
}

/** Map desired DNS to native provider identity without borrowing hosting scope. */
export function dnsZoneIdentity(dns: DnsSpec): DnsZoneIdentity {
  const { id, name, ...scope } = dns.zone;
  return { provider: dns.provider, zoneId: id, zoneName: name, scope };
}

function sameIdentity(left: DnsZoneIdentity, right: DnsZoneIdentity): boolean {
  const scopeKeys = ['accountId', 'projectId', 'subscriptionId', 'resourceGroup'] as const;
  return left.provider === right.provider && left.zoneId === right.zoneId
    && left.zoneName.toLowerCase().replace(/\.$/, '') === right.zoneName.toLowerCase().replace(/\.$/, '')
    && scopeKeys.every(key => left.scope[key] === right.scope[key]);
}

/**
 * Resolve authority and security intent without reading credentials or mutating DNS.
 * Ready means the policy admits planning; it never proves ownership, adoption,
 * HTTPS readiness or permission to execute a provider/engine write.
 */
export function resolveDnsPolicy(input: DnsPolicyInput): DnsPolicyResult {
  const { environmentSpec: environment, securityObservation: observed = {}, capabilities = {} } = input;
  const blockers: DnsPolicyResult['blockers'] = [];
  const block = (code: string, reason: string) => blockers.push({ code, reason });
  let dns = environment.dns;
  let source: DnsPolicyResult['source'] = dns ? 'explicit' : undefined;

  if (!dns && input.legacyOwnership) {
    const legacy = input.legacyOwnership;
    if (legacy.state !== 'verified') {
      return { state: 'blocked', blockers: [{ code: 'dns_legacy_ownership_unknown',
        reason: 'The existing DNS identity could not be verified. Preserve its records and refresh exact ownership before planning changes.' }] };
    }
    const parsed = dnsSpecSchema.safeParse({ provider: legacy.identity.provider,
      zone: { id: legacy.identity.zoneId, name: legacy.identity.zoneName, ...legacy.identity.scope },
      connectionScope: legacy.connectionScope });
    if (!parsed.success || parsed.data.provider !== 'cloudflare' || legacy.recordIds.length === 0
      || legacy.recordIds.some(id => !id.trim())
      || legacy.hostname.toLowerCase().replace(/\.$/, '') !== environment.domain?.toLowerCase().replace(/\.$/, '')
      || !dnsHostnameBelongsToZone(legacy.hostname, legacy.identity.zoneName)) {
      return { state: 'blocked', blockers: [{ code: 'dns_legacy_ownership_unknown',
        reason: 'The old custom domain needs exact Cloudflare zone, account and record ownership before its DNS can be managed.' }] };
    }
    dns = parsed.data;
    source = 'legacy-owned';
  }
  if (!dns) return { state: 'unmanaged', blockers };

  const identity = dnsZoneIdentity(dns);
  if (input.existingIdentity && !sameIdentity(identity, input.existingIdentity)) {
    block('dns_migration_requires_workflow', 'The existing owned DNS uses a different provider, zone or account. Preserve it until an explicit DNS migration workflow is supported.');
  }
  const desired = dns.policy ?? {};
  const hasExistingRecords = !!input.existingIdentity || source === 'legacy-owned' || !!dns.adoptRecords?.length;
  const explicitProxy = desired.proxy ?? (environment.domainProxy === undefined ? undefined : environment.domainProxy ? 'on' : 'off');
  if (dns.provider === 'cloudflare' && hasExistingRecords && explicitProxy === undefined && observed.proxy === undefined) {
    block('dns_proxy_unknown', 'The existing traffic record proxy setting could not be verified. Preserve it until the exact record is observed or an explicit proxy setting is reviewed.');
  }
  const policy: ResolvedDnsPolicy = {
    exposure: desired.exposure ?? 'public',
    tls: desired.tls ?? 'required',
    dnssec: desired.dnssec ?? 'preserve',
    caa: desired.caa ?? 'preserve',
    proxy: explicitProxy ?? (observed.proxy ? 'on' : 'off'),
    wildcard: desired.wildcard ?? 'deny',
  };
  if (policy.exposure === 'private' && !capabilities.privateZones) {
    block('dns_private_zone_unsupported', 'Private DNS requires a verified private-zone and private-ingress workflow. This custom-domain workflow currently supports public DNS.');
  }
  if (policy.tls === 'disabled' && !capabilities.plaintext) {
    block('dns_plaintext_unsupported', 'This custom-domain workflow requires HTTPS. Disabling TLS is not supported.');
  }
  if (policy.proxy === 'on' && !(capabilities.proxy ?? dns.provider === 'cloudflare')) {
    block('dns_proxy_unsupported', 'The selected DNS workflow cannot proxy application traffic. Choose an available proxy capability or set the DNS proxy policy to off.');
  }
  if (policy.wildcard === 'allow' && !capabilities.wildcard) {
    block('dns_wildcard_unsupported', 'Wildcard DNS needs a matching wildcard certificate and hosting route. This complete workflow is not yet supported.');
  }

  const checks: NonNullable<DnsPolicyResult['checks']> = {
    tls: policy.tls === 'disabled' ? 'preserved' : observed.tls === 'ready' ? 'satisfied' : observed.tls === 'unknown' ? 'unknown' : 'pending',
    dnssec: observed.dnssec && observed.dnssec !== 'unknown' ? 'preserved' : 'unknown',
    caa: observed.caa?.state === 'known' ? 'preserved' : 'unknown',
  };
  if (policy.dnssec === 'required') {
    if (observed.dnssec === 'enabled' && observed.dnssecValidation === 'validated') checks.dnssec = 'satisfied';
    else {
      checks.dnssec = observed.dnssec === 'disabled' || observed.dnssecValidation === 'not_validated' ? 'blocked' : 'unknown';
      block('dns_dnssec_required', 'Required DNSSEC needs enabled signing on the exact zone and successful public DNS validation. Automatic zone-signing and registrar changes are not supported.');
    }
  }
  if (policy.caa !== 'preserve') {
    const current = observed.caa?.state === 'known' ? [...new Set(observed.caa.issuers.map(issuer => issuer.toLowerCase().replace(/\.$/, '')))].sort() : undefined;
    const wanted = [...policy.caa.issuers].sort();
    if (current && JSON.stringify(current) === JSON.stringify(wanted)) checks.caa = 'satisfied';
    else {
      checks.caa = current ? 'blocked' : 'unknown';
      block('dns_caa_policy_requires_workflow', 'The requested certificate issuers must match verified effective CAA restrictions. Automatic CAA policy changes are not supported.');
    }
  }
  return { state: blockers.length ? 'blocked' : 'ready', source, dns, identity, policy, checks, blockers };
}
