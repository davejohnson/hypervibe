import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../spec.schema.js';

function project(environmentOverrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: 'billing-app',
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: {}, cron: {} },
        ...environmentOverrides,
      },
    },
  };
}

describe('Stripe environment sync spec', () => {
  it('accepts scoped credentials and deterministic price selectors', () => {
    const parsed = projectSpecSchema.parse(project({
      payments: {
        stripe: {
          environment: 'staging',
          services: ['web', 'cron'],
          credentials: {
            publishableKeyEnvVar: 'STRIPE_PUBLISHABLE_KEY',
          },
          prices: {
            STRIPE_STARTER_MONTHLY_PRICE_ID: {
              product: 'Starter',
              match: 'contains',
              interval: 'month',
              currency: 'CAD',
            },
          },
        },
      },
    }));

    const stripe = parsed.environments.staging.payments?.stripe;
    expect(stripe?.credentials?.secretKeyEnvVar).toBe('STRIPE_SECRET_KEY');
    expect(stripe?.prices.STRIPE_STARTER_MONTHLY_PRICE_ID.currency).toBe('cad');
  });

  it('allows price-only sync when runtime Stripe credentials are managed elsewhere', () => {
    const parsed = projectSpecSchema.parse(project({
      payments: {
        stripe: {
          prices: {
            STRIPE_STARTER_MONTHLY_PRICE_ID: {
              product: 'Starter',
              interval: 'month',
            },
          },
        },
      },
    }));
    expect(parsed.environments.staging.payments?.stripe?.credentials).toBeUndefined();
  });

  it('rejects unknown services and collisions with ordinary env sources', () => {
    const unknownService = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          services: ['worker'],
          prices: {
            STRIPE_PRICE_ID: { product: 'Starter', interval: 'month' },
          },
        },
      },
    }));
    expect(unknownService.success).toBe(false);
    expect(unknownService.success ? '' : unknownService.error.message).toContain('unknown service');

    const ordinaryEnv = projectSpecSchema.safeParse(project({
      envVars: { STRIPE_PRICE_ID: 'must-not-win' },
      payments: {
        stripe: {
          prices: {
            STRIPE_PRICE_ID: { product: 'Starter', interval: 'month' },
          },
        },
      },
    }));
    expect(ordinaryEnv.success).toBe(false);
    expect(ordinaryEnv.success ? '' : ordinaryEnv.error.message).toContain('cannot also be declared');
  });

  it('rejects a price binding that overwrites a projected runtime credential', () => {
    const result = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          credentials: {},
          prices: {
            STRIPE_SECRET_KEY: {
              product: 'Starter',
              interval: 'month',
            },
          },
        },
      },
    }));
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('cannot also be a price binding');
  });

  it('rejects Stripe-managed keys that are delegated or retired', () => {
    const delegated = projectSpecSchema.safeParse({
      ...project({
        payments: {
          stripe: {
            prices: {
              STRIPE_PRICE_ID: { product: 'Starter', interval: 'month' },
            },
          },
        },
      }),
      secrets: {
        STRIPE_PRICE_ID: {
          principal: 'github:billing-owner',
          environments: ['staging'],
        },
      },
    });
    expect(delegated.success).toBe(false);
    expect(delegated.success ? '' : delegated.error.message).toContain('cannot also be managed by Stripe');

    const retired = projectSpecSchema.safeParse(project({
      removeEnvVars: ['STRIPE_SECRET_KEY'],
      payments: {
        stripe: {
          credentials: {},
        },
      },
    }));
    expect(retired.success).toBe(false);
    expect(retired.success ? '' : retired.error.message).toContain('cannot also be retired');
  });
});
