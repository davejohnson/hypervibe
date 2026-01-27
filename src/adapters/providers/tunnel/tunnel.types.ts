export interface TunnelInfo {
  id: string;
  provider: 'cloudflared' | 'ngrok';
  localPort: number;
  publicUrl: string;
  status: 'running' | 'stopped' | 'error';
}

export interface TunnelAdapter {
  readonly provider: 'cloudflared' | 'ngrok';
  start(localPort: number): Promise<TunnelInfo>;
  stop(): Promise<void>;
  getStatus(): TunnelInfo | null;
  isRunning(): boolean;
}
