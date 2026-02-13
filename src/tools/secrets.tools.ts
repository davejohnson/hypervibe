import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { SecretMappingRepository, SecretAccessLogRepository } from '../adapters/db/repositories/secret-mapping.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { secretManagerRegistry } from '../domain/registry/secretmanager.registry.js';
import { SecretResolver } from '../domain/services/secret.resolver.js';
import { SecretRotator } from '../domain/services/secret.rotator.js';
import { parseSecretRef, type SecretManagerProvider } from '../domain/ports/secretmanager.port.js';
import { resolveProject } from './resolve-project.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();
const mappingRepo = new SecretMappingRepository();
const accessLogRepo = new SecretAccessLogRepository();
const auditRepo = new AuditRepository();

// Mask a secret value for display
function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export function registerSecretsTools(server: McpServer): void {
  // List secrets from a connected secret manager
  server.tool(
    'secrets_list',
    'List secrets from a connected secret manager',
    {
      provider: z.enum(['vault', 'aws-secrets', 'doppler']).describe('Secret manager provider'),
      pathPrefix: z.string().optional().describe('Filter by path prefix'),
    },
    async ({ provider, pathPrefix }) => {
      // Check connection
      const connection = connectionRepo.findByProvider(provider);
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No connection found for ${provider}. Use connection_create first.`,
            }),
          }],
        };
      }

      if (connection.status !== 'verified') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Connection for ${provider} is not verified. Use connection_verify first.`,
            }),
          }],
        };
      }

      try {
        const secretStore = getSecretStore();
        const credentials = secretStore.decryptObject(connection.credentialsEncrypted);
        const adapter = secretManagerRegistry.createAdapter(provider, credentials);
        await adapter.connect(credentials);

        const secrets = await adapter.listSecrets(pathPrefix);

        accessLogRepo.create({
          action: 'list',
          provider: provider as SecretManagerProvider,
          secretPath: pathPrefix || '*',
          success: true,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              provider,
              count: secrets.length,
              secrets: secrets.map((s) => ({
                path: s.path,
                keys: s.keys,
                updatedAt: s.updatedAt?.toISOString(),
              })),
            }),
          }],
        };
      } catch (error) {
        accessLogRepo.create({
          action: 'list',
          provider: provider as SecretManagerProvider,
          secretPath: pathPrefix || '*',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // Get a secret value (returns masked)
  server.tool(
    'secrets_get',
    'Get a secret value (returns masked). Use the returned secret reference for mapping to env vars.',
    {
      provider: z.enum(['vault', 'aws-secrets', 'doppler']).describe('Secret manager provider'),
      path: z.string().describe('Path to the secret'),
      key: z.string().optional().describe('Specific key within a multi-key secret'),
      version: z.string().optional().describe('Specific version to retrieve'),
    },
    async ({ provider, path, key, version }) => {
      const connection = connectionRepo.findByProvider(provider);
      if (!connection || connection.status !== 'verified') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No verified connection for ${provider}. Use connection_create and connection_verify.`,
            }),
          }],
        };
      }

      try {
        const secretStore = getSecretStore();
        const credentials = secretStore.decryptObject(connection.credentialsEncrypted);
        const adapter = secretManagerRegistry.createAdapter(provider, credentials);
        await adapter.connect(credentials);

        const secret = await adapter.getSecret(path, key, version);

        accessLogRepo.create({
          action: 'read',
          provider: provider as SecretManagerProvider,
          secretPath: path,
          success: true,
        });

        // Build the secret reference for use in mappings
        let secretRef = `${provider}://${path}`;
        if (key) secretRef += `#${key}`;
        if (version) secretRef += `@${version}`;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              secretRef,
              value: maskValue(secret.value),
              version: secret.version,
              createdAt: secret.createdAt?.toISOString(),
              metadata: secret.metadata,
            }),
          }],
        };
      } catch (error) {
        accessLogRepo.create({
          action: 'read',
          provider: provider as SecretManagerProvider,
          secretPath: path,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // Set a secret value
  server.tool(
    'secrets_set',
    'Create or update a secret in a secret manager',
    {
      provider: z.enum(['vault', 'aws-secrets', 'doppler']).describe('Secret manager provider'),
      path: z.string().describe('Path for the secret'),
      values: z.record(z.string()).describe('Key-value pairs to store'),
    },
    async ({ provider, path, values }) => {
      const connection = connectionRepo.findByProvider(provider);
      if (!connection || connection.status !== 'verified') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No verified connection for ${provider}.`,
            }),
          }],
        };
      }

      try {
        const secretStore = getSecretStore();
        const credentials = secretStore.decryptObject(connection.credentialsEncrypted);
        const adapter = secretManagerRegistry.createAdapter(provider, credentials);
        await adapter.connect(credentials);

        const receipt = await adapter.setSecret(path, values);

        accessLogRepo.create({
          action: 'write',
          provider: provider as SecretManagerProvider,
          secretPath: path,
          success: receipt.success,
          error: receipt.error,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: receipt.success,
              path: receipt.path,
              version: receipt.version,
              error: receipt.error,
              keysStored: Object.keys(values),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // Map a secret reference to an env var for a project
  server.tool(
    'secrets_map',
    'Map a secret reference to an environment variable for a project. The secret will be resolved and injected during deployment.',
    {
      projectName: z.string().describe('Project name'),
      envVar: z.string().describe('Environment variable name (e.g., DATABASE_URL)'),
      secretRef: z.string().describe('Secret reference (e.g., vault://secret/data/db#password)'),
      environments: z.array(z.string()).optional().describe('Specific environments to apply to (empty = all)'),
      serviceName: z.string().optional().describe('Specific service to apply to (empty = all services)'),
    },
    async ({ projectName, envVar, secretRef, environments, serviceName }) => {
      const project = resolveProject({ projectName });
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

      // Validate the secret reference format
      const ref = parseSecretRef(secretRef);
      if (!ref) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Invalid secret reference format. Expected: provider://path/to/secret[#key][@version]',
            }),
          }],
        };
      }

      // Check that we have a connection for this provider
      const scopeHints = getProjectScopeHints(project);
      const connection = connectionRepo.findBestMatchFromHints(ref.provider, scopeHints);
      if (!connection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No connection found for ${ref.provider}. Use connection_create first.`,
            }),
          }],
        };
      }

      try {
        const mapping = mappingRepo.upsert({
          projectId: project.id,
          envVar,
          secretRef,
          environments,
          serviceName: serviceName ?? null,
        });

        auditRepo.create({
          action: 'secret_mapping.created',
          resourceType: 'project',
          resourceId: project.id,
          details: { envVar, secretRef, environments, serviceName },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mapping: {
                id: mapping.id,
                envVar: mapping.envVar,
                secretRef: mapping.secretRef,
                environments: mapping.environments,
                serviceName: mapping.serviceName,
              },
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // List all secret-to-env-var mappings
  server.tool(
    'secrets_mappings_list',
    'List all secret-to-env-var mappings for a project',
    {
      projectName: z.string().describe('Project name'),
    },
    async ({ projectName }) => {
      const project = resolveProject({ projectName });
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

      const mappings = mappingRepo.findByProjectId(project.id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            projectName,
            count: mappings.length,
            mappings: mappings.map((m) => ({
              id: m.id,
              envVar: m.envVar,
              secretRef: m.secretRef,
              environments: m.environments.length > 0 ? m.environments : 'all',
              serviceName: m.serviceName || 'all',
            })),
          }),
        }],
      };
    }
  );

  // Delete a secret mapping
  server.tool(
    'secrets_mapping_delete',
    'Delete a secret-to-env-var mapping',
    {
      projectName: z.string().describe('Project name'),
      envVar: z.string().describe('Environment variable name'),
      serviceName: z.string().optional().describe('Specific service (omit for global mapping)'),
    },
    async ({ projectName, envVar, serviceName }) => {
      const project = resolveProject({ projectName });
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

      const deleted = mappingRepo.deleteByProjectAndEnvVar(
        project.id,
        envVar,
        serviceName === undefined ? undefined : (serviceName || null)
      );

      if (deleted) {
        auditRepo.create({
          action: 'secret_mapping.deleted',
          resourceType: 'project',
          resourceId: project.id,
          details: { envVar, serviceName },
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: deleted,
            message: deleted ? 'Mapping deleted' : 'Mapping not found',
          }),
        }],
      };
    }
  );

  // Sync secrets - resolve secret refs and push to environment(s)
  server.tool(
    'secrets_sync',
    'Resolve secret references and sync them to environment(s) on the hosting platform',
    {
      projectName: z.string().describe('Project name'),
      environmentName: z.string().optional().describe('Specific environment (default: all environments with mappings)'),
      serviceName: z.string().optional().describe('Specific service (default: based on mappings)'),
      dryRun: z.boolean().optional().describe('Show what would be synced without actually syncing'),
    },
    async ({ projectName, environmentName, serviceName, dryRun }) => {
      const project = resolveProject({ projectName });
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

      // Get environments to sync
      let environments = envRepo.findByProjectId(project.id);
      if (environmentName) {
        environments = environments.filter((e) => e.name === environmentName);
        if (environments.length === 0) {
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
      }

      const resolver = new SecretResolver();
      const results: Array<{
        environment: string;
        resolved: number;
        failed: number;
        errors: Array<{ envVar: string; error: string }>;
        synced: boolean;
      }> = [];

      for (const env of environments) {
        const resolved = await resolver.resolveForEnvironment({
          projectId: project.id,
          environmentName: env.name,
          serviceName,
        });

        if (resolved.resolved === 0 && resolved.failed === 0) {
          // No mappings for this environment
          continue;
        }

        const envResult = {
          environment: env.name,
          resolved: resolved.resolved,
          failed: resolved.failed,
          errors: resolved.errors.map((e) => ({ envVar: e.envVar, error: e.error })),
          synced: false,
        };

        if (!dryRun && resolved.resolved > 0) {
          // Get hosting adapter and sync vars
          const adapterResult = await adapterFactory.getHostingAdapter(project);
          if (adapterResult.success && adapterResult.adapter) {
            try {
              // Get service to set vars on (use specified or first available)
              const services = serviceRepo.findByProjectId(project.id);
              const targetService = serviceName
                ? services.find((s) => s.name === serviceName)
                : services[0];

              if (!targetService) {
                envResult.errors.push({
                  envVar: '*',
                  error: 'No service found to set environment variables on',
                });
              } else {
                await adapterResult.adapter.setEnvVars(env, targetService, resolved.vars);
                envResult.synced = true;

                auditRepo.create({
                  action: 'secrets.synced',
                  resourceType: 'environment',
                  resourceId: env.id,
                  details: {
                    varsSet: Object.keys(resolved.vars),
                    count: resolved.resolved,
                  },
                });
              }
            } catch (error) {
              envResult.errors.push({
                envVar: '*',
                error: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          } else {
            envResult.errors.push({
              envVar: '*',
              error: adapterResult.error || 'No hosting adapter available',
            });
          }
        }

        results.push(envResult);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            dryRun: dryRun ?? false,
            environments: results,
            summary: {
              totalResolved: results.reduce((sum, r) => sum + r.resolved, 0),
              totalFailed: results.reduce((sum, r) => sum + r.failed, 0),
              totalSynced: results.filter((r) => r.synced).length,
            },
          }),
        }],
      };
    }
  );

  // Rotate a secret and sync to all mapped environments
  server.tool(
    'secrets_rotate',
    'Rotate a secret and propagate the new value to all mapped environments. Only supported by some providers (e.g., AWS Secrets Manager).',
    {
      provider: z.enum(['vault', 'aws-secrets', 'doppler']).describe('Secret manager provider'),
      path: z.string().describe('Path to the secret to rotate'),
    },
    async ({ provider, path }) => {
      const connection = connectionRepo.findByProvider(provider);
      if (!connection || connection.status !== 'verified') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `No verified connection for ${provider}.`,
            }),
          }],
        };
      }

      // Check if provider supports rotation
      const capabilities = secretManagerRegistry.getCapabilities(provider);
      if (!capabilities?.supportsRotation) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Provider '${provider}' does not support rotation. Manually update the secret and use secrets_sync.`,
            }),
          }],
        };
      }

      try {
        const rotator = new SecretRotator();
        const result = await rotator.rotateAndSync(provider as SecretManagerProvider, path);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: result.rotation.success,
              rotation: {
                path: result.rotation.path,
                oldVersion: result.rotation.oldVersion,
                newVersion: result.rotation.newVersion,
                rotatedAt: result.rotation.rotatedAt.toISOString(),
                error: result.rotation.error,
              },
              synced: result.synced,
              summary: {
                totalMappings: result.synced.length,
                successfulSyncs: result.synced.filter((s) => s.success).length,
                failedSyncs: result.synced.filter((s) => !s.success).length,
              },
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // View secret access audit log
  server.tool(
    'secrets_audit',
    'View secret access audit log',
    {
      projectName: z.string().optional().describe('Filter by project'),
      secretPath: z.string().optional().describe('Filter by secret path'),
      limit: z.number().optional().describe('Maximum entries to return (default: 50)'),
    },
    async ({ projectName, secretPath, limit = 50 }) => {
      let logs;

      if (projectName) {
        const project = resolveProject({ projectName });
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
        logs = accessLogRepo.findByProjectId(project.id, limit);
      } else if (secretPath) {
        logs = accessLogRepo.findBySecretPath(secretPath, limit);
      } else {
        logs = accessLogRepo.findRecent(limit);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            count: logs.length,
            entries: logs.map((log) => ({
              id: log.id,
              timestamp: log.timestamp.toISOString(),
              action: log.action,
              provider: log.provider,
              secretPath: log.secretPath,
              projectId: log.projectId,
              environmentName: log.environmentName,
              success: log.success,
              error: log.error,
            })),
          }),
        }],
      };
    }
  );
}
