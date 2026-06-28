import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudflareAdapter, CloudflareDnsRecord } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { getAnyVerifiedCloudflareAdapter, getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import type { ToolContext } from './context.js';
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

/** Resolve a zone reference (domain name or zone id) to a zone id. */
async function resolveZoneId(adapter: CloudflareAdapter, zone: string): Promise<string | null> {
  if (!zone.includes('.')) return zone; // Already a zone id.
  const found = await adapter.findZoneByName(zone.trim().toLowerCase());
  return found?.id ?? null;
}

export function registerHvDomainsTools(server: McpServer, ctx: ToolContext): void {
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
      if (action === 'zones') {
        const adapterResult = getAnyVerifiedCloudflareAdapter();
        if ('error' in adapterResult) {
          return toolError('MISSING_CONNECTION', adapterResult.error, {
            hint: formatConnectionGuidance('cloudflare'),
          });
        }
        const { adapter, scope } = adapterResult;
        const zones = await adapter.listZones();
        return toolSuccess({
          count: zones.length,
          tokenScope: scope ?? 'global',
          zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused, nameServers: z.name_servers })),
        }, {
          hint: 'Only zones visible to the selected Cloudflare token are listed. Missing a domain? Add a scoped Cloudflare connection for it.',
        });
      }

      const adapterResult = getCloudflareAdapter(zone?.includes('.') ? zone : undefined);
      if ('error' in adapterResult) {
        return toolError('MISSING_CONNECTION', adapterResult.error, {
          hint: formatConnectionGuidance('cloudflare', { scope: zone }),
        });
      }
      const { adapter } = adapterResult;

      if (!zone) {
        throw new HvError('VALIDATION', `zone is required for action "${action}".`, {
          hint: 'Pass zone as a domain name (example.com) or a Cloudflare zone id.',
        });
      }
      const zoneId = await resolveZoneId(adapter, zone);
      if (!zoneId) {
        return toolError('NOT_FOUND', `Cloudflare zone "${zone}" not found.`, {
          hint: `The current token may not cover this domain. ${formatConnectionGuidance('cloudflare', { scope: zone })}`,
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
