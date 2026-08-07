import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StripeAdapter,
  StripeCredentialsSchema,
  type StripePrice,
  type StripeProduct,
} from '../../../adapters/providers/stripe/stripe.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../adapter.factory.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { PlanService } from '../../plan/plan.service.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';
import {
  applyStripeCatalogAction,
  applyStripeHostingEnvSync,
  applyStripeWebhookAction,
  parseStripeBindings,
  planStripeEnvironmentSync,
} from '../stripe-env.service.js';
import { getStripeAdapter } from '../stripe-ops.service.js';

const products: StripeProduct[] = [
  {
    id: 'prod_starter',
    name: 'Invoice Perfect Starter',
    description: null,
    active: true,
    metadata: {},
    created: 1,
    updated: 1,
  },
];

const prices: StripePrice[] = [
  {
    id: 'price_starter_month',
    product: 'prod_starter',
    active: true,
    currency: 'cad',
    unit_amount: 4900,
    recurring: { interval: 'month', interval_count: 1 },
    type: 'recurring',
    metadata: {},
    nickname: 'Starter monthly',
    lookup_key: 'starter_monthly',
    created: 1,
  },
];

function environmentSpec(): EnvironmentSpec {
  return {
    hosting: { provider: 'railway' },
    services: {
      web: {
        workloadKind: 'web',
        public: true,
      },
      cron: {
        workloadKind: 'cron',
        public: false,
      },
    },
    email: { enabled: false },
    envVars: {},
    payments: {
      stripe: {
        environment: 'staging',
        services: ['web', 'cron'],
        credentials: {
          secretKeyEnvVar: 'STRIPE_SECRET_KEY',
          publishableKeyEnvVar: 'STRIPE_PUBLISHABLE_KEY',
        },
        catalog: {
          products: {
            starter: {
              name: 'Invoice Perfect Starter',
              prices: {
                monthly: {
                  unitAmount: 4900,
                  currency: 'cad',
                  interval: 'month',
                  envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                },
              },
            },
          },
        },
        webhooks: {},
      },
    },
  };
}

function stripeCatalogBindings() {
  return {
    payments: {
      stripe: {
        environment: 'staging',
        catalog: {
          products: {
            starter: {
              productId: 'prod_starter',
              name: 'Invoice Perfect Starter',
              prices: {
                monthly: {
                  priceId: 'price_starter_month',
                  envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                  unitAmount: 4900,
                  currency: 'cad',
                  interval: 'month',
                },
              },
            },
          },
        },
        webhooks: {},
      },
    },
  };
}

describe('Stripe hosting environment sync', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-stripe-env-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    const repo = new ConnectionRepository();
    const connection = repo.create({
      provider: 'stripe',
      scope: 'staging',
      credentialsEncrypted: getSecretStore().encryptObject({
        secretKey: 'sk_test_staging_secret',
        publishableKey: 'pk_test_staging_public',
      }),
    });
    repo.updateStatus(connection.id, 'verified');
    const railway = repo.create({
      provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'railway-test-token' }),
    });
    repo.updateStatus(railway.id, 'verified');
    vi.spyOn(StripeAdapter.prototype, 'listProducts').mockResolvedValue(products);
    vi.spyOn(StripeAdapter.prototype, 'listPrices').mockResolvedValue(prices);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates scoped key pairs without allowing ambiguous legacy fields', () => {
    expect(StripeCredentialsSchema.safeParse({
      secretKey: 'sk_test_staging',
      publishableKey: 'pk_test_staging',
    }).success).toBe(true);
    expect(StripeCredentialsSchema.safeParse({
      secretKey: 'sk_test_staging',
      publishableKey: 'pk_live_production',
    }).success).toBe(false);
    expect(StripeCredentialsSchema.safeParse({
      secretKey: 'sk_test_staging',
      liveSecretKey: 'sk_live_production',
    }).success).toBe(false);
    expect(StripeCredentialsSchema.safeParse({
      secretKey: 'rk_test_staging',
      publishableKey: 'pk_test_staging',
    }).success).toBe(true);
    expect(StripeCredentialsSchema.safeParse({
      secretKey: 'rk_live_production',
      publishableKey: 'pk_test_staging',
    }).success).toBe(false);
  });

  it('refuses to treat a single unscoped key as both Stripe modes', async () => {
    const repo = new ConnectionRepository();
    const global = repo.create({
      provider: 'stripe',
      credentialsEncrypted: getSecretStore().encryptObject({
        secretKey: 'sk_live_unscoped',
      }),
    });
    repo.updateStatus(global.id, 'verified');
    const result = getStripeAdapter();
    expect(result).toEqual({
      error: expect.stringContaining('did not select an environment'),
    });

  });

  it('requires the Stripe connection scope mapped to the hosting environment', () => {
    const service = new PlanService();
    expect(service.preflight(environmentSpec(), 'staging')).toEqual([]);
    const productionSpec = environmentSpec();
    productionSpec.payments!.stripe!.environment = 'production';
    const blocked = service.preflight(productionSpec, 'production');
    expect(blocked).toEqual([
      expect.objectContaining({
        provider: 'stripe',
        scope: 'production',
        policy: 'hard',
      }),
    ]);
  });

  it('plans only drifted keys and never persists Stripe values in the action', async () => {
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [
        {
          name: 'web',
          externalId: 'web-1',
          workloadKind: 'web',
          customDomains: [],
          config: {},
          envVarKeys: [
            'STRIPE_SECRET_KEY',
            'STRIPE_PUBLISHABLE_KEY',
            'STRIPE_STARTER_MONTHLY_PRICE_ID',
          ],
          envVarHashes: {
            STRIPE_SECRET_KEY: hashEnvValue('sk_test_staging_secret'),
            STRIPE_PUBLISHABLE_KEY: hashEnvValue('pk_test_staging_public'),
            STRIPE_STARTER_MONTHLY_PRICE_ID: hashEnvValue('outdated'),
          },
          status: 'running',
        },
        {
          name: 'cron',
          externalId: 'cron-1',
          workloadKind: 'cron',
          customDomains: [],
          config: {},
          envVarKeys: [
            'STRIPE_SECRET_KEY',
            'STRIPE_PUBLISHABLE_KEY',
            'STRIPE_STARTER_MONTHLY_PRICE_ID',
          ],
          envVarHashes: {
            STRIPE_SECRET_KEY: hashEnvValue('sk_test_staging_secret'),
            STRIPE_PUBLISHABLE_KEY: hashEnvValue('pk_test_staging_public'),
            STRIPE_STARTER_MONTHLY_PRICE_ID: hashEnvValue('price_starter_month'),
          },
          status: 'running',
        },
      ],
      databases: [],
      partial: false,
      warnings: [],
    };

    const result = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: environmentSpec(),
      environment: { platformBindings: stripeCatalogBindings() } as never,
      observed,
    });

    expect(result.blocked).toEqual([]);
    expect(result.actions.find((action) => action.resource.name === 'web')).toMatchObject({
      type: 'update',
      diff: [{ field: 'env:STRIPE_STARTER_MONTHLY_PRICE_ID' }],
    });
    expect(result.actions.find((action) => action.resource.name === 'cron')?.type).toBe('noop');
    const serialized = JSON.stringify(result.actions);
    expect(serialized).not.toContain('sk_test_staging_secret');
    expect(serialized).not.toContain('pk_test_staging_public');
  });

  it('applies through the hosting adapter with CI deployment deferred and redacted receipts', async () => {
    const setEnvVars = vi.fn(async () => ({
      success: true,
      message: 'synced',
      data: { deploymentDeferred: true },
    }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        capabilities: { supportsDeferredDeploy: true },
        setEnvVars,
      } as never,
    });
    const spec = environmentSpec();
    spec.deploy = { strategy: 'branch', trigger: 'ci' };
    const project = {
      id: 'project-1',
      name: 'billing-app',
      defaultPlatform: 'railway',
      policies: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const environment = {
      id: 'environment-1',
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-staging',
        services: { web: { serviceId: 'railway-web' } },
        ...stripeCatalogBindings(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service = {
      id: 'service-1',
      projectId: project.id,
      name: 'web',
      buildConfig: {},
      envVarSpec: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const keys = [
      'STRIPE_PUBLISHABLE_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_STARTER_MONTHLY_PRICE_ID',
    ];

    const result = await applyStripeHostingEnvSync({
      project,
      environment,
      environmentSpec: spec,
      service,
      action: {
        id: 'payment:stripe:staging:hosting-env:web',
        type: 'update',
        resource: { kind: 'payment', name: 'web', provider: 'stripe' },
        verified: true,
        reason: 'test',
        metadata: {
          operation: 'stripeHostingEnvSync',
          stripeEnvironment: 'staging',
          service: 'web',
          keys,
          valueHashes: {
            STRIPE_PUBLISHABLE_KEY: hashEnvValue('pk_test_staging_public'),
            STRIPE_SECRET_KEY: hashEnvValue('sk_test_staging_secret'),
            STRIPE_STARTER_MONTHLY_PRICE_ID: hashEnvValue('price_starter_month'),
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(setEnvVars).toHaveBeenCalledWith(
      environment,
      service,
      {
        STRIPE_PUBLISHABLE_KEY: 'pk_test_staging_public',
        STRIPE_SECRET_KEY: 'sk_test_staging_secret',
        STRIPE_STARTER_MONTHLY_PRICE_ID: 'price_starter_month',
      },
      { deferDeployment: true }
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk_test_staging_secret');
    expect(serialized).not.toContain('pk_test_staging_public');
    expect(serialized).not.toContain('price_starter_month');
    expect(result.data).toMatchObject({ deploymentDeferred: true, variableCount: 3 });
  });

  it('plans immutable price replacement before hosting projection and archives the old price afterwards', async () => {
    const spec = environmentSpec();
    spec.payments!.stripe!.catalog!.products.starter.prices.monthly.unitAmount = 5900;
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [{
        name: 'web',
        externalId: 'web-1',
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: ['STRIPE_STARTER_MONTHLY_PRICE_ID'],
        envVarHashes: {
          STRIPE_STARTER_MONTHLY_PRICE_ID: hashEnvValue('price_starter_month'),
        },
        status: 'running',
      }],
      databases: [],
      completeness: { services: 'complete' },
      partial: false,
      warnings: [],
    };
    const result = await planStripeEnvironmentSync({
      projectName: 'billing-app',
      environmentName: 'staging',
      environmentSpec: spec,
      environment: { platformBindings: stripeCatalogBindings() } as never,
      observed,
    });

    const replace = result.actions.find((action) =>
      action.metadata?.operation === 'stripeCatalogPriceEnsure'
    );
    const hosting = result.actions.find((action) =>
      action.metadata?.operation === 'stripeHostingEnvSync'
      && action.resource.name === 'web'
    );
    const archive = result.actions.find((action) =>
      action.metadata?.operation === 'stripeCatalogPriceArchive'
    );
    expect(replace).toMatchObject({
      type: 'replace',
      metadata: {
        priceId: 'price_starter_month',
        previousPriceId: 'price_starter_month',
        unitAmount: 5900,
      },
    });
    expect(hosting?.dependsOn).toContain(replace?.id);
    expect(archive).toMatchObject({
      type: 'destroy',
      requiresConfirm: true,
      metadata: { priceId: 'price_starter_month', replacement: true },
    });
    expect(archive?.dependsOn).toEqual(expect.arrayContaining([replace!.id, hosting!.id]));
  });

  it('reviews explicit catalog recreation when a scoped connection points at a fresh sandbox', async () => {
    vi.spyOn(StripeAdapter.prototype, 'listProducts').mockResolvedValue([]);
    vi.spyOn(StripeAdapter.prototype, 'listPrices').mockResolvedValue([]);
    const spec = environmentSpec();
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [{
        name: 'web',
        externalId: 'web-1',
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: ['STRIPE_STARTER_MONTHLY_PRICE_ID'],
        envVarHashes: {
          STRIPE_STARTER_MONTHLY_PRICE_ID: hashEnvValue('price_starter_month'),
        },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    };

    const result = await planStripeEnvironmentSync({
      projectName: 'billing-app',
      environmentName: 'staging',
      environmentSpec: spec,
      environment: { platformBindings: stripeCatalogBindings() } as never,
      observed,
    });
    const product = result.actions.find((action) =>
      action.metadata?.operation === 'stripeCatalogProductEnsure'
    );
    const price = result.actions.find((action) =>
      action.metadata?.operation === 'stripeCatalogPriceEnsure'
    );

    expect(product).toMatchObject({
      type: 'replace',
      requiresConfirm: true,
      reason: expect.stringContaining('absent; recreate it'),
    });
    expect(price).toMatchObject({
      type: 'replace',
      requiresConfirm: true,
      dependsOn: [product?.id],
    });
    expect(result.actions.find((action) =>
      action.metadata?.operation === 'stripeHostingEnvSync'
      && action.resource.name === 'web'
    )?.dependsOn).toEqual(expect.arrayContaining([product!.id, price!.id]));
  });

  it('creates catalog resources with action-id idempotency and persists durable identities only', async () => {
    const project = new ProjectRepository().create({
      name: 'billing-app',
      defaultPlatform: 'railway',
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        payments: {
          stripe: {
            environment: 'staging',
            catalog: { products: {} },
            webhooks: {},
          },
        },
      },
    });
    const createProduct = vi.spyOn(StripeAdapter.prototype, 'createProduct').mockResolvedValue({
      ...products[0],
      metadata: {
        hypervibe_project: 'billing-app',
        hypervibe_environment: 'staging',
        hypervibe_product: 'starter',
      },
    });
    const createPrice = vi.spyOn(StripeAdapter.prototype, 'createPrice').mockResolvedValue({
      ...prices[0],
      metadata: {
        hypervibe_project: 'billing-app',
        hypervibe_environment: 'staging',
        hypervibe_product: 'starter',
        hypervibe_price: 'monthly',
      },
    });
    const spec = environmentSpec();
    const productAction = {
      id: 'payment:stripe:staging:catalog:product:starter',
      type: 'create' as const,
      resource: { kind: 'payment' as const, name: 'starter', provider: 'stripe' },
      verified: true,
      reason: 'create',
      metadata: {
        operation: 'stripeCatalogProductEnsure',
        stripeEnvironment: 'staging',
        projectName: 'billing-app',
        productKey: 'starter',
        productName: 'Invoice Perfect Starter',
        productDescription: null,
      },
    };
    const productResult = await applyStripeCatalogAction({
      environment,
      environmentSpec: spec,
      action: productAction,
    });
    expect(productResult.success).toBe(true);
    expect(createProduct).toHaveBeenCalledWith(
      'sandbox',
      expect.objectContaining({ name: 'Invoice Perfect Starter' }),
      { idempotencyKey: productAction.id }
    );

    const latest = new EnvironmentRepository().findById(environment.id)!;
    const priceAction = {
      id: 'payment:stripe:staging:catalog:price:starter:monthly',
      type: 'create' as const,
      resource: { kind: 'payment' as const, name: 'starter.monthly', provider: 'stripe' },
      verified: true,
      reason: 'create',
      metadata: {
        operation: 'stripeCatalogPriceEnsure',
        stripeEnvironment: 'staging',
        projectName: 'billing-app',
        productKey: 'starter',
        priceKey: 'monthly',
        productName: 'Invoice Perfect Starter',
        productDescription: null,
        envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
        unitAmount: 4900,
        currency: 'cad',
        interval: 'month',
      },
    };
    const priceResult = await applyStripeCatalogAction({
      environment: latest,
      environmentSpec: spec,
      action: priceAction,
    });
    expect(priceResult.success).toBe(true);
    expect(createPrice).toHaveBeenCalledWith(
      'sandbox',
      expect.objectContaining({
        product: 'prod_starter',
        unit_amount: 4900,
        currency: 'cad',
      }),
      { idempotencyKey: priceAction.id }
    );
    const bindings = parseStripeBindings(new EnvironmentRepository().findById(environment.id));
    expect(bindings.catalog.products.starter).toMatchObject({
      productId: 'prod_starter',
      prices: {
        monthly: {
          priceId: 'price_starter_month',
          envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
        },
      },
    });
    expect(JSON.stringify(bindings)).not.toContain('sk_test_staging_secret');
  });

  it('plans webhook creation and explicit adoption without exposing signing values', async () => {
    const spec = environmentSpec();
    spec.payments!.stripe = {
      environment: 'staging',
      webhooks: {
        billing: {
          url: 'https://billing.example.com/api/webhooks/stripe',
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
          events: ['checkout.session.completed'],
        },
      },
    };
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [{
        name: 'web',
        externalId: 'web-1',
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      completeness: { services: 'complete' },
      partial: false,
      warnings: [],
    };
    const list = vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([]);

    const createPlan = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: spec,
      observed,
    });
    expect(createPlan.actions).toEqual([
      expect.objectContaining({
        id: 'payment:stripe:staging:webhook:billing',
        type: 'create',
        resource: { kind: 'payment', name: 'billing', provider: 'stripe' },
        dependsOn: ['service:web'],
        metadata: expect.objectContaining({
          operation: 'stripeWebhookEnsure',
          envVar: 'STRIPE_WEBHOOK_SECRET',
        }),
      }),
    ]);

    list.mockResolvedValue([{
      id: 'we_existing',
      url: 'https://billing.example.com/api/webhooks/stripe',
      status: 'enabled',
      enabled_events: ['checkout.session.completed'],
      metadata: {},
      created: 1,
    }]);
    observed.services[0].envVarKeys = ['STRIPE_WEBHOOK_SECRET'];
    observed.services[0].envVarHashes = {
      STRIPE_WEBHOOK_SECRET: hashEnvValue('existing-signing-value'),
    };
    const adoptPlan = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: spec,
      observed,
    });
    expect(adoptPlan.actions[0]).toMatchObject({
      type: 'update',
      requiresConfirm: true,
      metadata: {
        operation: 'stripeWebhookAdopt',
        endpointId: 'we_existing',
        valueHash: hashEnvValue('existing-signing-value'),
      },
    });
    expect(JSON.stringify(adoptPlan)).not.toContain('existing-signing-value');
  });

  it('blocks webhook convergence on unknown observation and duplicate provider identities', async () => {
    const spec = environmentSpec();
    spec.payments!.stripe = {
      environment: 'staging',
      webhooks: {
        billing: {
          url: 'https://billing.example.com/api/webhooks/stripe',
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
          events: ['checkout.session.completed'],
        },
      },
    };
    const observed: ObservedState = {
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      services: [{
        name: 'web',
        externalId: 'web-1',
        workloadKind: 'web',
        customDomains: [],
        config: {},
        envVarKeys: [],
        envVarHashes: {},
        status: 'running',
      }],
      databases: [],
      completeness: { services: 'complete' },
      partial: false,
      warnings: [],
    };
    const list = vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints')
      .mockRejectedValue(new Error('permission denied'));
    const unknown = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: spec,
      observed,
    });
    expect(unknown.blocked).toEqual([
      expect.objectContaining({ provider: 'stripe', policy: 'hard' }),
    ]);
    expect(unknown.actions).toEqual([
      expect.objectContaining({
        type: 'update',
        metadata: expect.objectContaining({
          blockedReason: expect.stringContaining('permission denied'),
        }),
      }),
    ]);
    expect(unknown.actions.some((action) => action.type === 'create' || action.type === 'destroy')).toBe(false);

    list.mockResolvedValue([
      {
        id: 'we_first',
        url: spec.payments!.stripe!.webhooks.billing.url,
        status: 'enabled',
        enabled_events: ['checkout.session.completed'],
        metadata: {},
        created: 1,
      },
      {
        id: 'we_second',
        url: spec.payments!.stripe!.webhooks.billing.url,
        status: 'enabled',
        enabled_events: ['checkout.session.completed'],
        metadata: {},
        created: 2,
      },
    ]);
    const duplicate = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: spec,
      observed,
    });
    expect(duplicate.actions[0]).toMatchObject({
      type: 'update',
      metadata: {
        operation: 'stripeWebhookAdopt',
        blockedReason: expect.stringContaining('Multiple matching provider identities'),
      },
    });
    expect(duplicate.warnings).toEqual([
      expect.stringContaining('has 2 endpoints'),
    ]);
  });

  it('plans a true webhook noop from durable provider identity and matching hosting hash', async () => {
    const spec = environmentSpec();
    spec.payments!.stripe = {
      environment: 'staging',
      webhooks: {
        billing: {
          url: 'https://billing.example.com/api/webhooks/stripe',
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
          events: ['checkout.session.completed'],
        },
      },
    };
    const valueHash = hashEnvValue('already-synced');
    const environment = {
      platformBindings: {
        payments: {
          stripe: {
            environment: 'staging',
            webhooks: {
              billing: {
                endpointId: 'we_bound',
                url: spec.payments!.stripe!.webhooks.billing.url,
                events: ['checkout.session.completed'],
                service: 'web',
                envVar: 'STRIPE_WEBHOOK_SECRET',
                valueHash,
              },
            },
          },
        },
      },
    };
    vi.spyOn(StripeAdapter.prototype, 'listWebhookEndpoints').mockResolvedValue([{
      id: 'we_bound',
      url: spec.payments!.stripe!.webhooks.billing.url,
      status: 'enabled',
      enabled_events: ['checkout.session.completed'],
      metadata: {},
      created: 1,
    }]);
    const create = vi.spyOn(StripeAdapter.prototype, 'createWebhookEndpoint');
    const update = vi.spyOn(StripeAdapter.prototype, 'updateWebhookEndpoint');
    const destroy = vi.spyOn(StripeAdapter.prototype, 'deleteWebhookEndpoint');
    const plan = await planStripeEnvironmentSync({
      environmentName: 'staging',
      environmentSpec: spec,
      environment: environment as never,
      observed: {
        provider: 'railway',
        observedAt: new Date().toISOString(),
        projectExists: true,
        services: [{
          name: 'web',
          externalId: 'web-1',
          workloadKind: 'web',
          customDomains: [],
          config: {},
          envVarKeys: ['STRIPE_WEBHOOK_SECRET'],
          envVarHashes: { STRIPE_WEBHOOK_SECRET: valueHash },
          status: 'running',
        }],
        databases: [],
        completeness: { services: 'complete' },
        partial: false,
        warnings: [],
      },
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({
        id: 'payment:stripe:staging:webhook:billing',
        type: 'noop',
        verified: true,
      }),
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('creates a webhook, syncs its signing value, and persists only durable identity plus a hash', async () => {
    const project = new ProjectRepository().create({
      name: 'billing-app',
      defaultPlatform: 'railway',
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-staging',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    const spec = environmentSpec();
    spec.payments!.stripe = {
      environment: 'staging',
      webhooks: {
        billing: {
          url: 'https://billing.example.com/api/webhooks/stripe',
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
          events: ['checkout.session.completed'],
        },
      },
    };
    vi.spyOn(StripeAdapter.prototype, 'createWebhookEndpoint').mockResolvedValue({
      id: 'we_new',
      url: spec.payments!.stripe!.webhooks.billing.url,
      status: 'enabled',
      enabled_events: ['checkout.session.completed'],
      secret: 'whsec_never_persist',
      metadata: {},
      created: 1,
    });
    const setEnvVars = vi.fn(async () => ({ success: true, message: 'synced' }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', setEnvVars } as never,
    });

    const result = await applyStripeWebhookAction({
      project,
      environment,
      environmentSpec: spec,
      action: {
        id: 'payment:stripe:staging:webhook:billing',
        type: 'create',
        resource: { kind: 'payment', name: 'billing', provider: 'stripe' },
        verified: true,
        reason: 'create',
        metadata: {
          operation: 'stripeWebhookEnsure',
          stripeEnvironment: 'staging',
          webhookName: 'billing',
          url: spec.payments!.stripe!.webhooks.billing.url,
          events: ['checkout.session.completed'],
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(setEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.id }),
      expect.objectContaining({ name: 'web' }),
      { STRIPE_WEBHOOK_SECRET: 'whsec_never_persist' }
    );
    const latest = new EnvironmentRepository().findById(environment.id)!;
    expect(parseStripeBindings(latest).webhooks.billing).toMatchObject({
      endpointId: 'we_new',
      service: 'web',
      envVar: 'STRIPE_WEBHOOK_SECRET',
      valueHash: hashEnvValue('whsec_never_persist'),
    });
    expect(JSON.stringify(latest.platformBindings)).not.toContain('whsec_never_persist');
    expect(JSON.stringify(result)).not.toContain('whsec_never_persist');
  });

  it('rolls back a new endpoint when hosting sync fails and preserves no false binding', async () => {
    const project = new ProjectRepository().create({
      name: 'billing-app',
      defaultPlatform: 'railway',
    });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-staging',
        services: { web: { serviceId: 'railway-web' } },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    const spec = environmentSpec();
    spec.payments!.stripe = {
      environment: 'staging',
      webhooks: {
        billing: {
          url: 'https://billing.example.com/api/webhooks/stripe',
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
          events: ['checkout.session.completed'],
        },
      },
    };
    const endpoint = {
      id: 'we_rollback',
      url: spec.payments!.stripe!.webhooks.billing.url,
      status: 'enabled' as const,
      enabled_events: ['checkout.session.completed'],
      secret: 'whsec_rollback',
      metadata: {},
      created: 1,
    };
    vi.spyOn(StripeAdapter.prototype, 'createWebhookEndpoint').mockResolvedValue(endpoint);
    vi.spyOn(StripeAdapter.prototype, 'getWebhookEndpoint')
      .mockResolvedValueOnce(endpoint)
      .mockResolvedValueOnce(null);
    const deleted = vi.spyOn(StripeAdapter.prototype, 'deleteWebhookEndpoint')
      .mockResolvedValue({ id: endpoint.id, deleted: true });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'railway',
        setEnvVars: vi.fn(async () => ({ success: false, message: 'hosting rejected update' })),
      } as never,
    });

    const result = await applyStripeWebhookAction({
      project,
      environment,
      environmentSpec: spec,
      action: {
        id: 'payment:stripe:staging:webhook:billing',
        type: 'create',
        resource: { kind: 'payment', name: 'billing', provider: 'stripe' },
        verified: true,
        reason: 'create',
        metadata: {
          operation: 'stripeWebhookEnsure',
          stripeEnvironment: 'staging',
          webhookName: 'billing',
          url: endpoint.url,
          events: endpoint.enabled_events,
          service: 'web',
          envVar: 'STRIPE_WEBHOOK_SECRET',
        },
      },
    });
    expect(result).toMatchObject({
      success: false,
      data: { endpointId: endpoint.id, rollback: 'succeeded', bindingRecorded: false },
    });
    expect(deleted).toHaveBeenCalledWith('sandbox', endpoint.id);
    expect(parseStripeBindings(new EnvironmentRepository().findById(environment.id)).webhooks).toEqual({});
    expect(JSON.stringify(result)).not.toContain('whsec_rollback');
  });

  it('verifies webhook deletion before removing hosting state and its binding', async () => {
    const project = new ProjectRepository().create({
      name: 'billing-app',
      defaultPlatform: 'railway',
    });
    const endpoint = {
      id: 'we_old',
      url: 'https://billing.example.com/api/webhooks/stripe',
      status: 'enabled' as const,
      enabled_events: ['checkout.session.completed'],
      metadata: {},
      created: 1,
    };
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-staging',
        services: { web: { serviceId: 'railway-web' } },
        payments: {
          stripe: {
            environment: 'staging',
            webhooks: {
              billing: {
                endpointId: endpoint.id,
                url: endpoint.url,
                events: endpoint.enabled_events,
                service: 'web',
                envVar: 'STRIPE_WEBHOOK_SECRET',
                valueHash: hashEnvValue('old-signing-value'),
              },
            },
          },
        },
      },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web' });
    const spec = environmentSpec();
    const getEndpoint = vi.spyOn(StripeAdapter.prototype, 'getWebhookEndpoint')
      .mockResolvedValueOnce(endpoint)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const deleteEndpoint = vi.spyOn(StripeAdapter.prototype, 'deleteWebhookEndpoint')
      .mockResolvedValue({ id: endpoint.id, deleted: true });
    const deleteEnvVars = vi.fn(async () => ({ success: true, message: 'removed' }));
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
      success: true,
      adapter: { name: 'railway', deleteEnvVars } as never,
    });

    const action = {
      id: 'payment:stripe:staging:webhook:billing',
      type: 'destroy' as const,
      resource: { kind: 'payment' as const, name: 'billing', provider: 'stripe' },
      verified: true,
      reason: 'destroy',
      requiresConfirm: true,
      metadata: {
        operation: 'stripeWebhookDestroy',
        stripeEnvironment: 'staging',
        webhookName: 'billing',
        endpointId: endpoint.id,
        service: 'web',
        envVar: 'STRIPE_WEBHOOK_SECRET',
      },
    };
    const result = await applyStripeWebhookAction({
      project,
      environment,
      environmentSpec: spec,
      action,
    });
    expect(result.success).toBe(true);
    expect(deleteEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.id }),
      expect.objectContaining({ name: 'web' }),
      ['STRIPE_WEBHOOK_SECRET']
    );
    expect(parseStripeBindings(new EnvironmentRepository().findById(environment.id)).webhooks).toEqual({});

    // Simulate retry after provider deletion succeeded but local cleanup did
    // not persist. The bound endpoint is already absent, so no second provider
    // delete occurs and hosting cleanup remains safe to retry.
    const retry = await applyStripeWebhookAction({
      project,
      environment,
      environmentSpec: spec,
      action,
    });
    expect(retry).toMatchObject({
      success: true,
      data: { alreadyAbsent: true },
    });
    expect(getEndpoint).toHaveBeenCalledTimes(3);
    expect(deleteEndpoint).toHaveBeenCalledTimes(1);
  });
});
