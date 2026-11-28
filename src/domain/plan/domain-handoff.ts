import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { dnsHostnameSchema } from '../spec/dns.schema.js';
import type { Environment } from '../entities/environment.entity.js';
import { normalizedTrafficOrigin } from '../services/traffic-origin.js';

/** Public, secret-free conditions suitable for showing in a plan or receipt. */
export class DomainHandoffBlocked extends Error {}

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const handoffReviewSchema = z.object({
  hostname: dnsHostnameSchema, projectId: id, sourceEnvironment: id, sourceId: id, targetEnvironment: id, targetId: id, targetService: id,
  sourceProvider: id, providerProjectId: id, providerEnvironmentId: id, sourceService: id, sourceServiceId: id, attachmentId: id,
  zone: z.object({ provider: z.literal('cloudflare'), zoneId: id, zoneName: id, scope: z.object({ accountId: id }).strict() }).strict(),
  dnsConnectionId: id, recordId: id, recordAddress: id, verification: z.array(z.object({ name: id, id, address: id }).strict()),
  edge: z.object({ hostname: id, accountId: id, zoneId: id, routeId: id, scriptName: id, contentHash: id, origin: id, targetFingerprint: digest }).strict(),
}).strict();
export type HandoffReview = z.infer<typeof handoffReviewSchema>;
export const handoffSteps = ['detach', 'claim', 'verify'] as const;
export type HandoffStep = typeof handoffSteps[number];

/** Safe endpoint discovery from the target's local ownership receipt. Live checks report whether it serves now. */
export function ownedEdgeEndpoint(environment: Environment | null) {
  const parsed = handoffReviewSchema.safeParse(environment?.platformBindings.edgeDomain);
  if (!environment || !parsed.success) return undefined;
  const { targetId, projectId, targetEnvironment, targetService, hostname, edge } = parsed.data;
  if (environment.id !== targetId || environment.projectId !== projectId || environment.name !== targetEnvironment || edge.hostname !== hostname) return undefined;
  try {
    const nativeOrigin = normalizedTrafficOrigin(hostname, edge.origin);
    return { service: targetService, publicUrl: `https://${hostname}`, nativeOrigin };
  } catch { return undefined; }
}

/** Inspect the provider's complete saved DNS change, including identity and proxy state. TXT content remains private. */
export function exactHandoffDnsChanges(shown: unknown, review: HandoffReview, stage: 'route' | 'cleanup'): boolean {
  const rows = (shown as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(rows)) return false;
  const allowed = new Map([[review.recordAddress, { id: review.recordId, name: review.hostname, type: 'CNAME' }],
    ...review.verification.map(record => [record.address, { id: record.id, name: record.name, type: 'TXT' }] as const)]);
  const targetHost = new URL(normalizedTrafficOrigin(review.hostname, review.edge.origin)).hostname.toLowerCase().replace(/\.$/, '');
  const seen = new Set<string>();
  for (const row of rows) {
    const selected = allowed.get(row?.address);
    const change = row?.change;
    if (!selected || seen.has(row.address) || row.mode !== 'managed' || row.type !== 'cloudflare_dns_record'
      || row.deposed || row.previous_address || row.tainted || !Array.isArray(change?.actions) || change.actions.length !== 1
      || change.importing || change.forget) return false;
    seen.add(row.address);
    const before = change.before;
    if (!before || before.zone_id !== review.zone.zoneId || (before.id !== selected.id && `${review.zone.zoneId}/${before.id}` !== selected.id)
      || before.type !== selected.type || before.name?.toLowerCase().replace(/\.$/, '') !== selected.name) return false;
    const action = change.actions[0];
    if (selected.type === 'TXT') {
      if (action === 'no-op' && isDeepStrictEqual(before, change.after)) continue;
      if (stage !== 'cleanup' || action !== 'delete' || change.after !== null) return false;
      continue;
    }
    const after = change.after;
    if (!(action === 'no-op' || stage === 'route' && action === 'update') || !after || before.proxied !== true || before.ttl !== 1
      || typeof before.content !== 'string' || typeof after.content !== 'string'
      || after.content.toLowerCase().replace(/\.$/, '') !== targetHost || action === 'no-op' && !isDeepStrictEqual(before, after)
      || after.id && after.id !== before.id || change.after_unknown === true || change.after_unknown?.content === true) return false;
    for (const field of ['zone_id','name','type','ttl','proxied','private_routing','comment','tags','settings','priority','data']) {
      if (change.after_unknown?.[field] === true || !isDeepStrictEqual(before[field], after[field])) return false;
    }
  }
  return seen.has(review.recordAddress) && (stage === 'cleanup' || review.verification.every(record => seen.has(record.address)));
}
