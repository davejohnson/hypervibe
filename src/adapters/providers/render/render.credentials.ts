import { z } from 'zod';

export const RenderCredentialsSchema = z.object({
  apiKey: z
    .string({ required_error: 'Render API key is required' })
    .min(1, 'Render API key is required'),
  ownerId: z
    .string({ required_error: 'Render workspace ID is required' })
    .min(1, 'Render workspace ID is required'),
  registryCredentialId: z.string().min(1).optional(),
  region: z.enum([
    'frankfurt',
    'oregon',
    'ohio',
    'singapore',
    'virginia',
  ]).default('oregon'),
  servicePlan: z.string().min(1).default('starter'),
  postgresPlan: z.string().min(1).default('basic_256mb'),
  postgresVersion: z.string().min(1).default('18'),
  keyValuePlan: z.string().min(1).default('starter'),
  keyValuePersistenceMode: z.enum([
    'journal_snapshot',
    'snapshot',
    'off',
  ]).default('journal_snapshot'),
  keyValueMaxmemoryPolicy: z.enum([
    'noeviction',
    'allkeys_lfu',
    'allkeys_lru',
    'allkeys_random',
    'volatile_lfu',
    'volatile_lru',
    'volatile_random',
    'volatile_ttl',
  ]).default('noeviction'),
});

export type RenderCredentials = z.infer<typeof RenderCredentialsSchema>;
