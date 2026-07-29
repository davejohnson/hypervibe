import { z } from 'zod';

export const DigitalOceanCredentialsSchema = z.object({
  apiToken: z
    .string({ required_error: 'DigitalOcean personal access token is required' })
    .min(1, 'DigitalOcean personal access token is required'),
  containerRegistry: z.string().min(3).optional(),
  region: z.string().min(1).default('nyc3'),
  appRegion: z.string().min(1).default('nyc'),
  appInstanceSize: z.string().min(1).default('apps-s-1vcpu-0.5gb'),
  databaseSize: z.string().min(1).default('db-s-1vcpu-1gb'),
  postgresVersion: z.string().min(1).default('17'),
  valkeyVersion: z.string().min(1).default('8'),
});

export type DigitalOceanCredentials = z.infer<
  typeof DigitalOceanCredentialsSchema
>;
