import { domainToASCII } from 'node:url';
import { parse } from 'tldts';
import { PublicDnsClient, normalizeDnsName } from '../../adapters/dns/public-dns.client.js';

interface CaaReadiness {
  status: 'unrestricted' | 'restricted' | 'issuance_denied' | 'unknown';
  inherited?: boolean;
  issuerCompatibility: 'not_restricted' | 'not_verified' | 'denied';
}
export interface DomainSecurityReadiness {
  status: 'observed' | 'needs_attention' | 'unknown';
  basis: 'public-validating-resolver';
  resolver: 'dns.google';
  dnssec: 'validated' | 'not_validated' | 'unknown';
  caa: CaaReadiness;
  guidance: string;
}
const unknownCaa = (): CaaReadiness => ({ status: 'unknown', issuerCompatibility: 'not_verified' });

/** Inspects the declared exact hostname; never changes provider/registrar state. */
export async function inspectDomainSecurity(domain?: string): Promise<DomainSecurityReadiness | undefined> {
  if (!domain) return undefined;
  const name = normalizeDnsName(domainToASCII(domain));
  const parsed = parse(name, { allowPrivateDomains: true });
  const valid = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) && name.length <= 253
    && name.split('.').every(label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'))
    && Boolean(parsed.domain && (parsed.isIcann || parsed.isPrivate));
  const client = new PublicDnsClient();
  const signal = AbortSignal.timeout(3000);
  let queries = 0;
  const caaAt = async (host: string, visited = new Set<string>()): Promise<string[] | null> => {
    if (signal.aborted || ++queries > 20 || visited.has(host)) return null;
    visited.add(host);
    const read = await client.query(host, 257, signal);
    if (read.status === 'unknown' || ![0, 3].includes(read.code)) return null;
    if (read.code === 3) return read.answers.length ? null : [];
    const records = read.answers.filter(record => normalizeDnsName(record.name) === host);
    const caa = records.filter(record => record.type === 257);
    const aliases = records.filter(record => record.type === 5);
    if (aliases.length && caa.length) return null;
    if (caa.length) return caa.map(record => record.data);
    if (aliases.length) {
      const alias = normalizeDnsName(aliases[0].data);
      if (aliases.length !== 1 || !/^[a-z0-9.-]+$/.test(alias) || !parse(alias).domain) return null;
      return caaAt(alias, visited);
    }
    // Unrelated records cannot prove the queried name has no CAA.
    return read.answers.some(record => ![46, 47, 50].includes(record.type)) ? null : [];
  };
  const caaPolicy = async (): Promise<CaaReadiness> => {
    let host = name;
    while (host) {
      const records = await caaAt(host);
      if (records === null) return unknownCaa();
      if (records.length) {
        const issues: string[] = [];
        for (const record of records) {
          const match = /^(\d{1,3})\s+([a-zA-Z0-9-]+)\s+"([^"\\]*)"$/.exec(record);
          if (!match || Number(match[1]) > 255) return unknownCaa();
          const tag = match[2].toLowerCase();
          if ((Number(match[1]) & 128) !== 0 && !['issue', 'issuewild', 'iodef'].includes(tag)) return unknownCaa();
          // This report evaluates an exact hostname, never a wildcard certificate.
          if (tag === 'issue') issues.push(match[3]);
        }
        const inherited = host !== name;
        if (!issues.length) return { status: 'unrestricted', issuerCompatibility: 'not_restricted', inherited };
        const issuers = issues.map(value => value.split(';')[0].trim());
        if (issuers.every(issuer => issuer === '')) return { status: 'issuance_denied', issuerCompatibility: 'denied', inherited };
        if (issuers.some(issuer => issuer && !/^[a-zA-Z0-9.-]+$/.test(issuer))) return unknownCaa();
        return { status: 'restricted', issuerCompatibility: 'not_verified', inherited };
      }
      host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '';
    }
    return { status: 'unrestricted', issuerCompatibility: 'not_restricted' };
  };
  const [soa, caa] = valid ? await Promise.all([client.query(name, 6, signal), caaPolicy()])
    : [{ status: 'unknown' as const }, unknownCaa()];
  const dnssec = soa.status === 'known' && soa.code === 0 ? soa.authenticated ? 'validated' : 'not_validated' : 'unknown';
  return {
    status: caa.status === 'issuance_denied' || dnssec === 'not_validated' ? 'needs_attention'
      : dnssec === 'unknown' || caa.status === 'unknown' || caa.status === 'restricted' ? 'unknown' : 'observed',
    basis: 'public-validating-resolver', resolver: 'dns.google', dnssec, caa,
    guidance: 'DNSSEC reports a validating public resolver’s evidence, not the provider’s enabled switch. Missing validation does not identify a broken DS record. Confirm DNS-provider signing and registrar delegation together before changing either. CAA restrictions are preserved; issuer compatibility, wildcard certificates, and issuer-specific parameters require provider evidence. This read-only check does not change DNS, registrar settings, or certificates.',
  };
}
