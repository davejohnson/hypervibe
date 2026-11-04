import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';

/** Local write-ahead evidence; never imported from repository bindings. */
export const retainedDeleteRecoverySchema = z.object({
  version: z.literal(1),
  attemptId: z.string().uuid(),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['attempted', 'acknowledged']),
  operation: z.string().min(1).max(1024).regex(/^[A-Za-z0-9._/-]+$/).optional(),
}).strict().refine(value => value.state === 'acknowledged' ? !!value.operation : !value.operation);
export type RetainedDeleteRecovery = z.infer<typeof retainedDeleteRecoverySchema>;
export interface RetainedDeleteLifecycle {
  state?: RetainedDeleteRecovery;
  begin(): Promise<RetainedDeleteRecovery>;
  /** Saves/reloads under complete binding CAS; failure forbids the dependent write. */
  persist(next: RetainedDeleteRecovery): Promise<RetainedDeleteRecovery>;
}

export function retainedDeleteTargetHash(target: {
  provider: string; resource: string; externalId: string; name: string; providerScope: Record<string, string>;
}): string { return canonicalJsonSha256(target); }
