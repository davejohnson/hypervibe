import { resolveDnsConnection, dnsZoneFingerprint } from '../adapters/dns-observation/connections.js';
import { PublicDnsClient } from '../adapters/dns/public-dns.client.js';
import type { DnsZoneIdentity } from '../domain/ports/dns.port.js';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';

/** A cancelled attachment may be released only after native and public traffic DNS are absent. */
export async function verifyDnsTrafficAbsent(input: {
  ctx: CommandContext; project: Project; domain: string; zone: DnsZoneIdentity; connectionScope?: string;
  expected?: { zoneFingerprint: string; connectionId: string };
}): Promise<{ ready: true; zoneFingerprint: string; connectionId: string } | { ready: false; reason: string }> {
  const stop = (reason: string) => ({ ready: false as const, reason });
  try {
    const domain = input.domain.toLowerCase().replace(/\.$/, '');
    const connection = await resolveDnsConnection({ context: input.ctx, zone: input.zone, connectionScope: input.connectionScope,
      scopeHints: [parseGitHubRepoFromRemote(input.project.gitRemoteUrl), domain, input.zone.zoneName].filter((value): value is string => Boolean(value)) });
    if ('blocked' in connection) return stop(connection.blocked);
    const zone = await connection.observer.observeZone();
    if (zone.status !== 'present' || zone.value.visibility !== 'public') return stop('The exact public DNS zone could not be verified before releasing the domain claim.');
    const evidence = { zoneFingerprint: dnsZoneFingerprint(zone.value), connectionId: connection.connectionId };
    if (input.expected && (input.expected.zoneFingerprint !== evidence.zoneFingerprint || input.expected.connectionId !== evidence.connectionId)) return stop('The DNS zone or connection changed after review.');
    const publicDns = new PublicDnsClient();
    for (const [type, number] of [['A', 1], ['AAAA', 28], ['CNAME', 5]] as const) {
      const native = await connection.observer.observeRecordSets(domain, type);
      if (native.status !== 'absent') return stop(native.status === 'unknown' ? 'DNS absence is unknown; preserve the domain claim.' : 'Traffic DNS remains at this hostname. Preserve the domain claim until its exact DNS ownership is reconciled.');
      const publicRead = await publicDns.query(domain, number, AbortSignal.timeout(15_000));
      if (publicRead.status !== 'known' || ![0, 3].includes(publicRead.code) || publicRead.answers.length) return stop('Public traffic DNS is still present or unknown. Preserve the domain claim until absence is confirmed.');
    }
    return { ready: true, ...evidence };
  } catch { return stop('DNS absence could not be verified completely. Preserve the domain claim.'); }
}
