import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { IntegrationRepository } from '../adapters/db/repositories/integration.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { parseEnvFile, maskSecretValue } from '../utils/env-parser.js';
import type { RailwayCredentials } from '../domain/entities/connection.entity.js';
import type { IntegrationKeyMode, StoredKeys } from '../domain/entities/integration.entity.js';
import type { StripeCredentials } from '../adapters/providers/stripe/stripe.adapter.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();
const integrationRepo = new IntegrationRepository();
const auditRepo = new AuditRepository();

// Common Stripe key names
const STRIPE_KEY_NAMES = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'];

export function registerIntegrationTools(server: McpServer): void {
  server.tool(
    'integration_sync',
    'Sync integration keys to environment(s). Supports Stripe keys synced to Railway environments.',
    {
      provider: z.enum(['stripe']).describe('Integration provider'),
      projectName: z.string().describe('Project name'),
      targetEnvironments: z.array(z.string()).describe('Target environment names'),
      serviceName: z.string().describe('Service to sync keys to'),
      // Key sources (one required)
      keys: z.record(z.string()).optional().describe('Keys to sync directly (e.g., STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY)'),
      envFilePath: z.string().optional().describe('Path to .env file to read keys from'),
      useStoredKeys: z.boolean().optional().describe('Use previously stored integration keys'),
      useConnectionKeys: z.boolean().optional().describe('Use keys from the provider connection (created via connection_create)'),
      // Options
      storeKeys: z.boolean().optional().describe('Store keys for future syncs (default: true)'),
      mode: z.enum(['sandbox', 'live']).optional().describe('Key mode (sandbox or live). Required when using stored keys or connection keys.'),
    },
    async ({ provider, projectName, targetEnvironments, serviceName, keys, envFilePath, useStoredKeys, useConnectionKeys, storeKeys = true, mode }) => {
      // Validate key source
      const keySourceCount = [keys, envFilePath, useStoredKeys, useConnectionKeys].filter(Boolean).length;
      if (keySourceCount === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Must provide one of: keys, envFilePath, or useStoredKeys',
            }),
          }],
        };
      }
      if (keySourceCount > 1) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Provide only one of: keys, envFilePath, useStoredKeys, or useConnectionKeys',
            }),
          }],
        };
      }

      // Find project
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Project not found: ${projectName}`,
            }),
          }],
        };
      }

      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway connection found. Use connection_create first.',
            }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);

      // Get keys to sync
      let keysToSync: Record<string, string>;

      if (keys) {
        keysToSync = keys;
      } else if (envFilePath) {
        try {
          const envVars = parseEnvFile(envFilePath);
          keysToSync = {};
          for (const keyName of STRIPE_KEY_NAMES) {
            if (envVars[keyName]) {
              keysToSync[keyName] = envVars[keyName];
            }
          }
          if (Object.keys(keysToSync).length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `No Stripe keys found in ${envFilePath}. Expected: ${STRIPE_KEY_NAMES.join(', ')}`,
                }),
              }],
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Failed to read env file: ${error}`,
              }),
            }],
          };
        }
      } else if (useStoredKeys) {
        if (!mode) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'mode is required when using stored keys',
              }),
            }],
          };
        }
        const storedKey = integrationRepo.findByProviderAndMode(provider, mode);
        if (!storedKey) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No stored ${mode} keys found for ${provider}`,
              }),
            }],
          };
        }
        keysToSync = secretStore.decryptObject<StoredKeys>(storedKey.keysEncrypted);
      } else if (useConnectionKeys) {
        if (!mode) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'mode is required when using connection keys',
              }),
            }],
          };
        }

        // Get the provider connection
        const providerConnection = connectionRepo.findByProvider(provider);
        if (!providerConnection) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No ${provider} connection found. Use connection_create first.`,
              }),
            }],
          };
        }

        // Extract keys from connection based on provider
        if (provider === 'stripe') {
          const stripeCreds = secretStore.decryptObject<StripeCredentials>(providerConnection.credentialsEncrypted);
          const secretKey = mode === 'sandbox' ? stripeCreds.sandboxSecretKey : stripeCreds.liveSecretKey;
          const publishableKey = mode === 'sandbox' ? stripeCreds.sandboxPublishableKey : stripeCreds.livePublishableKey;

          if (!secretKey) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `No ${mode} secret key found in Stripe connection. Update connection with connection_create.`,
                }),
              }],
            };
          }

          keysToSync = {
            STRIPE_SECRET_KEY: secretKey,
          };

          if (publishableKey) {
            keysToSync.STRIPE_PUBLISHABLE_KEY = publishableKey;
          }
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `useConnectionKeys not supported for provider: ${provider}`,
              }),
            }],
          };
        }
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No key source provided',
            }),
          }],
        };
      }

      // Detect mode from keys if not provided
      let detectedMode: IntegrationKeyMode | undefined = mode;
      if (!detectedMode && provider === 'stripe') {
        const secretKey = keysToSync['STRIPE_SECRET_KEY'];
        if (secretKey) {
          if (secretKey.startsWith('sk_test_')) {
            detectedMode = 'sandbox';
          } else if (secretKey.startsWith('sk_live_')) {
            detectedMode = 'live';
          }
        }
      }

      // Connect to Railway
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      // Process each target environment
      const results: Array<{
        environment: string;
        success: boolean;
        message: string;
        keysSet?: string[];
      }> = [];

      for (const envName of targetEnvironments) {
        const environment = envRepo.findByProjectAndName(project.id, envName);
        if (!environment) {
          results.push({
            environment: envName,
            success: false,
            message: `Environment not found: ${envName}`,
          });
          continue;
        }

        // Find the service
        const service = serviceRepo.findByProjectAndName(project.id, serviceName);
        if (!service) {
          results.push({
            environment: envName,
            success: false,
            message: `Service not found: ${serviceName}`,
          });
          continue;
        }

        // Check if environment has Railway bindings
        const bindings = environment.platformBindings as {
          railwayProjectId?: string;
          railwayEnvironmentId?: string;
          services?: Record<string, { serviceId: string }>;
        };

        if (!bindings.railwayProjectId) {
          results.push({
            environment: envName,
            success: false,
            message: 'No Railway project bound to this environment',
          });
          continue;
        }

        if (!bindings.services?.[serviceName]?.serviceId) {
          results.push({
            environment: envName,
            success: false,
            message: `Service ${serviceName} not deployed to Railway in this environment`,
          });
          continue;
        }

        // Set environment variables
        try {
          const receipt = await adapter.setEnvVars(environment, service, keysToSync);
          if (receipt.success) {
            results.push({
              environment: envName,
              success: true,
              message: `Set ${Object.keys(keysToSync).length} keys`,
              keysSet: Object.keys(keysToSync),
            });

            // Audit log (key names only, not values)
            auditRepo.create({
              action: 'integration.synced',
              resourceType: 'environment',
              resourceId: environment.id,
              details: {
                provider,
                serviceName,
                keysSet: Object.keys(keysToSync),
                mode: detectedMode,
              },
            });
          } else {
            results.push({
              environment: envName,
              success: false,
              message: receipt.error || 'Failed to set environment variables',
            });
          }
        } catch (error) {
          results.push({
            environment: envName,
            success: false,
            message: `Error: ${error}`,
          });
        }
      }

      // Store keys if requested
      let storedKeysInfo: { mode: IntegrationKeyMode; keyNames: string[] } | undefined;
      if (storeKeys && detectedMode) {
        const encryptedKeys = secretStore.encryptObject(keysToSync);
        integrationRepo.upsert({
          provider,
          mode: detectedMode,
          keysEncrypted: encryptedKeys,
        });
        storedKeysInfo = {
          mode: detectedMode,
          keyNames: Object.keys(keysToSync),
        };
      }

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: failCount === 0,
            summary: {
              provider,
              mode: detectedMode,
              environmentsSucceeded: successCount,
              environmentsFailed: failCount,
            },
            results,
            storedKeys: storedKeysInfo,
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_keys_get',
    'Get stored integration keys. Returns key names and masked values.',
    {
      provider: z.enum(['stripe']).describe('Integration provider'),
      mode: z.enum(['sandbox', 'live']).optional().describe('Key mode (sandbox or live). If not specified, returns all modes.'),
    },
    async ({ provider, mode }) => {
      const secretStore = getSecretStore();

      if (mode) {
        const storedKey = integrationRepo.findByProviderAndMode(provider, mode);
        if (!storedKey) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                found: false,
                message: `No ${mode} keys stored for ${provider}`,
              }),
            }],
          };
        }

        const keys = secretStore.decryptObject<StoredKeys>(storedKey.keysEncrypted);
        const maskedKeys: Record<string, string> = {};
        for (const [keyName, value] of Object.entries(keys)) {
          maskedKeys[keyName] = maskSecretValue(value);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              found: true,
              provider,
              mode,
              keys: maskedKeys,
              updatedAt: storedKey.updatedAt,
            }),
          }],
        };
      }

      // Return all modes
      const storedKeys = integrationRepo.findByProvider(provider);
      if (storedKeys.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              found: false,
              message: `No keys stored for ${provider}`,
            }),
          }],
        };
      }

      const results = storedKeys.map((storedKey) => {
        const keys = secretStore.decryptObject<StoredKeys>(storedKey.keysEncrypted);
        const maskedKeys: Record<string, string> = {};
        for (const [keyName, value] of Object.entries(keys)) {
          maskedKeys[keyName] = maskSecretValue(value);
        }
        return {
          mode: storedKey.mode,
          keys: maskedKeys,
          updatedAt: storedKey.updatedAt,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            found: true,
            provider,
            storedKeys: results,
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_keys_delete',
    'Delete stored integration keys.',
    {
      provider: z.enum(['stripe']).describe('Integration provider'),
      mode: z.enum(['sandbox', 'live']).describe('Key mode to delete'),
    },
    async ({ provider, mode }) => {
      const storedKey = integrationRepo.findByProviderAndMode(provider, mode);
      if (!storedKey) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No ${mode} keys stored for ${provider}`,
            }),
          }],
        };
      }

      integrationRepo.delete(storedKey.id);

      auditRepo.create({
        action: 'integration.keys_deleted',
        resourceType: 'integration_key',
        resourceId: storedKey.id,
        details: { provider, mode },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Deleted ${mode} keys for ${provider}`,
          }),
        }],
      };
    }
  );

  server.tool(
    'integration_verify',
    'Verify integration keys are correctly set in an environment. Fetches actual env vars from Railway and checks expected keys exist with correct prefixes.',
    {
      provider: z.enum(['stripe']).describe('Integration provider'),
      projectName: z.string().describe('Project name'),
      environmentName: z.string().describe('Environment to verify'),
      serviceName: z.string().describe('Service to check'),
      expectedMode: z.enum(['sandbox', 'live']).optional().describe('Expected key mode (sandbox=sk_test_/pk_test_, live=sk_live_/pk_live_)'),
    },
    async ({ provider, projectName, environmentName, serviceName, expectedMode }) => {
      // Find project
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Project not found: ${projectName}`,
            }),
          }],
        };
      }

      // Find environment
      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Environment not found: ${environmentName}`,
            }),
          }],
        };
      }

      // Get Railway connection
      const connection = connectionRepo.findByProvider('railway');
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway connection found. Use connection_create first.',
            }),
          }],
        };
      }

      // Check environment has Railway bindings
      const bindings = environment.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway project bound to this environment',
            }),
          }],
        };
      }

      if (!bindings.railwayEnvironmentId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway environment bound to this environment',
            }),
          }],
        };
      }

      if (!bindings.services?.[serviceName]?.serviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service ${serviceName} not deployed to Railway in this environment`,
            }),
          }],
        };
      }

      // Connect to Railway and fetch variables
      const secretStore = getSecretStore();
      const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
      const adapter = new RailwayAdapter();
      await adapter.connect(credentials);

      const variables = await adapter.getServiceVariables(
        bindings.railwayProjectId,
        bindings.services[serviceName].serviceId,
        bindings.railwayEnvironmentId
      );

      // Check for Stripe keys
      const results: Array<{
        key: string;
        exists: boolean;
        maskedValue?: string;
        modeValid?: boolean;
        detectedMode?: string;
      }> = [];

      let allKeysExist = true;
      let allModesValid = true;

      for (const keyName of STRIPE_KEY_NAMES) {
        const value = variables[keyName];
        const exists = !!value;

        if (!exists) {
          allKeysExist = false;
          results.push({ key: keyName, exists: false });
          continue;
        }

        // Detect mode from key prefix
        let detectedMode: 'sandbox' | 'live' | undefined;
        if (keyName === 'STRIPE_SECRET_KEY') {
          if (value.startsWith('sk_test_')) {
            detectedMode = 'sandbox';
          } else if (value.startsWith('sk_live_')) {
            detectedMode = 'live';
          }
        } else if (keyName === 'STRIPE_PUBLISHABLE_KEY') {
          if (value.startsWith('pk_test_')) {
            detectedMode = 'sandbox';
          } else if (value.startsWith('pk_live_')) {
            detectedMode = 'live';
          }
        }

        // Validate mode if expected
        let modeValid: boolean | undefined;
        if (expectedMode && detectedMode) {
          modeValid = detectedMode === expectedMode;
          if (!modeValid) {
            allModesValid = false;
          }
        }

        results.push({
          key: keyName,
          exists: true,
          maskedValue: maskSecretValue(value),
          detectedMode,
          modeValid,
        });
      }

      // Build verification summary
      const passed = allKeysExist && (expectedMode ? allModesValid : true);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            verification: {
              passed,
              provider,
              environment: environmentName,
              service: serviceName,
              expectedMode,
              allKeysExist,
              allModesValid: expectedMode ? allModesValid : undefined,
            },
            keys: results,
          }),
        }],
      };
    }
  );
}
