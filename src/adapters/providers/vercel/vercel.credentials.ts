import { z } from 'zod';

export const VercelCredentialsSchema = z.object({
  accessToken: z.string().trim().min(1, 'Vercel personal access token is required'),
  teamId: z.string().trim().min(1, 'Vercel team ID cannot be empty').optional(),
});

export type VercelCredentials = z.infer<typeof VercelCredentialsSchema>;
