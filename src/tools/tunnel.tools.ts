import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { tunnelManager } from '../adapters/providers/tunnel/tunnel.manager.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { TunnelCredentials } from '../domain/entities/connection.entity.js';

const connectionRepo = new ConnectionRepository();

function getTunnelConfig(): { provider: 'cloudflared' | 'ngrok'; ngrokAuthToken?: string } {
  // Check if there's a tunnel connection with preferences
  const connection = connectionRepo.findByProvider('tunnel');
  if (connection) {
    const secretStore = getSecretStore();
    const credentials = secretStore.decryptObject<TunnelCredentials>(connection.credentialsEncrypted);
    return {
      provider: credentials.provider,
      ngrokAuthToken: credentials.ngrokAuthToken,
    };
  }

  // Default to cloudflared (free, no account required)
  return { provider: 'cloudflared' };
}

export function registerTunnelTools(server: McpServer): void {
  server.tool(
    'tunnel_start',
    'Start a webhook tunnel to expose a local port to the internet (for testing webhooks from Stripe, SendGrid, etc.)',
    {
      localPort: z.number().describe('Local port to expose (e.g., 3000)'),
      provider: z.enum(['cloudflared', 'ngrok']).optional().describe('Tunnel provider (default: cloudflared)'),
    },
    async ({ localPort, provider }) => {
      try {
        const config = getTunnelConfig();
        const selectedProvider = provider ?? config.provider;

        const tunnelInfo = await tunnelManager.start(localPort, selectedProvider, {
          ngrokAuthToken: config.ngrokAuthToken,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Tunnel started. Local port ${localPort} is now accessible at the public URL.`,
              tunnel: {
                id: tunnelInfo.id,
                provider: tunnelInfo.provider,
                localPort: tunnelInfo.localPort,
                publicUrl: tunnelInfo.publicUrl,
                status: tunnelInfo.status,
              },
              usage: `Use ${tunnelInfo.publicUrl} as your webhook URL for testing.`,
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
              hint: provider === 'ngrok'
                ? 'Make sure ngrok is installed: https://ngrok.com/download'
                : 'Make sure cloudflared is installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'tunnel_stop',
    'Stop a running webhook tunnel',
    {
      tunnelId: z.string().describe('Tunnel ID to stop (e.g., "cloudflared-3000")'),
    },
    async ({ tunnelId }) => {
      try {
        const stopped = await tunnelManager.stop(tunnelId);

        if (stopped) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: `Tunnel ${tunnelId} stopped`,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Tunnel ${tunnelId} not found`,
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
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'tunnel_list',
    'List all active webhook tunnels',
    {},
    async () => {
      try {
        const tunnels = tunnelManager.listTunnels();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: tunnels.length,
              tunnels: tunnels.map((t) => ({
                id: t.id,
                provider: t.provider,
                localPort: t.localPort,
                publicUrl: t.publicUrl,
                status: t.status,
              })),
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

  server.tool(
    'tunnel_status',
    'Get the status of a specific tunnel',
    {
      tunnelId: z.string().describe('Tunnel ID to check (e.g., "cloudflared-3000")'),
    },
    async ({ tunnelId }) => {
      try {
        const status = tunnelManager.getStatus(tunnelId);

        if (status) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                tunnel: {
                  id: status.id,
                  provider: status.provider,
                  localPort: status.localPort,
                  publicUrl: status.publicUrl,
                  status: status.status,
                },
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Tunnel ${tunnelId} not found or not running`,
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
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );
}
