import { runtimeCoordinatesSchema } from '../../lib/value-free-coordinates.js';
export { runtimeCoordinateSchema, runtimeCoordinatesSchema } from '../../lib/value-free-coordinates.js';
import { recoveryRuntimeBindingSchema, type RecoveryRuntimeBinding } from '../ports/recovery-runtime.port.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';


export function recoveryRuntimeBindings(raw: unknown): RecoveryRuntimeBinding | undefined {
  if (raw === undefined) return undefined;
  const parsed = recoveryRuntimeBindingSchema.safeParse(raw);
  if (!parsed.success || !runtimeCoordinatesSchema.safeParse(parsed.data.evidence).success
    || parsed.data.pending && !runtimeCoordinatesSchema.safeParse(parsed.data.pending.step.target).success) throw new Error('Malformed recovery runtime evidence cannot be shared.');
  return parsed.data;
}

export function mergeRecoveryRuntimeBindings(local: unknown, incoming: unknown): RecoveryRuntimeBinding | undefined {
  const previous = recoveryRuntimeBindings(local); const next = recoveryRuntimeBindings(incoming);
  if (!previous) return next;
  if (!next) return previous;
  if (previous.provider !== next.provider
    || Object.keys(previous.evidence).some(key => next.evidence[key] !== undefined && next.evidence[key] !== previous.evidence[key])
    || previous.pending && next.pending && canonicalJsonSha256(previous.pending) !== canonicalJsonSha256(next.pending)) throw new Error('Recovery runtime evidence conflicts with retained local state.');
  return previous.pending ? previous : { ...next, ...previous, evidence: { ...next.evidence, ...previous.evidence }, ...(next.pending ? { pending: next.pending } : {}) };
}
