import { z } from 'zod';

export const componentTypeSchema = z.enum(['postgres', 'redis', 'mysql', 'mongodb']).or(z.string().min(1));

export const componentBindingsSchema = z.object({
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
}).passthrough();

export const createComponentSchema = z.object({
  environmentId: z.string().uuid(),
  type: componentTypeSchema,
  bindings: componentBindingsSchema.optional(),
  externalId: z.string().optional(),
});

export const updateComponentSchema = createComponentSchema.partial().omit({ environmentId: true });

export type CreateComponentSchema = z.infer<typeof createComponentSchema>;
export type UpdateComponentSchema = z.infer<typeof updateComponentSchema>;
