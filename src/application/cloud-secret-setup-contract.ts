import { z } from 'zod';
import { secretDestinationSchema } from '../domain/ports/secret-destination.port.js';
import { sourceBranchSchema } from './cloud-source-branch.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/);
export const secretSetupServiceAccountSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
const key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
export const cloudSecretSetupSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({ id: identifier, name: z.string().min(1).max(200), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict(),
  environment: z.object({ id: identifier, key: identifier, name: z.string().min(1).max(200) }).strict(),
  source: z.object({ branch: sourceBranchSchema, revision: z.string().regex(/^[a-f0-9]{40}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  host: z.object({ status: z.enum(['ready', 'unavailable']), provider: z.literal('gcp'), serviceAccountEmail: secretSetupServiceAccountSchema.optional(), reason: code.optional() }).strict(),
  destinations: z.array(z.object({ key, destination: secretDestinationSchema, version: z.string().min(1).max(64).optional(),
    status: z.enum(['needs_setup', 'connected', 'unsupported', 'preserved', 'blocked']),
    writerIdentity: z.object({ serviceAccountEmail: secretSetupServiceAccountSchema }).strict().optional(),
    connectionId: identifier.optional(), reason: code.optional(),
  }).strict()).max(100),
}).strict();
export type CloudSecretSetup = z.infer<typeof cloudSecretSetupSchema>;
export const cloudSecretSetupReceiptSchema = z.object({
  schemaVersion: z.literal(1), projectId: identifier, environmentId: identifier,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  applied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  results: z.array(z.object({ key, status: z.enum(['connected', 'already_connected', 'failed']), connectionId: identifier.optional(), code: code.optional() }).strict()).max(100),
}).strict();
