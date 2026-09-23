import { z } from 'zod';

/** Shared repository binding envelope; values require boundary-specific projection. */
export const repoBindingsFileSchema = z.object({
  version: z.literal(1),
  project: z.string().trim().min(1),
  environments: z.record(z.string().min(1), z.object({
    platformBindings: z.record(z.unknown()),
  }).strict()),
}).strict();
