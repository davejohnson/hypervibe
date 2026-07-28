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
  it('accepts scoped credentials and a declarative catalog', () => {
    const parsed = projectSpecSchema.parse(project({
      payments: {
        stripe: {
          environment: 'staging',
          services: ['web', 'cron'],
          credentials: {
            publishableKeyEnvVar: 'STRIPE_PUBLISHABLE_KEY',
          },
          catalog: {
            products: {
              starter: {
                name: 'Starter',
                prices: {
                  monthly: {
                    unitAmount: 4900,
                    interval: 'month',
                    currency: 'CAD',
                    envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                  },
                },
              },
            },
          },
        },
      },
    }));

    const stripe = parsed.environments.staging.payments?.stripe;
    expect(stripe?.credentials?.secretKeyEnvVar).toBe('STRIPE_SECRET_KEY');
    expect(stripe?.catalog?.products.starter.prices.monthly.currency).toBe('cad');
  });

  it('allows catalog-only sync when runtime Stripe credentials are managed elsewhere', () => {
    const parsed = projectSpecSchema.parse(project({
      payments: {
        stripe: {
          catalog: {
            products: {
              starter: {
                name: 'Starter',
                prices: {
                  monthly: {
                    unitAmount: 4900,
                    interval: 'month',
                    envVar: 'STRIPE_STARTER_MONTHLY_PRICE_ID',
                  },
                },
              },
            },
          },
        },
      },
    }));
    expect(parsed.environments.staging.payments?.stripe?.credentials).toBeUndefined();
  });

  it('rejects legacy price selectors with migration guidance', () => {
    const parsed = projectSpecSchema.safeParse(project({
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
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.message).toContain('selectors have been removed');
  });

  it('accepts webhook-only desired state and applies safe defaults', () => {
    const parsed = projectSpecSchema.parse(project({
      payments: {
        stripe: {
          environment: 'staging',
          webhooks: {
            billing: {
              url: 'https://billing.example.com/api/webhooks/stripe',
              service: 'web',
            },
          },
        },
      },
    }));
    const webhook = parsed.environments.staging.payments?.stripe?.webhooks.billing;
    expect(webhook).toMatchObject({
      service: 'web',
      envVar: 'STRIPE_WEBHOOK_SECRET',
    });
    expect(webhook?.events).toContain('checkout.session.completed');
    expect(parsed.environments.staging.payments?.stripe?.services).toBeUndefined();
  });

  it('rejects unsafe or ambiguous webhook ownership', () => {
    const insecure = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          webhooks: {
            billing: {
              url: 'http://billing.example.com/api/webhooks/stripe',
              service: 'web',
            },
          },
        },
      },
    }));
    expect(insecure.success).toBe(false);
    expect(insecure.success ? '' : insecure.error.message).toContain('must use HTTPS');

    const duplicateSlot = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          webhooks: {
            billing: {
              url: 'https://billing.example.com/api/webhooks/stripe',
              service: 'web',
            },
            invoices: {
              url: 'https://billing.example.com/api/webhooks/invoices',
              service: 'web',
            },
          },
        },
      },
    }));
    expect(duplicateSlot.success).toBe(false);
    expect(duplicateSlot.success ? '' : duplicateSlot.error.message).toContain('both manage STRIPE_WEBHOOK_SECRET');
  });

  it('rejects webhook services and env vars that collide with other desired state', () => {
    const unknown = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          webhooks: {
            billing: {
              url: 'https://billing.example.com/api/webhooks/stripe',
              service: 'worker',
            },
          },
        },
      },
    }));
    expect(unknown.success).toBe(false);
    expect(unknown.success ? '' : unknown.error.message).toContain('targets unknown service');

    const collision = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          services: ['web'],
          credentials: {},
          webhooks: {
            billing: {
              url: 'https://billing.example.com/api/webhooks/stripe',
              service: 'web',
              envVar: 'STRIPE_SECRET_KEY',
            },
          },
        },
      },
    }));
    expect(collision.success).toBe(false);
    expect(collision.success ? '' : collision.error.message).toContain('runtime sync also manages');
  });

  it('rejects unknown services and collisions with ordinary env sources', () => {
    const unknownService = projectSpecSchema.safeParse(project({
      payments: {
        stripe: {
          services: ['worker'],
          catalog: {
            products: {
              starter: {
                name: 'Starter',
                prices: {
                  monthly: { unitAmount: 1000, interval: 'month', envVar: 'STRIPE_PRICE_ID' },
                },
              },
            },
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
          catalog: {
            products: {
              starter: {
                name: 'Starter',
                prices: {
                  monthly: { unitAmount: 1000, interval: 'month', envVar: 'STRIPE_PRICE_ID' },
                },
              },
            },
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
          catalog: {
            products: {
              starter: {
                name: 'Starter',
                prices: {
                  monthly: {
                    unitAmount: 1000,
                    interval: 'month',
                    envVar: 'STRIPE_SECRET_KEY',
                  },
                },
              },
            },
          },
        },
      },
    }));
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('cannot also be a catalog price binding');
  });

  it('rejects Stripe-managed keys that are delegated or retired', () => {
    const delegated = projectSpecSchema.safeParse({
      ...project({
        payments: {
          stripe: {
            catalog: {
              products: {
                starter: {
                  name: 'Starter',
                  prices: {
                    monthly: { unitAmount: 1000, interval: 'month', envVar: 'STRIPE_PRICE_ID' },
                  },
                },
              },
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
