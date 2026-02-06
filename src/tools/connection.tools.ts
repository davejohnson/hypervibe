import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

/**
 * Helper function to create an error response
 */
function errorResponse(error: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error }),
      },
    ],
  };
}

/**
 * Helper function to create a success response
 */
function successResponse(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, ...data }),
      },
    ],
  };
}

export function registerConnectionTools(server: McpServer): void {
  // Get all registered provider names for the enum
  const providerNames = providerRegistry.names();
  if (providerNames.length === 0) {
    throw new Error('No providers registered. Ensure adapters are imported before registering tools.');
  }

  server.tool(
    'connection_create',
    'Create or update a provider connection (e.g., Railway API token, Stripe keys, Cloudflare, SendGrid)',
    {
      provider: z.enum(providerNames as [string, ...string[]]).describe('Provider name'),
      credentials: z.record(z.unknown()).describe('Provider-specific credentials object'),
      scope: z.string().optional().describe('Optional scope for fine-grained tokens (e.g., "owner/repo" for GitHub, "example.com" for Cloudflare). Use "org/*" for wildcard matching. Leave empty for global fallback.'),
    },
    async ({ provider, credentials, scope }) => {
      const secretStore = getSecretStore();

      // Validate credentials using the provider's schema
      const validation = providerRegistry.validateCredentials(provider, credentials);
      if (!validation.success) {
        return errorResponse(validation.error!);
      }

      // Encrypt credentials
      const credentialsEncrypted = secretStore.encryptObject(validation.data);

      // Upsert connection
      const connection = connectionRepo.upsert({
        provider,
        scope: scope || null,
        credentialsEncrypted,
      });

      // Run provider dependency installation if needed
      const registeredProvider = providerRegistry.get(provider);
      let depsResult: { installed: string[]; errors: string[] } | undefined;
      if (registeredProvider?.ensureDependencies) {
        depsResult = await registeredProvider.ensureDependencies();
      }

      auditRepo.create({
        action: 'connection.created',
        resourceType: 'connection',
        resourceId: connection.id,
        details: { provider, scope: scope || null },
      });

      const scopeDisplay = scope || 'global';
      const response: Record<string, unknown> = {
        message: `Connection for ${provider} (${scopeDisplay}) saved. Use connection_verify to test it.`,
        connection: {
          id: connection.id,
          provider: connection.provider,
          scope: connection.scope,
          status: connection.status,
          createdAt: connection.createdAt,
        },
      };

      if (depsResult?.installed.length) {
        response.dependenciesInstalled = depsResult.installed;
      }
      if (depsResult?.errors.length) {
        response.dependencyErrors = depsResult.errors;
      }

      return successResponse(response);
    }
  );

  server.tool(
    'connection_verify',
    'Verify that a provider connection works',
    {
      provider: z.enum(providerNames as [string, ...string[]]).describe('Provider name'),
      scope: z.string().optional().describe('Optional scope to verify a specific scoped connection. Leave empty to verify the global connection.'),
    },
    async ({ provider, scope }) => {
      const connection = connectionRepo.findByProviderAndScope(provider, scope || null);

      const scopeDisplay = scope || 'global';
      if (!connection) {
        return errorResponse(`No connection found for provider: ${provider} (${scopeDisplay}). Use connection_create first.`);
      }

      const secretStore = getSecretStore();
      const registeredProvider = providerRegistry.get(provider);

      if (!registeredProvider) {
        return errorResponse(`Unknown provider: ${provider}`);
      }

      try {
        const decryptedCreds = secretStore.decryptObject(connection.credentialsEncrypted);
        const adapter = registeredProvider.factory(decryptedCreds);

        // Check if adapter has a verify method
        if (typeof (adapter as { verify?: () => Promise<unknown> }).verify !== 'function') {
          // For providers without verify (like local, tunnel), just mark as verified
          connectionRepo.updateStatus(connection.id, 'verified');
          return successResponse({
            message: `${provider} connection (${scopeDisplay}) saved`,
            status: 'verified',
          });
        }

        // Call verify on the adapter
        const result = await (adapter as { verify: (scope?: string) => Promise<{ success: boolean; error?: string; email?: string; accountId?: string; zones?: string[]; version?: string; warning?: string }> }).verify(scope || undefined);

        if (result.success) {
          connectionRepo.updateStatus(connection.id, 'verified');
          auditRepo.create({
            action: 'connection.verified',
            resourceType: 'connection',
            resourceId: connection.id,
            details: { provider, scope: scope || null, email: result.email, accountId: result.accountId, version: result.version },
          });

          const displayName = registeredProvider.metadata.displayName;
          let message = `${displayName} connection (${scopeDisplay}) verified successfully`;
          if (result.email) {
            message += ` for ${result.email}`;
          }
          if (result.version) {
            message += ` (v${result.version})`;
          }

          return successResponse({
            message,
            status: 'verified',
            ...(result.email && { email: result.email }),
            ...(result.accountId && { accountId: result.accountId }),
            ...(result.version && { version: result.version }),
            ...(result.warning && { warning: result.warning }),
          });
        } else {
          connectionRepo.updateStatus(connection.id, 'failed');
          auditRepo.create({
            action: 'connection.failed',
            resourceType: 'connection',
            resourceId: connection.id,
            details: { provider, scope: scope || null, reason: result.error },
          });

          const helpUrl = registeredProvider.metadata.setupHelpUrl;
          let errorMsg = `${registeredProvider.metadata.displayName} verification failed: ${result.error}`;
          if (helpUrl) {
            errorMsg += `. See ${helpUrl} for setup instructions.`;
          }

          return errorResponse(errorMsg);
        }
      } catch (error) {
        connectionRepo.updateStatus(connection.id, 'failed');
        auditRepo.create({
          action: 'connection.failed',
          resourceType: 'connection',
          resourceId: connection.id,
          details: { provider, scope: scope || null, error: String(error) },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Verification failed: ${error}`,
                status: 'failed',
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    'connection_list',
    'List all provider connections and available providers',
    {},
    async () => {
      const connections = connectionRepo.findAll();
      const allProviders = providerRegistry.all();

      return successResponse({
        count: connections.length,
        connections: connections.map((c) => ({
          id: c.id,
          provider: c.provider,
          scope: c.scope ?? 'global',
          status: c.status,
          lastVerifiedAt: c.lastVerifiedAt,
          createdAt: c.createdAt,
        })),
        availableProviders: allProviders.map((p) => ({
          name: p.metadata.name,
          displayName: p.metadata.displayName,
          category: p.metadata.category,
          setupHelpUrl: p.metadata.setupHelpUrl,
        })),
      });
    }
  );

  server.tool(
    'connection_delete',
    'Delete a provider connection',
    {
      provider: z.enum(providerNames as [string, ...string[]]).describe('Provider name'),
      scope: z.string().optional().describe('Optional scope to delete a specific scoped connection. Leave empty to delete the global connection.'),
    },
    async ({ provider, scope }) => {
      const connection = connectionRepo.findByProviderAndScope(provider, scope || null);

      const scopeDisplay = scope || 'global';
      if (!connection) {
        return errorResponse(`No connection found for provider: ${provider} (${scopeDisplay})`);
      }

      connectionRepo.delete(connection.id);

      auditRepo.create({
        action: 'connection.deleted',
        resourceType: 'connection',
        resourceId: connection.id,
        details: { provider, scope: scope || null },
      });

      return successResponse({
        message: `Connection for ${provider} (${scopeDisplay}) deleted`,
      });
    }
  );
}
