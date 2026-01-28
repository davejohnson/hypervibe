export type ConnectionStatus = 'pending' | 'verified' | 'failed';

export type ProviderType = 'railway' | 'local' | string;

export interface Connection {
  id: string;
  provider: ProviderType;
  scope: string | null;
  credentialsEncrypted: string;
  status: ConnectionStatus;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectionInput {
  provider: ProviderType;
  scope?: string | null;
  credentialsEncrypted: string;
}

export interface RailwayCredentials {
  apiToken: string;
  teamId?: string;
}

export interface LocalCredentials {
  dockerSocket?: string;
}

export interface StripeCredentials {
  sandboxSecretKey?: string;
  liveSecretKey?: string;
}

export interface CloudflareCredentials {
  apiToken: string;
}

export interface SendGridCredentials {
  apiKey: string;
}

export interface TunnelCredentials {
  provider: 'cloudflared' | 'ngrok';
  ngrokAuthToken?: string;
}
