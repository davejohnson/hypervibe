import { z } from 'zod';

/**
 * Integration complexity levels:
 * 1 - API Key only: Just set env vars
 * 2 - Webhooks: Need to register webhook URLs with the service
 * 3 - OAuth: Need OAuth flow, store tokens
 * 4 - Full: OAuth + Webhooks + more
 */
export type IntegrationLevel = 1 | 2 | 3 | 4;

export interface IntegrationVariable {
  name: string;
  envVar: string;
  description: string;
  required: boolean;
  secret: boolean; // Should be masked in output
  defaultValue?: string;
  validation?: z.ZodString;
  // For variables that have a public/frontend version
  publicEnvVar?: string; // e.g., NEXT_PUBLIC_* version
  // For environment-specific values (sandbox vs live)
  perEnvironment?: boolean;
}

export interface IntegrationScope {
  name: string;
  description: string;
  // Which env vars this scope requires (beyond base vars)
  additionalVars?: string[];
}

export interface WebhookConfig {
  // Default path in the app where webhooks should be sent
  defaultPath: string;
  // Events that can be subscribed to
  events?: string[];
  // Does this service provide a signing secret?
  hasSigningSecret: boolean;
  signingSecretEnvVar?: string;
}

export interface OAuthConfig {
  // OAuth authorization URL
  authorizationUrl: string;
  // Token URL
  tokenUrl: string;
  // Default scopes
  defaultScopes: string[];
  // Does the token need periodic refresh?
  requiresRefresh: boolean;
}

export interface IntegrationPlugin {
  name: string;
  displayName: string;
  category: 'ai' | 'commerce' | 'communication' | 'analytics' | 'auth' | 'storage' | 'payment' | 'email' | 'other';
  description: string;
  setupUrl?: string;
  documentationUrl?: string;

  // Complexity level (1-4)
  level: IntegrationLevel;

  // Variables this integration needs
  variables: IntegrationVariable[];

  // Optional: scopes/features that affect what's needed
  scopes?: IntegrationScope[];

  // Level 2+: Webhook configuration
  webhooks?: WebhookConfig;

  // Level 3+: OAuth configuration
  oauth?: OAuthConfig;

  // For services with sandbox/live modes
  hasModes?: boolean;
  modes?: {
    sandbox: { name: string; description: string };
    live: { name: string; description: string };
  };

  // Guided setup prompts - returned to Claude for conversation
  guidedSetup?: {
    intro: string;
    scopeQuestion?: string; // "What features do you want to use?"
  };

  // Optional: Zod schema for API credentials (for managed features)
  // If provided, infraprint can make API calls to this service
  apiCredentialsSchema?: z.ZodTypeAny;

  // Factory to create an adapter (for managed integrations)
  factory?: (credentials: unknown) => unknown;
}

/**
 * Registry for integration plugins
 */
class IntegrationRegistry {
  private plugins = new Map<string, IntegrationPlugin>();

  register(plugin: IntegrationPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): IntegrationPlugin | undefined {
    return this.plugins.get(name);
  }

  all(): IntegrationPlugin[] {
    return [...this.plugins.values()];
  }

  names(): string[] {
    return [...this.plugins.keys()];
  }

  getByCategory(category: IntegrationPlugin['category']): IntegrationPlugin[] {
    return [...this.plugins.values()].filter((p) => p.category === category);
  }

  getByLevel(level: IntegrationLevel): IntegrationPlugin[] {
    return [...this.plugins.values()].filter((p) => p.level === level);
  }

  /**
   * Get integrations that require webhooks (level 2+)
   */
  getWithWebhooks(): IntegrationPlugin[] {
    return [...this.plugins.values()].filter((p) => p.webhooks !== undefined);
  }

  /**
   * Get integrations that require OAuth (level 3+)
   */
  getWithOAuth(): IntegrationPlugin[] {
    return [...this.plugins.values()].filter((p) => p.oauth !== undefined);
  }

  /**
   * Get integrations that have managed features (API adapter available)
   */
  getManaged(): IntegrationPlugin[] {
    return [...this.plugins.values()].filter((p) => p.factory !== undefined);
  }

  /**
   * Get the env vars needed for an integration, optionally filtered by scopes
   */
  getRequiredVars(name: string, selectedScopes?: string[]): IntegrationVariable[] {
    const plugin = this.plugins.get(name);
    if (!plugin) return [];

    let vars = plugin.variables.filter((v) => v.required);

    // Add scope-specific vars if scopes are selected
    if (selectedScopes && plugin.scopes) {
      for (const scopeName of selectedScopes) {
        const scope = plugin.scopes.find((s) => s.name === scopeName);
        if (scope?.additionalVars) {
          const additionalVars = plugin.variables.filter(
            (v) => scope.additionalVars!.includes(v.name)
          );
          vars = [...vars, ...additionalVars];
        }
      }
    }

    return vars;
  }

  /**
   * Check if an integration has managed features
   */
  isManaged(name: string): boolean {
    const plugin = this.plugins.get(name);
    return plugin?.factory !== undefined;
  }

  /**
   * Create an adapter for managed integrations
   */
  createAdapter<T = unknown>(name: string, credentials: unknown): T {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Unknown integration: ${name}`);
    }
    if (!plugin.factory) {
      throw new Error(`Integration ${name} does not have managed features`);
    }
    return plugin.factory(credentials) as T;
  }
}

export const integrationRegistry = new IntegrationRegistry();

// ============================================
// Built-in Integration Plugins
// ============================================

// Anthropic / Claude (Level 1 - API key only)
integrationRegistry.register({
  name: 'anthropic',
  displayName: 'Anthropic (Claude)',
  category: 'ai',
  level: 1,
  description: 'Add Claude AI to your application',
  setupUrl: 'https://console.anthropic.com/settings/keys',
  documentationUrl: 'https://docs.anthropic.com',
  variables: [
    {
      name: 'apiKey',
      envVar: 'ANTHROPIC_API_KEY',
      description: 'Your Anthropic API key',
      required: true,
      secret: true,
      validation: z.string().startsWith('sk-ant-'),
    },
  ],
  guidedSetup: {
    intro: 'To add Claude to your app, you\'ll need an API key from the Anthropic Console.',
  },
});

// OpenAI (Level 1 - API key only)
integrationRegistry.register({
  name: 'openai',
  displayName: 'OpenAI',
  category: 'ai',
  level: 1,
  description: 'Add GPT and other OpenAI models to your application',
  setupUrl: 'https://platform.openai.com/api-keys',
  documentationUrl: 'https://platform.openai.com/docs',
  variables: [
    {
      name: 'apiKey',
      envVar: 'OPENAI_API_KEY',
      description: 'Your OpenAI API key',
      required: true,
      secret: true,
      validation: z.string().startsWith('sk-'),
    },
    {
      name: 'orgId',
      envVar: 'OPENAI_ORG_ID',
      description: 'Organization ID (optional, for team accounts)',
      required: false,
      secret: false,
    },
  ],
  guidedSetup: {
    intro: 'To add OpenAI to your app, you\'ll need an API key from the OpenAI Platform.',
  },
});

// Shopify (Level 2 - API key + webhooks, can be Level 3 with OAuth apps)
integrationRegistry.register({
  name: 'shopify',
  displayName: 'Shopify',
  category: 'commerce',
  level: 2,
  description: 'Connect to Shopify for e-commerce functionality',
  setupUrl: 'https://partners.shopify.com',
  documentationUrl: 'https://shopify.dev/docs/api',
  variables: [
    {
      name: 'apiKey',
      envVar: 'SHOPIFY_API_KEY',
      publicEnvVar: 'NEXT_PUBLIC_SHOPIFY_API_KEY',
      description: 'Shopify API key (also called Client ID)',
      required: true,
      secret: false,
    },
    {
      name: 'apiSecret',
      envVar: 'SHOPIFY_API_SECRET',
      description: 'Shopify API secret key',
      required: true,
      secret: true,
    },
    {
      name: 'shopDomain',
      envVar: 'SHOPIFY_SHOP_DOMAIN',
      publicEnvVar: 'NEXT_PUBLIC_SHOPIFY_SHOP_DOMAIN',
      description: 'Your Shopify store domain (e.g., mystore.myshopify.com)',
      required: true,
      secret: false,
    },
    {
      name: 'storefrontAccessToken',
      envVar: 'SHOPIFY_STOREFRONT_ACCESS_TOKEN',
      publicEnvVar: 'NEXT_PUBLIC_SHOPIFY_STOREFRONT_ACCESS_TOKEN',
      description: 'Storefront API access token (for public/client-side access)',
      required: false,
      secret: false,
    },
    {
      name: 'adminAccessToken',
      envVar: 'SHOPIFY_ADMIN_ACCESS_TOKEN',
      description: 'Admin API access token (for server-side operations)',
      required: false,
      secret: true,
    },
    {
      name: 'webhookSecret',
      envVar: 'SHOPIFY_WEBHOOK_SECRET',
      description: 'Webhook signing secret for verifying webhook requests',
      required: false,
      secret: true,
    },
    {
      name: 'scopes',
      envVar: 'SHOPIFY_SCOPES',
      description: 'API scopes (comma-separated)',
      required: false,
      secret: false,
      defaultValue: 'read_products,read_orders',
    },
  ],
  scopes: [
    {
      name: 'storefront',
      description: 'Read product catalog, collections, and checkout (public/headless)',
      additionalVars: ['storefrontAccessToken'],
    },
    {
      name: 'orders',
      description: 'Manage orders and fulfillment',
      additionalVars: ['adminAccessToken'],
    },
    {
      name: 'customers',
      description: 'Access customer data and accounts',
      additionalVars: ['adminAccessToken'],
    },
    {
      name: 'inventory',
      description: 'Manage product inventory levels',
      additionalVars: ['adminAccessToken'],
    },
    {
      name: 'webhooks',
      description: 'Receive real-time updates via webhooks',
      additionalVars: ['webhookSecret'],
    },
  ],
  webhooks: {
    defaultPath: '/api/webhooks/shopify',
    events: ['orders/create', 'orders/updated', 'products/create', 'products/update', 'customers/create', 'app/uninstalled'],
    hasSigningSecret: true,
    signingSecretEnvVar: 'SHOPIFY_WEBHOOK_SECRET',
  },
  guidedSetup: {
    intro: 'To connect Shopify, you\'ll need to create a Shopify app in the Partners dashboard or your store\'s admin.',
    scopeQuestion: 'What Shopify features do you want to use? (e.g., storefront browsing, order management, inventory)',
  },
});

// Lightspeed (Level 3 - OAuth)
integrationRegistry.register({
  name: 'lightspeed',
  displayName: 'Lightspeed',
  category: 'commerce',
  level: 3,
  description: 'Connect to Lightspeed POS/Retail',
  setupUrl: 'https://cloud.lightspeedapp.com',
  documentationUrl: 'https://developers.lightspeedhq.com',
  variables: [
    {
      name: 'accountId',
      envVar: 'LIGHTSPEED_ACCOUNT_ID',
      description: 'Lightspeed account ID',
      required: true,
      secret: false,
    },
    {
      name: 'clientId',
      envVar: 'LIGHTSPEED_CLIENT_ID',
      description: 'OAuth client ID',
      required: true,
      secret: false,
    },
    {
      name: 'clientSecret',
      envVar: 'LIGHTSPEED_CLIENT_SECRET',
      description: 'OAuth client secret',
      required: true,
      secret: true,
    },
    {
      name: 'refreshToken',
      envVar: 'LIGHTSPEED_REFRESH_TOKEN',
      description: 'OAuth refresh token',
      required: true,
      secret: true,
    },
  ],
  oauth: {
    authorizationUrl: 'https://cloud.lightspeedapp.com/oauth/authorize.php',
    tokenUrl: 'https://cloud.lightspeedapp.com/oauth/access_token.php',
    defaultScopes: ['employee:all'],
    requiresRefresh: true,
  },
  guidedSetup: {
    intro: 'To connect Lightspeed, you\'ll need to create an app in the Lightspeed developer portal and complete the OAuth flow.',
  },
});

// Twilio (Level 2 - API key + webhooks for incoming messages/calls)
integrationRegistry.register({
  name: 'twilio',
  displayName: 'Twilio',
  category: 'communication',
  level: 2,
  description: 'Add SMS, voice, and communication features',
  setupUrl: 'https://console.twilio.com',
  documentationUrl: 'https://www.twilio.com/docs',
  variables: [
    {
      name: 'accountSid',
      envVar: 'TWILIO_ACCOUNT_SID',
      description: 'Twilio Account SID',
      required: true,
      secret: false,
    },
    {
      name: 'authToken',
      envVar: 'TWILIO_AUTH_TOKEN',
      description: 'Twilio Auth Token',
      required: true,
      secret: true,
    },
    {
      name: 'phoneNumber',
      envVar: 'TWILIO_PHONE_NUMBER',
      description: 'Your Twilio phone number',
      required: false,
      secret: false,
    },
  ],
  scopes: [
    {
      name: 'sms',
      description: 'Send and receive SMS messages',
      additionalVars: ['phoneNumber'],
    },
    {
      name: 'voice',
      description: 'Make and receive phone calls',
      additionalVars: ['phoneNumber'],
    },
    {
      name: 'verify',
      description: 'Phone number verification (2FA)',
    },
  ],
  webhooks: {
    defaultPath: '/api/webhooks/twilio',
    events: ['incoming-sms', 'incoming-call', 'message-status', 'call-status'],
    hasSigningSecret: false, // Twilio uses request validation via auth token
  },
  guidedSetup: {
    intro: 'To add Twilio, you\'ll need your Account SID and Auth Token from the Twilio Console.',
    scopeQuestion: 'What Twilio features do you want to use? (SMS, voice calls, verification)',
  },
});

// AWS (Level 1 - API keys)
integrationRegistry.register({
  name: 'aws',
  displayName: 'Amazon Web Services',
  category: 'storage',
  level: 1,
  description: 'Connect to AWS services (S3, SES, etc.)',
  setupUrl: 'https://console.aws.amazon.com/iam',
  documentationUrl: 'https://docs.aws.amazon.com',
  variables: [
    {
      name: 'accessKeyId',
      envVar: 'AWS_ACCESS_KEY_ID',
      description: 'AWS Access Key ID',
      required: true,
      secret: false,
    },
    {
      name: 'secretAccessKey',
      envVar: 'AWS_SECRET_ACCESS_KEY',
      description: 'AWS Secret Access Key',
      required: true,
      secret: true,
    },
    {
      name: 'region',
      envVar: 'AWS_REGION',
      description: 'AWS Region (e.g., us-east-1)',
      required: true,
      secret: false,
      defaultValue: 'us-east-1',
    },
    {
      name: 's3Bucket',
      envVar: 'AWS_S3_BUCKET',
      description: 'S3 bucket name',
      required: false,
      secret: false,
    },
  ],
  scopes: [
    {
      name: 's3',
      description: 'File storage with S3',
      additionalVars: ['s3Bucket'],
    },
    {
      name: 'ses',
      description: 'Email sending with SES',
    },
    {
      name: 'dynamodb',
      description: 'NoSQL database with DynamoDB',
    },
  ],
  guidedSetup: {
    intro: 'To connect AWS, create an IAM user with programmatic access and the appropriate permissions.',
    scopeQuestion: 'What AWS services do you want to use? (S3, SES, DynamoDB, etc.)',
  },
});

// Google Analytics (Level 1 - just measurement ID)
integrationRegistry.register({
  name: 'google-analytics',
  displayName: 'Google Analytics',
  category: 'analytics',
  level: 1,
  description: 'Add Google Analytics tracking',
  setupUrl: 'https://analytics.google.com',
  documentationUrl: 'https://developers.google.com/analytics',
  variables: [
    {
      name: 'measurementId',
      envVar: 'GA_MEASUREMENT_ID',
      publicEnvVar: 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
      description: 'GA4 Measurement ID (starts with G-)',
      required: true,
      secret: false,
      validation: z.string().startsWith('G-'),
    },
  ],
  guidedSetup: {
    intro: 'To add Google Analytics, you\'ll need your GA4 Measurement ID from the Analytics dashboard.',
  },
});

// Supabase (Level 1 - API keys)
integrationRegistry.register({
  name: 'supabase',
  displayName: 'Supabase',
  category: 'storage',
  level: 1,
  description: 'Add Supabase for auth, database, and storage',
  setupUrl: 'https://supabase.com/dashboard',
  documentationUrl: 'https://supabase.com/docs',
  variables: [
    {
      name: 'url',
      envVar: 'SUPABASE_URL',
      publicEnvVar: 'NEXT_PUBLIC_SUPABASE_URL',
      description: 'Supabase project URL',
      required: true,
      secret: false,
    },
    {
      name: 'anonKey',
      envVar: 'SUPABASE_ANON_KEY',
      publicEnvVar: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      description: 'Supabase anonymous/public key',
      required: true,
      secret: false,
    },
    {
      name: 'serviceRoleKey',
      envVar: 'SUPABASE_SERVICE_ROLE_KEY',
      description: 'Supabase service role key (server-side only)',
      required: false,
      secret: true,
    },
  ],
  guidedSetup: {
    intro: 'To add Supabase, you\'ll need your project URL and API keys from the Supabase dashboard.',
  },
});

// PostHog (Level 1 - API key)
integrationRegistry.register({
  name: 'posthog',
  displayName: 'PostHog',
  category: 'analytics',
  level: 1,
  description: 'Add PostHog for product analytics and feature flags',
  setupUrl: 'https://app.posthog.com/project/settings',
  documentationUrl: 'https://posthog.com/docs',
  variables: [
    {
      name: 'apiKey',
      envVar: 'POSTHOG_API_KEY',
      publicEnvVar: 'NEXT_PUBLIC_POSTHOG_KEY',
      description: 'PostHog project API key',
      required: true,
      secret: false,
    },
    {
      name: 'host',
      envVar: 'POSTHOG_HOST',
      publicEnvVar: 'NEXT_PUBLIC_POSTHOG_HOST',
      description: 'PostHog host (default: https://app.posthog.com)',
      required: false,
      secret: false,
      defaultValue: 'https://app.posthog.com',
    },
  ],
  guidedSetup: {
    intro: 'To add PostHog, you\'ll need your project API key from the PostHog settings.',
  },
});

// Sentry (Level 1 - DSN, optional auth token for releases)
integrationRegistry.register({
  name: 'sentry',
  displayName: 'Sentry',
  category: 'analytics',
  level: 1,
  description: 'Add Sentry for error tracking and performance monitoring',
  setupUrl: 'https://sentry.io/settings/projects/',
  documentationUrl: 'https://docs.sentry.io',
  variables: [
    {
      name: 'dsn',
      envVar: 'SENTRY_DSN',
      publicEnvVar: 'NEXT_PUBLIC_SENTRY_DSN',
      description: 'Sentry DSN (Data Source Name)',
      required: true,
      secret: false,
    },
    {
      name: 'authToken',
      envVar: 'SENTRY_AUTH_TOKEN',
      description: 'Sentry auth token (for source maps, releases)',
      required: false,
      secret: true,
    },
    {
      name: 'org',
      envVar: 'SENTRY_ORG',
      description: 'Sentry organization slug',
      required: false,
      secret: false,
    },
    {
      name: 'project',
      envVar: 'SENTRY_PROJECT',
      description: 'Sentry project slug',
      required: false,
      secret: false,
    },
  ],
  guidedSetup: {
    intro: 'To add Sentry, you\'ll need your DSN from your Sentry project settings.',
  },
});

// Stripe (Level 2 - API keys + webhooks)
integrationRegistry.register({
  name: 'stripe',
  displayName: 'Stripe',
  category: 'payment',
  level: 2,
  description: 'Add Stripe for payment processing',
  setupUrl: 'https://dashboard.stripe.com/apikeys',
  documentationUrl: 'https://stripe.com/docs',
  hasModes: true,
  modes: {
    sandbox: { name: 'Test Mode', description: 'Use test API keys for development' },
    live: { name: 'Live Mode', description: 'Use live API keys for production' },
  },
  variables: [
    {
      name: 'secretKey',
      envVar: 'STRIPE_SECRET_KEY',
      description: 'Stripe secret key (sk_test_* or sk_live_*)',
      required: true,
      secret: true,
      perEnvironment: true,
    },
    {
      name: 'publishableKey',
      envVar: 'STRIPE_PUBLISHABLE_KEY',
      publicEnvVar: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      description: 'Stripe publishable key (pk_test_* or pk_live_*)',
      required: true,
      secret: false,
      perEnvironment: true,
    },
    {
      name: 'webhookSecret',
      envVar: 'STRIPE_WEBHOOK_SECRET',
      description: 'Webhook signing secret (whsec_*)',
      required: false,
      secret: true,
      perEnvironment: true,
    },
  ],
  webhooks: {
    defaultPath: '/api/webhooks/stripe',
    events: [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
    ],
    hasSigningSecret: true,
    signingSecretEnvVar: 'STRIPE_WEBHOOK_SECRET',
  },
  guidedSetup: {
    intro: 'To add Stripe, you\'ll need your API keys from the Stripe Dashboard. Use test keys for staging and live keys for production.',
  },
});

// SendGrid (Level 2 - API key + webhooks)
integrationRegistry.register({
  name: 'sendgrid',
  displayName: 'SendGrid',
  category: 'email',
  level: 2,
  description: 'Add SendGrid for transactional email',
  setupUrl: 'https://app.sendgrid.com/settings/api_keys',
  documentationUrl: 'https://docs.sendgrid.com',
  variables: [
    {
      name: 'apiKey',
      envVar: 'SENDGRID_API_KEY',
      description: 'SendGrid API key',
      required: true,
      secret: true,
    },
    {
      name: 'fromEmail',
      envVar: 'SENDGRID_FROM_EMAIL',
      description: 'Default sender email address',
      required: false,
      secret: false,
    },
    {
      name: 'fromName',
      envVar: 'SENDGRID_FROM_NAME',
      description: 'Default sender name',
      required: false,
      secret: false,
    },
  ],
  webhooks: {
    defaultPath: '/api/webhooks/sendgrid',
    events: ['bounce', 'delivered', 'open', 'click', 'spam_report', 'unsubscribe', 'dropped'],
    hasSigningSecret: false, // SendGrid uses OAuth or verification key
  },
  guidedSetup: {
    intro: 'To add SendGrid, you\'ll need an API key with Mail Send permissions.',
  },
});

// reCAPTCHA (Level 1 - site key + secret key)
integrationRegistry.register({
  name: 'recaptcha',
  displayName: 'Google reCAPTCHA',
  category: 'auth',
  level: 1,
  description: 'Add reCAPTCHA for bot protection on forms',
  setupUrl: 'https://www.google.com/recaptcha/admin',
  documentationUrl: 'https://developers.google.com/recaptcha',
  variables: [
    {
      name: 'siteKey',
      envVar: 'RECAPTCHA_SITE_KEY',
      publicEnvVar: 'NEXT_PUBLIC_RECAPTCHA_SITE_KEY',
      description: 'reCAPTCHA site key (public)',
      required: true,
      secret: false,
    },
    {
      name: 'secretKey',
      envVar: 'RECAPTCHA_SECRET_KEY',
      description: 'reCAPTCHA secret key',
      required: true,
      secret: true,
    },
  ],
  guidedSetup: {
    intro: 'To add reCAPTCHA, you\'ll need to register your site in the reCAPTCHA admin console.',
  },
});
