import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { StripeAdapter } from '../../adapters/providers/stripe/stripe.adapter.js';
import type { StripeCredentials } from '../../adapters/providers/stripe/stripe.adapter.js';

const connectionRepo = new ConnectionRepository();

export function getStripeAdapter(): { adapter: StripeAdapter; credentials: StripeCredentials } | { error: string } {
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
