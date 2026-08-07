import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const STRIPE_API_URL = 'https://api.stripe.com/v1';

export type StripeMode = 'sandbox' | 'live';

export interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
  default_price?: string | null;
  created: number;
  updated: number;
}

export interface StripePrice {
  id: string;
  product: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: {
    interval: 'day' | 'week' | 'month' | 'year';
    interval_count: number;
  } | null;
  type: 'one_time' | 'recurring';
  metadata: Record<string, string>;
  nickname: string | null;
  lookup_key?: string | null;
  created: number;
}

export interface StripeWebhookEndpoint {
  id: string;
  url: string;
  status: 'enabled' | 'disabled';
  enabled_events: string[];
  secret?: string; // Only returned on creation
  created: number;
  description?: string;
  metadata: Record<string, string>;
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

// Credentials schema for self-registration
export const StripeCredentialsSchema = z.object({
  /**
   * Preferred shape for an environment-scoped Stripe connection
   * (hv_connections provider="stripe" scope="staging" ...).
   */
  secretKey: z.string().optional().refine(
    (key) => !key || key.startsWith('sk_test_') || key.startsWith('sk_live_'),
    'Secret key must start with sk_test_ or sk_live_'
  ),
  publishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_test_') || key.startsWith('pk_live_'),
    'Publishable key must start with pk_test_ or pk_live_'
  ),
  /** Legacy global connection fields retained for compatibility. */
  sandboxSecretKey: z.string().optional().refine(
    (key) => !key || key.startsWith('sk_test_'),
    'Sandbox secret key must start with sk_test_'
  ),
  sandboxPublishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_test_'),
    'Sandbox publishable key must start with pk_test_'
  ),
  liveSecretKey: z.string().optional().refine(
    (key) => !key || key.startsWith('sk_live_'),
    'Live secret key must start with sk_live_'
  ),
  livePublishableKey: z.string().optional().refine(
    (key) => !key || key.startsWith('pk_live_'),
    'Live publishable key must start with pk_live_'
  ),
}).superRefine((data, ctx) => {
  if (!data.secretKey && !data.sandboxSecretKey && !data.liveSecretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'secretKey, sandboxSecretKey, or liveSecretKey is required',
    });
  }
  if (data.publishableKey && data.secretKey) {
    const secretIsLive = data.secretKey.startsWith('sk_live_');
    const publishableIsLive = data.publishableKey.startsWith('pk_live_');
    if (secretIsLive !== publishableIsLive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secretKey and publishableKey must belong to the same Stripe mode',
        path: ['publishableKey'],
      });
    }
  }
  const hasScopedShape = Boolean(data.secretKey || data.publishableKey);
  const hasLegacyShape = Boolean(
    data.sandboxSecretKey
    || data.sandboxPublishableKey
    || data.liveSecretKey
    || data.livePublishableKey
  );
  if (hasScopedShape && hasLegacyShape) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Do not mix environment-scoped secretKey/publishableKey with legacy global sandbox/live fields',
    });
  }
  if (data.publishableKey && !data.secretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'publishableKey requires the matching environment-scoped secretKey',
      path: ['publishableKey'],
    });
  }
});

export type StripeCredentials = z.infer<typeof StripeCredentialsSchema>;

export class StripeAdapter {
  readonly name = 'stripe';
  private credentials: StripeCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as StripeCredentials;
  }

  private getApiKey(mode: StripeMode): string {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const key = this.credentials.secretKey
      ?? (mode === 'sandbox' ? this.credentials.sandboxSecretKey : this.credentials.liveSecretKey);
    if (!key) {
      throw new Error(`No ${mode} Stripe secret key configured. Use an environment-scoped secretKey, or a legacy global sandboxSecretKey/liveSecretKey.`);
    }
    return key;
  }

  /**
   * Runtime key material for the selected Stripe mode. Callers must keep these
   * values inside provider mutation boundaries and never include them in
   * plans, logs, warnings, bindings, or receipts.
   */
  getRuntimeCredentials(mode: StripeMode): { secretKey: string; publishableKey?: string; mode: StripeMode } {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const secretKey = this.getApiKey(mode);
    const publishableKey = this.credentials.publishableKey
      ?? (mode === 'sandbox'
        ? this.credentials.sandboxPublishableKey
        : this.credentials.livePublishableKey);
    return {
      secretKey,
      ...(publishableKey ? { publishableKey } : {}),
      mode: secretKey.startsWith('sk_live_') ? 'live' : 'sandbox',
    };
  }

  private async request<T>(
    mode: StripeMode,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>,
    requestOptions: { idempotencyKey?: string } = {}
  ): Promise<T> {
    const apiKey = this.getApiKey(mode);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (requestOptions.idempotencyKey) {
      headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body && method === 'POST') {
      fetchOptions.body = this.encodeFormData(body);
    }

    const response = await fetch(`${STRIPE_API_URL}${endpoint}`, fetchOptions);
    const data = (await response.json()) as T & { error?: { message?: string } };

    if (!response.ok) {
      throw new StripeApiError(
        data.error?.message || `Stripe API error: ${response.status}`,
        response.status
      );
    }

    return data;
  }

  private encodeFormData(obj: Record<string, unknown>, prefix = ''): string {
    const pairs: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}[${key}]` : key;

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value)) {
        pairs.push(this.encodeFormData(value as Record<string, unknown>, fullKey));
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object') {
            pairs.push(this.encodeFormData(item as Record<string, unknown>, `${fullKey}[${index}]`));
          } else {
            pairs.push(`${encodeURIComponent(`${fullKey}[${index}]`)}=${encodeURIComponent(String(item))}`);
          }
        });
      } else {
        pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
      }
    }

    return pairs.filter(Boolean).join('&');
  }

  async verify(modeOrScope?: StripeMode | string): Promise<{ success: boolean; error?: string; accountId?: string }> {
    // The generic connection-verify path passes no mode; default to whichever
    // key is configured (live wins when both are) instead of failing a
    // sandbox-only connection by always reaching for the live key.
    const resolvedMode: StripeMode = modeOrScope === 'live' || modeOrScope === 'sandbox'
      ? modeOrScope
      : (this.credentials?.secretKey?.startsWith('sk_live_') || this.credentials?.liveSecretKey ? 'live' : 'sandbox');
    try {
      const result = await this.request<{ id: string }>(resolvedMode, 'GET', '/account');
      return { success: true, accountId: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listProducts(mode: StripeMode, limit = 100, includeInactive = false): Promise<StripeProduct[]> {
    const products: StripeProduct[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore && products.length < limit) {
      const active = includeInactive ? '' : '&active=true';
      const endpoint = startingAfter
        ? `/products?limit=100${active}&starting_after=${startingAfter}`
        : `/products?limit=100${active}`;

      const response = await this.request<{ data: StripeProduct[]; has_more: boolean }>(mode, 'GET', endpoint);
      products.push(...response.data);
      hasMore = response.has_more;

      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    return products;
  }

  async listPrices(mode: StripeMode, limit = 100, includeInactive = false): Promise<StripePrice[]> {
    const prices: StripePrice[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore && prices.length < limit) {
      const active = includeInactive ? '' : '&active=true';
      const endpoint = startingAfter
        ? `/prices?limit=100${active}&starting_after=${startingAfter}`
        : `/prices?limit=100${active}`;

      const response = await this.request<{ data: StripePrice[]; has_more: boolean }>(mode, 'GET', endpoint);
      prices.push(...response.data);
      hasMore = response.has_more;

      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    return prices;
  }

  async getProduct(mode: StripeMode, productId: string): Promise<StripeProduct | null> {
    try {
      return await this.request<StripeProduct>(mode, 'GET', `/products/${productId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getPrice(mode: StripeMode, priceId: string): Promise<StripePrice | null> {
    try {
      return await this.request<StripePrice>(mode, 'GET', `/prices/${priceId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createProduct(
    mode: StripeMode,
    product: Partial<StripeProduct> & { id?: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<StripeProduct> {
    const body: Record<string, unknown> = {
      name: product.name,
      active: product.active ?? true,
    };

    if (product.id) {
      body.id = product.id;
    }
    if (product.description) {
      body.description = product.description;
    }
    if (product.metadata && Object.keys(product.metadata).length > 0) {
      body.metadata = product.metadata;
    }

    return this.request<StripeProduct>(mode, 'POST', '/products', body, options);
  }

  async updateProduct(
    mode: StripeMode,
    productId: string,
    product: Pick<Partial<StripeProduct>, 'name' | 'description' | 'active' | 'metadata'>
  ): Promise<StripeProduct> {
    return this.request<StripeProduct>(mode, 'POST', `/products/${productId}`, {
      ...(product.name !== undefined ? { name: product.name } : {}),
      ...(product.description !== undefined ? { description: product.description ?? '' } : {}),
      ...(product.active !== undefined ? { active: product.active } : {}),
      ...(product.metadata !== undefined ? { metadata: product.metadata } : {}),
    });
  }

  async createPrice(
    mode: StripeMode,
    price: Partial<StripePrice> & { product: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<StripePrice> {
    const body: Record<string, unknown> = {
      product: price.product,
      currency: price.currency || 'usd',
      active: price.active ?? true,
    };

    if (price.unit_amount !== null && price.unit_amount !== undefined) {
      body.unit_amount = price.unit_amount;
    }

    if (price.recurring) {
      body.recurring = {
        interval: price.recurring.interval,
        interval_count: price.recurring.interval_count,
      };
    }

    if (price.nickname) {
      body.nickname = price.nickname;
    }
    if (price.lookup_key) {
      body.lookup_key = price.lookup_key;
    }

    if (price.metadata && Object.keys(price.metadata).length > 0) {
      body.metadata = price.metadata;
    }

    return this.request<StripePrice>(mode, 'POST', '/prices', body, options);
  }

  async updatePrice(
    mode: StripeMode,
    priceId: string,
    price: Pick<Partial<StripePrice>, 'active' | 'nickname' | 'metadata'>
  ): Promise<StripePrice> {
    return this.request<StripePrice>(mode, 'POST', `/prices/${priceId}`, {
      ...(price.active !== undefined ? { active: price.active } : {}),
      ...(price.nickname !== undefined ? { nickname: price.nickname ?? '' } : {}),
      ...(price.metadata !== undefined ? { metadata: price.metadata } : {}),
    });
  }

  // Webhook Management

  async listWebhookEndpoints(mode: StripeMode): Promise<StripeWebhookEndpoint[]> {
    const response = await this.request<{ data: StripeWebhookEndpoint[] }>(mode, 'GET', '/webhook_endpoints?limit=100');
    return response.data;
  }

  async getWebhookEndpoint(mode: StripeMode, endpointId: string): Promise<StripeWebhookEndpoint | null> {
    try {
      return await this.request<StripeWebhookEndpoint>(mode, 'GET', `/webhook_endpoints/${endpointId}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createWebhookEndpoint(
    mode: StripeMode,
    url: string,
    events: string[],
    options?: { description?: string; metadata?: Record<string, string> }
  ): Promise<StripeWebhookEndpoint> {
    const body: Record<string, unknown> = {
      url,
      enabled_events: events,
    };

    if (options?.description) {
      body.description = options.description;
    }
    if (options?.metadata) {
      body.metadata = options.metadata;
    }

    return this.request<StripeWebhookEndpoint>(mode, 'POST', '/webhook_endpoints', body);
  }

  async updateWebhookEndpoint(
    mode: StripeMode,
    endpointId: string,
    updates: { url?: string; enabled_events?: string[]; description?: string; disabled?: boolean }
  ): Promise<StripeWebhookEndpoint> {
    return this.request<StripeWebhookEndpoint>(mode, 'POST', `/webhook_endpoints/${endpointId}`, updates as Record<string, unknown>);
  }

  async deleteWebhookEndpoint(mode: StripeMode, endpointId: string): Promise<{ id: string; deleted: boolean }> {
    return this.request<{ id: string; deleted: boolean }>(mode, 'DELETE', `/webhook_endpoints/${endpointId}`);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'stripe',
    displayName: 'Stripe',
    category: 'payment',
    credentialsSchema: StripeCredentialsSchema,
    setupHelpUrl: 'https://dashboard.stripe.com/apikeys',
  },
  factory: (credentials) => {
    const adapter = new StripeAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
