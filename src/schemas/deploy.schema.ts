import { z } from 'zod';

export const deployInputSchema = z.object({
  projectName: z.string().min(1).optional(),
  projectId: z.string().uuid().optional(),
  environmentName: z.string().min(1).optional(),
  environmentId: z.string().uuid().optional(),
  services: z.array(z.string()).optional(),
  envVars: z.record(z.string()).optional(),
}).refine(
  (data) => data.projectName || data.projectId,
  { message: 'Either projectName or projectId must be provided' }
);

export const deployStatusInputSchema = z.object({
  runId: z.string().uuid(),
});

export type DeployInputSchema = z.infer<typeof deployInputSchema>;
export type DeployStatusInputSchema = z.infer<typeof deployStatusInputSchema>;
