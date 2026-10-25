import { z } from 'zod';

const uuid = z.string().guid();
const accountNumber = z.string().regex(/^\d{12}$/);
const region = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
export const awsSecretDestinationSchema = z.object({
  provider: z.literal('aws-secrets'), accountId: accountNumber, region,
  secretArn: z.string().max(2048).regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/),
}).strict();
export const gcpSecretDestinationSchema = z.object({
  provider: z.literal('gcp-secret-manager'),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  projectNumber: z.string().regex(/^[1-9]\d{5,19}$/),
  secretId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
}).strict();
export const azureSecretDestinationSchema = z.object({
  provider: z.literal('azure-key-vault'), tenantId: uuid, subscriptionId: uuid,
  resourceGroup: z.string().regex(/^[A-Za-z0-9_().-]{1,90}$/).refine(value => !value.endsWith('.')),
  vaultName: z.string().regex(/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/).refine(value => !value.includes('--')),
  secretName: z.string().regex(/^[A-Za-z0-9-]{1,127}$/),
}).strict();

/** Native scope is explicit; host authorization is required in addition to parsing. */
export const secretDestinationSchema = z.discriminatedUnion('provider', [
  awsSecretDestinationSchema, gcpSecretDestinationSchema, azureSecretDestinationSchema,
]).superRefine((destination, ctx) => {
  if (destination.provider === 'aws-secrets') {
    const fields = destination.secretArn.split(':');
    if (fields[3] !== destination.region || fields[4] !== destination.accountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Secret ARN does not match its approved account and region.' });
    }
  }
});
export type SecretDestination = z.infer<typeof secretDestinationSchema>;
export type AwsSecretDestination = z.infer<typeof awsSecretDestinationSchema>;
export type GcpSecretDestination = z.infer<typeof gcpSecretDestinationSchema>;
export type AzureSecretDestination = z.infer<typeof azureSecretDestinationSchema>;

/** Provider identity normalization for cross-environment collision detection. */
export function secretDestinationIdentity(input: SecretDestination): { provider: SecretDestination['provider']; resource: string } {
  const parsed = secretDestinationSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid secret destination.');
  const destination = parsed.data;
  if (destination.provider === 'aws-secrets') return { provider: destination.provider, resource: destination.secretArn };
  if (destination.provider === 'gcp-secret-manager') return { provider: destination.provider,
    resource: `projects/${destination.projectNumber}/secrets/${destination.secretId}` };
  return { provider: destination.provider,
    resource: `https://${destination.vaultName}.vault.azure.net/secrets/${destination.secretName.toLowerCase()}` };
}

export const runtimeSecretReferenceSchema = z.object({
  destination: secretDestinationSchema,
  version: z.string().min(1).max(64),
}).strict().superRefine((reference, ctx) => {
  const valid = reference.destination.provider === 'gcp-secret-manager'
    ? /^[1-9]\d{0,19}$/.test(reference.version)
    : reference.destination.provider === 'azure-key-vault'
      ? /^[a-f0-9]{32}$/.test(reference.version)
      : /^[A-Za-z0-9-]{32,64}$/.test(reference.version);
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An immutable native secret version is required.' });
});
export type RuntimeSecretReference = z.infer<typeof runtimeSecretReferenceSchema>;
export type SecretVersionReference = RuntimeSecretReference;

export function validateSecretDestination(input: unknown): SecretDestination {
  const parsed = secretDestinationSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid secret destination.');
  return parsed.data;
}
export function validateRuntimeSecretReference(input: unknown): RuntimeSecretReference {
  const parsed = runtimeSecretReferenceSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid immutable secret reference.');
  return parsed.data;
}

export const secretDeliveryAttemptSchema = z.object({
  attemptId: uuid,
  context: z.object({
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  destination: secretDestinationSchema,
}).strict();
export type SecretDeliveryAttempt = z.infer<typeof secretDeliveryAttemptSchema>;

export const secretDestinationFailureCodeSchema = z.enum([
  'invalid_input', 'scope_mismatch', 'destination_absent', 'destination_initialized',
  'access_denied', 'provider_unavailable', 'invalid_response', 'deadline_exceeded',
  'write_uncertain', 'reconciliation_unavailable', 'attempt_not_found', 'attempt_ambiguous',
  'authorization_unconfirmed',
]);
export type SecretDestinationFailureCode = z.infer<typeof secretDestinationFailureCodeSchema>;
export const secretDeliveryResultSchema = z.union([
  z.object({ status: z.literal('delivered'), reference: runtimeSecretReferenceSchema }).strict(),
  z.object({ status: z.enum(['unknown', 'rejected']), code: secretDestinationFailureCodeSchema }).strict(),
]);
export type SecretDeliveryResult = z.infer<typeof secretDeliveryResultSchema>;
export type SecretDestinationObservation =
  | { status: 'present'; hasVersions: boolean }
  | { status: 'absent' }
  | { status: 'unknown'; code: SecretDestinationFailureCode };
export interface SecretDestinationCallOptions {
  signal?: AbortSignal;
  /** Entire operation, including token acquisition and response bodies; 1..30000 ms. */
  deadlineMs?: number;
}
export interface SecretDestinationDeliveryOptions extends SecretDestinationCallOptions {
  /** Current host source/authority check after native preflight, before mutation. */
  beforeWrite?: (signal: AbortSignal) => Promise<void>;
}
export interface SecretDestinationDriver {
  /** Optional native readiness hint, never a replacement for mutation authorization. */
  verifyWriteAccess?(destination: SecretDestination, options?: SecretDestinationCallOptions): Promise<SecretWriterAccess>;
  observe(destination: SecretDestination, options?: SecretDestinationCallOptions): Promise<SecretDestinationObservation>;
  /** Host must durably claim this attempt before calling once. Never retry this method. */
  deliver(attempt: SecretDeliveryAttempt, transientValue: string, options?: SecretDestinationDeliveryOptions): Promise<SecretDeliveryResult>;
  /** Read-only recovery. Unknown never authorizes replay of deliver. */
  reconcile(attempt: SecretDeliveryAttempt, options?: SecretDestinationCallOptions): Promise<SecretDeliveryResult>;
}

export type SecretWriterAccess = { status: 'ready' }
  | { status: 'unavailable'; code: SecretDestinationFailureCode };

export const MAX_DELIVERY_SECRET_BYTES = 16_384;
