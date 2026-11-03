import { z } from 'zod';
import { runtimeExecutionCoordinatesSchema } from '../../lib/value-free-coordinates.js';

/** Nonsecret task progress. The application owns exact request reservation and CAS. */
export const managedRecoveryTaskCheckpointSchema = z.object({
  version: z.literal(1),
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  authorityHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['create-attempted', 'created', 'run-attempted', 'running', 'terminal',
    'delete-execution-attempted', 'execution-deleted', 'delete-job-attempted', 'complete']),
  coordinates: runtimeExecutionCoordinatesSchema.refine(value => Object.keys(value).length <= 16),
  terminal: z.object({ status: z.enum(['succeeded', 'failed']), exitCode: z.number().int().min(0).max(255).optional() }).strict().optional(),
}).strict().superRefine((state, ctx) => {
  if (['terminal', 'delete-execution-attempted', 'execution-deleted', 'delete-job-attempted', 'complete'].includes(state.phase) !== Boolean(state.terminal)
    || state.terminal?.status === 'succeeded' && state.terminal.exitCode !== 0) {
    ctx.addIssue({ code: 'custom', message: 'Recovery task terminal evidence is incomplete.' });
  }
});
export type ManagedRecoveryTaskCheckpoint = z.infer<typeof managedRecoveryTaskCheckpointSchema>;

export interface ManagedRecoveryTaskLifecycle {
  state?: ManagedRecoveryTaskCheckpoint;
  /** Persist atomically and independently reload before the next native effect. */
  persist(next: ManagedRecoveryTaskCheckpoint): Promise<ManagedRecoveryTaskCheckpoint>;
}
