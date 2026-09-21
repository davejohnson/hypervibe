import { z } from 'zod';

const responseSchema = z.object({
  Status: z.number().int().min(0).max(15), TC: z.boolean(), AD: z.boolean(), CD: z.boolean(),
  Question: z.array(z.object({ name: z.string(), type: z.number().int() })).length(1),
  Answer: z.array(z.object({ name: z.string(), type: z.number().int(), data: z.string() })).max(128).optional(),
});
export type PublicDnsRead = { status: 'known'; code: number; authenticated: boolean; answers: Array<{ name: string; type: number; data: string }> } | { status: 'unknown' };
export const normalizeDnsName = (name: string): string => name.toLowerCase().replace(/\.$/, '');

/** Account-free public DNS observation. No connection credentials enter requests. */
export class PublicDnsClient {
  async query(name: string, type: 6 | 257, signal: AbortSignal): Promise<PublicDnsRead> {
    try {
      const url = new URL('https://dns.google/resolve');
      url.search = new URLSearchParams({ name, type: String(type), cd: 'false', do: 'true', edns_client_subnet: '0.0.0.0/0' }).toString();
      const response = await fetch(url, { method: 'GET', signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok) return { status: 'unknown' };
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.TC || parsed.data.CD
        || normalizeDnsName(parsed.data.Question[0].name) !== name || parsed.data.Question[0].type !== type) return { status: 'unknown' };
      return { status: 'known', code: parsed.data.Status, authenticated: parsed.data.AD, answers: parsed.data.Answer ?? [] };
    } catch {
      // Resolver comments and errors can contain inputs; report only safe state.
      return { status: 'unknown' };
    }
  }
}
