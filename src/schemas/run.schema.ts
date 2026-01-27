import { z } from 'zod';

export const runTypeSchema = z.enum(['deploy', 'migrate', 'rollback']).or(z.string().min(1));
export const runStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']);

export const runStepSchema = z.object({
  name: z.string(),
  action: z.string(),
  target: z.string().optional(),
  params: z.record(z.unknown()).optional(),
});

export const runPlanSchema = z.object({
  steps: z.array(runStepSchema),
  metadata: z.record(z.unknown()).optional(),
});

export const createRunSchema = z.object({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  type: runTypeSchema,
  plan: runPlanSchema.optional(),
});

export type CreateRunSchema = z.infer<typeof createRunSchema>;
export type RunPlanSchema = z.infer<typeof runPlanSchema>;
export type RunStepSchema = z.infer<typeof runStepSchema>;
