import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// Credentials schema for self-registration
export const RecaptchaCredentialsSchema = z.object({
  siteKey: z.string().min(1, 'Site key is required'),
  secretKey: z.string().min(1, 'Secret key is required'),
  version: z.enum(['v2', 'v3']).optional().default('v2'),
});

export type RecaptchaCredentials = z.infer<typeof RecaptchaCredentialsSchema>;

export interface RecaptchaVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  score?: number; // v3 only
  action?: string; // v3 only
  'error-codes'?: string[];
}

export class RecaptchaAdapter {
  readonly name = 'recaptcha';
  private credentials: RecaptchaCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as RecaptchaCredentials;
  }

  async verify(): Promise<{ success: boolean; error?: string }> {
    if (!this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }

    try {
      // Test the secret key by making a verify request with a dummy token
      // Google will return specific error codes that tell us if the key is valid
      const params = new URLSearchParams({
        secret: this.credentials.secretKey,
        response: 'test-token-for-validation',
      });

      const response = await fetch(RECAPTCHA_VERIFY_URL, {
        method: 'POST',
        body: params,
      });

      const data = (await response.json()) as RecaptchaVerifyResponse;

      // Expected error codes for a test token with valid secret key:
      // - "invalid-input-response" means the token is invalid (expected, we sent a fake one)
      // If we get "invalid-input-secret", the secret key itself is invalid
      if (data['error-codes']?.includes('invalid-input-secret')) {
        return { success: false, error: 'Invalid secret key' };
      }

      // If we get "invalid-input-response" (or success=false without invalid-input-secret),
      // the secret key is valid - we just sent an invalid token which is expected
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Verify a reCAPTCHA token from the frontend
   */
  async verifyToken(
    token: string,
    remoteIp?: string
  ): Promise<{ success: boolean; score?: number; action?: string; errors?: string[] }> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const params = new URLSearchParams({
      secret: this.credentials.secretKey,
      response: token,
    });

    if (remoteIp) {
      params.append('remoteip', remoteIp);
    }

    const response = await fetch(RECAPTCHA_VERIFY_URL, {
      method: 'POST',
      body: params,
    });

    const data = (await response.json()) as RecaptchaVerifyResponse;

    return {
      success: data.success,
      score: data.score,
      action: data.action,
      errors: data['error-codes'],
    };
  }

  /**
   * Get environment variables for deployment
   */
  getEnvVars(): Record<string, string> {
    if (!this.credentials) {
      return {};
    }

    return {
      RECAPTCHA_SITE_KEY: this.credentials.siteKey,
      RECAPTCHA_SECRET_KEY: this.credentials.secretKey,
      // Common alternative names
      NEXT_PUBLIC_RECAPTCHA_SITE_KEY: this.credentials.siteKey,
    };
  }

  getSiteKey(): string | null {
    return this.credentials?.siteKey ?? null;
  }

  getVersion(): string {
    return this.credentials?.version ?? 'v2';
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'recaptcha',
    displayName: 'Google reCAPTCHA',
    category: 'security',
    credentialsSchema: RecaptchaCredentialsSchema,
    setupHelpUrl: 'https://www.google.com/recaptcha/admin',
  },
  factory: (credentials) => {
    const adapter = new RecaptchaAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
