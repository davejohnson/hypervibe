import { z } from 'zod';
import type { TunnelInfo, TunnelAdapter } from './tunnel.types.js';
import { CloudflaredAdapter } from './cloudflared.adapter.js';
import { NgrokAdapter } from './ngrok.adapter.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

// Credentials schema for tunnel configuration
export const TunnelCredentialsSchema = z.object({
  provider: z.enum(['cloudflared', 'ngrok']).default('cloudflared'),
  ngrokAuthToken: z.string().optional(),
});

export type TunnelCredentials = z.infer<typeof TunnelCredentialsSchema>;

/**
 * Manages multiple tunnel instances across providers.
 * Tunnels are ephemeral and not persisted to the database.
 */
class TunnelManager {
  private tunnels = new Map<string, TunnelAdapter>();

  async start(
    localPort: number,
    provider: 'cloudflared' | 'ngrok' = 'cloudflared',
    options?: { ngrokAuthToken?: string }
  ): Promise<TunnelInfo> {
    const tunnelId = `${provider}-${localPort}`;

    // Check if tunnel already exists for this port
    const existing = this.tunnels.get(tunnelId);
    if (existing?.isRunning()) {
      const status = existing.getStatus();
      if (status) {
        return status;
      }
    }

    // Create new adapter
    let adapter: TunnelAdapter;
    if (provider === 'ngrok') {
      adapter = new NgrokAdapter(options?.ngrokAuthToken);
    } else {
      adapter = new CloudflaredAdapter();
    }

    const info = await adapter.start(localPort);
    this.tunnels.set(tunnelId, adapter);
    return info;
  }

  async stop(tunnelId: string): Promise<boolean> {
    const adapter = this.tunnels.get(tunnelId);
    if (!adapter) {
      return false;
    }

    await adapter.stop();
    this.tunnels.delete(tunnelId);
    return true;
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.tunnels.values()).map((adapter) => adapter.stop());
    await Promise.all(stopPromises);
    this.tunnels.clear();
  }

  getStatus(tunnelId: string): TunnelInfo | null {
    const adapter = this.tunnels.get(tunnelId);
    return adapter?.getStatus() ?? null;
  }

  listTunnels(): TunnelInfo[] {
    const tunnels: TunnelInfo[] = [];
    for (const adapter of this.tunnels.values()) {
      const status = adapter.getStatus();
      if (status) {
        tunnels.push(status);
      }
    }
    return tunnels;
  }
}

// Export singleton instance
export const tunnelManager = new TunnelManager();

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'tunnel',
    displayName: 'Tunnel',
    category: 'tunnel',
    credentialsSchema: TunnelCredentialsSchema,
    setupHelpUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/',
  },
  factory: (credentials) => {
    // Tunnel doesn't create a traditional adapter - it just stores preferences
    // The tunnelManager handles actual tunnel creation
    return credentials;
  },
});
