import { z } from 'zod';

export const buildConfigSchema = z.object({
  builder: z.enum(['nixpacks', 'dockerfile', 'buildpack']).optional(),
  dockerfilePath: z.string().optional(),
  buildCommand: z.string().optional(),
  watchPaths: z.array(z.string()).optional(),
});

export const envVarSpecSchema = z.object({
  required: z.array(z.string()).optional(),
  optional: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
});

export const createServiceSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  buildConfig: buildConfigSchema.optional(),
  envVarSpec: envVarSpecSchema.optional(),
});

export const updateServiceSchema = createServiceSchema.partial().omit({ projectId: true });

export type CreateServiceSchema = z.infer<typeof createServiceSchema>;
export type UpdateServiceSchema = z.infer<typeof updateServiceSchema>;
