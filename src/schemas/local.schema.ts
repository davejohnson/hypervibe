import { z } from 'zod';

export const localBootstrapInputSchema = z.object({
  projectName: z.string().min(1).optional(),
  projectId: z.string().uuid().optional(),
  outputDir: z.string().optional(),
  components: z.array(z.enum(['postgres', 'redis', 'mysql', 'mongodb'])).optional(),
}).refine(
  (data) => data.projectName || data.projectId,
  { message: 'Either projectName or projectId must be provided' }
);

export type LocalBootstrapInputSchema = z.infer<typeof localBootstrapInputSchema>;
