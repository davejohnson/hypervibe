import { z } from 'zod';
import { spawn } from 'child_process';
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

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { shell: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function brewInstall(pkg: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('brew', ['install', pkg], { shell: true });
    let stderr = '';
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      resolve(code === 0
        ? { success: true }
        : { success: false, error: stderr || `brew install exited with code ${code}` });
    });
    child.on('error', (err) => resolve({ success: false, error: err.message }));
  });
}

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
  ensureDependencies: async () => {
    const installed: string[] = [];
    const errors: string[] = [];
    const hasBrew = await commandExists('brew');

    if (!await commandExists('cloudflared')) {
      if (hasBrew) {
        const result = await brewInstall('cloudflared');
        if (result.success) {
          installed.push('cloudflared (via Homebrew)');
        } else {
          errors.push(`Failed to install cloudflared: ${result.error}`);
        }
      } else {
        errors.push('cloudflared is not installed and Homebrew is not available. Install manually: brew install cloudflared');
      }
    }

    return { installed, errors };
  },
});
