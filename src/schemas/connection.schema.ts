import { z } from 'zod';

export const providerSchema = z.enum(['railway', 'local']).or(z.string().min(1));

export const railwayCredentialsSchema = z.object({
  apiToken: z.string().min(1),
  teamId: z.string().optional(),
});

export const localCredentialsSchema = z.object({
  dockerSocket: z.string().optional(),
});

export const createConnectionSchema = z.object({
  provider: providerSchema,
  credentials: z.union([railwayCredentialsSchema, localCredentialsSchema, z.record(z.unknown())]),
});

export type CreateConnectionSchema = z.infer<typeof createConnectionSchema>;
export type RailwayCredentialsSchema = z.infer<typeof railwayCredentialsSchema>;
export type LocalCredentialsSchema = z.infer<typeof localCredentialsSchema>;
