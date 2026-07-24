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
  workspaceId?: string;
  teamId?: string;
}

export interface LocalCredentials {
  dockerSocket?: string;
}

export interface StripeCredentials {
  /** Preferred shape for a connection scoped to one named Stripe environment. */
  secretKey?: string;
  publishableKey?: string;
  /** Legacy global connection fields. */
  sandboxSecretKey?: string;
  sandboxPublishableKey?: string;
  liveSecretKey?: string;
  livePublishableKey?: string;
}

export interface CloudflareCredentials {
  apiToken: string;
  accountId?: string;
  registrarApiToken?: string;
  apiTokenKind?: 'user' | 'account' | 'unknown';
}

export interface SendGridCredentials {
  apiKey: string;
}

export interface TunnelCredentials {
  provider: 'cloudflared' | 'ngrok';
  ngrokAuthToken?: string;
}
