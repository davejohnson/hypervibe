import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type {
  CloudflareCredentials,
  CloudflareEmailRoutingAddress,
  CloudflareEmailRoutingRule,
  CloudflareZone,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';

const connectionRepo = new ConnectionRepository();

type CloudflareEmailContext = {
  adapter: CloudflareAdapter;
  zone: CloudflareZone;
  accountId: string;
  provider: 'cloudflare';
};

function getCloudflareAdapter(domain: string): { adapter: CloudflareAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', domain);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use hv_connect provider=cloudflare first. Recommended: export the API token and pass credentialsRef="env:CLOUDFLARE_API_TOKEN" credentialsKey="apiToken"; raw credentials={...} is still accepted if intentional.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export async function resolveCloudflareEmailContext(domain: string): Promise<CloudflareEmailContext | { error: string }> {
  const adapterResult = getCloudflareAdapter(domain);
  if ('error' in adapterResult) return { error: adapterResult.error };

  const zone = await adapterResult.adapter.findZoneByName(domain);
  if (!zone) {
    return {
      error: `Domain "${domain}" was not found in Cloudflare. Add the domain to Cloudflare or create a scoped Cloudflare connection for it.`,
    };
  }

  if (!zone.account?.id) {
    return {
      error: `Cloudflare zone "${domain}" did not include an account ID. Use an API token with Zone:Zone:Read plus Account Email Routing permissions.`,
    };
  }

  return {
    adapter: adapterResult.adapter,
    zone,
    accountId: zone.account.id,
    provider: 'cloudflare',
  };
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeAlias(address: string, domain: string): string {
  const trimmed = address.trim().toLowerCase();
  if (trimmed.includes('@')) {
    return trimmed;
  }
  return `${trimmed.replace(/^@/, '')}@${domain}`;
}

export function routingRuleForAddress(rule: CloudflareEmailRoutingRule, address: string): boolean {
  return rule.matchers.some((matcher) =>
    matcher.type === 'literal'
    && matcher.field === 'to'
    && matcher.value?.toLowerCase() === address.toLowerCase()
  );
}

export function forwardedTo(rule: CloudflareEmailRoutingRule): string[] {
  return rule.actions
    .filter((action) => action.type === 'forward')
    .flatMap((action) => action.value ?? []);
}

export function isVerifiedDestination(address: CloudflareEmailRoutingAddress): boolean {
  return Boolean(address.verified);
}

export function summarizeDestination(address: CloudflareEmailRoutingAddress) {
  return {
    id: address.id,
    email: address.email,
    verified: isVerifiedDestination(address),
    verifiedAt: address.verified,
  };
}

export function summarizeRule(rule: CloudflareEmailRoutingRule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    forwardsTo: forwardedTo(rule),
    matchers: rule.matchers,
    actions: rule.actions,
  };
}

export function rulePayload(address: string, forwardTo: string) {
  return {
    name: `Forward ${address} to ${forwardTo}`,
    enabled: true,
    matchers: [{
      type: 'literal' as const,
      field: 'to' as const,
      value: address,
    }],
    actions: [{
      type: 'forward' as const,
      value: [forwardTo],
    }],
  };
}

export function catchAllPayload(action: 'drop' | 'forward', forwardTo: string | undefined, enabled: boolean) {
  return {
    name: action === 'forward' && forwardTo ? `Catch-all forward to ${forwardTo}` : 'Catch-all drop',
    enabled,
    matchers: [{ type: 'all' as const }],
    actions: action === 'forward'
      ? [{ type: 'forward' as const, value: [forwardTo!] }]
      : [{ type: 'drop' as const }],
  };
}

export async function ensureDestination(
  adapter: CloudflareAdapter,
  accountId: string,
  forwardTo: string,
  confirm: boolean
): Promise<{
  destination?: CloudflareEmailRoutingAddress;
  destinationCreated?: boolean;
  plannedDestination?: { action: 'create_destination'; email: string };
}> {
  const addresses = await adapter.listEmailRoutingAddresses(accountId);
  const existing = addresses.find((address) => address.email.toLowerCase() === forwardTo.toLowerCase());
  if (existing) {
    return { destination: existing, destinationCreated: false };
  }

  if (!confirm) {
    return {
      plannedDestination: {
        action: 'create_destination',
        email: forwardTo,
      },
    };
  }

  const created = await adapter.createEmailRoutingAddress(accountId, forwardTo);
  return { destination: created, destinationCreated: true };
}
