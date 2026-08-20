import type {
  StripeAdapter,
  StripePrice,
  StripeProduct,
  StripeWebhookEndpoint,
} from '../../adapters/providers/stripe/stripe.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { Service } from '../entities/service.entity.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type {
  EnvironmentSpec,
  StripeCatalogPriceSpec,
  StripeCatalogProductSpec,
  StripeEnvironmentSyncSpec,
  StripeWebhookSpec,
} from '../spec/spec.schema.js';
import { removeHostingEnvVars, syncHostingEnvVars } from './hosting-env.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { getStripeAdapter } from './stripe-ops.service.js';

export const STRIPE_HOSTING_ENV_SYNC_OPERATION = 'stripeHostingEnvSync';
export const STRIPE_CATALOG_OPERATIONS = {
  productEnsure: 'stripeCatalogProductEnsure',
  productAdopt: 'stripeCatalogProductAdopt',
  productArchive: 'stripeCatalogProductArchive',
  priceEnsure: 'stripeCatalogPriceEnsure',
  priceAdopt: 'stripeCatalogPriceAdopt',
  priceArchive: 'stripeCatalogPriceArchive',
} as const;
export const STRIPE_WEBHOOK_OPERATIONS = {
  ensure: 'stripeWebhookEnsure',
  adopt: 'stripeWebhookAdopt',
  destroy: 'stripeWebhookDestroy',
} as const;

const STRIPE_WEBHOOK_OPERATION_SET = new Set<string>(Object.values(STRIPE_WEBHOOK_OPERATIONS));
const STRIPE_CATALOG_OPERATION_SET = new Set<string>(Object.values(STRIPE_CATALOG_OPERATIONS));
const environmentRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();

export interface StripeWebhookBinding {
  endpointId: string;
  url: string;
  events: string[];
  service: string;
  envVar: string;
  valueHash?: string;
  updatedAt?: string;
}

export interface StripeBindings {
  environment?: string;
  catalog: {
    products: Record<string, StripeCatalogProductBinding>;
  };
  webhooks: Record<string, StripeWebhookBinding>;
}

export interface StripeCatalogPriceBinding {
  priceId: string;
  envVar: string;
  unitAmount: number;
  currency: string;
  interval: 'month' | 'year';
  updatedAt?: string;
}

export interface StripeCatalogProductBinding {
  productId: string;
  name: string;
  taxCode?: string;
  prices: Record<string, StripeCatalogPriceBinding>;
  updatedAt?: string;
}

export type StripeEnvironmentResolution =
  | {
    success: true;
    stripeEnvironment: string;
    mode: 'sandbox' | 'live';
    values: Record<string, string>;
  }
  | {
    success: false;
    stripeEnvironment: string;
    error: string;
  };

export type StripeIntegrationResolution =
  | {
    success: true;
    stripeEnvironment: string;
    mode: 'sandbox' | 'live';
    values: Record<string, string>;
    products: StripeProduct[];
    prices: StripePrice[];
    webhookEndpoints: StripeWebhookEndpoint[];
  }
  | {
    success: false;
    stripeEnvironment: string;
    error: string;
  };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

export function parseStripeBindings(
  environment: Pick<Environment, 'platformBindings'> | null
): StripeBindings {
  const payments = asRecord(environment?.platformBindings.payments);
  const stripe = asRecord(payments?.stripe);
  const rawCatalog = asRecord(stripe?.catalog);
  const rawProducts = asRecord(rawCatalog?.products);
  const products: Record<string, StripeCatalogProductBinding> = {};
  for (const [productKey, value] of Object.entries(rawProducts ?? {})) {
    const record = asRecord(value);
    const rawPrices = asRecord(record?.prices);
    if (!record || typeof record.productId !== 'string' || typeof record.name !== 'string') continue;
    const prices: Record<string, StripeCatalogPriceBinding> = {};
    for (const [priceKey, rawPrice] of Object.entries(rawPrices ?? {})) {
      const price = asRecord(rawPrice);
      if (
        !price
        || typeof price.priceId !== 'string'
        || typeof price.envVar !== 'string'
        || typeof price.unitAmount !== 'number'
        || typeof price.currency !== 'string'
        || (price.interval !== 'month' && price.interval !== 'year')
      ) {
        continue;
      }
      prices[priceKey] = {
        priceId: price.priceId,
        envVar: price.envVar,
        unitAmount: price.unitAmount,
        currency: price.currency,
        interval: price.interval,
        ...(typeof price.updatedAt === 'string' ? { updatedAt: price.updatedAt } : {}),
      };
    }
    products[productKey] = {
      productId: record.productId,
      name: record.name,
      ...(typeof record.taxCode === 'string' ? { taxCode: record.taxCode } : {}),
      prices,
      ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    };
  }
  const rawWebhooks = asRecord(stripe?.webhooks);
  const webhooks: Record<string, StripeWebhookBinding> = {};
  for (const [name, value] of Object.entries(rawWebhooks ?? {})) {
    const record = asRecord(value);
    const events = stringArray(record?.events);
    if (
      !record
      || typeof record.endpointId !== 'string'
      || typeof record.url !== 'string'
      || !events
      || typeof record.service !== 'string'
      || typeof record.envVar !== 'string'
      || (record.valueHash !== undefined && typeof record.valueHash !== 'string')
    ) {
      continue;
    }
    webhooks[name] = {
      endpointId: record.endpointId,
      url: record.url,
      events,
      service: record.service,
      envVar: record.envVar,
      ...(typeof record.valueHash === 'string' ? { valueHash: record.valueHash } : {}),
      ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    };
  }
  return {
    ...(typeof stripe?.environment === 'string' ? { environment: stripe.environment } : {}),
    catalog: { products },
    webhooks,
  };
}

function persistStripeBindings(
  environment: Environment,
  stripeEnvironment: string,
  bindings: Pick<StripeBindings, 'catalog' | 'webhooks'>
): void {
  const payments = asRecord(environment.platformBindings.payments) ?? {};
  const stripe = asRecord(payments.stripe) ?? {};
  environmentRepo.updatePlatformBindings(environment.id, {
    payments: {
      ...payments,
      stripe: {
        ...stripe,
        environment: stripeEnvironment,
        catalog: bindings.catalog,
        webhooks: bindings.webhooks,
      },
    },
  });
}

function persistStripeWebhookBindings(
  environment: Environment,
  stripeEnvironment: string,
  webhooks: Record<string, StripeWebhookBinding>
): void {
  const current = parseStripeBindings(environment);
  persistStripeBindings(environment, stripeEnvironment, {
    catalog: current.catalog,
    webhooks,
  });
}

function persistStripeCatalogBindings(
  environment: Environment,
  stripeEnvironment: string,
  catalog: StripeBindings['catalog']
): void {
  const current = parseStripeBindings(environment);
  persistStripeBindings(environment, stripeEnvironment, {
    catalog,
    webhooks: current.webhooks,
  });
}

export function stripeResolutionFingerprint(
  resolution: Extract<StripeEnvironmentResolution, { success: true }>
): string {
  const valueHashes = Object.fromEntries(
    Object.keys(resolution.values)
      .sort()
      .map((key) => [key, hashEnvValue(resolution.values[key])])
  );
  return hashEnvValue(JSON.stringify({
    stripeEnvironment: resolution.stripeEnvironment,
    mode: resolution.mode,
    valueHashes,
  }));
}

export function stripeIntegrationFingerprint(
  resolution: Extract<StripeIntegrationResolution, { success: true }>
): string {
  const products = [...resolution.products]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      taxCode: product.tax_code ?? null,
      active: product.active,
      metadata: product.metadata,
    }));
  const prices = [...resolution.prices]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((price) => ({
      id: price.id,
      product: price.product,
      active: price.active,
      currency: price.currency,
      unitAmount: price.unit_amount,
      interval: price.recurring?.interval ?? null,
      metadata: price.metadata,
    }));
  const endpoints = [...resolution.webhookEndpoints]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      status: endpoint.status,
      events: [...endpoint.enabled_events].sort(),
    }));
  return hashEnvValue(JSON.stringify({
    runtime: stripeResolutionFingerprint(resolution),
    products,
    prices,
    endpoints,
  }));
}

export function stripeEnvironmentName(
  environmentName: string,
  spec: StripeEnvironmentSyncSpec
): string {
  return spec.environment?.trim() || environmentName;
}

export function stripeTargetServiceNames(environmentSpec: EnvironmentSpec): string[] {
  const stripe = environmentSpec.payments?.stripe;
  if (!stripe) return [];
  if (stripeRuntimeEnvKeys(environmentSpec).length === 0) return [];
  return [...(stripe.services ?? Object.keys(environmentSpec.services))].sort();
}

export function stripeRuntimeEnvKeys(environmentSpec: EnvironmentSpec): string[] {
  const stripe = environmentSpec.payments?.stripe;
  if (!stripe) return [];
  const catalogKeys = Object.values(stripe.catalog?.products ?? {})
    .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
  return [
    ...catalogKeys,
    ...(stripe.credentials
      ? [
        stripe.credentials.secretKeyEnvVar,
        ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
      ]
      : []),
  ].sort();
}

export function stripeManagedEnvKeys(environmentSpec: EnvironmentSpec): string[] {
  const stripe = environmentSpec.payments?.stripe;
  if (!stripe) return [];
  return [...new Set([
    ...stripeRuntimeEnvKeys(environmentSpec),
    ...Object.values(stripe.webhooks).map((webhook) => webhook.envVar),
  ])].sort();
}

function resolveStripeCatalogEnvValues(
  catalog: StripeEnvironmentSyncSpec['catalog'],
  bindings: StripeBindings,
  products: StripeProduct[],
  prices: StripePrice[]
): Record<string, string> {
  const values: Record<string, string> = {};
  const productById = new Map(products.map((product) => [product.id, product]));
  const priceById = new Map(prices.map((price) => [price.id, price]));
  for (const [productKey, productSpec] of Object.entries(catalog?.products ?? {})) {
    const productBinding = bindings.catalog.products[productKey];
    const product = productBinding ? productById.get(productBinding.productId) : undefined;
    if (!product?.active) continue;
    for (const [priceKey, priceSpec] of Object.entries(productSpec.prices)) {
      const priceBinding = productBinding.prices[priceKey];
      const price = priceBinding ? priceById.get(priceBinding.priceId) : undefined;
      if (
        price?.active
        && price.product === product.id
        && price.currency.toLowerCase() === priceSpec.currency
        && price.unit_amount === priceSpec.unitAmount
        && price.recurring?.interval === priceSpec.interval
      ) {
        values[priceSpec.envVar] = price.id;
      }
    }
  }
  return values;
}

export async function resolveStripeEnvironmentValues(params: {
  environmentName: string;
  spec: StripeEnvironmentSyncSpec;
  environment?: Pick<Environment, 'platformBindings'> | null;
  observedCatalog?: { products: StripeProduct[]; prices: StripePrice[] };
  verifiedConnection?: boolean;
}): Promise<StripeEnvironmentResolution> {
  const target = stripeEnvironmentName(params.environmentName, params.spec);
  const stripe = getStripeAdapter(target, { verifiedOnly: params.verifiedConnection === true });
  if ('error' in stripe) {
    return { success: false, stripeEnvironment: target, error: stripe.error };
  }

  try {
    const values: Record<string, string> = {};
    if (params.spec.credentials) {
      const credentials = stripe.adapter.getRuntimeCredentials(stripe.mode);
      values[params.spec.credentials.secretKeyEnvVar] = credentials.secretKey;
      if (params.spec.credentials.publishableKeyEnvVar) {
        if (!credentials.publishableKey) {
          return {
            success: false,
            stripeEnvironment: target,
            error: `Stripe connection scope "${target}" does not include publishableKey required for ${params.spec.credentials.publishableKeyEnvVar}. ${formatConnectionGuidance('stripe', { scope: target })}`,
          };
        }
        values[params.spec.credentials.publishableKeyEnvVar] = credentials.publishableKey;
      }
    }

    if (params.spec.catalog) {
      const observedCatalog = params.observedCatalog ?? {
        products: await stripe.adapter.listProducts(stripe.mode, 100, true),
        prices: await stripe.adapter.listPrices(stripe.mode, 100, true),
      };
      Object.assign(values, resolveStripeCatalogEnvValues(
        params.spec.catalog,
        parseStripeBindings(params.environment ?? null),
        observedCatalog.products,
        observedCatalog.prices
      ));
    }

    return {
      success: true,
      stripeEnvironment: target,
      mode: stripe.mode,
      values,
    };
  } catch (error) {
    return {
      success: false,
      stripeEnvironment: target,
      error: `Failed to observe Stripe environment "${target}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function resolveStripeIntegrationState(params: {
  environmentName: string;
  spec?: StripeEnvironmentSyncSpec;
  environment: Pick<Environment, 'platformBindings'> | null;
  verifiedConnection?: boolean;
}): Promise<StripeIntegrationResolution> {
  const bindings = parseStripeBindings(params.environment);
  const target = params.spec
    ? stripeEnvironmentName(params.environmentName, params.spec)
    : bindings.environment?.trim() || params.environmentName;
  const stripe = getStripeAdapter(target, {
    verifiedOnly: params.verifiedConnection === true,
  });
  if ('error' in stripe) {
    return { success: false, stripeEnvironment: target, error: stripe.error };
  }

  const desiredUrls = new Set(
    Object.values(params.spec?.webhooks ?? {}).map((webhook) => webhook.url)
  );
  const boundIds = new Set(
    Object.values(bindings.webhooks).map((binding) => binding.endpointId)
  );
  const needsWebhookObservation = desiredUrls.size > 0 || boundIds.size > 0;
  try {
    const needsCatalogObservation = Boolean(params.spec?.catalog)
      || Object.keys(bindings.catalog.products).length > 0;
    const [products, prices, webhookEndpoints] = await Promise.all([
      needsCatalogObservation
        ? stripe.adapter.listProducts(stripe.mode, 100, true)
        : Promise.resolve([]),
      needsCatalogObservation
        ? stripe.adapter.listPrices(stripe.mode, 100, true)
        : Promise.resolve([]),
      needsWebhookObservation
        ? stripe.adapter.listWebhookEndpoints(stripe.mode)
        : Promise.resolve([]),
    ]);
    const runtime = params.spec
      ? await resolveStripeEnvironmentValues({
        environmentName: params.environmentName,
        spec: params.spec,
        environment: params.environment,
        observedCatalog: { products, prices },
        verifiedConnection: params.verifiedConnection,
      })
      : null;
    if (runtime && !runtime.success) return runtime;
    return {
      success: true,
      stripeEnvironment: target,
      mode: runtime?.mode ?? stripe.mode,
      values: runtime?.values ?? {},
      products,
      prices,
      webhookEndpoints: webhookEndpoints
        .filter((endpoint) => boundIds.has(endpoint.id) || desiredUrls.has(endpoint.url)),
    };
  } catch (error) {
    return {
      success: false,
      stripeEnvironment: target,
      error: `Failed to observe Stripe environment "${target}" webhooks: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizedEvents(events: string[]): string[] {
  return [...events].sort();
}

function webhookConfigMatches(endpoint: StripeWebhookEndpoint, spec: StripeWebhookSpec): boolean {
  const actual = normalizedEvents(endpoint.enabled_events);
  const desired = normalizedEvents(spec.events);
  return endpoint.url === spec.url
    && endpoint.status === 'enabled'
    && actual.length === desired.length
    && actual.every((event, index) => event === desired[index]);
}

function stripeWebhookAction(params: {
  stripeEnvironment: string;
  name: string;
  type: PlanAction['type'];
  operation: string;
  reason: string;
  verified: boolean;
  spec?: StripeWebhookSpec;
  endpointId?: string;
  valueHash?: string;
  blockedReason?: string;
  requiresConfirm?: boolean;
}): PlanAction {
  return {
    id: `payment:stripe:${params.stripeEnvironment}:webhook:${params.name}`,
    type: params.type,
    resource: { kind: 'payment', name: params.name, provider: 'stripe' },
    verified: params.verified,
    reason: params.reason,
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    ...(params.spec ? { dependsOn: [`service:${params.spec.service}`] } : {}),
    metadata: {
      operation: params.operation,
      stripeEnvironment: params.stripeEnvironment,
      webhookName: params.name,
      ...(params.spec
        ? {
          url: params.spec.url,
          events: normalizedEvents(params.spec.events),
          service: params.spec.service,
          envVar: params.spec.envVar,
        }
        : {}),
      ...(params.endpointId ? { endpointId: params.endpointId } : {}),
      ...(params.valueHash ? { valueHash: params.valueHash } : {}),
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    },
  };
}

function blockedStripeWebhookActions(params: {
  stripeEnvironment: string;
  desired: Record<string, StripeWebhookSpec>;
  bindings: Record<string, StripeWebhookBinding>;
  reason: string;
}): PlanAction[] {
  const names = new Set([
    ...Object.keys(params.desired),
    ...Object.keys(params.bindings),
  ]);
  return [...names].sort().map((name) => stripeWebhookAction({
    stripeEnvironment: params.stripeEnvironment,
    name,
    type: 'update',
    operation: params.desired[name]
      ? STRIPE_WEBHOOK_OPERATIONS.ensure
      : STRIPE_WEBHOOK_OPERATIONS.destroy,
    reason: `Stripe webhook "${name}" could not be observed; preserving its current state`,
    verified: false,
    spec: params.desired[name],
    endpointId: params.bindings[name]?.endpointId,
    blockedReason: params.reason,
  }));
}

function planStripeWebhookActions(params: {
  stripeEnvironment: string;
  desired: Record<string, StripeWebhookSpec>;
  bindings: Record<string, StripeWebhookBinding>;
  endpoints: StripeWebhookEndpoint[];
  observed: ObservedState | null;
}): { actions: PlanAction[]; warnings: string[] } {
  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const endpointById = new Map(params.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const hostingObservationKnown = params.observed !== null
    && params.observed.completeness?.services !== 'unknown';
  const observedServices = new Map(
    (params.observed?.services ?? []).map((service) => [service.name, service])
  );

  for (const [name, spec] of Object.entries(params.desired).sort(([a], [b]) => a.localeCompare(b))) {
    const binding = params.bindings[name];
    const liveHash = observedServices.get(spec.service)?.envVarHashes[spec.envVar];
    if (binding) {
      if (binding.service !== spec.service || binding.envVar !== spec.envVar) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'update',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: `Stripe webhook "${name}" changes its signing-value destination`,
          verified: true,
          spec,
          endpointId: binding.endpointId,
          blockedReason: 'Remove this webhook from the spec and apply its confirmed destroy before re-adding it with a different service or envVar.',
        }));
        continue;
      }

      const endpoint = endpointById.get(binding.endpointId);
      const competingEndpoints = params.endpoints.filter((candidate) =>
        candidate.id !== binding.endpointId && candidate.url === spec.url
      );
      if (competingEndpoints.length > 0) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'update',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: `Stripe webhook "${name}" has competing endpoints at its desired URL`,
          verified: true,
          spec,
          endpointId: binding.endpointId,
          blockedReason: 'Multiple provider identities match the desired URL. Remove the unmanaged duplicates explicitly before convergence.',
        }));
        warnings.push(`Stripe webhook "${name}" is bound to ${binding.endpointId}, but ${competingEndpoints.length} additional endpoint(s) use ${spec.url}.`);
        continue;
      }
      if (!endpoint) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'replace',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: `Bound Stripe webhook "${name}" is absent; recreate it and rotate its signing value`,
          verified: true,
          spec,
          endpointId: binding.endpointId,
          requiresConfirm: true,
        }));
        continue;
      }

      const configMatches = webhookConfigMatches(endpoint, spec);
      if (!hostingObservationKnown) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: configMatches ? 'noop' : 'update',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: configMatches
            ? `Preserving Stripe webhook "${name}" because hosting signing-value observation is unknown`
            : `Update Stripe webhook "${name}" configuration; preserve its existing signing value because hosting observation is unknown`,
          verified: false,
          spec,
          endpointId: binding.endpointId,
          valueHash: binding.valueHash,
        }));
        continue;
      }

      if (liveHash !== binding.valueHash) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'replace',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: `Stripe webhook "${name}" signing value is missing or drifted on service "${spec.service}"; replace the endpoint to rotate it`,
          verified: true,
          spec,
          endpointId: binding.endpointId,
          requiresConfirm: true,
        }));
        continue;
      }

      actions.push(stripeWebhookAction({
        stripeEnvironment: params.stripeEnvironment,
        name,
        type: configMatches ? 'noop' : 'update',
        operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
        reason: configMatches
          ? `Stripe webhook "${name}" is in sync`
          : `Update Stripe webhook "${name}" URL, events, or enabled status`,
        verified: true,
        spec,
        endpointId: binding.endpointId,
        valueHash: binding.valueHash,
      }));
      continue;
    }

    const matches = params.endpoints.filter((endpoint) => endpoint.url === spec.url);
    if (matches.length > 1) {
      actions.push(stripeWebhookAction({
        stripeEnvironment: params.stripeEnvironment,
        name,
        type: 'update',
        operation: STRIPE_WEBHOOK_OPERATIONS.adopt,
        reason: `Multiple unmanaged Stripe webhooks match "${name}" by URL`,
        verified: true,
        spec,
        blockedReason: 'Multiple matching provider identities exist. Remove the duplicates explicitly before planning adoption.',
      }));
      warnings.push(`Stripe webhook "${name}" has ${matches.length} endpoints with URL ${spec.url}; Hypervibe will not choose one.`);
      continue;
    }
    if (matches.length === 1) {
      const endpoint = matches[0];
      if (!hostingObservationKnown) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'update',
          operation: STRIPE_WEBHOOK_OPERATIONS.adopt,
          reason: `An unmanaged Stripe webhook matches "${name}", but its hosting signing value cannot be observed`,
          verified: false,
          spec,
          endpointId: endpoint.id,
          blockedReason: 'Hosting environment observation must succeed before this endpoint can be adopted or replaced safely.',
        }));
      } else if (liveHash) {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'update',
          operation: STRIPE_WEBHOOK_OPERATIONS.adopt,
          reason: `Adopt the existing Stripe webhook matching "${name}" and its observed hosting value hash`,
          verified: true,
          spec,
          endpointId: endpoint.id,
          valueHash: liveHash,
          requiresConfirm: true,
        }));
      } else {
        actions.push(stripeWebhookAction({
          stripeEnvironment: params.stripeEnvironment,
          name,
          type: 'replace',
          operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
          reason: `Existing Stripe webhook "${name}" has no recoverable signing value on "${spec.service}"; replace it`,
          verified: true,
          spec,
          endpointId: endpoint.id,
          requiresConfirm: true,
        }));
      }
      continue;
    }

    actions.push(stripeWebhookAction({
      stripeEnvironment: params.stripeEnvironment,
      name,
      type: 'create',
      operation: STRIPE_WEBHOOK_OPERATIONS.ensure,
      reason: `Create Stripe webhook "${name}" and sync its signing value to "${spec.service}"`,
      verified: true,
      spec,
    }));
  }

  for (const [name, binding] of Object.entries(params.bindings).sort(([a], [b]) => a.localeCompare(b))) {
    if (params.desired[name]) continue;
    const slotReplacement = Object.entries(params.desired).find(([, webhook]) =>
      webhook.service === binding.service && webhook.envVar === binding.envVar
    );
    if (slotReplacement) {
      actions.push(stripeWebhookAction({
        stripeEnvironment: params.stripeEnvironment,
        name,
        type: 'update',
        operation: STRIPE_WEBHOOK_OPERATIONS.destroy,
        reason: `Stripe webhook "${name}" was removed, but "${slotReplacement[0]}" now owns the same hosting variable`,
        verified: true,
        endpointId: binding.endpointId,
        blockedReason: 'Apply the confirmed webhook destroy before assigning its service/envVar slot to another webhook.',
      }));
      continue;
    }
    actions.push(stripeWebhookAction({
      stripeEnvironment: params.stripeEnvironment,
      name,
      type: 'destroy',
      operation: STRIPE_WEBHOOK_OPERATIONS.destroy,
      reason: endpointById.has(binding.endpointId)
        ? `Stripe webhook "${name}" was removed from the spec; delete its endpoint and hosting variable`
        : `Stripe webhook "${name}" is already absent; remove its hosting variable and binding`,
      verified: true,
      endpointId: binding.endpointId,
      requiresConfirm: true,
    }));
    actions[actions.length - 1].metadata = {
      ...actions[actions.length - 1].metadata,
      service: binding.service,
      envVar: binding.envVar,
      url: binding.url,
      events: normalizedEvents(binding.events),
      ...(binding.valueHash ? { valueHash: binding.valueHash } : {}),
    };
  }

  return { actions, warnings };
}

function catalogPriceMatches(price: StripePrice, productId: string, spec: StripeCatalogPriceSpec): boolean {
  return price.product === productId
    && price.currency.toLowerCase() === spec.currency
    && price.unit_amount === spec.unitAmount
    && price.recurring?.interval === spec.interval;
}

function catalogProductConfigMatches(product: StripeProduct, spec: StripeCatalogProductSpec): boolean {
  return product.active
    && product.name === spec.name
    && (product.description ?? null) === (spec.description ?? null)
    && (spec.taxCode === undefined || (product.tax_code ?? null) === spec.taxCode);
}

function catalogProductDiff(
  product: StripeProduct,
  spec: StripeCatalogProductSpec
): NonNullable<PlanAction['diff']> {
  if (spec.taxCode !== undefined && (product.tax_code ?? null) !== spec.taxCode) {
    return [{
      field: 'taxCode',
      ...(product.tax_code ? { from: product.tax_code } : {}),
      to: spec.taxCode,
    }];
  }
  return [];
}

function stripeCatalogAction(params: {
  stripeEnvironment: string;
  productKey: string;
  priceKey?: string;
  type: PlanAction['type'];
  operation: string;
  reason: string;
  verified: boolean;
  projectName: string;
  productSpec?: StripeCatalogProductSpec;
  priceSpec?: StripeCatalogPriceSpec;
  productId?: string;
  priceId?: string;
  previousPriceId?: string;
  diff?: PlanAction['diff'];
  dependsOn?: string[];
  blockedReason?: string;
  requiresConfirm?: boolean;
}): PlanAction {
  const name = params.priceKey
    ? `${params.productKey}.${params.priceKey}`
    : params.productKey;
  const suffix = params.priceKey
    ? `price:${params.productKey}:${params.priceKey}`
    : `product:${params.productKey}`;
  return {
    id: `payment:stripe:${params.stripeEnvironment}:catalog:${suffix}`,
    type: params.type,
    resource: { kind: 'payment', name, provider: 'stripe' },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff?.length ? { diff: params.diff } : {}),
    ...(params.dependsOn?.length ? { dependsOn: [...new Set(params.dependsOn)] } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: {
      operation: params.operation,
      stripeEnvironment: params.stripeEnvironment,
      projectName: params.projectName,
      productKey: params.productKey,
      ...(params.priceKey ? { priceKey: params.priceKey } : {}),
      ...(params.productSpec
        ? {
          productName: params.productSpec.name,
          productDescription: params.productSpec.description ?? null,
          ...(params.productSpec.taxCode
            ? { productTaxCode: params.productSpec.taxCode }
            : {}),
        }
        : {}),
      ...(params.priceSpec
        ? {
          envVar: params.priceSpec.envVar,
          unitAmount: params.priceSpec.unitAmount,
          currency: params.priceSpec.currency,
          interval: params.priceSpec.interval,
        }
        : {}),
      ...(params.productId ? { productId: params.productId } : {}),
      ...(params.priceId ? { priceId: params.priceId } : {}),
      ...(params.previousPriceId ? { previousPriceId: params.previousPriceId } : {}),
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    },
  };
}

function stripePriceArchiveAction(params: {
  stripeEnvironment: string;
  projectName: string;
  productKey: string;
  priceKey: string;
  productId: string;
  priceId: string;
  reason: string;
  envVar: string;
  dependsOn: string[];
  replacement?: boolean;
}): PlanAction {
  return {
    id: `payment:stripe:${params.stripeEnvironment}:catalog:price-archive:${params.productKey}:${params.priceKey}`,
    type: 'destroy',
    resource: {
      kind: 'payment',
      name: `${params.productKey}.${params.priceKey}`,
      provider: 'stripe',
    },
    verified: true,
    reason: params.reason,
    requiresConfirm: true,
    dependsOn: [...new Set(params.dependsOn)],
    metadata: {
      operation: STRIPE_CATALOG_OPERATIONS.priceArchive,
      stripeEnvironment: params.stripeEnvironment,
      projectName: params.projectName,
      productKey: params.productKey,
      priceKey: params.priceKey,
      productId: params.productId,
      priceId: params.priceId,
      envVar: params.envVar,
      replacement: params.replacement === true,
    },
  };
}

function planStripeCatalogActions(params: {
  stripeEnvironment: string;
  projectName: string;
  desired: StripeEnvironmentSyncSpec['catalog'];
  bindings: StripeBindings['catalog'];
  products: StripeProduct[];
  prices: StripePrice[];
  hostingActionIds: string[];
}): { ensureActions: PlanAction[]; archiveActions: PlanAction[]; warnings: string[] } {
  const ensureActions: PlanAction[] = [];
  const archiveActions: PlanAction[] = [];
  const warnings: string[] = [];
  const productById = new Map(params.products.map((product) => [product.id, product]));
  const priceById = new Map(params.prices.map((price) => [price.id, price]));
  const desiredProducts = params.desired?.products ?? {};

  for (const [productKey, productSpec] of Object.entries(desiredProducts).sort(([a], [b]) => a.localeCompare(b))) {
    const productBinding = params.bindings.products[productKey];
    const boundProduct = productBinding ? productById.get(productBinding.productId) : undefined;
    let productAction: PlanAction;

    if (productBinding) {
      productAction = stripeCatalogAction({
        stripeEnvironment: params.stripeEnvironment,
        projectName: params.projectName,
        productKey,
        type: boundProduct
          ? (catalogProductConfigMatches(boundProduct, productSpec) ? 'noop' : 'update')
          : 'replace',
        operation: STRIPE_CATALOG_OPERATIONS.productEnsure,
        reason: boundProduct
          ? (catalogProductConfigMatches(boundProduct, productSpec)
            ? `Stripe catalog product "${productKey}" is in sync`
            : `Update Stripe catalog product "${productKey}"`)
          : `Bound Stripe catalog product "${productKey}" is absent; recreate it`,
        verified: true,
        productSpec,
        productId: productBinding.productId,
        diff: boundProduct ? catalogProductDiff(boundProduct, productSpec) : undefined,
        requiresConfirm: !boundProduct,
      });
    } else {
      const ownedMatches = params.products.filter((product) =>
        product.metadata.hypervibe_project === params.projectName
        && product.metadata.hypervibe_environment === params.stripeEnvironment
        && product.metadata.hypervibe_product === productKey
      );
      const nameMatches = ownedMatches.length > 0
        ? ownedMatches
        : params.products.filter((product) => product.name === productSpec.name);
      if (nameMatches.length > 1) {
        productAction = stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          type: 'update',
          operation: STRIPE_CATALOG_OPERATIONS.productAdopt,
          reason: `Multiple Stripe products match catalog product "${productKey}"`,
          verified: true,
          productSpec,
          blockedReason: 'Multiple provider identities match. Archive or rename the duplicates before planning adoption.',
        });
        warnings.push(`Stripe catalog product "${productKey}" has ${nameMatches.length} adoption candidates; Hypervibe will not choose one.`);
      } else if (nameMatches.length === 1) {
        productAction = stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          type: 'update',
          operation: STRIPE_CATALOG_OPERATIONS.productAdopt,
          reason: `Adopt existing Stripe product for catalog product "${productKey}"`,
          verified: true,
          productSpec,
          productId: nameMatches[0].id,
          requiresConfirm: true,
        });
      } else {
        productAction = stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          type: 'create',
          operation: STRIPE_CATALOG_OPERATIONS.productEnsure,
          reason: `Create Stripe catalog product "${productKey}"`,
          verified: true,
          productSpec,
        });
      }
    }
    ensureActions.push(productAction);

    for (const [priceKey, priceSpec] of Object.entries(productSpec.prices).sort(([a], [b]) => a.localeCompare(b))) {
      const priceBinding = productBinding?.prices[priceKey];
      const boundPrice = priceBinding ? priceById.get(priceBinding.priceId) : undefined;
      const productId = productBinding?.productId ?? productAction.metadata?.productId;
      const productDependency = productAction.type === 'noop' ? [] : [productAction.id];
      if (priceBinding) {
        const matches = Boolean(
          boundPrice
          && typeof productId === 'string'
          && catalogPriceMatches(boundPrice, productId, priceSpec)
        );
        const active = boundPrice?.active === true;
        const priceAction = stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          priceKey,
          type: matches && active ? 'noop' : (boundPrice && matches ? 'update' : 'replace'),
          operation: STRIPE_CATALOG_OPERATIONS.priceEnsure,
          reason: matches && active
            ? `Stripe catalog price "${productKey}.${priceKey}" is in sync`
            : boundPrice && matches
              ? `Reactivate Stripe catalog price "${productKey}.${priceKey}"`
              : `Replace immutable Stripe catalog price "${productKey}.${priceKey}"`,
          verified: true,
          productSpec,
          priceSpec,
          productId: typeof productId === 'string' ? productId : undefined,
          priceId: priceBinding.priceId,
          previousPriceId: boundPrice && !matches ? boundPrice.id : undefined,
          dependsOn: productDependency,
          requiresConfirm: !boundPrice,
        });
        ensureActions.push(priceAction);
        if (boundPrice && !matches) {
          archiveActions.push(stripePriceArchiveAction({
            stripeEnvironment: params.stripeEnvironment,
            projectName: params.projectName,
            productKey,
            priceKey,
            productId: boundPrice.product,
            priceId: boundPrice.id,
            envVar: priceBinding.envVar,
            reason: `Archive the replaced Stripe price for "${productKey}.${priceKey}" after hosting uses its replacement`,
            dependsOn: [...params.hostingActionIds, priceAction.id],
            replacement: true,
          }));
        }
        continue;
      }

      const liveProductId = typeof productId === 'string' ? productId : undefined;
      const ownedMatches = liveProductId
        ? params.prices.filter((price) =>
          price.product === liveProductId
          && price.metadata.hypervibe_project === params.projectName
          && price.metadata.hypervibe_environment === params.stripeEnvironment
          && price.metadata.hypervibe_product === productKey
          && price.metadata.hypervibe_price === priceKey
        )
        : [];
      const tupleMatches = liveProductId && ownedMatches.length === 0
        ? params.prices.filter((price) => catalogPriceMatches(price, liveProductId, priceSpec))
        : ownedMatches;
      if (tupleMatches.length > 1) {
        ensureActions.push(stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          priceKey,
          type: 'update',
          operation: STRIPE_CATALOG_OPERATIONS.priceAdopt,
          reason: `Multiple Stripe prices match catalog price "${productKey}.${priceKey}"`,
          verified: true,
          productSpec,
          priceSpec,
          productId: liveProductId,
          dependsOn: productDependency,
          blockedReason: 'Multiple provider identities match. Archive the duplicate prices before planning adoption.',
        }));
        warnings.push(`Stripe catalog price "${productKey}.${priceKey}" has ${tupleMatches.length} adoption candidates; Hypervibe will not choose one.`);
      } else if (tupleMatches.length === 1) {
        ensureActions.push(stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          priceKey,
          type: 'update',
          operation: STRIPE_CATALOG_OPERATIONS.priceAdopt,
          reason: `Adopt existing Stripe price for catalog price "${productKey}.${priceKey}"`,
          verified: true,
          productSpec,
          priceSpec,
          productId: liveProductId,
          priceId: tupleMatches[0].id,
          dependsOn: productDependency,
          requiresConfirm: true,
        }));
      } else {
        ensureActions.push(stripeCatalogAction({
          stripeEnvironment: params.stripeEnvironment,
          projectName: params.projectName,
          productKey,
          priceKey,
          type: 'create',
          operation: STRIPE_CATALOG_OPERATIONS.priceEnsure,
          reason: `Create Stripe catalog price "${productKey}.${priceKey}"`,
          verified: true,
          productSpec,
          priceSpec,
          productId: liveProductId,
          dependsOn: productDependency,
        }));
      }
    }
  }

  for (const [productKey, productBinding] of Object.entries(params.bindings.products).sort(([a], [b]) => a.localeCompare(b))) {
    const desiredProduct = desiredProducts[productKey];
    for (const [priceKey, priceBinding] of Object.entries(productBinding.prices).sort(([a], [b]) => a.localeCompare(b))) {
      if (desiredProduct?.prices[priceKey]) continue;
      archiveActions.push(stripePriceArchiveAction({
        stripeEnvironment: params.stripeEnvironment,
        projectName: params.projectName,
        productKey,
        priceKey,
        productId: productBinding.productId,
        priceId: priceBinding.priceId,
        envVar: priceBinding.envVar,
        reason: `Stripe catalog price "${productKey}.${priceKey}" was removed; archive it after removing its hosting variable`,
        dependsOn: params.hostingActionIds,
      }));
    }
    if (!desiredProduct) {
      const priceArchiveIds = archiveActions
        .filter((action) => action.metadata?.productKey === productKey)
        .map((action) => action.id);
      archiveActions.push(stripeCatalogAction({
        stripeEnvironment: params.stripeEnvironment,
        projectName: params.projectName,
        productKey,
        type: 'destroy',
        operation: STRIPE_CATALOG_OPERATIONS.productArchive,
        reason: `Stripe catalog product "${productKey}" was removed; archive it after its managed prices`,
        verified: true,
        productId: productBinding.productId,
        dependsOn: priceArchiveIds,
        requiresConfirm: true,
      }));
    }
  }

  return { ensureActions, archiveActions, warnings };
}

export async function planStripeEnvironmentSync(params: {
  projectName?: string;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  environment?: Environment | null;
  observed: ObservedState | null;
}): Promise<{
  actions: PlanAction[];
  warnings: string[];
  blocked: Array<{ provider: string; reason: string; scope: string; policy: 'hard' }>;
  fingerprint?: string;
}> {
  const stripeSpec = params.environmentSpec.payments?.stripe;
  const projectName = params.projectName ?? 'hypervibe';
  const bindings = parseStripeBindings(params.environment ?? null);
  if (
    !stripeSpec
    && Object.keys(bindings.webhooks).length === 0
    && Object.keys(bindings.catalog.products).length === 0
  ) {
    return { actions: [], warnings: [], blocked: [] };
  }

  const stripeEnvironment = stripeSpec
    ? stripeEnvironmentName(params.environmentName, stripeSpec)
    : bindings.environment?.trim() || params.environmentName;
  const managedKeys = stripeRuntimeEnvKeys(params.environmentSpec);
  const previouslyManagedKeys = Object.values(bindings.catalog.products)
    .flatMap((product) => Object.values(product.prices).map((price) => price.envVar));
  const removeKeys = [...new Set(previouslyManagedKeys.filter((key) => !managedKeys.includes(key)))].sort();
  const targetServices = stripeSpec
    ? stripeTargetServiceNames(params.environmentSpec)
    : Object.keys(params.environmentSpec.services).sort();
  const resolved = await resolveStripeIntegrationState({
    environmentName: params.environmentName,
    spec: stripeSpec,
    environment: params.environment ?? null,
    verifiedConnection: true,
  });
  const warnings: string[] = [];
  const blocked: Array<{ provider: string; reason: string; scope: string; policy: 'hard' }> = [];
  if (!resolved.success) {
    warnings.push(resolved.error);
    blocked.push({
      provider: 'stripe',
      scope: stripeEnvironment,
      policy: 'hard',
      reason: resolved.error,
    });
  }

  const observedServices = new Map((params.observed?.services ?? []).map((service) => [service.name, service]));
  const hostingActionIds = targetServices.map((serviceName) =>
    `payment:stripe:${stripeEnvironment}:hosting-env:${serviceName}`
  );
  const catalogPlan = resolved.success
    ? planStripeCatalogActions({
      stripeEnvironment,
      projectName,
      desired: stripeSpec?.catalog,
      bindings: bindings.catalog,
      products: resolved.products,
      prices: resolved.prices,
      hostingActionIds,
    })
    : { ensureActions: [], archiveActions: [], warnings: [] };
  warnings.push(...catalogPlan.warnings);
  const catalogDependencies = catalogPlan.ensureActions
    .filter((action) => action.type !== 'noop')
    .map((action) => action.id);
  const actions: PlanAction[] = [...catalogPlan.ensureActions];
  actions.push(...targetServices.map<PlanAction>((serviceName) => {
    const live = observedServices.get(serviceName);
    const driftedKeys = resolved.success && live
      ? managedKeys.filter((key) =>
        !resolved.values[key] || live.envVarHashes[key] !== hashEnvValue(resolved.values[key])
      )
      : managedKeys;
    const removalDrift = removeKeys.filter((key) => Boolean(live?.envVarHashes[key]));
    const inSync = resolved.success
      && Boolean(live)
      && driftedKeys.length === 0
      && removalDrift.length === 0
      && catalogDependencies.length === 0;

    return {
      id: `payment:stripe:${stripeEnvironment}:hosting-env:${serviceName}`,
      type: inSync ? 'noop' : 'update',
      resource: { kind: 'payment', name: serviceName, provider: 'stripe' },
      verified: resolved.success && params.observed !== null,
      reason: inSync
        ? `Stripe environment "${stripeEnvironment}" runtime variables are in sync on "${serviceName}"`
        : resolved.success
          ? `Sync Stripe-managed runtime variables from "${stripeEnvironment}" to "${serviceName}"`
          : `Stripe environment "${stripeEnvironment}" could not be resolved; sync remains blocked`,
      ...(!inSync
        ? { diff: [
          ...driftedKeys.map((key) => ({ field: `env:${key}` })),
          ...removalDrift.map((key) => ({ field: `env:${key}`, after: null })),
        ] }
        : {}),
      ...(catalogDependencies.length ? { dependsOn: catalogDependencies } : {}),
      metadata: {
        operation: STRIPE_HOSTING_ENV_SYNC_OPERATION,
        stripeEnvironment,
        service: serviceName,
        keys: managedKeys,
        removeKeys,
        ...(resolved.success
          ? {
            valueHashes: Object.fromEntries(
              managedKeys
                .filter((key) => resolved.values[key])
                .map((key) => [key, hashEnvValue(resolved.values[key])])
            ),
          }
          : {}),
      },
    };
  }));
  if (resolved.success) {
    const webhookPlan = planStripeWebhookActions({
      stripeEnvironment,
      desired: stripeSpec?.webhooks ?? {},
      bindings: bindings.webhooks,
      endpoints: resolved.webhookEndpoints,
      observed: params.observed,
    });
    actions.push(...webhookPlan.actions);
    warnings.push(...webhookPlan.warnings);
  } else {
    actions.push(...blockedStripeWebhookActions({
      stripeEnvironment,
      desired: stripeSpec?.webhooks ?? {},
      bindings: bindings.webhooks,
      reason: resolved.error,
    }));
  }
  actions.push(...catalogPlan.archiveActions);

  return {
    actions,
    warnings,
    blocked,
    ...(resolved.success ? { fingerprint: stripeIntegrationFingerprint(resolved) } : {}),
  };
}

export function isStripeHostingEnvSyncAction(action: {
  resource: { kind: string; provider: string };
  metadata?: Record<string, unknown>;
}): boolean {
  return action.resource.kind === 'payment'
    && action.resource.provider === 'stripe'
    && action.metadata?.operation === STRIPE_HOSTING_ENV_SYNC_OPERATION;
}

export function isStripeWebhookAction(action: {
  resource: { kind: string; provider: string };
  metadata?: Record<string, unknown>;
}): boolean {
  return action.resource.kind === 'payment'
    && action.resource.provider === 'stripe'
    && typeof action.metadata?.operation === 'string'
    && STRIPE_WEBHOOK_OPERATION_SET.has(action.metadata.operation);
}

export function isStripeCatalogAction(action: {
  resource: { kind: string; provider: string };
  metadata?: Record<string, unknown>;
}): boolean {
  return action.resource.kind === 'payment'
    && action.resource.provider === 'stripe'
    && typeof action.metadata?.operation === 'string'
    && STRIPE_CATALOG_OPERATION_SET.has(action.metadata.operation);
}

function catalogProductSpecMatchesAction(spec: StripeCatalogProductSpec, action: PlanAction): boolean {
  const metadata = action.metadata ?? {};
  return metadata.productName === spec.name
    && metadata.productDescription === (spec.description ?? null)
    && metadata.productTaxCode === spec.taxCode;
}

function catalogPriceSpecMatchesAction(spec: StripeCatalogPriceSpec, action: PlanAction): boolean {
  const metadata = action.metadata ?? {};
  return metadata.envVar === spec.envVar
    && metadata.unitAmount === spec.unitAmount
    && metadata.currency === spec.currency
    && metadata.interval === spec.interval;
}

function catalogOwnershipMetadata(params: {
  projectName: string;
  stripeEnvironment: string;
  productKey: string;
  priceKey?: string;
}): Record<string, string> {
  return {
    hypervibe_project: params.projectName,
    hypervibe_environment: params.stripeEnvironment,
    hypervibe_product: params.productKey,
    ...(params.priceKey ? { hypervibe_price: params.priceKey } : {}),
  };
}

export async function applyStripeCatalogAction(params: {
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{
  success: boolean;
  status?: 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}> {
  const metadata = params.action.metadata ?? {};
  const operation = typeof metadata.operation === 'string' ? metadata.operation : '';
  const productKey = typeof metadata.productKey === 'string' ? metadata.productKey : '';
  const priceKey = typeof metadata.priceKey === 'string' ? metadata.priceKey : undefined;
  const plannedEnvironment = typeof metadata.stripeEnvironment === 'string'
    ? metadata.stripeEnvironment
    : '';
  const projectName = typeof metadata.projectName === 'string' ? metadata.projectName : '';
  const stripeSpec = params.environmentSpec.payments?.stripe;
  const bindings = parseStripeBindings(params.environment);
  const currentEnvironment = stripeSpec
    ? stripeEnvironmentName(params.environment.name, stripeSpec)
    : bindings.environment?.trim() || params.environment.name;
  const productSpec = stripeSpec?.catalog?.products[productKey];
  const priceSpec = priceKey ? productSpec?.prices[priceKey] : undefined;
  const productBinding = bindings.catalog.products[productKey];
  const priceBinding = priceKey ? productBinding?.prices[priceKey] : undefined;

  if (!productKey || !projectName || !plannedEnvironment || plannedEnvironment !== currentEnvironment) {
    return {
      success: false,
      message: 'Stripe catalog plan is stale',
      error: 'The project, catalog key, or Stripe environment changed after planning. Re-run hv_plan.',
    };
  }
  if (metadata.blockedReason) {
    return {
      success: false,
      status: 'blocked',
      message: params.action.reason,
      error: String(metadata.blockedReason),
    };
  }
  const stripe = getStripeAdapter(plannedEnvironment, { verifiedOnly: true });
  if ('error' in stripe) {
    return {
      success: false,
      status: 'blocked',
      message: `Stripe environment "${plannedEnvironment}" is unavailable`,
      error: stripe.error,
    };
  }
  const ownership = catalogOwnershipMetadata({
    projectName,
    stripeEnvironment: plannedEnvironment,
    productKey,
    ...(priceKey ? { priceKey } : {}),
  });

  try {
    if (operation === STRIPE_CATALOG_OPERATIONS.productArchive) {
      const productId = typeof metadata.productId === 'string' ? metadata.productId : '';
      if (productSpec || !productBinding || productBinding.productId !== productId) {
        return {
          success: false,
          message: `Stripe catalog product "${productKey}" archive plan is stale`,
          error: 'The desired product or its durable provider binding changed. Re-run hv_plan.',
        };
      }
      if (Object.keys(productBinding.prices).length > 0) {
        return {
          success: false,
          status: 'blocked',
          message: `Stripe catalog product "${productKey}" still has managed prices`,
          error: 'Its price archive actions must complete before the product can be archived.',
        };
      }
      const live = await stripe.adapter.getProduct(stripe.mode, productId);
      if (live?.active) {
        await stripe.adapter.updateProduct(stripe.mode, productId, { active: false });
      }
      const verified = await stripe.adapter.getProduct(stripe.mode, productId);
      if (verified?.active) {
        return {
          success: false,
          message: `Stripe catalog product "${productKey}" could not be verified archived`,
          error: 'Stripe still reports the product as active.',
        };
      }
      const nextProducts = { ...bindings.catalog.products };
      delete nextProducts[productKey];
      persistStripeCatalogBindings(params.environment, plannedEnvironment, { products: nextProducts });
      return {
        success: true,
        message: `Archived Stripe catalog product "${productKey}"`,
        data: { productId, alreadyAbsent: !live },
      };
    }

    if (operation === STRIPE_CATALOG_OPERATIONS.priceArchive) {
      const productId = typeof metadata.productId === 'string' ? metadata.productId : '';
      const priceId = typeof metadata.priceId === 'string' ? metadata.priceId : '';
      const replacement = metadata.replacement === true;
      const bindingIsExpected = replacement
        ? Boolean(productBinding && productBinding.productId === productId && priceBinding?.priceId !== priceId)
        : Boolean(!priceSpec && productBinding?.productId === productId && priceBinding?.priceId === priceId);
      if (!priceKey || !productId || !priceId || !bindingIsExpected) {
        return {
          success: false,
          message: `Stripe catalog price "${productKey}.${priceKey ?? ''}" archive plan is stale`,
          error: 'The desired price or its durable provider binding changed. Re-run hv_plan.',
        };
      }
      const live = await stripe.adapter.getPrice(stripe.mode, priceId);
      if (live?.active) {
        await stripe.adapter.updatePrice(stripe.mode, priceId, { active: false });
      }
      const verified = await stripe.adapter.getPrice(stripe.mode, priceId);
      if (verified?.active) {
        return {
          success: false,
          message: `Stripe catalog price "${productKey}.${priceKey}" could not be verified archived`,
          error: 'Stripe still reports the price as active.',
        };
      }
      if (!replacement && productBinding && priceBinding) {
        const nextPrices = { ...productBinding.prices };
        delete nextPrices[priceKey];
        persistStripeCatalogBindings(params.environment, plannedEnvironment, {
          products: {
            ...bindings.catalog.products,
            [productKey]: { ...productBinding, prices: nextPrices, updatedAt: new Date().toISOString() },
          },
        });
      }
      return {
        success: true,
        message: `Archived Stripe catalog price "${productKey}.${priceKey}"`,
        data: { priceId, alreadyAbsent: !live, replacement },
      };
    }

    if (operation === STRIPE_CATALOG_OPERATIONS.productAdopt) {
      const productId = typeof metadata.productId === 'string' ? metadata.productId : '';
      if (!productSpec || productBinding || !productId || !catalogProductSpecMatchesAction(productSpec, params.action)) {
        return {
          success: false,
          message: `Stripe catalog product "${productKey}" adoption plan is stale`,
          error: 'The desired product, provider identity, or local binding changed. Re-run hv_plan.',
        };
      }
      const live = await stripe.adapter.getProduct(stripe.mode, productId);
      if (!live || (live.name !== productSpec.name
        && !(live.metadata.hypervibe_project === projectName
          && live.metadata.hypervibe_environment === plannedEnvironment
          && live.metadata.hypervibe_product === productKey))) {
        return {
          success: false,
          message: `Cannot adopt Stripe catalog product "${productKey}"`,
          error: 'The reviewed provider identity is absent or no longer matches. Re-run hv_plan.',
        };
      }
      const converged = catalogProductConfigMatches(live, productSpec)
        ? live
        : await stripe.adapter.updateProduct(stripe.mode, productId, {
          name: productSpec.name,
          description: productSpec.description ?? null,
          ...(productSpec.taxCode ? { tax_code: productSpec.taxCode } : {}),
          active: true,
          metadata: { ...live.metadata, ...ownership },
        });
      persistStripeCatalogBindings(params.environment, plannedEnvironment, {
        products: {
          ...bindings.catalog.products,
          [productKey]: {
            productId: converged.id,
            name: productSpec.name,
            ...(productSpec.taxCode ? { taxCode: productSpec.taxCode } : {}),
            prices: {},
            updatedAt: new Date().toISOString(),
          },
        },
      });
      return {
        success: true,
        message: `Adopted Stripe catalog product "${productKey}"`,
        data: {
          productId,
          ...(productSpec.taxCode ? { taxCode: productSpec.taxCode } : {}),
        },
      };
    }

    if (operation === STRIPE_CATALOG_OPERATIONS.productEnsure) {
      if (!productSpec || priceKey || !catalogProductSpecMatchesAction(productSpec, params.action)) {
        return {
          success: false,
          message: `Stripe catalog product "${productKey}" ensure plan is stale`,
          error: 'The desired product changed after planning. Re-run hv_plan.',
        };
      }
      let product: StripeProduct;
      if (params.action.type === 'update') {
        const productId = typeof metadata.productId === 'string' ? metadata.productId : '';
        if (!productBinding || productBinding.productId !== productId) {
          return {
            success: false,
            message: `Stripe catalog product "${productKey}" update plan is stale`,
            error: 'Its durable provider binding changed. Re-run hv_plan.',
          };
        }
        const live = await stripe.adapter.getProduct(stripe.mode, productId);
        if (!live) {
          return {
            success: false,
            message: `Stripe catalog product "${productKey}" is absent`,
            error: 'Re-run hv_plan to review a replacement.',
          };
        }
        product = await stripe.adapter.updateProduct(stripe.mode, productId, {
          name: productSpec.name,
          description: productSpec.description ?? null,
          ...(productSpec.taxCode ? { tax_code: productSpec.taxCode } : {}),
          active: true,
          metadata: { ...live.metadata, ...ownership },
        });
      } else if (params.action.type === 'create' || params.action.type === 'replace') {
        if (params.action.type === 'create' && productBinding) {
          return {
            success: false,
            message: `Stripe catalog product "${productKey}" create plan is stale`,
            error: 'A durable provider binding now exists. Re-run hv_plan.',
          };
        }
        if (params.action.type === 'replace') {
          const plannedProductId = typeof metadata.productId === 'string' ? metadata.productId : '';
          if (!productBinding || productBinding.productId !== plannedProductId) {
            return {
              success: false,
              message: `Stripe catalog product "${productKey}" replacement plan is stale`,
              error: 'Its durable provider binding changed. Re-run hv_plan.',
            };
          }
          const unexpectedlyLive = await stripe.adapter.getProduct(stripe.mode, plannedProductId);
          if (unexpectedlyLive) {
            return {
              success: false,
              message: `Stripe catalog product "${productKey}" is no longer absent`,
              error: 'Re-run hv_plan before mutating the recovered provider identity.',
            };
          }
        }
        product = await stripe.adapter.createProduct(stripe.mode, {
          name: productSpec.name,
          description: productSpec.description ?? null,
          ...(productSpec.taxCode ? { tax_code: productSpec.taxCode } : {}),
          active: true,
          metadata: ownership,
        }, { idempotencyKey: params.action.id });
      } else {
        return {
          success: false,
          status: 'blocked',
          message: `No action-scoped product handler exists for "${productKey}"`,
          error: `Expected create, update, or replace; received ${params.action.type}.`,
        };
      }
      persistStripeCatalogBindings(params.environment, plannedEnvironment, {
        products: {
          ...bindings.catalog.products,
          [productKey]: {
            productId: product.id,
            name: productSpec.name,
            ...(productSpec.taxCode ? { taxCode: productSpec.taxCode } : {}),
            prices: productBinding?.prices ?? {},
            updatedAt: new Date().toISOString(),
          },
        },
      });
      return {
        success: true,
        message: `${params.action.type === 'create' ? 'Created' : params.action.type === 'replace' ? 'Recreated' : 'Updated'} Stripe catalog product "${productKey}"`,
        data: {
          productId: product.id,
          ...(productSpec.taxCode ? { taxCode: productSpec.taxCode } : {}),
        },
      };
    }

    if (operation === STRIPE_CATALOG_OPERATIONS.priceAdopt) {
      const productId = typeof metadata.productId === 'string' ? metadata.productId : '';
      const priceId = typeof metadata.priceId === 'string' ? metadata.priceId : '';
      if (
        !priceKey
        || !productSpec
        || !priceSpec
        || priceBinding
        || !productBinding
        || productBinding.productId !== productId
        || !priceId
        || !catalogPriceSpecMatchesAction(priceSpec, params.action)
      ) {
        return {
          success: false,
          message: `Stripe catalog price "${productKey}.${priceKey ?? ''}" adoption plan is stale`,
          error: 'The desired price, product binding, provider identity, or price binding changed. Re-run hv_plan.',
        };
      }
      const live = await stripe.adapter.getPrice(stripe.mode, priceId);
      if (!live || !catalogPriceMatches(live, productId, priceSpec)) {
        return {
          success: false,
          message: `Cannot adopt Stripe catalog price "${productKey}.${priceKey}"`,
          error: 'The reviewed price is absent or its immutable configuration changed. Re-run hv_plan.',
        };
      }
      if (!live.active) {
        await stripe.adapter.updatePrice(stripe.mode, priceId, {
          active: true,
          metadata: { ...live.metadata, ...ownership },
        });
      }
      persistStripeCatalogBindings(params.environment, plannedEnvironment, {
        products: {
          ...bindings.catalog.products,
          [productKey]: {
            ...productBinding,
            prices: {
              ...productBinding.prices,
              [priceKey]: {
                priceId,
                envVar: priceSpec.envVar,
                unitAmount: priceSpec.unitAmount,
                currency: priceSpec.currency,
                interval: priceSpec.interval,
                updatedAt: new Date().toISOString(),
              },
            },
            updatedAt: new Date().toISOString(),
          },
        },
      });
      return {
        success: true,
        message: `Adopted Stripe catalog price "${productKey}.${priceKey}"`,
        data: { productId, priceId },
      };
    }

    if (operation === STRIPE_CATALOG_OPERATIONS.priceEnsure) {
      if (
        !priceKey
        || !productSpec
        || !priceSpec
        || !productBinding
        || !catalogPriceSpecMatchesAction(priceSpec, params.action)
      ) {
        return {
          success: false,
          message: `Stripe catalog price "${productKey}.${priceKey ?? ''}" ensure plan is stale`,
          error: 'The desired price or product binding changed after planning. Re-run hv_plan.',
        };
      }
      const productId = productBinding.productId;
      let price: StripePrice;
      if (params.action.type === 'update') {
        const priceId = typeof metadata.priceId === 'string' ? metadata.priceId : '';
        if (!priceBinding || priceBinding.priceId !== priceId) {
          return {
            success: false,
            message: `Stripe catalog price "${productKey}.${priceKey}" update plan is stale`,
            error: 'Its durable provider binding changed. Re-run hv_plan.',
          };
        }
        const live = await stripe.adapter.getPrice(stripe.mode, priceId);
        if (!live || !catalogPriceMatches(live, productId, priceSpec)) {
          return {
            success: false,
            message: `Stripe catalog price "${productKey}.${priceKey}" cannot be updated`,
            error: 'Its immutable configuration changed. Re-run hv_plan to review a replacement.',
          };
        }
        price = await stripe.adapter.updatePrice(stripe.mode, priceId, {
          active: true,
          metadata: { ...live.metadata, ...ownership },
        });
      } else if (params.action.type === 'create' || params.action.type === 'replace') {
        if (params.action.type === 'create' && priceBinding) {
          return {
            success: false,
            message: `Stripe catalog price "${productKey}.${priceKey}" create plan is stale`,
            error: 'A durable provider binding now exists. Re-run hv_plan.',
          };
        }
        if (params.action.type === 'replace') {
          const oldPriceId = typeof metadata.priceId === 'string' ? metadata.priceId : '';
          if (!priceBinding || priceBinding.priceId !== oldPriceId) {
            return {
              success: false,
              message: `Stripe catalog price "${productKey}.${priceKey}" replacement plan is stale`,
              error: 'Its durable provider binding changed. Re-run hv_plan.',
            };
          }
        }
        price = await stripe.adapter.createPrice(stripe.mode, {
          product: productId,
          active: true,
          currency: priceSpec.currency,
          unit_amount: priceSpec.unitAmount,
          recurring: { interval: priceSpec.interval, interval_count: 1 },
          metadata: ownership,
          lookup_key: `hypervibe_${projectName}_${plannedEnvironment}_${productKey}_${priceKey}`
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .slice(0, 200),
        }, { idempotencyKey: params.action.id });
      } else {
        return {
          success: false,
          status: 'blocked',
          message: `No action-scoped price handler exists for "${productKey}.${priceKey}"`,
          error: `Expected create, update, or replace; received ${params.action.type}.`,
        };
      }
      persistStripeCatalogBindings(params.environment, plannedEnvironment, {
        products: {
          ...bindings.catalog.products,
          [productKey]: {
            ...productBinding,
            prices: {
              ...productBinding.prices,
              [priceKey]: {
                priceId: price.id,
                envVar: priceSpec.envVar,
                unitAmount: priceSpec.unitAmount,
                currency: priceSpec.currency,
                interval: priceSpec.interval,
                updatedAt: new Date().toISOString(),
              },
            },
            updatedAt: new Date().toISOString(),
          },
        },
      });
      return {
        success: true,
        message: `${params.action.type === 'create' ? 'Created' : params.action.type === 'replace' ? 'Replaced' : 'Updated'} Stripe catalog price "${productKey}.${priceKey}"`,
        data: { productId, priceId: price.id },
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to converge Stripe catalog resource "${params.action.resource.name}"`,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    success: false,
    status: 'blocked',
    message: `No action-scoped Stripe catalog handler exists for "${params.action.resource.name}"`,
    error: `Unrecognized Stripe catalog operation "${operation}".`,
  };
}

export async function applyStripeHostingEnvSync(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  service: Service;
  action: PlanAction;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}> {
  const stripeSpec = params.environmentSpec.payments?.stripe;
  const plannedKeys = Array.isArray(params.action.metadata?.keys)
    ? params.action.metadata.keys.filter((key): key is string => typeof key === 'string')
    : [];
  const plannedRemoveKeys = Array.isArray(params.action.metadata?.removeKeys)
    ? params.action.metadata.removeKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const currentKeys = stripeRuntimeEnvKeys(params.environmentSpec);
  const plannedHashes = params.action.metadata?.valueHashes
    && typeof params.action.metadata.valueHashes === 'object'
    && !Array.isArray(params.action.metadata.valueHashes)
    ? params.action.metadata.valueHashes as Record<string, unknown>
    : null;
  if (
    (plannedKeys.length === 0 && plannedRemoveKeys.length === 0)
    || plannedKeys.length !== currentKeys.length
    || plannedKeys.some((key, index) => key !== currentKeys[index])
    || !plannedHashes
    || Object.keys(plannedHashes).some((key) =>
      !plannedKeys.includes(key) || typeof plannedHashes[key] !== 'string'
    )
  ) {
    return {
      success: false,
      message: 'Stripe hosting environment sync plan is stale',
      error: 'Managed Stripe key names changed after planning. Re-run hv_plan.',
    };
  }

  if (!stripeSpec && plannedKeys.length > 0) {
    return {
      success: false,
      message: 'Stripe hosting environment sync is no longer declared',
      error: 'The project spec changed after planning. Re-run hv_plan.',
    };
  }
  const resolved = stripeSpec
    ? await resolveStripeEnvironmentValues({
      environmentName: params.environment.name,
      spec: stripeSpec,
      environment: params.environment,
      verifiedConnection: true,
    })
    : {
      success: true as const,
      stripeEnvironment: String(params.action.metadata?.stripeEnvironment ?? params.environment.name),
      mode: 'sandbox' as const,
      values: {},
    };
  if (!resolved.success) {
    return {
      success: false,
      message: `Could not resolve Stripe environment "${resolved.stripeEnvironment}"`,
      error: resolved.error,
    };
  }
  const unresolvedKeys = plannedKeys.filter((key) => !resolved.values[key]);
  if (unresolvedKeys.length > 0) {
    return {
      success: false,
      message: `Stripe catalog bindings are incomplete for "${params.service.name}"`,
      error: `No active, matching Stripe value is bound for ${unresolvedKeys.join(', ')}. Re-run hv_plan.`,
    };
  }
  const changedAfterPlan = Object.keys(plannedHashes).filter((key) =>
    plannedHashes[key] !== hashEnvValue(resolved.values[key])
  );
  if (changedAfterPlan.length > 0) {
    return {
      success: false,
      message: `Stripe environment "${resolved.stripeEnvironment}" changed after planning`,
      error: `Resolved Stripe values changed for ${changedAfterPlan.join(', ')}. Re-run hv_plan before apply.`,
      data: {
        stripeEnvironment: resolved.stripeEnvironment,
        keys: changedAfterPlan,
      },
    };
  }

  let removedData: Record<string, unknown> | undefined;
  if (plannedRemoveKeys.length > 0) {
    const removed = await removeHostingEnvVars({
      project: params.project,
      environment: params.environment,
      service: params.service,
      keys: plannedRemoveKeys,
    });
    if (!removed.success) {
      return {
        success: false,
        message: `Failed to remove retired Stripe runtime variables from "${params.service.name}"`,
        error: removed.error ?? removed.message,
        data: {
          stripeEnvironment: resolved.stripeEnvironment,
          service: params.service.name,
          keys: plannedRemoveKeys,
        },
      };
    }
    removedData = removed.data as Record<string, unknown> | undefined;
  }
  const vars = Object.fromEntries(plannedKeys.map((key) => [key, resolved.values[key]]));
  const synced = plannedKeys.length > 0
    ? await syncHostingEnvVars({
      project: params.project,
      environment: params.environment,
      service: params.service,
      vars,
      deferDeployment: params.environmentSpec.deploy?.strategy === 'branch'
        && params.environmentSpec.deploy.trigger === 'ci',
    })
    : {
      success: true as const,
      message: 'No current Stripe variables to sync',
      provider: 'none',
      data: undefined,
    };
  if (!synced.success) {
    return {
      success: false,
      message: `Failed to sync Stripe runtime variables to "${params.service.name}"`,
      error: synced.error ?? synced.message,
      data: {
        stripeEnvironment: resolved.stripeEnvironment,
        service: params.service.name,
        keys: plannedKeys,
      },
    };
  }
  const syncedData = synced.data as Record<string, unknown> | undefined;
  const rolloutData = syncedData?.runtimeRolloutRequired === true
    ? syncedData
    : removedData?.runtimeRolloutRequired === true
      ? removedData
      : undefined;

  return {
    success: true,
    message: `Converged Stripe runtime variables from "${resolved.stripeEnvironment}" on "${params.service.name}"`,
    data: {
      stripeEnvironment: resolved.stripeEnvironment,
      stripeMode: resolved.mode,
      hostingProvider: synced.provider,
      service: params.service.name,
      keys: plannedKeys,
      removedKeys: plannedRemoveKeys,
      variableCount: plannedKeys.length,
      ...(syncedData?.deploymentDeferred === true || removedData?.deploymentDeferred === true
        ? { deploymentDeferred: true }
        : {}),
      ...(rolloutData
        ? {
            runtimeRolloutRequired: true,
            ...(rolloutData.rolloutBaseline
              ? { rolloutBaseline: rolloutData.rolloutBaseline }
              : {}),
          }
        : {}),
    },
  };
}

function webhookSpecMatchesAction(
  spec: StripeWebhookSpec,
  action: PlanAction
): boolean {
  const metadata = action.metadata ?? {};
  const events = stringArray(metadata.events);
  return metadata.url === spec.url
    && metadata.service === spec.service
    && metadata.envVar === spec.envVar
    && Boolean(events)
    && normalizedEvents(events ?? []).join('\0') === normalizedEvents(spec.events).join('\0');
}

async function deleteStripeWebhookAndVerify(params: {
  adapter: StripeAdapter;
  mode: 'sandbox' | 'live';
  endpointId: string;
}): Promise<{ success: true; alreadyAbsent: boolean } | { success: false; error: string }> {
  try {
    const existing = await params.adapter.getWebhookEndpoint(params.mode, params.endpointId);
    if (!existing) return { success: true, alreadyAbsent: true };
    const deleted = await params.adapter.deleteWebhookEndpoint(params.mode, params.endpointId);
    if (!deleted.deleted) {
      return {
        success: false,
        error: `Stripe did not confirm deletion of webhook endpoint ${params.endpointId}.`,
      };
    }
    const remaining = await params.adapter.getWebhookEndpoint(params.mode, params.endpointId);
    return remaining
      ? {
        success: false,
        error: `Stripe webhook endpoint ${params.endpointId} still exists after deletion.`,
      }
      : { success: true, alreadyAbsent: false };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyStripeWebhookAction(params: {
  project: Project;
  environment: Environment;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<{
  success: boolean;
  status?: 'blocked';
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}> {
  const metadata = params.action.metadata ?? {};
  const operation = typeof metadata.operation === 'string' ? metadata.operation : '';
  const name = typeof metadata.webhookName === 'string'
    ? metadata.webhookName
    : params.action.resource.name;
  const plannedEnvironment = typeof metadata.stripeEnvironment === 'string'
    ? metadata.stripeEnvironment
    : '';
  const endpointId = typeof metadata.endpointId === 'string' ? metadata.endpointId : undefined;
  const currentBindings = parseStripeBindings(params.environment);
  const binding = currentBindings.webhooks[name];
  const stripeSpec = params.environmentSpec.payments?.stripe;
  const currentSpec = stripeSpec?.webhooks?.[name];
  const currentEnvironment = stripeSpec
    ? stripeEnvironmentName(params.environment.name, stripeSpec)
    : currentBindings.environment?.trim() || params.environment.name;

  if (!plannedEnvironment || plannedEnvironment !== currentEnvironment) {
    return {
      success: false,
      message: `Stripe webhook "${name}" plan is stale`,
      error: 'The Stripe environment mapping changed after planning. Re-run hv_plan.',
    };
  }
  if (metadata.blockedReason) {
    return {
      success: false,
      status: 'blocked',
      message: params.action.reason,
      error: String(metadata.blockedReason),
    };
  }

  const stripe = getStripeAdapter(plannedEnvironment, { verifiedOnly: true });
  if ('error' in stripe) {
    return {
      success: false,
      status: 'blocked',
      message: `Stripe environment "${plannedEnvironment}" is unavailable`,
      error: stripe.error,
    };
  }

  if (operation === STRIPE_WEBHOOK_OPERATIONS.destroy) {
    if (currentSpec) {
      return {
        success: false,
        message: `Stripe webhook "${name}" is still declared`,
        error: 'The spec changed after planning. Re-run hv_plan.',
      };
    }
    if (!binding || !endpointId || binding.endpointId !== endpointId) {
      return {
        success: false,
        message: `Stripe webhook "${name}" destroy plan is stale`,
        error: 'Its durable provider binding changed after planning. Re-run hv_plan.',
      };
    }

    const deleted = await deleteStripeWebhookAndVerify({
      adapter: stripe.adapter,
      mode: stripe.mode,
      endpointId,
    });
    if (!deleted.success) {
      return {
        success: false,
        message: `Failed to delete Stripe webhook "${name}"`,
        error: deleted.error,
      };
    }

    const service = serviceRepo.findByProjectAndName(params.project.id, binding.service);
    if (!service) {
      return {
        success: false,
        message: `Stripe webhook "${name}" endpoint is absent, but hosting cleanup is incomplete`,
        error: `Service "${binding.service}" is not tracked locally, so ${binding.envVar} could not be removed. The binding was preserved for retry.`,
        data: { endpointId, providerAbsent: true, bindingPreserved: true },
      };
    }
    const removed = await removeHostingEnvVars({
      project: params.project,
      environment: params.environment,
      service,
      keys: [binding.envVar],
    });
    if (!removed.success) {
      return {
        success: false,
        message: `Stripe webhook "${name}" endpoint is absent, but hosting cleanup failed`,
        error: removed.error ?? removed.message,
        data: {
          endpointId,
          providerAbsent: true,
          bindingPreserved: true,
          service: binding.service,
          envVar: binding.envVar,
        },
      };
    }

    const nextBindings = { ...currentBindings.webhooks };
    delete nextBindings[name];
    persistStripeWebhookBindings(params.environment, plannedEnvironment, nextBindings);
    return {
      success: true,
      message: `Deleted Stripe webhook "${name}" and removed ${binding.envVar} from "${binding.service}"`,
      data: {
        endpointId,
        alreadyAbsent: deleted.alreadyAbsent,
        service: binding.service,
        envVar: binding.envVar,
        ...((removed.data as Record<string, unknown> | undefined)?.deploymentDeferred === true
          ? { deploymentDeferred: true }
          : {}),
        ...((removed.data as Record<string, unknown> | undefined)?.runtimeRolloutRequired === true
          ? {
              runtimeRolloutRequired: true,
              ...((removed.data as Record<string, unknown>).rolloutBaseline
                ? { rolloutBaseline: (removed.data as Record<string, unknown>).rolloutBaseline }
                : {}),
            }
          : {}),
      },
    };
  }

  if (!currentSpec || !webhookSpecMatchesAction(currentSpec, params.action)) {
    return {
      success: false,
      message: `Stripe webhook "${name}" plan is stale`,
      error: 'The webhook URL, events, service, or envVar changed after planning. Re-run hv_plan.',
    };
  }
  const service = serviceRepo.findByProjectAndName(params.project.id, currentSpec.service);
  if (!service) {
    return {
      success: false,
      message: `Cannot converge Stripe webhook "${name}"`,
      error: `Service "${currentSpec.service}" is not tracked locally.`,
    };
  }

  if (operation === STRIPE_WEBHOOK_OPERATIONS.adopt) {
    const valueHash = typeof metadata.valueHash === 'string' ? metadata.valueHash : undefined;
    if (binding || !endpointId || !valueHash) {
      return {
        success: false,
        message: `Stripe webhook "${name}" adoption plan is stale`,
        error: 'The provider identity, hosting value hash, or local binding changed after planning. Re-run hv_plan.',
      };
    }
    try {
      const endpoint = await stripe.adapter.getWebhookEndpoint(stripe.mode, endpointId);
      if (!endpoint) {
        return {
          success: false,
          message: `Cannot adopt Stripe webhook "${name}"`,
          error: `Endpoint ${endpointId} is absent. Re-run hv_plan.`,
        };
      }
      if (endpoint.url !== currentSpec.url) {
        return {
          success: false,
          message: `Cannot adopt Stripe webhook "${name}"`,
          error: 'The endpoint URL changed after planning. Re-run hv_plan.',
        };
      }
      if (!webhookConfigMatches(endpoint, currentSpec)) {
        await stripe.adapter.updateWebhookEndpoint(stripe.mode, endpointId, {
          url: currentSpec.url,
          enabled_events: normalizedEvents(currentSpec.events),
          description: `${params.project.name} - ${params.environment.name} (${name})`,
          disabled: false,
        });
      }
      persistStripeWebhookBindings(params.environment, plannedEnvironment, {
        ...currentBindings.webhooks,
        [name]: {
          endpointId,
          url: currentSpec.url,
          events: normalizedEvents(currentSpec.events),
          service: currentSpec.service,
          envVar: currentSpec.envVar,
          valueHash,
          updatedAt: new Date().toISOString(),
        },
      });
      return {
        success: true,
        message: `Adopted existing Stripe webhook "${name}" without rotating its signing value`,
        data: {
          endpointId,
          service: currentSpec.service,
          envVar: currentSpec.envVar,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to adopt Stripe webhook "${name}"`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (operation !== STRIPE_WEBHOOK_OPERATIONS.ensure) {
    return {
      success: false,
      status: 'blocked',
      message: `No action-scoped handler exists for Stripe webhook "${name}"`,
      error: `Unrecognized Stripe webhook operation "${operation}".`,
    };
  }

  if (params.action.type === 'update') {
    if (!binding || !endpointId || binding.endpointId !== endpointId) {
      return {
        success: false,
        message: `Stripe webhook "${name}" update plan is stale`,
        error: 'Its durable provider binding changed after planning. Re-run hv_plan.',
      };
    }
    try {
      const endpoint = await stripe.adapter.getWebhookEndpoint(stripe.mode, endpointId);
      if (!endpoint) {
        return {
          success: false,
          message: `Cannot update Stripe webhook "${name}"`,
          error: `Endpoint ${endpointId} is absent. Re-run hv_plan to plan a replacement.`,
        };
      }
      if (!webhookConfigMatches(endpoint, currentSpec)) {
        await stripe.adapter.updateWebhookEndpoint(stripe.mode, endpointId, {
          url: currentSpec.url,
          enabled_events: normalizedEvents(currentSpec.events),
          description: `${params.project.name} - ${params.environment.name} (${name})`,
          disabled: false,
        });
      }
      persistStripeWebhookBindings(params.environment, plannedEnvironment, {
        ...currentBindings.webhooks,
        [name]: {
          ...binding,
          url: currentSpec.url,
          events: normalizedEvents(currentSpec.events),
          updatedAt: new Date().toISOString(),
        },
      });
      return {
        success: true,
        message: `Updated Stripe webhook "${name}" without rotating its signing value`,
        data: { endpointId, service: binding.service, envVar: binding.envVar },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update Stripe webhook "${name}"`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (params.action.type !== 'create' && params.action.type !== 'replace') {
    return {
      success: false,
      message: `Stripe webhook "${name}" ensure plan is invalid`,
      error: `Expected create or replace, received ${params.action.type}.`,
    };
  }
  if (params.action.type === 'create' && binding) {
    return {
      success: false,
      message: `Stripe webhook "${name}" create plan is stale`,
      error: 'A durable provider binding now exists. Re-run hv_plan.',
    };
  }
  if (params.action.type === 'replace') {
    if (!endpointId) {
      return {
        success: false,
        message: `Stripe webhook "${name}" replacement plan is invalid`,
        error: 'The reviewed action did not identify the endpoint being replaced.',
      };
    }
    if (binding && binding.endpointId !== endpointId) {
      return {
        success: false,
        message: `Stripe webhook "${name}" replacement plan is stale`,
        error: 'Its durable provider binding changed after planning. Re-run hv_plan.',
      };
    }
    const deleted = await deleteStripeWebhookAndVerify({
      adapter: stripe.adapter,
      mode: stripe.mode,
      endpointId,
    });
    if (!deleted.success) {
      return {
        success: false,
        message: `Failed to replace Stripe webhook "${name}"`,
        error: `The existing endpoint could not be deleted and verified absent: ${deleted.error}`,
      };
    }
  }

  let created: StripeWebhookEndpoint;
  try {
    created = await stripe.adapter.createWebhookEndpoint(
      stripe.mode,
      currentSpec.url,
      normalizedEvents(currentSpec.events),
      {
        description: `${params.project.name} - ${params.environment.name} (${name})`,
        metadata: {
          hypervibe_project: params.project.name,
          hypervibe_environment: params.environment.name,
          hypervibe_webhook: name,
        },
      }
    );
  } catch (error) {
    return {
      success: false,
      message: `Failed to create Stripe webhook "${name}"`,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!created.secret) {
    const rollback = await deleteStripeWebhookAndVerify({
      adapter: stripe.adapter,
      mode: stripe.mode,
      endpointId: created.id,
    });
    if (!rollback.success) {
      persistStripeWebhookBindings(params.environment, plannedEnvironment, {
        ...currentBindings.webhooks,
        [name]: {
          endpointId: created.id,
          url: currentSpec.url,
          events: normalizedEvents(currentSpec.events),
          service: currentSpec.service,
          envVar: currentSpec.envVar,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return {
      success: false,
      message: `Stripe webhook "${name}" did not return a signing value`,
      error: rollback.success
        ? 'The new endpoint was deleted. Re-run hv_plan before retrying.'
        : `The new endpoint could not be rolled back: ${rollback.error}`,
      data: {
        endpointId: created.id,
        rollback: rollback.success ? 'succeeded' : 'failed',
        bindingRecorded: !rollback.success,
      },
    };
  }

  const valueHash = hashEnvValue(created.secret);
  const synced = await syncHostingEnvVars({
    project: params.project,
    environment: params.environment,
    service,
    vars: { [currentSpec.envVar]: created.secret },
    deferDeployment: params.environmentSpec.deploy?.strategy === 'branch'
      && params.environmentSpec.deploy.trigger === 'ci',
  });
  if (!synced.success) {
    const rollback = await deleteStripeWebhookAndVerify({
      adapter: stripe.adapter,
      mode: stripe.mode,
      endpointId: created.id,
    });
    if (!rollback.success) {
      persistStripeWebhookBindings(params.environment, plannedEnvironment, {
        ...currentBindings.webhooks,
        [name]: {
          endpointId: created.id,
          url: currentSpec.url,
          events: normalizedEvents(currentSpec.events),
          service: currentSpec.service,
          envVar: currentSpec.envVar,
          valueHash,
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return {
      success: false,
      message: `Failed to sync the signing value for Stripe webhook "${name}"`,
      error: rollback.success
        ? `${synced.error ?? synced.message} The new endpoint was rolled back.`
        : `${synced.error ?? synced.message} Rollback also failed: ${rollback.error}`,
      data: {
        endpointId: created.id,
        service: currentSpec.service,
        envVar: currentSpec.envVar,
        rollback: rollback.success ? 'succeeded' : 'failed',
        bindingRecorded: !rollback.success,
      },
    };
  }

  persistStripeWebhookBindings(params.environment, plannedEnvironment, {
    ...currentBindings.webhooks,
    [name]: {
      endpointId: created.id,
      url: currentSpec.url,
      events: normalizedEvents(currentSpec.events),
      service: currentSpec.service,
      envVar: currentSpec.envVar,
      valueHash,
      updatedAt: new Date().toISOString(),
    },
  });
  return {
    success: true,
    message: `${params.action.type === 'replace' ? 'Replaced' : 'Created'} Stripe webhook "${name}" and synced its signing value to "${currentSpec.service}"`,
    data: {
      endpointId: created.id,
      stripeEnvironment: plannedEnvironment,
      stripeMode: stripe.mode,
      hostingProvider: synced.provider,
      service: currentSpec.service,
      envVar: currentSpec.envVar,
      ...((synced.data as Record<string, unknown> | undefined)?.deploymentDeferred === true
        ? { deploymentDeferred: true }
        : {}),
      ...((synced.data as Record<string, unknown> | undefined)?.runtimeRolloutRequired === true
        ? {
            runtimeRolloutRequired: true,
            ...((synced.data as Record<string, unknown>).rolloutBaseline
              ? { rolloutBaseline: (synced.data as Record<string, unknown>).rolloutBaseline }
              : {}),
          }
        : {}),
    },
  };
}
