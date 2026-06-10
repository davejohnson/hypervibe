import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { StripeAdapter, STRIPE_COMMON_WEBHOOK_EVENTS } from '../adapters/providers/stripe/stripe.adapter.js';
import type { StripeCredentials, StripeMode, StripeCustomer } from '../adapters/providers/stripe/stripe.adapter.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { providerDisplayName, syncHostingEnvVars } from '../domain/services/hosting-env.service.js';

import { resolveProject } from './resolve-project.js';

const connectionRepo = new ConnectionRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const auditRepo = new AuditRepository();

function getStripeAdapter(): { adapter: StripeAdapter; credentials: StripeCredentials } | { error: string } {
  const connection = connectionRepo.findByProvider('stripe');
  if (!connection) {
    return { error: 'No Stripe connection found. Use connection_create with provider=stripe first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<StripeCredentials>(connection.credentialsEncrypted);
  const adapter = new StripeAdapter();
  adapter.connect(credentials);

  return { adapter, credentials };
}

export function registerStripeTools(server: McpServer): void {
  server.tool(
    'stripe_setup_help',
    'Get instructions for setting up Stripe API keys and local webhook testing (no Stripe CLI needed)',
    {},
    async () => {
      const instructions = `# Stripe Setup

## API Keys

1. Go to https://dashboard.stripe.com/apikeys
2. Copy your **Secret key** (starts with \`sk_test_\` for sandbox, \`sk_live_\` for live)
3. Optionally copy the **Publishable key** too (\`pk_test_\` / \`pk_live_\`)

Connect to Hypervibe:

\`\`\`
connection_create provider=stripe credentials={"sandboxSecretKey":"sk_test_...","liveSecretKey":"sk_live_..."}
connection_verify provider=stripe
\`\`\`

You can start with just the sandbox key and add the live key later.

## Local Webhook Testing (No Stripe CLI)

Instead of \`stripe listen\`, use a tunnel to get a public URL for your local server:

\`\`\`
# 1. Start a tunnel to your local dev server
tunnel_start localPort=3000

# 2. Create a Stripe webhook pointing at your tunnel URL
stripe_webhook_create mode=sandbox url=https://<tunnel-url>/api/webhooks/stripe

# 3. Save the signing secret returned by Stripe
env_create name=STRIPE_WEBHOOK_SECRET value=whsec_...
\`\`\`

Stripe sends real events to the tunnel URL, which forwards to localhost:3000. When you're done:

\`\`\`
tunnel_stop tunnelId=cloudflared-3000
\`\`\`

The tunnel uses cloudflared by default (free, no account required). You can also use ngrok.

## Production Webhooks

For deployed services, use the one-step setup that creates the webhook and syncs the signing secret to your environment:

\`\`\`
stripe_webhook_setup mode=live webhookUrl=https://myapp.com/api/webhooks/stripe projectName=myapp environmentName=production serviceName=api
\`\`\`

## What Each Key Is For

| Key | Prefix | Purpose |
|-----|--------|---------|
| Sandbox secret key | \`sk_test_\` | API calls in test mode |
| Live secret key | \`sk_live_\` | API calls in production |
| Sandbox publishable key | \`pk_test_\` | Client-side Stripe.js (test) |
| Live publishable key | \`pk_live_\` | Client-side Stripe.js (production) |
| Webhook signing secret | \`whsec_\` | Verify webhook payloads |`;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            instructions,
          }),
        }],
      };
    }
  );

  server.tool(
    'stripe_products_list',
    'List products in a Stripe environment (sandbox or live)',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode to list products from'),
      limit: z.number().optional().describe('Max products to return (default 100)'),
    },
    async ({ mode, limit }) => {
      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const products = await adapter.listProducts(mode as StripeMode, limit || 100);
        const prices = await adapter.listPrices(mode as StripeMode, 500);

        // Group prices by product
        const pricesByProduct = new Map<string, typeof prices>();
        for (const price of prices) {
          const productPrices = pricesByProduct.get(price.product) || [];
          productPrices.push(price);
          pricesByProduct.set(price.product, productPrices);
        }

        const productsWithPrices = products.map((product) => ({
          id: product.id,
          name: product.name,
          description: product.description,
          active: product.active,
          prices: (pricesByProduct.get(product.id) || []).map((price) => ({
            id: price.id,
            currency: price.currency,
            unit_amount: price.unit_amount,
            type: price.type,
            recurring: price.recurring,
            nickname: price.nickname,
          })),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode,
              count: products.length,
              products: productsWithPrices,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_data_diff',
    'Compare products/prices between two Stripe environments to see what would be synced',
    {
      sourceMode: z.enum(['sandbox', 'live']).describe('Source environment'),
      targetMode: z.enum(['sandbox', 'live']).describe('Target environment'),
    },
    async ({ sourceMode, targetMode }) => {
      if (sourceMode === targetMode) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Source and target modes must be different',
            }),
          }],
        };
      }

      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const sourceProducts = await adapter.listProducts(sourceMode as StripeMode);
        const targetProducts = await adapter.listProducts(targetMode as StripeMode);
        const sourcePrices = await adapter.listPrices(sourceMode as StripeMode);
        const targetPrices = await adapter.listPrices(targetMode as StripeMode);

        const targetProductIds = new Set(targetProducts.map((p) => p.id));
        const targetPriceSourceIds = new Set(
          targetPrices.filter((p) => p.metadata?._source_id).map((p) => p.metadata._source_id)
        );

        const productsToCreate = sourceProducts.filter((p) => !targetProductIds.has(p.id));
        const productsExisting = sourceProducts.filter((p) => targetProductIds.has(p.id));
        const pricesToCreate = sourcePrices.filter((p) => !targetPriceSourceIds.has(p.id));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              sourceMode,
              targetMode,
              diff: {
                products: {
                  toCreate: productsToCreate.map((p) => ({ id: p.id, name: p.name })),
                  existing: productsExisting.map((p) => ({ id: p.id, name: p.name })),
                },
                prices: {
                  toCreate: pricesToCreate.length,
                  details: pricesToCreate.slice(0, 20).map((p) => ({
                    id: p.id,
                    product: p.product,
                    amount: p.unit_amount,
                    currency: p.currency,
                  })),
                },
              },
              summary: {
                productsToSync: productsToCreate.length,
                productsExisting: productsExisting.length,
                pricesToSync: pricesToCreate.length,
              },
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_data_sync',
    'Sync products and prices from one Stripe environment to another',
    {
      sourceMode: z.enum(['sandbox', 'live']).describe('Source environment to copy from'),
      targetMode: z.enum(['sandbox', 'live']).describe('Target environment to copy to'),
      preserveIds: z.boolean().optional().describe('Try to preserve product IDs (default: true)'),
    },
    async ({ sourceMode, targetMode, preserveIds = true }) => {
      if (sourceMode === targetMode) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Source and target modes must be different',
            }),
          }],
        };
      }

      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const syncResult = await adapter.syncData(
          sourceMode as StripeMode,
          targetMode as StripeMode,
          { preserveIds }
        );

        auditRepo.create({
          action: 'stripe.data_synced',
          resourceType: 'stripe',
          resourceId: `${sourceMode}->${targetMode}`,
          details: {
            sourceMode,
            targetMode,
            productsCreated: syncResult.products.created.length,
            productsSkipped: syncResult.products.skipped.length,
            pricesCreated: syncResult.prices.created.length,
            pricesSkipped: syncResult.prices.skipped.length,
          },
        });

        const hasErrors =
          syncResult.products.errors.length > 0 || syncResult.prices.errors.length > 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: !hasErrors,
              sourceMode,
              targetMode,
              results: {
                products: {
                  created: syncResult.products.created.length,
                  skipped: syncResult.products.skipped.length,
                  errors: syncResult.products.errors,
                },
                prices: {
                  created: syncResult.prices.created.length,
                  skipped: syncResult.prices.skipped.length,
                  errors: syncResult.prices.errors,
                },
              },
              summary: hasErrors
                ? `Sync completed with errors. Created ${syncResult.products.created.length} products and ${syncResult.prices.created.length} prices.`
                : `Successfully synced ${syncResult.products.created.length} products and ${syncResult.prices.created.length} prices from ${sourceMode} to ${targetMode}.`,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  // Webhook Management Tools

  server.tool(
    'stripe_webhooks_list',
    'List all webhook endpoints configured in Stripe',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode'),
    },
    async ({ mode }) => {
      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        const webhooks = await adapter.listWebhookEndpoints(mode as StripeMode);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              mode,
              count: webhooks.length,
              webhooks: webhooks.map((w) => ({
                id: w.id,
                url: w.url,
                status: w.status,
                enabled_events: w.enabled_events,
                description: w.description,
                created: new Date(w.created * 1000).toISOString(),
              })),
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_webhook_create',
    'Create or update a webhook endpoint in Stripe. Returns the webhook signing secret on creation.',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode'),
      url: z.string().url().describe('Webhook endpoint URL (e.g., https://myapp.com/api/webhooks/stripe)'),
      events: z.array(z.string()).optional().describe('Events to listen for. If not specified, uses common SaaS events.'),
      description: z.string().optional().describe('Description for the webhook endpoint'),
    },
    async ({ mode, url, events, description }) => {
      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;
      const eventsToUse = events && events.length > 0 ? events : STRIPE_COMMON_WEBHOOK_EVENTS;

      try {
        const upsertResult = await adapter.upsertWebhookEndpoint(
          mode as StripeMode,
          url,
          eventsToUse,
          { description }
        );

        auditRepo.create({
          action: `stripe.webhook_${upsertResult.action}`,
          resourceType: 'stripe_webhook',
          resourceId: upsertResult.endpoint.id,
          details: { mode, url, events: eventsToUse },
        });

        const response: Record<string, unknown> = {
          success: true,
          action: upsertResult.action,
          mode,
          webhook: {
            id: upsertResult.endpoint.id,
            url: upsertResult.endpoint.url,
            status: upsertResult.endpoint.status,
            enabled_events: upsertResult.endpoint.enabled_events,
          },
        };

        // Include the signing secret if this was a new creation
        if (upsertResult.action === 'created' && upsertResult.secret) {
          response.signingSecret = upsertResult.secret;
          response.message = 'Webhook created. IMPORTANT: Save the signing secret - it cannot be retrieved again!';
          response.envVarSuggestion = 'STRIPE_WEBHOOK_SECRET';
        } else {
          response.message = 'Webhook updated. Signing secret unchanged.';
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_webhook_delete',
    'Delete a webhook endpoint from Stripe',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode'),
      webhookId: z.string().optional().describe('Webhook endpoint ID to delete'),
      url: z.string().url().optional().describe('Or specify the webhook URL to find and delete'),
    },
    async ({ mode, webhookId, url }) => {
      if (!webhookId && !url) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Provide either webhookId or url',
            }),
          }],
        };
      }

      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        let idToDelete = webhookId;

        if (!idToDelete && url) {
          const webhook = await adapter.findWebhookByUrl(mode as StripeMode, url);
          if (!webhook) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `No webhook found with URL: ${url}`,
                }),
              }],
            };
          }
          idToDelete = webhook.id;
        }

        const deleteResult = await adapter.deleteWebhookEndpoint(mode as StripeMode, idToDelete!);

        auditRepo.create({
          action: 'stripe.webhook_deleted',
          resourceType: 'stripe_webhook',
          resourceId: idToDelete!,
          details: { mode, url },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              deleted: deleteResult.deleted,
              webhookId: deleteResult.id,
              message: `Webhook ${deleteResult.id} deleted from ${mode}`,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_webhook_events',
    'List common webhook events that can be subscribed to',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            commonEvents: STRIPE_COMMON_WEBHOOK_EVENTS,
            description: 'These are the most common events for SaaS applications. You can also use specific events like "product.created" or wildcards like "customer.*".',
            documentation: 'https://stripe.com/docs/api/events/types',
          }),
        }],
      };
    }
  );

  server.tool(
    'stripe_sandbox_clear',
    'Clear all customer records from Stripe sandbox. Two-step: preview first, then confirm to delete.',
    {
      confirm: z.boolean().optional().describe('Set to true to actually delete customers. Omit or false to preview.'),
    },
    async ({ confirm }) => {
      const result = getStripeAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter } = result;

      try {
        if (!confirm) {
          // Preview mode: list customers
          const customers = await adapter.listCustomers('sandbox');

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                mode: 'sandbox',
                preview: true,
                count: customers.length,
                customers: customers.map((c: StripeCustomer) => ({
                  id: c.id,
                  name: c.name,
                  email: c.email,
                  created: new Date(c.created * 1000).toISOString(),
                })),
                message: customers.length === 0
                  ? 'No customers found in sandbox.'
                  : `Found ${customers.length} customer(s) in sandbox. Call again with confirm=true to delete them all.`,
              }),
            }],
          };
        }

        // Confirm mode: delete all customers
        const clearResult = await adapter.clearCustomers('sandbox');

        auditRepo.create({
          action: 'stripe.sandbox_customers_cleared',
          resourceType: 'stripe',
          resourceId: 'sandbox',
          details: {
            deleted: clearResult.deleted,
            errors: clearResult.errors.length,
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: clearResult.errors.length === 0,
              mode: 'sandbox',
              deleted: clearResult.deleted,
              errors: clearResult.errors,
              message: clearResult.errors.length === 0
                ? `Deleted ${clearResult.deleted} customer(s) from sandbox.`
                : `Deleted ${clearResult.deleted} customer(s) with ${clearResult.errors.length} error(s).`,
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );

  server.tool(
    'stripe_webhook_setup',
    'Create a Stripe webhook and sync the signing secret to the current hosting provider in one step',
    {
      mode: z.enum(['sandbox', 'live']).describe('Stripe mode (sandbox or live)'),
      webhookUrl: z.string().url().describe('Webhook endpoint URL (e.g., https://myapp.railway.app/api/webhooks/stripe)'),
      projectName: z.string().describe('Hypervibe project name'),
      environmentName: z.string().describe('Environment to sync the webhook secret to'),
      serviceName: z.string().describe('Service to set the STRIPE_WEBHOOK_SECRET on'),
      events: z.array(z.string()).optional().describe('Events to listen for (defaults to common SaaS events)'),
      secretEnvVar: z.string().optional().describe('Env var name for the secret (default: STRIPE_WEBHOOK_SECRET)'),
    },
    async ({ mode, webhookUrl, projectName, environmentName, serviceName, events, secretEnvVar = 'STRIPE_WEBHOOK_SECRET' }) => {
      // Get Stripe adapter
      const stripeResult = getStripeAdapter();
      if ('error' in stripeResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: stripeResult.error }),
          }],
        };
      }

      // Find project and environment
      const project = resolveProject({ projectName });
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const service = serviceRepo.findByProjectAndName(project.id, serviceName);
      if (!service) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service not found: ${serviceName}` }),
          }],
        };
      }

      const { adapter: stripeAdapter } = stripeResult;
      const eventsToUse = events && events.length > 0 ? events : STRIPE_COMMON_WEBHOOK_EVENTS;

      try {
        // Step 1: Create or update webhook in Stripe
        const webhookResult = await stripeAdapter.upsertWebhookEndpoint(
          mode as StripeMode,
          webhookUrl,
          eventsToUse,
          { description: `${projectName} - ${environmentName}` }
        );

        const response: Record<string, unknown> = {
          success: true,
          webhook: {
            id: webhookResult.endpoint.id,
            url: webhookResult.endpoint.url,
            action: webhookResult.action,
            events: webhookResult.endpoint.enabled_events,
          },
        };

        // Step 2: If created (has secret), sync to the current hosting provider.
        if (webhookResult.action === 'created' && webhookResult.secret) {
          const envVars = { [secretEnvVar]: webhookResult.secret };
          const syncResult = await syncHostingEnvVars({
            project,
            environment,
            service,
            vars: envVars,
          });

          if (syncResult.success) {
            response.secretSynced = true;
            response.envVar = secretEnvVar;
            response.environment = environmentName;
            response.hostingProvider = syncResult.provider;
            response.message = `Webhook created and ${secretEnvVar} synced to ${serviceName} in ${environmentName}${syncResult.provider ? ` on ${providerDisplayName(syncResult.provider)}` : ''}`;

            auditRepo.create({
              action: 'stripe.webhook_setup',
              resourceType: 'stripe_webhook',
              resourceId: webhookResult.endpoint.id,
              details: {
                mode,
                url: webhookUrl,
                environment: environmentName,
                service: serviceName,
                envVar: secretEnvVar,
              },
            });
          } else {
            response.secretSynced = false;
            response.hostingProvider = syncResult.provider;
            response.syncError = syncResult.error || syncResult.message;
            response.signingSecret = webhookResult.secret;
            response.message = `Webhook created but failed to sync secret: ${syncResult.error || syncResult.message}. Secret included in response - set ${secretEnvVar} manually.`;
          }
        } else if (webhookResult.action === 'updated') {
          response.secretSynced = false;
          response.message = `Webhook updated. Signing secret unchanged - if you need to update it, delete and recreate the webhook.`;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
        };
      }
    }
  );
}
