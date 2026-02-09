import { z } from 'zod';

// Secret manager provider types
export type SecretManagerProvider =
  | 'vault'
  | 'aws-secrets'
  | 'gcp-secrets'
  | 'azure-keyvault'
  | '1password'
  | 'doppler'
  | 'infisical';

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
  return {
    provider: provider as SecretManagerProvider,
    path: pathPart,
    key,
    version,
    raw: ref,
  };
}

// Build a secret reference string from components
export function buildSecretRef(ref: Omit<SecretReference, 'raw'>): string {
  let result = `${ref.provider}://${ref.path}`;
  if (ref.key) {
    result += `#${ref.key}`;
  }
  if (ref.version) {
    result += `@${ref.version}`;
  }
  return result;
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

// Receipt for write operations
export interface SecretReceipt {
  success: boolean;
  path: string;
  version?: string;
  error?: string;
}

// Rotation result
export interface RotationResult {
  success: boolean;
  path: string;
  oldVersion?: string;
  newVersion?: string;
  rotatedAt: Date;
  error?: string;
}

// Audit log entry
export interface SecretAuditEntry {
  id: string;
  timestamp: Date;
  action: 'read' | 'write' | 'delete' | 'rotate' | 'list';
  provider: SecretManagerProvider;
  secretPath: string;
  projectId?: string;
  environmentName?: string;
  success: boolean;
  error?: string;
}

// Capabilities that secret managers may support
export interface SecretManagerCapabilities {
  supportsVersioning: boolean;
  supportsMultipleKeys: boolean; // Single secret can have multiple key-value pairs
  supportsRotation: boolean;
  supportsAuditLog: boolean;
  supportsDynamicSecrets: boolean; // Secrets that are generated on-demand
  maxSecretSize?: number; // In bytes
}

// Verify result from connect/verify
export interface SecretManagerVerifyResult {
  success: boolean;
  error?: string;
  identity?: string; // Account/user identity if available
  capabilities?: Partial<SecretManagerCapabilities>;
}

/**
 * Interface for secret manager adapters.
 * All secret managers must implement this interface.
 */
export interface ISecretManagerAdapter {
  /** Provider name (e.g., 'vault', 'aws-secrets') */
  readonly name: SecretManagerProvider;

  /** Capabilities supported by this provider */
  readonly capabilities: SecretManagerCapabilities;

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
   * Get multiple secrets at once (batch operation).
   * More efficient than multiple getSecret calls.
   */
  getSecrets(references: SecretReference[]): Promise<Map<string, ResolvedSecret>>;

  /**
   * Set a secret value.
   * @param path Path to the secret
   * @param values Key-value pairs to store
   */
  setSecret(path: string, values: Record<string, string>): Promise<SecretReceipt>;

  /**
   * Delete a secret.
   */
  deleteSecret(path: string): Promise<SecretReceipt>;

  /**
   * List secrets at a path or prefix.
   */
  listSecrets(pathPrefix?: string): Promise<SecretListItem[]>;

  /**
   * Rotate a secret (optional - check capabilities.supportsRotation).
   * Uses native rotation if available, otherwise generates new value.
   */
  rotateSecret?(path: string): Promise<RotationResult>;

  /**
   * Get audit log for secrets (optional - check capabilities.supportsAuditLog).
   */
  getAuditLog?(secretPath?: string, limit?: number): Promise<SecretAuditEntry[]>;
}

// Zod schema for validating secret references in MCP tool inputs
export const SecretRefSchema = z.string().refine(
  (val) => parseSecretRef(val) !== null,
  'Invalid secret reference format. Expected: provider://path/to/secret[#key][@version]'
);

// Credentials schemas for each provider
export const VaultCredentialsSchema = z.object({
  address: z.string().url('Vault address must be a valid URL'),
  token: z.string().optional(),
  roleId: z.string().optional(),
  secretId: z.string().optional(),
  namespace: z.string().optional(),
}).refine(
  (data) => data.token || (data.roleId && data.secretId),
  'Either token or roleId+secretId is required'
);

export const AwsSecretsCredentialsSchema = z.object({
  region: z.string().default('us-east-1'),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  // If not provided, uses default credential chain
});

export const GcpSecretsCredentialsSchema = z.object({
  projectId: z.string(),
  keyFilePath: z.string().optional(),
  // If keyFilePath not provided, uses default credentials
});

export const AzureKeyVaultCredentialsSchema = z.object({
  vaultUrl: z.string().url('Vault URL must be valid'),
  tenantId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  // If not provided, uses default Azure credential chain
});

export const OnePasswordCredentialsSchema = z.object({
  connectHost: z.string().url('Connect server URL required'),
  connectToken: z.string().min(1, 'Connect token required'),
});

export const DopplerCredentialsSchema = z.object({
  token: z.string().min(1, 'Service token required'),
  project: z.string().optional(),
  config: z.string().optional(),
});

export const InfisicalCredentialsSchema = z.object({
  siteUrl: z.string().url().default('https://app.infisical.com'),
  serviceToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
}).refine(
  (data) => data.serviceToken || (data.clientId && data.clientSecret),
  'Either serviceToken or clientId+clientSecret is required'
);

export type VaultCredentials = z.infer<typeof VaultCredentialsSchema>;
export type AwsSecretsCredentials = z.infer<typeof AwsSecretsCredentialsSchema>;
export type GcpSecretsCredentials = z.infer<typeof GcpSecretsCredentialsSchema>;
export type AzureKeyVaultCredentials = z.infer<typeof AzureKeyVaultCredentialsSchema>;
export type OnePasswordCredentials = z.infer<typeof OnePasswordCredentialsSchema>;
export type DopplerCredentials = z.infer<typeof DopplerCredentialsSchema>;
export type InfisicalCredentials = z.infer<typeof InfisicalCredentialsSchema>;
