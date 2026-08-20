import { z } from 'zod';

export const FlyCredentialsSchema = z.object({
  apiToken: z.string()
    .trim()
    .min(1, 'Fly.io organization-scoped API token is required'),
  organizationSlug: z.string()
    .trim()
    .regex(
      /^(?:personal|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/,
      'Fly.io organization slug is invalid'
    ),
}).strict();

export type FlyCredentials = z.infer<typeof FlyCredentialsSchema>;
