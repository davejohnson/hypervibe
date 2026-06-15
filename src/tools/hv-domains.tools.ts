import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudflareAdapter, CloudflareDnsRecord } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { setupCustomDomain } from '../domain/services/domain.service.js';
import { getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import type { ToolContext } from './context.js';
import { projectField, envField, confirmField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';

function summarizeRecord(record: CloudflareDnsRecord) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
    priority: record.priority,
  };
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, '').toLowerCase();
}

function domainsFromArgs(domain?: string, domains?: string[]): string[] {
  const values = [
    ...(domain ? [domain] : []),
    ...(domains ?? []),
  ]
    .map(normalizeDomain)
    .filter(Boolean);
  return Array.from(new Set(values));
}

/** Resolve a zone reference (domain name or zone id) to a zone id. */
async function resolveZoneId(adapter: CloudflareAdapter, zone: string): Promise<string | null> {
  if (!zone.includes('.')) return zone; // Already a zone id.
  const found = await adapter.findZoneByName(zone.trim().toLowerCase());
  return found?.id ?? null;
}

async function resolveRegistrarAccountId(adapter: CloudflareAdapter, accountId?: string): Promise<string> {
  try {
    return await adapter.resolveAccountId(accountId);
  } catch (error) {
    throw new HvError('VALIDATION', error instanceof Error ? error.message : String(error), {
      hint: 'Pass accountId to hv_domain_register, or save it with hv_connect provider=cloudflare credentialsRef="file:/absolute/path" where the JSON includes {"apiToken":"...","accountId":"..."}.',
    });
  }
}

function summarizeRegistrarDomain(domain: {
  name: string;
  registrable: boolean;
  pricing?: { currency: string; registration_cost: string; renewal_cost: string };
  reason?: string;
  tier?: string;
}) {
  return {
    name: domain.name,
    registrable: domain.registrable,
    tier: domain.tier ?? null,
    reason: domain.reason ?? null,
    pricing: domain.pricing
      ? {
        currency: domain.pricing.currency,
        registrationCost: domain.pricing.registration_cost,
        renewalCost: domain.pricing.renewal_cost,
      }
      : null,
  };
}

export function registerHvDomainsTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_domain_setup',
    'Attach a custom domain to a deployed service in one call: checks the Cloudflare zone, attaches the domain on the hosting provider (when supported), creates the required DNS records, and reports verification status.',
    {
      project: projectField,
      env: envField,
      domain: z.string().describe('Domain to attach (e.g. app.example.com or example.com)'),
      service: z.string().optional().describe('Service to attach the domain to. Defaults to the first bound service in the environment.'),
    },
    wrapHandler(async ({ project: projectRef, env, domain, service }) => {
      const project = ctx.resolveProjectOrThrow({ project: projectRef });
      const environment = ctx.resolveEnvironmentOrThrow(project, env);

      const result = await setupCustomDomain({ project, environment, domain, serviceName: service });
      if (result.error && !result.zone) {
        return toolError(result.reason === 'no_connection' ? 'MISSING_CONNECTION' : 'NOT_FOUND', result.error, {
          next: result.reason === 'no_zone' ? ['hv_dns_record'] : undefined,
        });
      }

      ctx.repos.audit.create({
        action: 'hv.domain_setup',
        resourceType: 'domain',
        resourceId: domain,
        details: {
          project: project.name,
          environment: environment.name,
          attached: result.customDomainAttached ?? false,
          dnsConfigured: result.dnsConfigured ?? false,
        },
      });

      const warnings = [
        ...(result.customDomainError ? [`Custom-domain attach failed: ${result.customDomainError}`] : []),
        ...(result.dnsError ? [`DNS: ${result.dnsError}`] : []),
      ];
      return toolSuccess(
        {
          domain: domain.trim().toLowerCase(),
          environment: environment.name,
          zone: result.zone,
          hostingProvider: result.hostingProvider,
          service: result.service,
          customDomainAttached: result.customDomainAttached ?? false,
          dnsConfigured: result.dnsConfigured ?? false,
          dnsRecords: result.dnsRecords,
          verification: result.verification,
        },
        {
          warnings,
          hint: result.success
            ? 'DNS is configured. Certificates may take a few minutes to provision; re-check the verification status afterwards.'
            : 'Domain setup is incomplete — see warnings for what to fix, then re-run hv_domain_setup.',
        }
      );
    })
  );

  server.tool(
    'hv_domain_register',
    'Search, check, purchase, or poll Cloudflare Registrar domain registrations. action="search" returns suggestions; "check" performs real-time availability and pricing checks; "purchase" is billable/non-refundable and requires confirm=true; "status" polls an async registration workflow. Uses Cloudflare Registrar API, not provider CLIs. Recommended: connect Cloudflare with an account-scoped API token and credentialsRef, optionally including accountId in the JSON file.',
    {
      action: z.enum(['search', 'check', 'purchase', 'status']).default('check'),
      accountId: z.string().optional().describe('Cloudflare account id. If omitted, Hypervibe uses credentials.accountId or a single visible account.'),
      query: z.string().optional().describe('Search term for action="search" (keyword, phrase, or domain).'),
      domain: z.string().optional().describe('Single domain for check/purchase/status, e.g. example.com.'),
      domains: z.array(z.string()).optional().describe('Up to 20 domains for action="check".'),
      extensions: z.array(z.string()).optional().describe('Optional search extension filters, e.g. ["com","dev"].'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum search suggestions (default is Cloudflare default).'),
      years: z.number().int().min(1).max(10).optional().describe('Registration term for purchase. Omit to use Cloudflare/registry default.'),
      autoRenew: z.boolean().optional().describe('Set true to opt into renewal charges before expiry. Defaults to Cloudflare default false.'),
      privacyMode: z.enum(['redaction', 'off']).optional().describe('WHOIS privacy mode. Defaults to Cloudflare default redaction.'),
      registrant: z.record(z.unknown()).optional().describe('Optional Cloudflare contacts.registrant object. Omit to use the account default registrar contact configured in Cloudflare.'),
      confirm: confirmField,
    },
    wrapHandler(async ({ action = 'check', accountId, query, domain, domains, extensions, limit, years, autoRenew, privacyMode, registrant, confirm }) => {
      const adapterResult = getCloudflareAdapter();
      if ('error' in adapterResult) {
        return toolError('MISSING_CONNECTION', adapterResult.error);
      }
      const { adapter } = adapterResult;
      const resolvedAccountId = await resolveRegistrarAccountId(adapter, accountId);

      switch (action) {
        case 'search': {
          if (!query?.trim()) {
            throw new HvError('VALIDATION', 'query is required for action="search".');
          }
          const suggestions = await adapter.searchRegistrarDomains({
            accountId: resolvedAccountId,
            query: query.trim(),
            extensions,
            limit,
          });
          return toolSuccess(
            {
              accountId: resolvedAccountId,
              count: suggestions.length,
              domains: suggestions.map(summarizeRegistrarDomain),
            },
            { hint: 'Run hv_domain_register action="check" with the chosen domain immediately before purchase.' }
          );
        }

        case 'check': {
          const targets = domainsFromArgs(domain, domains);
          if (targets.length === 0) {
            throw new HvError('VALIDATION', 'domain or domains is required for action="check".');
          }
          if (targets.length > 20) {
            throw new HvError('VALIDATION', 'Cloudflare allows at most 20 domains per availability check.');
          }
          const checked = await adapter.checkRegistrarDomains(resolvedAccountId, targets);
          return toolSuccess(
            {
              accountId: resolvedAccountId,
              count: checked.length,
              domains: checked.map(summarizeRegistrarDomain),
            },
            {
              hint: checked.some((entry) => entry.registrable && entry.tier !== 'premium')
                ? 'To purchase, re-run hv_domain_register action="purchase" domain="<name>" confirm=true. This is billable and successful registrations are non-refundable.'
                : undefined,
            }
          );
        }

        case 'purchase': {
          const target = domain ? normalizeDomain(domain) : undefined;
          if (!target) {
            throw new HvError('VALIDATION', 'domain is required for action="purchase".');
          }

          const checked = await adapter.checkRegistrarDomains(resolvedAccountId, [target]);
          const candidate = checked.find((entry) => entry.name.toLowerCase() === target) ?? checked[0];
          if (!candidate) {
            return toolError('PROVIDER_ERROR', `Cloudflare did not return an availability result for ${target}.`);
          }
          if (!candidate.registrable) {
            return toolError('VALIDATION', `${target} is not registrable through Cloudflare Registrar API.`, {
              details: summarizeRegistrarDomain(candidate),
              hint: candidate.reason === 'extension_not_supported_via_api'
                ? `Cloudflare says this extension must be registered through the dashboard: https://dash.cloudflare.com/${resolvedAccountId}/domains/registrations`
                : undefined,
            });
          }
          if (candidate.tier === 'premium') {
            return toolError('UNSUPPORTED', `${target} is premium priced; Cloudflare Registrar API does not support premium registration.`, {
              details: summarizeRegistrarDomain(candidate),
            });
          }

          const details = {
            accountId: resolvedAccountId,
            domain: target,
            pricing: summarizeRegistrarDomain(candidate).pricing,
            years: years ?? 'default',
            autoRenew: autoRenew ?? false,
            privacyMode: privacyMode ?? 'redaction',
            registrant: registrant ? 'provided' : 'cloudflare-account-default',
          };
          if (!confirm) {
            return toolError('CONFIRM_REQUIRED', `Registering ${target} through Cloudflare is billable and successful registrations are non-refundable.`, {
              details,
              hint: 'Re-run hv_domain_register with action="purchase" and confirm=true to submit the registration. Configure Cloudflare default registrar contact first, or pass registrant if you intentionally want to provide contact data.',
            });
          }

          const workflow = await adapter.createRegistrarRegistration(resolvedAccountId, {
            domainName: target,
            ...(autoRenew !== undefined ? { autoRenew } : {}),
            ...(privacyMode ? { privacyMode } : {}),
            ...(years !== undefined ? { years } : {}),
            ...(registrant ? { contacts: { registrant: registrant as never } } : {}),
          });
          ctx.repos.audit.create({
            action: 'cloudflare.domain_registration_created',
            resourceType: 'domain_registration',
            resourceId: target,
            details: { accountId: resolvedAccountId, domain: target, state: workflow.state, completed: workflow.completed },
          });
          return toolSuccess(
            {
              accountId: resolvedAccountId,
              domain: target,
              pricing: details.pricing,
              workflow,
            },
            {
              hint: workflow.completed
                ? 'Registration workflow completed. If it succeeded, run hv_domain_setup after the Cloudflare zone is visible.'
                : 'Registration is still processing. Poll with hv_domain_register action="status".',
              next: workflow.completed ? ['hv_domain_setup'] : ['hv_domain_register'],
            }
          );
        }

        case 'status': {
          const target = domain ? normalizeDomain(domain) : undefined;
          if (!target) {
            throw new HvError('VALIDATION', 'domain is required for action="status".');
          }
          const workflow = await adapter.getRegistrarRegistrationStatus(resolvedAccountId, target);
          return toolSuccess(
            {
              accountId: resolvedAccountId,
              domain: target,
              workflow,
            },
            {
              hint: workflow.state === 'action_required'
                ? 'Cloudflare requires user action. Open the Cloudflare dashboard and follow the registration workflow instructions; do not re-submit purchase.'
                : workflow.completed
                  ? 'Registration workflow is complete.'
                  : 'Registration is still processing; poll again later.',
            }
          );
        }
      }
    })
  );

  server.tool(
    'hv_dns_record',
    'Manage Cloudflare DNS: list zones, list records, upsert (create-or-update) a record by name+type, or delete records by name.',
    {
      action: z.enum(['list', 'upsert', 'delete', 'zones']).describe('zones: list Cloudflare zones; list: list records in a zone; upsert: create or update a record; delete: delete records matching name (and type/content when given)'),
      zone: z.string().optional().describe('Zone domain name (e.g. example.com) or Cloudflare zone id. Required for every action except "zones".'),
      type: z.string().optional().describe('Record type (A, AAAA, CNAME, TXT, MX, ...). Required for upsert; optional filter for list/delete.'),
      name: z.string().optional().describe('Record name (e.g. "www" or "www.example.com"). Required for upsert and delete.'),
      content: z.string().optional().describe('Record content (IP, hostname, or text). Required for upsert; optional match for delete.'),
      proxied: z.boolean().optional().describe('Proxy through Cloudflare (upsert only, default false)'),
      ttl: z.number().optional().describe('TTL in seconds (1 = automatic)'),
    },
    wrapHandler(async ({ action, zone, type, name, content, proxied, ttl }) => {
      const adapterResult = getCloudflareAdapter(zone?.includes('.') ? zone : undefined);
      if ('error' in adapterResult) {
        return toolError('MISSING_CONNECTION', adapterResult.error);
      }
      const { adapter, scope } = adapterResult;

      if (action === 'zones') {
        const zones = await adapter.listZones();
        return toolSuccess({
          count: zones.length,
          tokenScope: scope ?? 'global',
          zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused, nameServers: z.name_servers })),
        }, {
          hint: 'Only zones visible to the current API token are listed. Missing a domain? Add a scoped Cloudflare connection for it.',
        });
      }

      if (!zone) {
        throw new HvError('VALIDATION', `zone is required for action "${action}".`, {
          hint: 'Pass zone as a domain name (example.com) or a Cloudflare zone id.',
        });
      }
      const zoneId = await resolveZoneId(adapter, zone);
      if (!zoneId) {
        return toolError('NOT_FOUND', `Cloudflare zone "${zone}" not found.`, {
          hint: `The current token may not cover this domain. Add a scoped connection with hv_connect provider=cloudflare scope=${zone} credentialsRef="env:CLOUDFLARE_API_TOKEN" credentialsKey="apiToken".`,
        });
      }

      switch (action) {
        case 'list': {
          const records = await adapter.listDnsRecords(zoneId, type);
          return toolSuccess({ zoneId, count: records.length, records: records.map(summarizeRecord) });
        }
        case 'upsert': {
          if (!type || !name || content === undefined) {
            throw new HvError('VALIDATION', 'upsert requires type, name, and content.');
          }
          const { record, action: act } = await adapter.upsertDnsRecord(zoneId, name, type, content, { ttl, proxied });
          ctx.repos.audit.create({
            action: `cloudflare.dns_${act}`,
            resourceType: 'dns_record',
            resourceId: record.id,
            details: { name: record.name, type: record.type, content: record.content },
          });
          return toolSuccess({ zoneId, action: act, record: summarizeRecord(record) });
        }
        case 'delete': {
          if (!name) {
            throw new HvError('VALIDATION', 'delete requires name.');
          }
          const records = await adapter.listDnsRecords(zoneId, type);
          const target = name.trim().toLowerCase();
          const fqdn = zone.includes('.') && !target.endsWith(zone.toLowerCase()) ? `${target}.${zone.toLowerCase()}` : target;
          const matches = records.filter((r) => {
            const recordName = r.name.toLowerCase();
            if (recordName !== target && recordName !== fqdn) return false;
            return content === undefined || r.content === content;
          });
          if (matches.length === 0) {
            return toolError('NOT_FOUND', `No DNS records named "${name}"${type ? ` of type ${type}` : ''} in zone ${zone}.`);
          }
          for (const record of matches) {
            await adapter.deleteDnsRecord(zoneId, record.id);
            ctx.repos.audit.create({
              action: 'cloudflare.dns_deleted',
              resourceType: 'dns_record',
              resourceId: record.id,
              details: { zoneId, name: record.name, type: record.type },
            });
          }
          return toolSuccess({ zoneId, deleted: matches.map(summarizeRecord) });
        }
      }
    })
  );
}
