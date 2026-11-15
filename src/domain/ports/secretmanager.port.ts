import { z } from 'zod';

export const SECRET_MANAGER_PROVIDERS = [
  'aws-secrets',
  'stripe-projects',
] as const;

export type SecretManagerProvider = (typeof SECRET_MANAGER_PROVIDERS)[number];

// Secret reference format: provider://path/to/secret[#key][@version]
export interface SecretReference {
  provider: SecretManagerProvider;
  path: string;
  key?: string;
  version?: string;
  raw: string; // Original reference string
}

// Parse a secret reference string into its components
export function parseSecretRef(ref: string): SecretReference | null {
  // Format: provider://path/to/secret[#key][@version]
  const match = ref.match(/^([a-z0-9-]+):\/\/(.+?)(?:#([^@]+))?(?:@(.+))?$/);
  if (!match) {
    return null;
  }

  const [, provider, pathPart, key, version] = match;
  if (!SECRET_MANAGER_PROVIDERS.includes(provider as SecretManagerProvider)) {
    return null;
  }
  return {
    provider: provider as SecretManagerProvider,
    path: pathPart,
    key,
    version,
    raw: ref,
  };
}

// Resolved secret from a secret manager
export interface ResolvedSecret {
  value: string;
  version?: string;
  createdAt?: Date;
  expiresAt?: Date;
  metadata?: Record<string, string>;
}

// Secret listing item
export interface SecretListItem {
  path: string;
  keys?: string[]; // If the secret contains multiple keys
  version?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// Verify result from connect/verify
export interface SecretManagerVerifyResult {
  success: boolean;
  error?: string;
  identity?: string; // Account/user identity if available
}

/**
 * Interface for secret manager adapters.
 * All secret managers must implement this interface.
 */
export interface ISecretManagerAdapter {
  /** Provider name (e.g., 'aws-secrets') */
  readonly name: SecretManagerProvider;

  /**
   * Connect to the secret manager with credentials.
   * Credentials structure varies by provider.
   */
  connect(credentials: unknown): Promise<void>;

  /**
   * Verify the connection is working.
   */
  verify(): Promise<SecretManagerVerifyResult>;

  /**
   * Get a single secret value.
   * @param path Path to the secret
   * @param key Optional key within a multi-key secret
   * @param version Optional version to retrieve
   */
  getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret>;

  /**
   * List secrets at a path or prefix.
   */
  listSecrets(pathPrefix?: string): Promise<SecretListItem[]>;
}

// Zod schema for validating secret references in MCP tool inputs
export const SecretRefSchema = z.string().refine(
  (val) => parseSecretRef(val) !== null,
  'Invalid secret reference format. Expected: provider://path/to/secret[#key][@version]'
);

// Credentials schemas for each provider
export const AwsSecretsCredentialsSchema = z.object({
  region: z.string().default('us-east-1'),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  /** Required for temporary STS credentials (adds X-Amz-Security-Token). */
  sessionToken: z.string().optional(),
  // When explicit keys are omitted, the adapter resolves the AWS SDK default provider chain.
}).superRefine((credentials, ctx) => {
  if (Boolean(credentials.accessKeyId) !== Boolean(credentials.secretAccessKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'accessKeyId and secretAccessKey must be provided together',
      path: credentials.accessKeyId ? ['secretAccessKey'] : ['accessKeyId'],
    });
  }
});

/** Stripe Projects uses the authenticated local Stripe CLI session. */
export const StripeProjectsCredentialsSchema = z.object({
  authMode: z.literal('default').default('default'),
}).strict();

export type AwsSecretsCredentials = z.infer<typeof AwsSecretsCredentialsSchema>;
export type StripeProjectsCredentials = z.infer<typeof StripeProjectsCredentialsSchema>;
