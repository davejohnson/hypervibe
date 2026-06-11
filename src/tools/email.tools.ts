import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type {
  CloudflareCredentials,
  CloudflareEmailRoutingAddress,
  CloudflareEmailRoutingRule,
  CloudflareZone,
} from '../adapters/providers/cloudflare/cloudflare.adapter.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

type EmailToolResponse = Record<string, unknown>;

type CloudflareEmailContext = {
  adapter: CloudflareAdapter;
  zone: CloudflareZone;
  accountId: string;
  provider: 'cloudflare';
};

function response(data: EmailToolResponse) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data),
    }],
  };
}

function getCloudflareAdapter(domain: string): { adapter: CloudflareAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', domain);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use connection_create with provider=cloudflare first.' };
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

export function registerEmailTools(server: McpServer): void {
  server.tool(
    'email_address_create',
    'Create or update an email forwarding address. Cloudflare-backed domains create Email Routing aliases that forward to a verified destination.',
    {
      domain: z.string().describe('Domain name, e.g. example.com'),
      address: z.string().describe('Alias to create, e.g. support or support@example.com'),
      forwardTo: z.string().email().describe('Destination mailbox, e.g. a Gmail address. Cloudflare will send verification if needed.'),
      provider: z.enum(['cloudflare']).optional().describe('Email routing provider (default: cloudflare)'),
      replace: z.boolean().optional().describe('Replace an existing route for this address if it forwards somewhere else'),
      enableRoutingDns: z.boolean().optional().describe('Enable/repair Cloudflare Email Routing DNS records before creating the rule (default true)'),
      confirm: z.boolean().optional().describe('Set true to create/update Cloudflare resources'),
    },
    async ({ domain, address, forwardTo, provider = 'cloudflare', replace = false, enableRoutingDns = true, confirm = false }) => {
      if (provider !== 'cloudflare') {
        return response({ success: false, error: `Unsupported email provider: ${provider}` });
      }

      const normalizedDomain = normalizeDomain(domain);
      const alias = normalizeAlias(address, normalizedDomain);
      const destinationEmail = normalizeEmail(forwardTo);

      if (!alias.endsWith(`@${normalizedDomain}`)) {
        return response({
          success: false,
          error: `Address ${alias} is not under domain ${normalizedDomain}`,
        });
      }

      try {
        const context = await resolveCloudflareEmailContext(normalizedDomain);
        if ('error' in context) return response({ success: false, error: context.error });

        const existingRules = await context.adapter.listEmailRoutingRules(context.zone.id);
        const existingRule = existingRules.find((rule) => routingRuleForAddress(rule, alias));
        const existingForwardsTo = existingRule ? forwardedTo(existingRule).map(normalizeEmail) : [];
        const destination = await ensureDestination(context.adapter, context.accountId, destinationEmail, confirm);

        if (existingRule && existingForwardsTo.includes(destinationEmail)) {
          return response({
            success: true,
            provider,
            domain: normalizedDomain,
            address: alias,
            forwardTo: destinationEmail,
            route: summarizeRule(existingRule),
            destination: destination.destination ? summarizeDestination(destination.destination) : undefined,
            destinationVerificationRequired: destination.destination ? !isVerifiedDestination(destination.destination) : true,
            message: `Email address ${alias} already forwards to ${destinationEmail}`,
          });
        }

        if (existingRule && !replace) {
          return response({
            success: false,
            provider,
            domain: normalizedDomain,
            address: alias,
            existingRoute: summarizeRule(existingRule),
            error: `Email address ${alias} already has a routing rule. Re-run with replace=true to update it.`,
          });
        }

        const plannedChanges: Array<Record<string, unknown>> = [];
        if (enableRoutingDns) {
          plannedChanges.push({ action: 'enable_email_routing_dns', domain: normalizedDomain });
        }
        if (destination.plannedDestination) {
          plannedChanges.push(destination.plannedDestination);
        }
        plannedChanges.push({
          action: existingRule ? 'update_route' : 'create_route',
          address: alias,
          forwardTo: destinationEmail,
        });

        if (!confirm) {
          return response({
            success: true,
            mode: 'preview',
            provider,
            domain: normalizedDomain,
            address: alias,
            forwardTo: destinationEmail,
            plannedChanges,
            message: 'Call again with confirm=true to create the forwarding address.',
          });
        }

        const dns = enableRoutingDns ? await context.adapter.enableEmailRoutingDns(context.zone.id) : undefined;
        const payload = rulePayload(alias, destinationEmail);
        const route = existingRule
          ? await context.adapter.updateEmailRoutingRule(context.zone.id, existingRule.id, payload)
          : await context.adapter.createEmailRoutingRule(context.zone.id, payload);

        auditRepo.create({
          action: existingRule ? 'email.address_updated' : 'email.address_created',
          resourceType: 'email_address',
          resourceId: alias,
          details: {
            provider,
            domain: normalizedDomain,
            forwardTo: destinationEmail,
            routeId: route.id,
            destinationCreated: destination.destinationCreated,
          },
        });

        const destinationVerificationRequired = destination.destination ? !isVerifiedDestination(destination.destination) : true;
        return response({
          success: true,
          mode: 'executed',
          provider,
          domain: normalizedDomain,
          address: alias,
          forwardTo: destinationEmail,
          route: summarizeRule(route),
          destination: destination.destination ? summarizeDestination(destination.destination) : undefined,
          destinationCreated: destination.destinationCreated,
          destinationVerificationRequired,
          dns,
          message: destinationVerificationRequired
            ? `${alias} was created, but ${destinationEmail} must accept Cloudflare's verification email before forwarding works.`
            : `${alias} now forwards to ${destinationEmail}.`,
        });
      } catch (error) {
        return response({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  server.tool(
    'email_address_list',
    'List email forwarding addresses for a domain.',
    {
      domain: z.string().describe('Domain name, e.g. example.com'),
      provider: z.enum(['cloudflare']).optional().describe('Email routing provider (default: cloudflare)'),
      includeDestinations: z.boolean().optional().describe('Include destination mailbox verification state'),
    },
    async ({ domain, provider = 'cloudflare', includeDestinations = true }) => {
      if (provider !== 'cloudflare') {
        return response({ success: false, error: `Unsupported email provider: ${provider}` });
      }

      const normalizedDomain = normalizeDomain(domain);
      try {
        const context = await resolveCloudflareEmailContext(normalizedDomain);
        if ('error' in context) return response({ success: false, error: context.error });

        const [settings, rules, catchAll, destinations] = await Promise.all([
          context.adapter.getEmailRoutingSettings(context.zone.id).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
          context.adapter.listEmailRoutingRules(context.zone.id),
          context.adapter.getEmailRoutingCatchAll(context.zone.id).catch(() => undefined),
          includeDestinations ? context.adapter.listEmailRoutingAddresses(context.accountId) : Promise.resolve([]),
        ]);

        return response({
          success: true,
          provider,
          domain: normalizedDomain,
          zoneId: context.zone.id,
          accountId: context.accountId,
          settings,
          count: rules.length,
          addresses: rules.map((rule) => ({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            address: rule.matchers.find((matcher) => matcher.type === 'literal' && matcher.field === 'to')?.value,
            forwardsTo: forwardedTo(rule),
          })),
          catchAll: catchAll ? summarizeRule(catchAll) : undefined,
          destinations: includeDestinations ? destinations.map(summarizeDestination) : undefined,
        });
      } catch (error) {
        return response({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  server.tool(
    'email_address_delete',
    'Delete an email forwarding address route. Destination mailbox records are preserved unless deleteDestination=true.',
    {
      domain: z.string().describe('Domain name, e.g. example.com'),
      address: z.string().describe('Alias to delete, e.g. support or support@example.com'),
      provider: z.enum(['cloudflare']).optional().describe('Email routing provider (default: cloudflare)'),
      deleteDestination: z.boolean().optional().describe('Also delete the destination address if no remaining rules forward to it'),
      confirm: z.boolean().optional().describe('Set true to delete Cloudflare resources'),
    },
    async ({ domain, address, provider = 'cloudflare', deleteDestination = false, confirm = false }) => {
      if (provider !== 'cloudflare') {
        return response({ success: false, error: `Unsupported email provider: ${provider}` });
      }

      const normalizedDomain = normalizeDomain(domain);
      const alias = normalizeAlias(address, normalizedDomain);

      try {
        const context = await resolveCloudflareEmailContext(normalizedDomain);
        if ('error' in context) return response({ success: false, error: context.error });

        const rules = await context.adapter.listEmailRoutingRules(context.zone.id);
        const rule = rules.find((candidate) => routingRuleForAddress(candidate, alias));
        if (!rule) {
          return response({
            success: true,
            provider,
            domain: normalizedDomain,
            address: alias,
            message: `No routing rule exists for ${alias}. No changes needed.`,
          });
        }

        const destinationsToMaybeDelete = forwardedTo(rule).map(normalizeEmail);
        const plannedChanges: Array<Record<string, unknown>> = [{
          action: 'delete_route',
          address: alias,
          routeId: rule.id,
        }];

        if (deleteDestination) {
          plannedChanges.push(...destinationsToMaybeDelete.map((email) => ({
            action: 'delete_destination_if_unused',
            email,
          })));
        }

        if (!confirm) {
          return response({
            success: true,
            mode: 'preview',
            provider,
            domain: normalizedDomain,
            address: alias,
            plannedChanges,
            message: 'Call again with confirm=true to delete the forwarding address.',
          });
        }

        await context.adapter.deleteEmailRoutingRule(context.zone.id, rule.id);
        const deletedDestinations: string[] = [];
        if (deleteDestination && destinationsToMaybeDelete.length > 0) {
          const remainingRules = rules.filter((candidate) => candidate.id !== rule.id);
          const destinations = await context.adapter.listEmailRoutingAddresses(context.accountId);
          for (const email of destinationsToMaybeDelete) {
            const stillUsed = remainingRules.some((candidate) => forwardedTo(candidate).map(normalizeEmail).includes(email));
            const destination = destinations.find((candidate) => candidate.email.toLowerCase() === email);
            if (!stillUsed && destination) {
              await context.adapter.deleteEmailRoutingAddress(context.accountId, destination.id);
              deletedDestinations.push(email);
            }
          }
        }

        auditRepo.create({
          action: 'email.address_deleted',
          resourceType: 'email_address',
          resourceId: alias,
          details: { provider, domain: normalizedDomain, deletedDestinations },
        });

        return response({
          success: true,
          mode: 'executed',
          provider,
          domain: normalizedDomain,
          address: alias,
          deletedRouteId: rule.id,
          deletedDestinations,
          message: `Deleted forwarding route for ${alias}.`,
        });
      } catch (error) {
        return response({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  server.tool(
    'email_catchall_set',
    'Configure the domain catch-all email route to forward unmatched addresses or drop them.',
    {
      domain: z.string().describe('Domain name, e.g. example.com'),
      action: z.enum(['forward', 'drop']).describe('Forward unmatched emails or drop them'),
      forwardTo: z.string().email().optional().describe('Destination mailbox when action=forward'),
      enabled: z.boolean().optional().describe('Enable the catch-all rule (default true)'),
      provider: z.enum(['cloudflare']).optional().describe('Email routing provider (default: cloudflare)'),
      enableRoutingDns: z.boolean().optional().describe('Enable/repair Cloudflare Email Routing DNS records before updating catch-all (default true)'),
      confirm: z.boolean().optional().describe('Set true to update Cloudflare resources'),
    },
    async ({ domain, action, forwardTo, enabled = true, provider = 'cloudflare', enableRoutingDns = true, confirm = false }) => {
      if (provider !== 'cloudflare') {
        return response({ success: false, error: `Unsupported email provider: ${provider}` });
      }

      if (action === 'forward' && !forwardTo) {
        return response({ success: false, error: 'forwardTo is required when action=forward' });
      }

      const normalizedDomain = normalizeDomain(domain);
      const destinationEmail = forwardTo ? normalizeEmail(forwardTo) : undefined;

      try {
        const context = await resolveCloudflareEmailContext(normalizedDomain);
        if ('error' in context) return response({ success: false, error: context.error });

        const destination = destinationEmail
          ? await ensureDestination(context.adapter, context.accountId, destinationEmail, confirm)
          : undefined;
        const plannedChanges: Array<Record<string, unknown>> = [];
        if (enableRoutingDns) {
          plannedChanges.push({ action: 'enable_email_routing_dns', domain: normalizedDomain });
        }
        if (destination?.plannedDestination) {
          plannedChanges.push(destination.plannedDestination);
        }
        plannedChanges.push({
          action: 'update_catch_all',
          catchAllAction: action,
          enabled,
          ...(destinationEmail ? { forwardTo: destinationEmail } : {}),
        });

        if (!confirm) {
          return response({
            success: true,
            mode: 'preview',
            provider,
            domain: normalizedDomain,
            plannedChanges,
            message: 'Call again with confirm=true to update the catch-all route.',
          });
        }

        const dns = enableRoutingDns ? await context.adapter.enableEmailRoutingDns(context.zone.id) : undefined;
        const catchAll = await context.adapter.updateEmailRoutingCatchAll(
          context.zone.id,
          catchAllPayload(action, destinationEmail, enabled)
        );

        auditRepo.create({
          action: 'email.catchall_updated',
          resourceType: 'email_catchall',
          resourceId: normalizedDomain,
          details: { provider, domain: normalizedDomain, action, forwardTo: destinationEmail, enabled },
        });

        return response({
          success: true,
          mode: 'executed',
          provider,
          domain: normalizedDomain,
          catchAll: summarizeRule(catchAll),
          destination: destination?.destination ? summarizeDestination(destination.destination) : undefined,
          destinationCreated: destination?.destinationCreated,
          destinationVerificationRequired: destination?.destination ? !isVerifiedDestination(destination.destination) : undefined,
          dns,
          message: action === 'forward' && destinationEmail
            ? `Catch-all for ${normalizedDomain} now forwards to ${destinationEmail}.`
            : `Catch-all for ${normalizedDomain} now drops unmatched email.`,
        });
      } catch (error) {
        return response({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );
}
