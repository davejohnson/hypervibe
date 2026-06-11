import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { STRIPE_COMMON_WEBHOOK_EVENTS } from '../adapters/providers/stripe/stripe.adapter.js';
import type { StripeAdapter, StripeMode } from '../adapters/providers/stripe/stripe.adapter.js';
import { providerDisplayName, syncHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { getStripeAdapter } from '../domain/services/stripe-ops.service.js';
import type { ToolContext } from './context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

const modeField = z
  .enum(['sandbox', 'live'])
  .optional()
  .describe('Stripe mode. Defaults to "live" when env is "production", otherwise "sandbox".');

function resolveMode(mode: StripeMode | undefined, env: string | undefined): StripeMode {
  if (mode) return mode;
  return env?.trim().toLowerCase() === 'production' ? 'live' : 'sandbox';
}

function summarizeWebhook(w: { id: string; url: string; status: string; enabled_events: string[]; description?: string }) {
  return { id: w.id, url: w.url, status: w.status, enabledEvents: w.enabled_events, description: w.description };
}

/** Compute which products/prices exist in source but not in target. */
async function computeStripeDiff(adapter: StripeAdapter, sourceMode: StripeMode, targetMode: StripeMode) {
  const [sourceProducts, targetProducts, sourcePrices, targetPrices] = await Promise.all([
    adapter.listProducts(sourceMode),
    adapter.listProducts(targetMode),
    adapter.listPrices(sourceMode),
    adapter.listPrices(targetMode),
  ]);
  const targetProductIds = new Set(targetProducts.map((p) => p.id));
  const targetPriceSourceIds = new Set(
    targetPrices.filter((p) => p.metadata?._source_id).map((p) => p.metadata._source_id)
  );
  const productsToCreate = sourceProducts.filter((p) => !targetProductIds.has(p.id));
  const productsExisting = sourceProducts.filter((p) => targetProductIds.has(p.id));
  const pricesToCreate = sourcePrices.filter((p) => !targetPriceSourceIds.has(p.id));
  return {
    products: {
      toCreate: productsToCreate.map((p) => ({ id: p.id, name: p.name })),
      existing: productsExisting.map((p) => ({ id: p.id, name: p.name })),
    },
    prices: {
      toCreate: pricesToCreate.length,
      details: pricesToCreate.slice(0, 20).map((p) => ({ id: p.id, product: p.product, amount: p.unit_amount, currency: p.currency })),
    },
    summary: {
      productsToSync: productsToCreate.length,
      productsExisting: productsExisting.length,
      pricesToSync: pricesToCreate.length,
    },
  };
}

export function registerHvPaymentsTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_payments_setup',
    'Set up and manage Stripe webhooks. Default action "setup" creates (or updates) a webhook endpoint and syncs the signing secret to the hosting provider as STRIPE_WEBHOOK_SECRET. Other actions: webhooks-list, webhook-delete.',
    {
      project: projectField,
      env: envField,
      action: z.enum(['setup', 'webhooks-list', 'webhook-delete']).optional().describe('Defaults to "setup".'),
      webhookId: z.string().optional().describe('Webhook endpoint id to delete (webhook-delete)'),
      url: z.string().optional().describe('Webhook endpoint URL. Required for setup; for webhook-delete it can be used instead of webhookId.'),
      mode: modeField,
      service: z.string().optional().describe('Service to set STRIPE_WEBHOOK_SECRET on (setup). Defaults to the first service in the project.'),
    },
    wrapHandler(async ({ project: projectRef, env, action = 'setup', webhookId, url, mode, service: serviceName }) => {
      const stripeResult = getStripeAdapter();
      if ('error' in stripeResult) {
        return toolError('MISSING_CONNECTION', stripeResult.error);
      }
      const { adapter } = stripeResult;
      const stripeMode = resolveMode(mode, env);

      switch (action) {
        case 'webhooks-list': {
          const webhooks = await adapter.listWebhookEndpoints(stripeMode);
          return toolSuccess({ mode: stripeMode, count: webhooks.length, webhooks: webhooks.map(summarizeWebhook) });
        }
        case 'webhook-delete': {
          if (!webhookId && !url) {
            throw new HvError('VALIDATION', 'webhook-delete requires webhookId or url.');
          }
          let idToDelete = webhookId;
          if (!idToDelete && url) {
            const found = await adapter.findWebhookByUrl(stripeMode, url);
            if (!found) {
              return toolError('NOT_FOUND', `No webhook found with URL ${url} in ${stripeMode}.`);
            }
            idToDelete = found.id;
          }
          const deleted = await adapter.deleteWebhookEndpoint(stripeMode, idToDelete!);
          ctx.repos.audit.create({
            action: 'stripe.webhook_deleted',
            resourceType: 'stripe_webhook',
            resourceId: idToDelete!,
            details: { mode: stripeMode, url },
          });
          return toolSuccess({ mode: stripeMode, webhookId: deleted.id, deleted: deleted.deleted });
        }
        case 'setup': {
          if (!url) {
            throw new HvError('VALIDATION', 'url is required for action "setup".', {
              hint: 'Pass the webhook endpoint URL, e.g. https://myapp.com/api/webhooks/stripe.',
            });
          }
          const project = ctx.resolveProjectOrThrow({ project: projectRef });
          const environment = ctx.resolveEnvironmentOrThrow(project, env);
          const services = ctx.repos.services.findByProjectId(project.id);
          const service = serviceName ? services.find((s) => s.name === serviceName) : services[0];
          if (!service) {
            return toolError(
              'NOT_FOUND',
              serviceName
                ? `Service "${serviceName}" not found in project "${project.name}".`
                : `Project "${project.name}" has no services to sync the webhook secret to.`
            );
          }

          const upsert = await adapter.upsertWebhookEndpoint(stripeMode, url, STRIPE_COMMON_WEBHOOK_EVENTS, {
            description: `${project.name} - ${environment.name}`,
          });

          const data: Record<string, unknown> = {
            mode: stripeMode,
            environment: environment.name,
            webhook: {
              id: upsert.endpoint.id,
              url: upsert.endpoint.url,
              action: upsert.action,
              events: upsert.endpoint.enabled_events,
            },
            secretSynced: false,
          };
          const warnings: string[] = [];
          let hint: string;

          if (upsert.action === 'created' && upsert.secret) {
            const sync = await syncHostingEnvVars({
              project,
              environment,
              service,
              vars: { STRIPE_WEBHOOK_SECRET: upsert.secret },
            });
            data.envVar = 'STRIPE_WEBHOOK_SECRET';
            data.hostingProvider = sync.provider;
            if (sync.success) {
              data.secretSynced = true;
              hint = `Webhook created and STRIPE_WEBHOOK_SECRET synced to ${service.name} in ${environment.name}${sync.provider ? ` on ${providerDisplayName(sync.provider)}` : ''}.`;
            } else {
              data.signingSecret = upsert.secret;
              warnings.push(`Failed to sync the signing secret: ${sync.error || sync.message}`);
              hint = 'The signing secret is included in the response — set STRIPE_WEBHOOK_SECRET on the service manually.';
            }
          } else {
            hint = 'Webhook already existed; the signing secret is unchanged. Delete it (action="webhook-delete") and re-run setup to rotate the secret.';
          }

          ctx.repos.audit.create({
            action: 'hv.payments_setup',
            resourceType: 'stripe_webhook',
            resourceId: upsert.endpoint.id,
            details: {
              mode: stripeMode,
              url,
              project: project.name,
              environment: environment.name,
              service: service.name,
              secretSynced: data.secretSynced,
            },
          });

          return toolSuccess(data, { warnings, hint });
        }
      }
    })
  );

  server.tool(
    'hv_stripe_sync',
    'Sync or compare Stripe data between modes, list products, or clear sandbox customers. Actions: sync (sandbox→live by default; dryRun previews the diff), diff, products, clear-sandbox (requires confirm=true).',
    {
      project: projectField,
      action: z.enum(['sync', 'diff', 'products', 'clear-sandbox']).optional().describe('Defaults to "sync".'),
      sourceMode: z.enum(['sandbox', 'live']).optional().describe('Source mode for sync/diff/products (default "sandbox")'),
      targetMode: z.enum(['sandbox', 'live']).optional().describe('Target mode for sync/diff (default "live")'),
      dryRun: z.boolean().optional().describe('For sync: preview the diff without writing anything.'),
      confirm: confirmField,
    },
    wrapHandler(async ({ project: projectRef, action = 'sync', sourceMode = 'sandbox', targetMode = 'live', dryRun, confirm }) => {
      const stripeResult = getStripeAdapter();
      if ('error' in stripeResult) {
        return toolError('MISSING_CONNECTION', stripeResult.error);
      }
      const { adapter } = stripeResult;
      const project = ctx.resolveProject({ project: projectRef });

      switch (action) {
        case 'diff':
        case 'sync': {
          if (sourceMode === targetMode) {
            throw new HvError('VALIDATION', 'sourceMode and targetMode must be different.');
          }
          if (action === 'diff' || dryRun) {
            const diff = await computeStripeDiff(adapter, sourceMode, targetMode);
            return toolSuccess(
              { sourceMode, targetMode, dryRun: action === 'sync' ? true : undefined, diff },
              {
                hint: diff.summary.productsToSync === 0 && diff.summary.pricesToSync === 0
                  ? `${targetMode} already has everything from ${sourceMode}.`
                  : `Run hv_stripe_sync with action="sync" (no dryRun) to copy ${diff.summary.productsToSync} product(s) and ${diff.summary.pricesToSync} price(s).`,
              }
            );
          }

          const result = await adapter.syncData(sourceMode, targetMode, { preserveIds: true });
          ctx.repos.audit.create({
            action: 'stripe.data_synced',
            resourceType: 'stripe',
            resourceId: `${sourceMode}->${targetMode}`,
            details: {
              project: project?.name,
              sourceMode,
              targetMode,
              productsCreated: result.products.created.length,
              productsSkipped: result.products.skipped.length,
              pricesCreated: result.prices.created.length,
              pricesSkipped: result.prices.skipped.length,
            },
          });

          const data = {
            sourceMode,
            targetMode,
            products: { created: result.products.created.length, skipped: result.products.skipped.length, errors: result.products.errors },
            prices: { created: result.prices.created.length, skipped: result.prices.skipped.length, errors: result.prices.errors },
          };
          const hasErrors = result.products.errors.length > 0 || result.prices.errors.length > 0;
          if (hasErrors) {
            return toolError('PROVIDER_ERROR', 'Sync completed with errors.', { details: data });
          }
          return toolSuccess(data, {
            hint: `Synced ${result.products.created.length} product(s) and ${result.prices.created.length} price(s) from ${sourceMode} to ${targetMode}.`,
          });
        }
        case 'products': {
          const [products, prices] = await Promise.all([
            adapter.listProducts(sourceMode),
            adapter.listPrices(sourceMode, 500),
          ]);
          const pricesByProduct = new Map<string, typeof prices>();
          for (const price of prices) {
            pricesByProduct.set(price.product, [...(pricesByProduct.get(price.product) ?? []), price]);
          }
          return toolSuccess({
            mode: sourceMode,
            count: products.length,
            products: products.map((product) => ({
              id: product.id,
              name: product.name,
              description: product.description,
              active: product.active,
              prices: (pricesByProduct.get(product.id) ?? []).map((price) => ({
                id: price.id,
                currency: price.currency,
                unitAmount: price.unit_amount,
                type: price.type,
                recurring: price.recurring,
                nickname: price.nickname,
              })),
            })),
          });
        }
        case 'clear-sandbox': {
          if (!confirm) {
            const customers = await adapter.listCustomers('sandbox');
            return toolError('CONFIRM_REQUIRED', `This deletes all ${customers.length} customer(s) from the Stripe sandbox.`, {
              details: {
                count: customers.length,
                customers: customers.map((c) => ({ id: c.id, name: c.name, email: c.email })),
              },
              hint: customers.length === 0
                ? 'No customers found in sandbox; nothing to delete.'
                : 'Re-run with confirm=true to delete them all.',
            });
          }

          const result = await adapter.clearCustomers('sandbox');
          ctx.repos.audit.create({
            action: 'stripe.sandbox_customers_cleared',
            resourceType: 'stripe',
            resourceId: 'sandbox',
            details: { project: project?.name, deleted: result.deleted, errors: result.errors.length },
          });
          if (result.errors.length > 0) {
            return toolError('PROVIDER_ERROR', `Deleted ${result.deleted} customer(s) with ${result.errors.length} error(s).`, {
              details: { deleted: result.deleted, errors: result.errors },
            });
          }
          return toolSuccess({ deleted: result.deleted }, { hint: `Deleted ${result.deleted} customer(s) from sandbox.` });
        }
      }
    })
  );
}
