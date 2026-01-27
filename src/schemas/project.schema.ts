import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  defaultPlatform: z.string().default('railway'),
  policies: z.record(z.unknown()).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export type CreateProjectSchema = z.infer<typeof createProjectSchema>;
export type UpdateProjectSchema = z.infer<typeof updateProjectSchema>;
