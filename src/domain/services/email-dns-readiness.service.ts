import { Resolver } from 'node:dns/promises';
import { getDomain } from 'tldts';
import type { SendGridSenderIdentityEvidence } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';

type Publication = 'published' | 'missing' | 'mismatch' | 'unknown';
export interface DmarcReadiness {
  status: 'configured' | 'monitoring' | 'partial' | 'missing' | 'invalid' | 'unknown';
  policy?: 'none' | 'quarantine' | 'reject';
  inherited?: boolean;
}
export interface EmailDnsReadiness {
  status: 'configured' | 'needs_attention' | 'unknown';
  basis: 'dns-publication';
  senders: Array<{ key: string; spf: Publication; dkim: Publication; dmarc: DmarcReadiness }>;
  uncheckedSenders?: number;
  guidance: string;
}

const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');
const missing = (error: unknown) => ['ENODATA', 'ENOTFOUND'].includes((error as { code?: string })?.code ?? '');

/** DNS publication is evidence of configuration, never a message-authentication result. */
export async function inspectEmailDnsReadiness(senders: Array<{
  key: string;
  address: string;
  evidence: SendGridSenderIdentityEvidence;
}>): Promise<EmailDnsReadiness> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cnameReads = new Map<string, Promise<string[]>>();
  const txtReads = new Map<string, Promise<string[][]>>();
  const txt = (name: string) => {
    if (!txtReads.has(name)) txtReads.set(name, resolver.resolveTxt(name));
    return txtReads.get(name)!;
  };
  const publication = async (record: unknown, domain: string): Promise<Publication> => {
    if (!record || typeof record !== 'object') return 'unknown';
    const { type, host, data } = record as Record<string, unknown>;
    if (typeof type !== 'string' || type.toLowerCase() !== 'cname'
      || typeof host !== 'string' || typeof data !== 'string'
      || !/^[a-zA-Z0-9_.-]+\.?$/.test(host) || !/^[a-zA-Z0-9.-]+\.?$/.test(data)
      || !normalize(host).endsWith(`.${domain}`)) return 'unknown';
    try {
      const name = normalize(host);
      if (!cnameReads.has(name)) cnameReads.set(name, resolver.resolveCname(name));
      const records = await cnameReads.get(name)!;
      return records.length === 0 ? 'missing'
        : records.length === 1 && normalize(records[0]) === normalize(data) ? 'published' : 'mismatch';
    } catch (error) {
      return missing(error) ? 'missing' : 'unknown';
    }
  };
  const dmarc = async (domain: string): Promise<DmarcReadiness> => {
    const organizational = getDomain(domain, { allowPrivateDomains: true });
    for (const candidate of [...new Set([domain, ...(organizational ? [organizational] : [])])]) {
      let records: string[];
      try {
        records = (await txt(`_dmarc.${candidate}`)).map(parts => parts.join(''))
          .filter(value => /^v\s*=\s*DMARC1(?:\s*;|\s*$)/.test(value));
      } catch (error) {
        if (missing(error)) continue;
        return { status: 'unknown' };
      }
      if (!records.length) continue;
      if (records.length !== 1) return { status: 'invalid' };
      const tags = new Map<string, string>();
      for (const part of records[0].split(';').filter(part => part.trim())) {
        const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(part);
        if (!match || tags.has(match[1])) return { status: 'invalid' };
        tags.set(match[1], match[2]);
      }
      const policies = ['none', 'quarantine', 'reject'];
      if (!policies.includes(tags.get('p') ?? '') || (tags.has('sp') && !policies.includes(tags.get('sp')!))
        || ['adkim', 'aspf'].some(key => tags.has(key) && !['r', 's'].includes(tags.get(key)!))) return { status: 'invalid' };
      const pct = tags.get('pct') ?? '100';
      if (!/^\d{1,3}$/.test(pct) || Number(pct) > 100) return { status: 'invalid' };
      const inherited = candidate !== domain;
      const policy = (inherited ? tags.get('sp') ?? tags.get('p') : tags.get('p')) as 'none' | 'quarantine' | 'reject';
      return { status: policy === 'none' ? 'monitoring' : Number(pct) < 100 ? 'partial' : 'configured', policy, inherited };
    }
    return { status: 'missing' };
  };
  const results: EmailDnsReadiness['senders'] = [];
  // Bound concurrent DNS work to one sender; cache repeated domains/records.
  for (const sender of senders.slice(0, 8)) {
    const domain = normalize(sender.address.slice(sender.address.lastIndexOf('@') + 1));
    const records = sender.evidence.automaticSecurity === true && sender.evidence.dns && typeof sender.evidence.dns === 'object'
      ? sender.evidence.dns as Record<string, unknown> : {};
    const [spf, first, second, policy] = await Promise.all([
      publication(records.mail_cname, domain), publication(records.dkim1, domain), publication(records.dkim2, domain), dmarc(domain),
    ]);
    const dkim: Publication = [first, second].includes('missing') ? 'missing'
      : [first, second].includes('mismatch') ? 'mismatch' : first === 'published' && second === 'published' ? 'published' : 'unknown';
    results.push({ key: sender.key, spf, dkim, dmarc: policy });
  }
  const attention = results.some(item => ['missing', 'mismatch'].includes(item.spf) || ['missing', 'mismatch'].includes(item.dkim)
    || ['missing', 'invalid', 'monitoring', 'partial'].includes(item.dmarc.status));
  const unknown = results.length !== senders.length || !results.length
    || results.some(item => item.spf === 'unknown' || item.dkim === 'unknown' || item.dmarc.status === 'unknown');
  return {
    status: attention ? 'needs_attention' : unknown ? 'unknown' : 'configured', basis: 'dns-publication', senders: results,
    ...(results.length < senders.length ? { uncheckedSenders: senders.length - results.length } : {}),
    guidance: 'SPF/DKIM checks cover SendGrid automated-security CNAME publication. DMARC checks the From domain and inherited policy. Use reviewed email plan/apply to repair managed delegation records. DMARC policy management is not yet implemented; preserve existing policy and review all legitimate senders before strengthening it. A signed test message is still needed to prove SPF/DKIM alignment and delivery.',
  };
}
