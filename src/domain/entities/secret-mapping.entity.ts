import type { SecretManagerProvider } from '../ports/secretmanager.port.js';

/**
 * Maps environment variables to secret manager references.
 * When deploying, these mappings are resolved and the secret values
 * are injected into the target environment.
 */
export interface SecretMapping {
  id: string;
  projectId: string;
  envVar: string; // Target environment variable name (e.g., DATABASE_URL)
  secretRef: string; // Secret reference (e.g., vault://secret/data/db#password)
  environments: string[]; // Which environments to apply to (empty = all)
  serviceName: string | null; // Specific service, or null for all services
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSecretMappingInput {
  projectId: string;
  envVar: string;
  secretRef: string;
  environments?: string[];
  serviceName?: string | null;
}

/**
 * Audit log entry for secret access.
 * Stored locally for tracking which secrets were accessed and when.
 */
export interface SecretAccessLog {
  id: string;
  timestamp: Date;
  action: 'read' | 'write' | 'delete' | 'rotate' | 'list';
  provider: SecretManagerProvider;
  secretPath: string;
  projectId: string | null;
  environmentName: string | null;
  success: boolean;
  error: string | null;
}

export interface CreateSecretAccessLogInput {
  action: 'read' | 'write' | 'delete' | 'rotate' | 'list';
  provider: SecretManagerProvider;
  secretPath: string;
  projectId?: string | null;
  environmentName?: string | null;
  success: boolean;
  error?: string | null;
}
