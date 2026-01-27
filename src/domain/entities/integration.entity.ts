export type IntegrationProvider = 'stripe';

export type IntegrationKeyMode = 'sandbox' | 'live';

export interface IntegrationKey {
  id: string;
  provider: IntegrationProvider;
  mode: IntegrationKeyMode;
  keysEncrypted: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntegrationKeyInput {
  provider: IntegrationProvider;
  mode: IntegrationKeyMode;
  keysEncrypted: string;
}

export interface StoredKeys {
  [key: string]: string;
}
