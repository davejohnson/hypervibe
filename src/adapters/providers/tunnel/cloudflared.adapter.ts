import { spawn, type ChildProcess } from 'child_process';
import type { TunnelInfo, TunnelAdapter } from './tunnel.types.js';

export class CloudflaredAdapter implements TunnelAdapter {
  readonly provider = 'cloudflared' as const;
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private localPort: number | null = null;

  async start(localPort: number): Promise<TunnelInfo> {
    if (this.process) {
      throw new Error('Tunnel already running. Stop it first.');
    }

    this.localPort = localPort;

    return new Promise((resolve, reject) => {
      const process = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = process;

      let stdoutData = '';
      let stderrData = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timeout waiting for tunnel URL. Is cloudflared installed?'));
        }
      }, 30000);

      process.stdout?.on('data', (data: Buffer) => {
        stdoutData += data.toString();
      });

      process.stderr?.on('data', (data: Buffer) => {
        stderrData += data.toString();

        // cloudflared outputs the URL to stderr
        const urlMatch = stderrData.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.tunnelUrl = urlMatch[0];
          resolve({
            id: `cloudflared-${localPort}`,
            provider: 'cloudflared',
            localPort,
            publicUrl: this.tunnelUrl,
            status: 'running',
          });
        }
      });

      process.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start cloudflared: ${error.message}. Is cloudflared installed?`));
        }
      });

      process.on('exit', (code) => {
        this.process = null;
        this.tunnelUrl = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
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
      id: `cloudflared-${this.localPort}`,
      provider: 'cloudflared',
      localPort: this.localPort,
      publicUrl: this.tunnelUrl,
      status: 'running',
    };
  }

  isRunning(): boolean {
    return this.process !== null && this.tunnelUrl !== null;
  }
}
