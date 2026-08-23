import { z } from 'zod';
import { UNCONFIGURED_HOSTING_PROVIDER } from '../domain/entities/project.entity.js';

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  defaultPlatform: z.string().default(UNCONFIGURED_HOSTING_PROVIDER),
  gitRemoteUrl: z.string().optional(),
  policies: z.record(z.unknown()).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export type CreateProjectSchema = z.infer<typeof createProjectSchema>;
export type UpdateProjectSchema = z.infer<typeof updateProjectSchema>;
