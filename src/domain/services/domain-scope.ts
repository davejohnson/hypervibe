import { createHash } from 'node:crypto';
import { parse } from 'tldts';

const DOMAIN_PARSE_OPTIONS = { allowPrivateDomains: true };

/** Stable key used by saved Google Cloud DNS ownership receipts. */
export function additionalGcpDomainDnsOwner(domain: string): string {
  const hostname = domain.toLowerCase().replace(/\.$/, '');
  const digest = createHash('sha256').update(JSON.stringify(hostname)).digest('hex');
  return `gcp-domain-${digest.slice(0, 20)}`;
}

export function normalizeDomainName(domain: string): string {
  const raw = domain.trim().toLowerCase();
  const parsed = parse(raw, DOMAIN_PARSE_OPTIONS);
  return (parsed.hostname ?? raw).replace(/\.+$/, '');
}

export function dnsZoneScopeForDomain(domain: string): string {
  const normalized = normalizeDomainName(domain);
  const parsed = parse(normalized, DOMAIN_PARSE_OPTIONS);
  return parsed.domain ?? normalized;
}

export function cloudflareScopeHintsForDomain(domain: string, extraHints: string[] = []): string[] {
  const normalized = normalizeDomainName(domain);
  return Array.from(new Set([
    dnsZoneScopeForDomain(normalized),
    normalized,
    ...extraHints,
  ].filter(Boolean)));
}
