import { z } from 'zod';

export const HerokuCredentialsSchema = z.object({
  apiKey: z
    .string({ required_error: 'Heroku API token is required' })
    .min(1, 'Heroku API token is required'),
  region: z.string().min(1).default('us'),
  dynoSize: z.string().min(1).default('basic'),
});

export type HerokuCredentials = z.infer<typeof HerokuCredentialsSchema>;
