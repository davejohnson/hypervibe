import { z } from 'zod';

export const environmentNameSchema = z.enum(['local', 'staging', 'production']).or(z.string().min(1));

export const createEnvironmentSchema = z.object({
  projectId: z.string().uuid(),
  name: environmentNameSchema,
  platformBindings: z.record(z.unknown()).optional(),
});

export const updateEnvironmentSchema = createEnvironmentSchema.partial().omit({ projectId: true });

export type CreateEnvironmentSchema = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentSchema = z.infer<typeof updateEnvironmentSchema>;
