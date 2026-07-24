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
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { adapterFactory } from '../adapter.factory.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { PlanService } from '../../plan/plan.service.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';
import {
  applyStripeHostingEnvSync,
  planStripeEnvironmentSync,
  resolveStripePriceEnvValues,
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
        prices: {
          STRIPE_STARTER_MONTHLY_PRICE_ID: {
            product: 'Starter',
            match: 'contains',
            interval: 'month',
            currency: 'cad',
            lookupKey: 'starter_monthly',
          },
        },
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

    const adapter = new StripeAdapter();
    adapter.connect({ secretKey: 'sk_live_unscoped' });
    await expect(adapter.clearCustomers('sandbox')).rejects.toThrow('Refusing to clear customers in live mode');
  });

  it('resolves an Invoice Express-style product/interval binding deterministically', () => {
    const result = resolveStripePriceEnvValues(
      {
        STRIPE_STARTER_MONTHLY_PRICE_ID: {
          product: 'Starter',
          match: 'contains',
          interval: 'month',
          currency: 'cad',
          lookupKey: 'starter_monthly',
        },
      },
      products,
      prices
    );
    expect(result).toEqual({
      success: true,
      values: { STRIPE_STARTER_MONTHLY_PRICE_ID: 'price_starter_month' },
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

  it('rejects ambiguous active prices instead of silently choosing one', () => {
    const result = resolveStripePriceEnvValues(
      {
        STRIPE_STARTER_MONTHLY_PRICE_ID: {
          product: 'Starter',
          match: 'contains',
          interval: 'month',
        },
      },
      products,
      [...prices, { ...prices[0], id: 'price_other', nickname: 'Other' }]
    );
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error).toContain('2 active');
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
    expect(serialized).not.toContain('price_starter_month');
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
});
