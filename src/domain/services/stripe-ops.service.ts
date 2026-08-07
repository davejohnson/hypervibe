import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter, stripeApiKeyMode } from '../../adapters/providers/stripe/stripe.adapter.js';
import type { StripeCredentials, StripeMode } from '../../adapters/providers/stripe/stripe.adapter.js';
import type { Connection } from '../entities/connection.entity.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const connectionRepo = new ConnectionRepository();

export function stripeModeForEnvironment(
  environment: string,
  credentials: StripeCredentials
): StripeMode {
  if (credentials.secretKey) {
    return stripeApiKeyMode(credentials.secretKey) ?? 'sandbox';
  }
  return ['live', 'production', 'prod'].includes(environment.trim().toLowerCase())
    ? 'live'
    : 'sandbox';
}

function stripeConnection(environment?: string, verifiedOnly = false): Connection | null {
  if (!environment) {
    const global = connectionRepo.findByProvider('stripe');
    return !verifiedOnly || global?.status === 'verified' ? global : null;
  }
  return verifiedOnly
    ? connectionRepo.findBestVerifiedMatch('stripe', environment)
    : connectionRepo.findBestMatch('stripe', environment);
}

export function getStripeAdapter(
  environment?: string,
  options: { verifiedOnly?: boolean } = {}
): { adapter: StripeAdapter; credentials: StripeCredentials; connection: Connection; mode: StripeMode } | { error: string } {
  const connection = stripeConnection(environment, options.verifiedOnly === true);
  if (!connection) {
    return {
      error: `No ${options.verifiedOnly ? 'verified ' : ''}Stripe connection found${environment ? ` for environment scope "${environment}"` : ''}. ${formatConnectionGuidance('stripe', { scope: environment })}`,
    };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<StripeCredentials>(connection.credentialsEncrypted);
  const adapter = new StripeAdapter();
  adapter.connect(credentials);
  const mode = stripeModeForEnvironment(environment ?? connection.scope ?? 'sandbox', credentials);
  if (credentials.secretKey && !connection.scope) {
    if (!environment) {
      return {
        error: `The global Stripe connection contains one environment-scoped secretKey, but this operation did not select an environment. Reconnect it with scope="development", scope="staging", or scope="production". ${formatConnectionGuidance('stripe')}`,
      };
    }
    const canonicalProduction = ['live', 'production', 'prod'].includes(environment.trim().toLowerCase());
    if ((canonicalProduction && mode !== 'live') || (!canonicalProduction && mode === 'live')) {
      return {
        error: `The unscoped Stripe ${mode} key cannot safely target environment "${environment}". Reconnect the key with scope="${environment}" so the mapping is explicit. ${formatConnectionGuidance('stripe', { scope: environment })}`,
      };
    }
  }
  try {
    adapter.getRuntimeCredentials(mode);
  } catch (error) {
    return {
      error: `Stripe connection ${connection.scope ? `scope "${connection.scope}"` : 'global'} cannot target "${environment ?? mode}": ${error instanceof Error ? error.message : String(error)} ${formatConnectionGuidance('stripe', { scope: environment })}`,
    };
  }

  return { adapter, credentials, connection, mode };
}

export type StripeWebhookStatusRead =
  | {
    success: true;
    mode: StripeMode;
    webhooks: Array<{
      id: string;
      url: string;
      status: string;
      enabledEvents: number;
      description?: string | null;
    }>;
  }
  | {
    success: false;
    code: 'MISSING_CONNECTION' | 'VALIDATION' | 'PROVIDER_ERROR';
    error: string;
  };

/** Read webhook status through the same environment-scoped Stripe connection as reconciliation. */
export async function fetchStripeWebhookStatuses(
  environment: string,
  requestedMode?: StripeMode
): Promise<StripeWebhookStatusRead> {
  const stripe = getStripeAdapter(environment, { verifiedOnly: true });
  if ('error' in stripe) {
    return { success: false, code: 'MISSING_CONNECTION', error: stripe.error };
  }
  if (requestedMode && requestedMode !== stripe.mode) {
    return {
      success: false,
      code: 'VALIDATION',
      error: `Stripe environment "${environment}" uses ${stripe.mode} mode, not requested ${requestedMode} mode.`,
    };
  }

  try {
    const webhooks = await stripe.adapter.listWebhookEndpoints(stripe.mode);
    return {
      success: true,
      mode: stripe.mode,
      webhooks: webhooks.map((webhook) => ({
        id: webhook.id,
        url: webhook.url,
        status: webhook.status,
        enabledEvents: webhook.enabled_events.length,
        description: webhook.description,
      })),
    };
  } catch (error) {
    return {
      success: false,
      code: 'PROVIDER_ERROR',
      error: `Stripe webhook inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
