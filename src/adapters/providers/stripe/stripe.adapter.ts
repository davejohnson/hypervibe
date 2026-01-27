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
  created: number;
}

export interface SyncResult {
  products: {
    created: string[];
    skipped: string[];
    errors: Array<{ id: string; error: string }>;
  };
  prices: {
    created: string[];
    skipped: string[];
    errors: Array<{ id: string; error: string }>;
  };
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

// Common webhook events for typical SaaS apps
export const STRIPE_COMMON_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.created',
  'customer.updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
];

// Credentials schema for self-registration
export const StripeCredentialsSchema = z.object({
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
}).refine(
  (data) => data.sandboxSecretKey || data.liveSecretKey,
  'At least one of sandboxSecretKey or liveSecretKey is required'
);

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

    const key = mode === 'sandbox' ? this.credentials.sandboxSecretKey : this.credentials.liveSecretKey;
    if (!key) {
      throw new Error(`No ${mode} API key configured`);
    }
    return key;
  }

  private async request<T>(
    mode: StripeMode,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const apiKey = this.getApiKey(mode);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method === 'POST') {
      options.body = this.encodeFormData(body);
    }

    const response = await fetch(`${STRIPE_API_URL}${endpoint}`, options);
    const data = (await response.json()) as T & { error?: { message?: string } };

    if (!response.ok) {
      throw new Error(data.error?.message || `Stripe API error: ${response.status}`);
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

  async verify(mode: StripeMode): Promise<{ success: boolean; error?: string; accountId?: string }> {
    try {
      const result = await this.request<{ id: string }>(mode, 'GET', '/account');
      return { success: true, accountId: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listProducts(mode: StripeMode, limit = 100): Promise<StripeProduct[]> {
    const products: StripeProduct[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore && products.length < limit) {
      const endpoint = startingAfter
        ? `/products?limit=100&active=true&starting_after=${startingAfter}`
        : '/products?limit=100&active=true';

      const response = await this.request<{ data: StripeProduct[]; has_more: boolean }>(mode, 'GET', endpoint);
      products.push(...response.data);
      hasMore = response.has_more;

      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    return products;
  }

  async listPrices(mode: StripeMode, limit = 100): Promise<StripePrice[]> {
    const prices: StripePrice[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore && prices.length < limit) {
      const endpoint = startingAfter
        ? `/prices?limit=100&active=true&starting_after=${startingAfter}`
        : '/prices?limit=100&active=true';

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
    } catch {
      return null;
    }
  }

  async getPrice(mode: StripeMode, priceId: string): Promise<StripePrice | null> {
    try {
      return await this.request<StripePrice>(mode, 'GET', `/prices/${priceId}`);
    } catch {
      return null;
    }
  }

  async createProduct(mode: StripeMode, product: Partial<StripeProduct> & { id?: string }): Promise<StripeProduct> {
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

    return this.request<StripeProduct>(mode, 'POST', '/products', body);
  }

  async createPrice(mode: StripeMode, price: Partial<StripePrice> & { product: string }): Promise<StripePrice> {
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

    if (price.metadata && Object.keys(price.metadata).length > 0) {
      body.metadata = price.metadata;
    }

    return this.request<StripePrice>(mode, 'POST', '/prices', body);
  }

  async syncData(
    sourceMode: StripeMode,
    targetMode: StripeMode,
    options: { preserveIds?: boolean; includeInactive?: boolean } = {}
  ): Promise<SyncResult> {
    const { preserveIds = true } = options;

    const result: SyncResult = {
      products: { created: [], skipped: [], errors: [] },
      prices: { created: [], skipped: [], errors: [] },
    };

    // Fetch source data
    const sourceProducts = await this.listProducts(sourceMode);
    const sourcePrices = await this.listPrices(sourceMode);

    // Fetch existing target products for comparison
    const targetProducts = await this.listProducts(targetMode);
    const targetProductIds = new Set(targetProducts.map((p) => p.id));

    // Map source product IDs to target product IDs (for price linking)
    const productIdMap = new Map<string, string>();

    // Sync products
    for (const product of sourceProducts) {
      // Check if product already exists in target
      if (preserveIds && targetProductIds.has(product.id)) {
        result.products.skipped.push(product.id);
        productIdMap.set(product.id, product.id);
        continue;
      }

      try {
        const newProduct = await this.createProduct(targetMode, {
          id: preserveIds ? product.id : undefined,
          name: product.name,
          description: product.description,
          active: product.active,
          metadata: {
            ...product.metadata,
            _synced_from: sourceMode,
            _source_id: product.id,
          },
        });
        result.products.created.push(newProduct.id);
        productIdMap.set(product.id, newProduct.id);
      } catch (error) {
        result.products.errors.push({
          id: product.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fetch existing target prices for comparison
    const targetPrices = await this.listPrices(targetMode);
    const targetPricesBySourceId = new Map<string, StripePrice>();
    for (const price of targetPrices) {
      if (price.metadata?._source_id) {
        targetPricesBySourceId.set(price.metadata._source_id, price);
      }
    }

    // Sync prices
    for (const price of sourcePrices) {
      const targetProductId = productIdMap.get(price.product);
      if (!targetProductId) {
        result.prices.errors.push({
          id: price.id,
          error: `Product ${price.product} not found in target`,
        });
        continue;
      }

      // Check if price already exists (by source ID metadata)
      if (targetPricesBySourceId.has(price.id)) {
        result.prices.skipped.push(price.id);
        continue;
      }

      try {
        const newPrice = await this.createPrice(targetMode, {
          product: targetProductId,
          currency: price.currency,
          unit_amount: price.unit_amount,
          recurring: price.recurring,
          nickname: price.nickname,
          active: price.active,
          metadata: {
            ...price.metadata,
            _synced_from: sourceMode,
            _source_id: price.id,
          },
        });
        result.prices.created.push(newPrice.id);
      } catch (error) {
        result.prices.errors.push({
          id: price.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  // Webhook Management

  async listWebhookEndpoints(mode: StripeMode): Promise<StripeWebhookEndpoint[]> {
    const response = await this.request<{ data: StripeWebhookEndpoint[] }>(mode, 'GET', '/webhook_endpoints?limit=100');
    return response.data;
  }

  async getWebhookEndpoint(mode: StripeMode, endpointId: string): Promise<StripeWebhookEndpoint | null> {
    try {
      return await this.request<StripeWebhookEndpoint>(mode, 'GET', `/webhook_endpoints/${endpointId}`);
    } catch {
      return null;
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

  async findWebhookByUrl(mode: StripeMode, url: string): Promise<StripeWebhookEndpoint | null> {
    const endpoints = await this.listWebhookEndpoints(mode);
    return endpoints.find((e) => e.url === url) ?? null;
  }

  async upsertWebhookEndpoint(
    mode: StripeMode,
    url: string,
    events: string[],
    options?: { description?: string; metadata?: Record<string, string> }
  ): Promise<{ endpoint: StripeWebhookEndpoint; action: 'created' | 'updated'; secret?: string }> {
    const existing = await this.findWebhookByUrl(mode, url);

    if (existing) {
      const updated = await this.updateWebhookEndpoint(mode, existing.id, {
        enabled_events: events,
        description: options?.description,
      });
      return { endpoint: updated, action: 'updated' };
    } else {
      const created = await this.createWebhookEndpoint(mode, url, events, options);
      return { endpoint: created, action: 'created', secret: created.secret };
    }
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
