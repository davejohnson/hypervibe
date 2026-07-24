import type {
  StripePrice,
  StripeProduct,
} from '../../adapters/providers/stripe/stripe.adapter.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
import type { Service } from '../entities/service.entity.js';
import { hashEnvValue, type ObservedState } from '../ports/observe.port.js';
import type { PlanAction } from '../plan/plan.types.js';
import type {
  EnvironmentSpec,
  StripeEnvironmentSyncSpec,
  StripePriceEnvBindingSpec,
} from '../spec/spec.schema.js';
import { syncHostingEnvVars } from './hosting-env.service.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { getStripeAdapter } from './stripe-ops.service.js';

export const STRIPE_HOSTING_ENV_SYNC_OPERATION = 'stripeHostingEnvSync';

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

export function stripeEnvironmentName(
  environmentName: string,
  spec: StripeEnvironmentSyncSpec
): string {
  return spec.environment?.trim() || environmentName;
}

export function stripeTargetServiceNames(environmentSpec: EnvironmentSpec): string[] {
  const stripe = environmentSpec.payments?.stripe;
  if (!stripe) return [];
  return [...(stripe.services ?? Object.keys(environmentSpec.services))].sort();
}

export function stripeManagedEnvKeys(environmentSpec: EnvironmentSpec): string[] {
  const stripe = environmentSpec.payments?.stripe;
  if (!stripe) return [];
  return [
    ...Object.keys(stripe.prices),
    ...(stripe.credentials
      ? [
        stripe.credentials.secretKeyEnvVar,
        ...(stripe.credentials.publishableKeyEnvVar ? [stripe.credentials.publishableKeyEnvVar] : []),
      ]
      : []),
  ].sort();
}

function productMatches(product: StripeProduct, selector: StripePriceEnvBindingSpec): boolean {
  if (selector.product.startsWith('prod_')) {
    return product.id === selector.product;
  }
  const actual = product.name.trim().toLowerCase();
  const wanted = selector.product.trim().toLowerCase();
  return selector.match === 'contains' ? actual.includes(wanted) : actual === wanted;
}

/**
 * Resolve selectors without ever returning price ids in diagnostics. Stripe
 * ids become hosting env values only inside the apply/provider boundary.
 */
export function resolveStripePriceEnvValues(
  bindings: Record<string, StripePriceEnvBindingSpec>,
  products: StripeProduct[],
  prices: StripePrice[]
): { success: true; values: Record<string, string> } | { success: false; error: string } {
  const values: Record<string, string> = {};

  for (const [envVar, selector] of Object.entries(bindings)) {
    const matchingProducts = products.filter((product) => productMatches(product, selector));
    if (matchingProducts.length !== 1) {
      return {
        success: false,
        error: matchingProducts.length === 0
          ? `${envVar}: no active Stripe product matches "${selector.product}" (${selector.match})`
          : `${envVar}: "${selector.product}" (${selector.match}) matches ${matchingProducts.length} active Stripe products; use an exact product name or prod_ id`,
      };
    }

    const productId = matchingProducts[0].id;
    const matchingPrices = prices.filter((price) => {
      if (price.product !== productId || price.recurring?.interval !== selector.interval) return false;
      if (selector.currency && price.currency.toLowerCase() !== selector.currency) return false;
      if (selector.nickname && price.nickname !== selector.nickname) return false;
      if (selector.lookupKey && price.lookup_key !== selector.lookupKey) return false;
      return true;
    });
    if (matchingPrices.length !== 1) {
      return {
        success: false,
        error: matchingPrices.length === 0
          ? `${envVar}: no active ${selector.interval} price matches product "${selector.product}"`
          : `${envVar}: ${matchingPrices.length} active ${selector.interval} prices match product "${selector.product}"; add currency, nickname, or lookupKey`,
      };
    }
    values[envVar] = matchingPrices[0].id;
  }

  return { success: true, values };
}

export async function resolveStripeEnvironmentValues(params: {
  environmentName: string;
  spec: StripeEnvironmentSyncSpec;
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

    if (Object.keys(params.spec.prices).length > 0) {
      const [products, prices] = await Promise.all([
        stripe.adapter.listProducts(stripe.mode),
        stripe.adapter.listPrices(stripe.mode),
      ]);
      const resolvedPrices = resolveStripePriceEnvValues(params.spec.prices, products, prices);
      if (!resolvedPrices.success) {
        return {
          success: false,
          stripeEnvironment: target,
          error: `Stripe environment "${target}" price selection failed: ${resolvedPrices.error}`,
        };
      }
      Object.assign(values, resolvedPrices.values);
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

export async function planStripeEnvironmentSync(params: {
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
}): Promise<{
  actions: PlanAction[];
  warnings: string[];
  blocked: Array<{ provider: string; reason: string; scope: string; policy: 'hard' }>;
  fingerprint?: string;
}> {
  const stripeSpec = params.environmentSpec.payments?.stripe;
  if (!stripeSpec) return { actions: [], warnings: [], blocked: [] };

  const stripeEnvironment = stripeEnvironmentName(params.environmentName, stripeSpec);
  const managedKeys = stripeManagedEnvKeys(params.environmentSpec);
  const targetServices = stripeTargetServiceNames(params.environmentSpec);
  const resolved = await resolveStripeEnvironmentValues({
    environmentName: params.environmentName,
    spec: stripeSpec,
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
  const actions = targetServices.map<PlanAction>((serviceName) => {
    const live = observedServices.get(serviceName);
    const driftedKeys = resolved.success && live
      ? managedKeys.filter((key) => live.envVarHashes[key] !== hashEnvValue(resolved.values[key]))
      : managedKeys;
    const inSync = resolved.success && Boolean(live) && driftedKeys.length === 0;

    return {
      id: `payment:stripe:${stripeEnvironment}:hosting-env:${serviceName}`,
      type: inSync ? 'noop' : 'update',
      resource: { kind: 'payment', name: serviceName, provider: 'stripe' },
      verified: resolved.success && params.observed !== null,
      reason: inSync
        ? `Stripe environment "${stripeEnvironment}" runtime variables are in sync on "${serviceName}"`
        : resolved.success
          ? `Sync ${driftedKeys.length} Stripe-managed runtime variable(s) from "${stripeEnvironment}" to "${serviceName}"`
          : `Stripe environment "${stripeEnvironment}" could not be resolved; sync remains blocked`,
      ...(!inSync
        ? { diff: driftedKeys.map((key) => ({ field: `env:${key}` })) }
        : {}),
      metadata: {
        operation: STRIPE_HOSTING_ENV_SYNC_OPERATION,
        stripeEnvironment,
        service: serviceName,
        keys: managedKeys,
        ...(resolved.success
          ? {
            valueHashes: Object.fromEntries(
              managedKeys.map((key) => [key, hashEnvValue(resolved.values[key])])
            ),
          }
          : {}),
      },
    };
  });

  return {
    actions,
    warnings,
    blocked,
    ...(resolved.success ? { fingerprint: stripeResolutionFingerprint(resolved) } : {}),
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
  if (!stripeSpec) {
    return {
      success: false,
      message: 'Stripe hosting environment sync is no longer declared',
      error: 'The project spec changed after planning. Re-run hv_plan.',
    };
  }

  const plannedKeys = Array.isArray(params.action.metadata?.keys)
    ? params.action.metadata.keys.filter((key): key is string => typeof key === 'string')
    : [];
  const currentKeys = stripeManagedEnvKeys(params.environmentSpec);
  const plannedHashes = params.action.metadata?.valueHashes
    && typeof params.action.metadata.valueHashes === 'object'
    && !Array.isArray(params.action.metadata.valueHashes)
    ? params.action.metadata.valueHashes as Record<string, unknown>
    : null;
  if (
    plannedKeys.length === 0
    || plannedKeys.length !== currentKeys.length
    || plannedKeys.some((key, index) => key !== currentKeys[index])
    || !plannedHashes
    || plannedKeys.some((key) => typeof plannedHashes[key] !== 'string')
  ) {
    return {
      success: false,
      message: 'Stripe hosting environment sync plan is stale',
      error: 'Managed Stripe key names changed after planning. Re-run hv_plan.',
    };
  }

  const resolved = await resolveStripeEnvironmentValues({
    environmentName: params.environment.name,
    spec: stripeSpec,
    verifiedConnection: true,
  });
  if (!resolved.success) {
    return {
      success: false,
      message: `Could not resolve Stripe environment "${resolved.stripeEnvironment}"`,
      error: resolved.error,
    };
  }
  const changedAfterPlan = plannedKeys.filter((key) =>
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

  const vars = Object.fromEntries(plannedKeys.map((key) => [key, resolved.values[key]]));
  const synced = await syncHostingEnvVars({
    project: params.project,
    environment: params.environment,
    service: params.service,
    vars,
    deferDeployment: params.environmentSpec.deploy?.strategy === 'branch'
      && params.environmentSpec.deploy.trigger === 'ci',
  });
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

  return {
    success: true,
    message: `Synced ${plannedKeys.length} Stripe runtime variable(s) from "${resolved.stripeEnvironment}" to "${params.service.name}"`,
    data: {
      stripeEnvironment: resolved.stripeEnvironment,
      stripeMode: resolved.mode,
      hostingProvider: synced.provider,
      service: params.service.name,
      keys: plannedKeys,
      variableCount: plannedKeys.length,
      ...((synced.data as Record<string, unknown> | undefined)?.deploymentDeferred === true
        ? { deploymentDeferred: true }
        : {}),
    },
  };
}
