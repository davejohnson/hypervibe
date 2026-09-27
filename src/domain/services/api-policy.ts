import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { ApiReleaseSpec } from '../spec/spec.schema.js';
import type { PlanAction } from '../plan/plan.types.js';

export const API_POLICY_OPERATION = 'acceptApiReleasePolicy';
const ledgerSchema = z.object({
  version: z.literal(1), service: z.string().min(1),
  versions: z.record(z.string().regex(/^v[1-9][0-9]*$/), z.object({
    path: z.string().min(1), status: z.enum(['supported', 'deprecated', 'retired']),
    retirement: z.object({ id: z.string().min(1), reason: z.string().min(1) }).strict().optional(),
  }).strict()),
}).strict();
type Ledger = z.infer<typeof ledgerSchema>;

function ledger(policy: ApiReleaseSpec): Ledger {
  return { version: 1, service: policy.service, versions: Object.fromEntries(Object.entries(policy.versions)
    .map(([name, value]) => [name, { path: value.path, status: value.status, ...(value.retirement ? { retirement: value.retirement } : {}) }])) };
}

/** Retained intent prevents omitting a declaration from erasing client support. */
export function planApiPolicy(environmentName: string, retained: unknown, desired: ApiReleaseSpec | undefined): { action?: PlanAction; error?: string } {
  let previous: Ledger | undefined;
  if (retained !== undefined) {
    const parsed = ledgerSchema.safeParse(retained);
    if (!parsed.success) return { error: 'Retained API policy is invalid; restore its reviewed binding before changing release protection.' };
    previous = parsed.data;
  }
  if (!desired) return previous ? { error: 'Retain the API policy and version tombstones; removing the declaration cannot disable release protection.' } : {};
  const next = ledger(desired);
  if (previous && previous.service !== next.service) return { error: 'Retain the API service identity; moving version routes requires a separate reviewed migration.' };
  for (const [name, value] of Object.entries(previous?.versions ?? {})) {
    if (!next.versions[name]) return { error: `Retain API ${name}; retire it explicitly with a reason instead of removing its declaration.` };
    if (next.versions[name].path !== value.path) return { error: `Retain API ${name}'s path while clients depend on it.` };
    if (value.status === 'retired' && canonicalJsonSha256(next.versions[name]) !== canonicalJsonSha256(value)) return { error: `Retain API ${name}'s retirement tombstone; a retired version cannot be changed or revived.` };
  }
  const previousHash = canonicalJsonSha256(previous ?? null);
  const desiredHash = canonicalJsonSha256(next);
  if (previousHash === desiredHash) return {};
  const retirements = Object.entries(next.versions).filter(([name, value]) => value.status === 'retired'
    && canonicalJsonSha256(value) !== canonicalJsonSha256(previous?.versions[name] ?? null)).map(([name]) => name);
  return { action: {
    id: `api-policy:${environmentName}:${desiredHash.slice(0, 16)}`, type: 'update',
    resource: { kind: 'ci', name: `api-policy:${environmentName}`, provider: 'hypervibe' }, verified: false,
    reason: retirements.length ? `Approve API retirement: ${retirements.join(', ')}. Existing clients may need to update.` : 'Record supported API versions before changing release workflows',
    ...(retirements.length ? { requiresConfirm: true } : {}),
    metadata: { operation: API_POLICY_OPERATION, environmentName, previousHash, desiredHash, retirements },
  } };
}

export function applyApiPolicy(environmentName: string, retained: unknown, desired: ApiReleaseSpec | undefined, action: PlanAction, confirmed: ReadonlySet<string>, save: (ledger: Ledger) => void) {
  const fresh = planApiPolicy(environmentName, retained, desired);
  const block = (message: string) => ({ success: false, status: 'blocked' as const, message });
  if (fresh.error) return block(fresh.error);
  // A completed local write may outlive its receipt. Only the same reviewed target can recover.
  if (!fresh.action && desired && action.metadata?.desiredHash === canonicalJsonSha256(ledger(desired))
    && action.metadata?.environmentName === environmentName && action.metadata?.operation === API_POLICY_OPERATION
    && action.resource.name === `api-policy:${environmentName}` && action.resource.provider === 'hypervibe'
    && action.resource.kind === 'ci' && action.id === `api-policy:${environmentName}:${String(action.metadata.desiredHash).slice(0, 16)}`
    && action.type === 'update') {
    save(ledger(desired)); // Retry the repository export if the local write outlived its failed receipt.
    return { success: true, message: 'API policy already recorded; repository binding export refreshed.' };
  }
  if (!fresh.action || canonicalJsonSha256(fresh.action) !== canonicalJsonSha256(action)) return block('API policy action changed; run hv_plan again.');
  if (fresh.action.requiresConfirm && (!action.requiresConfirm || !confirmed.has(action.id))) return block('Confirm this exact API retirement action before applying.');
  save(ledger(desired!));
  return { success: true, message: 'API policy recorded. Run hv_plan to review its release workflow changes.' };
}
