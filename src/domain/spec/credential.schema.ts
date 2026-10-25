import { z } from 'zod';
import { parseSecretRef } from '../ports/secretmanager.port.js';
import { databaseCredentialSelectionSchema } from '../ports/database-credential.port.js';

// Descriptors only. Values stay in the existing encrypted plan storage.
export const credentialSourceSchema = z.string().max(2048).refine(value =>
  /^(env:[A-Za-z_][A-Za-z0-9_]*|dotenv:[^\r\n?#]+#[A-Za-z_][A-Za-z0-9_]*|file:[^\r\n?#]+)$/.test(value)
    || !/[\s?]/.test(value) && parseSecretRef(value) !== null,
  'Use a local or secret-manager reference, never a value or URL containing credentials.');

const verificationFields = {
  environment: z.string().min(1), service: z.string().min(1),
  requiredCounts: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/), z.number().int().positive())
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Declare one to sixteen business-operation counts.'),
  maxAgeSeconds: z.number().int().min(1).max(86400).default(900),
};
export const credentialVerificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http-receipt'), ...verificationFields,
    receiptService: z.string().min(1).optional().describe('Optional bound web service exposing receipts for this worker or cron consumer.'),
    path: z.string().max(1024).regex(/^\/[A-Za-z0-9/_.-]+$/).refine(value => !value.split('/').includes('..'), 'Use an app-local receipt path without query parameters.'),
  }).strict(),
  z.object({ kind: z.literal('environment-task'), ...verificationFields, task: z.string().regex(/^[a-z0-9-]+$/),
    operationIdInput: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }).strict(),
]);
export type CredentialVerification = z.infer<typeof credentialVerificationSchema>;

export const credentialTrackingSchema = z.object({
  role: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  label: z.string().min(1).max(160),
  purpose: z.string().min(1).max(500),
  source: credentialSourceSchema.optional(),
  database: databaseCredentialSelectionSchema.optional(),
  rotationGeneration: z.number().int().positive().optional(),
  runtimeConsumers: z.array(z.object({ environment: z.string().min(1), service: z.string().min(1), variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), format: z.enum(['value', 'database-url']).optional() }).strict()).min(1).optional(),
  verification: z.array(credentialVerificationSchema).min(1).max(32).optional().describe('Read an existing application operation receipt, or verify a separately approved declared environment task. Neither runs a business operation during inventory.'),
  kind: z.enum(['opaque', 'session-signing', 'github-package-read', 'github-api-management', 'anthropic', 'sendgrid', 'stripe', 'stripe-webhook', 'database-password']),
  stripeWebhook: z.object({
    environment: z.string().min(1),
    webhook: z.string().min(1),
    delivery: z.object({
      payloadFile: z.string().startsWith('/').max(2048).refine(value => !/[\r\n]/.test(value), 'Use an absolute path to the private raw delivery body.'),
      signatureRef: credentialSourceSchema,
    }).strict().optional(),
    userReportedPreviousSecretExpiresAt: z.string().datetime({ offset: true }).optional(),
  }).strict().optional(),
  containerPull: z.array(z.object({ environment: z.string().min(1), service: z.string().min(1), username: z.string().min(1) }).strict()).optional(),
  identity: z.object({ accountId: z.string().min(1), mode: z.enum(['test', 'live']).optional(), sandboxId: z.string().min(1).optional(), endpointId: z.string().min(1).optional() }).strict().optional(),
  userReportedCreatedAt: z.string().datetime({ offset: true }).optional(),
  userReportedRotatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type CredentialTracking = z.infer<typeof credentialTrackingSchema>;
