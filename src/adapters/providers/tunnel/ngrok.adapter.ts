import { spawn, type ChildProcess } from 'child_process';
import type { TunnelInfo, TunnelAdapter } from './tunnel.types.js';

interface NgrokTunnelResponse {
  tunnels: Array<{
    name: string;
    public_url: string;
    proto: string;
    config: {
      addr: string;
    };
  }>;
}

export class NgrokAdapter implements TunnelAdapter {
  readonly provider = 'ngrok' as const;
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private localPort: number | null = null;
  private authToken?: string;

  constructor(authToken?: string) {
    this.authToken = authToken;
  }

  async start(localPort: number): Promise<TunnelInfo> {
    if (this.process) {
      throw new Error('Tunnel already running. Stop it first.');
    }

    this.localPort = localPort;

    return new Promise((resolve, reject) => {
      const args = ['http', String(localPort)];

      if (this.authToken) {
        args.unshift('--authtoken', this.authToken);
      }

      const process = spawn('ngrok', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = process;

      const timeout = setTimeout(async () => {
        // Try to get URL from ngrok API
        try {
          const url = await this.fetchTunnelUrl();
          if (url) {
            this.tunnelUrl = url;
            resolve({
              id: `ngrok-${localPort}`,
              provider: 'ngrok',
              localPort,
              publicUrl: url,
              status: 'running',
            });
            return;
          }
        } catch {
          // Ignore
        }
        reject(new Error('Timeout waiting for ngrok tunnel URL'));
      }, 10000);

      process.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start ngrok: ${error.message}. Is ngrok installed?`));
      });

      process.on('exit', (code) => {
        this.process = null;
        this.tunnelUrl = null;
        clearTimeout(timeout);
        if (!this.tunnelUrl) {
          reject(new Error(`ngrok exited with code ${code}`));
        }
      });

      // Poll for the tunnel URL from ngrok's local API
      const pollForUrl = async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const url = await this.fetchTunnelUrl();
            if (url) {
              clearTimeout(timeout);
              this.tunnelUrl = url;
              resolve({
                id: `ngrok-${localPort}`,
                provider: 'ngrok',
                localPort,
                publicUrl: url,
                status: 'running',
              });
              return;
            }
          } catch {
            // Keep polling
          }
        }
      };

      pollForUrl();
    });
  }

  private async fetchTunnelUrl(): Promise<string | null> {
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      const data = (await response.json()) as NgrokTunnelResponse;

      // Prefer HTTPS tunnel
      const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
      return httpsTunnel?.public_url ?? data.tunnels[0]?.public_url ?? null;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.tunnelUrl = null;
      this.localPort = null;
    }
  }

  getStatus(): TunnelInfo | null {
    if (!this.process || !this.tunnelUrl || !this.localPort) {
      return null;
    }

    return {
      id: `ngrok-${this.localPort}`,
      provider: 'ngrok',
      localPort: this.localPort,
      publicUrl: this.tunnelUrl,
      status: 'running',
    };
  }

  isRunning(): boolean {
    return this.process !== null && this.tunnelUrl !== null;
  }
}
