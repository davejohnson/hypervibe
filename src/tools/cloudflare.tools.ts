import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { CloudflareCredentials } from '../domain/entities/connection.entity.js';

const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

/**
 * Get a Cloudflare adapter, using scoped connection if available.
 * @param scopeHint - Optional domain hint (e.g., "example.com") for finding scoped tokens
 */
function getCloudflareAdapter(scopeHint?: string): { adapter: CloudflareAdapter; scope: string | null } | { error: string } {
  const connection = connectionRepo.findBestMatch('cloudflare', scopeHint);
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use connection_create with provider=cloudflare first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter, scope: connection.scope };
}

export function registerCloudflareTools(server: McpServer): void {
  server.tool(
    'cloudflare_setup_help',
    'Get instructions for creating a Cloudflare API token with the correct permissions',
    {},
    async () => {
      const instructions = `# Cloudflare API Token Setup

## Quick Setup (Recommended)

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **"Create Token"**
3. Find **"Edit zone DNS"** template and click **"Use template"**
4. Configure zone resources:
   - **Zone Resources**: Select specific zones or "All zones"
   - For production, scope to specific zones (e.g., example.com)
5. Click **"Continue to summary"** → **"Create Token"**
6. Copy the token (shown only once!)

## What the Template Provides

The "Edit zone DNS" template includes:

| Permission | Level | Purpose |
|------------|-------|---------|
| Zone:Zone:Read | Zone | List zones, find zone by domain name |
| Zone:DNS:Edit | Zone | Create, read, update, delete DNS records |

## Manual Setup (If Needed)

If you need to create the token manually:

1. Click **"Create Custom Token"**
2. Add these permissions:
   - Zone → Zone → Read
   - Zone → DNS → Edit
3. Under **Zone Resources**, select which zones to grant access to
4. (Optional) Add IP filtering or TTL for additional security

## Token Security Tips

- **Scope to specific zones** in production (don't use "All zones" unless necessary)
- **Set a TTL** if the token is temporary (e.g., for testing)
- **Add IP restrictions** if you have a static IP
- Store the token securely - it's shown only once!

## Verification

After creating the token, verify it works:

  connection_create provider=cloudflare apiToken=your_token_here
  connection_verify provider=cloudflare`;

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
    'cloudflare_zones_list',
    'List all domains (zones) in the Cloudflare account',
    {},
    async () => {
      const result = getCloudflareAdapter();
      if ('error' in result) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      const { adapter, scope } = result;

      try {
        const zones = await adapter.listZones();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: zones.length,
              zones: zones.map((z) => ({
                id: z.id,
                name: z.name,
                status: z.status,
                paused: z.paused,
                nameServers: z.name_servers,
              })),
              tokenScope: scope ?? 'global',
              note: 'These are only the zones accessible to the current API token. If a domain is missing, the token may not have permission for it. Use connection_create with provider=cloudflare and a scope parameter to add a token for a specific domain.',
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
    'cloudflare_dns_list',
    'List DNS records for a domain. Provide either zoneId or domain name.',
    {
      zoneId: z.string().optional().describe('Cloudflare zone ID'),
      domain: z.string().optional().describe('Domain name (e.g., example.com)'),
      type: z.string().optional().describe('Filter by record type (A, AAAA, CNAME, TXT, MX, etc.)'),
    },
    async ({ zoneId, domain, type }) => {
      if (!zoneId && !domain) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either zoneId or domain is required' }),
          }],
        };
      }

      const result = getCloudflareAdapter(domain);
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
        let resolvedZoneId = zoneId;

        if (!resolvedZoneId && domain) {
          const zone = await adapter.findZoneByName(domain);
          if (!zone) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Domain "${domain}" not found. This may mean the current API token doesn't have permission for this domain. You can add a new Cloudflare token scoped to "${domain}" using: connection_create provider=cloudflare scope=${domain} credentials={apiToken: "..."}` }),
              }],
            };
          }
          resolvedZoneId = zone.id;
        }

        const records = await adapter.listDnsRecords(resolvedZoneId!, type);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              zoneId: resolvedZoneId,
              count: records.length,
              records: records.map((r) => ({
                id: r.id,
                name: r.name,
                type: r.type,
                content: r.content,
                proxied: r.proxied,
                ttl: r.ttl,
                priority: r.priority,
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
    'cloudflare_dns_create',
    'Create a DNS record',
    {
      zoneId: z.string().optional().describe('Cloudflare zone ID'),
      domain: z.string().optional().describe('Domain name (e.g., example.com)'),
      type: z.string().describe('Record type (A, AAAA, CNAME, TXT, MX, etc.)'),
      name: z.string().describe('Record name (e.g., "www" or "mail.example.com")'),
      content: z.string().describe('Record content (IP address, hostname, or text value)'),
      ttl: z.number().optional().describe('TTL in seconds (1 = automatic)'),
      proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare (default: false)'),
      priority: z.number().optional().describe('Priority (for MX records)'),
    },
    async ({ zoneId, domain, type, name, content, ttl, proxied, priority }) => {
      if (!zoneId && !domain) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either zoneId or domain is required' }),
          }],
        };
      }

      const result = getCloudflareAdapter(domain);
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
        let resolvedZoneId = zoneId;

        if (!resolvedZoneId && domain) {
          const zone = await adapter.findZoneByName(domain);
          if (!zone) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Domain "${domain}" not found. This may mean the current API token doesn't have permission for this domain. You can add a new Cloudflare token scoped to "${domain}" using: connection_create provider=cloudflare scope=${domain} credentials={apiToken: "..."}` }),
              }],
            };
          }
          resolvedZoneId = zone.id;
        }

        // CAA records require structured data for the Cloudflare API
        let data: Record<string, unknown> | undefined;
        if (type.toUpperCase() === 'CAA') {
          const match = content.match(/^(\d+)\s+(\w+)\s+"?([^"]+)"?$/);
          if (match) {
            data = { flags: parseInt(match[1], 10), tag: match[2], value: match[3] };
          }
        }

        const record = await adapter.createDnsRecord(resolvedZoneId!, {
          type,
          name,
          content,
          ttl,
          proxied,
          priority,
          data,
        });

        auditRepo.create({
          action: 'cloudflare.dns_created',
          resourceType: 'dns_record',
          resourceId: record.id,
          details: { name: record.name, type: record.type, content: record.content },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Created ${type} record for ${name}`,
              record: {
                id: record.id,
                name: record.name,
                type: record.type,
                content: record.content,
                proxied: record.proxied,
                ttl: record.ttl,
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
    'cloudflare_dns_update',
    'Update an existing DNS record',
    {
      zoneId: z.string().optional().describe('Cloudflare zone ID'),
      domain: z.string().optional().describe('Domain name (e.g., example.com)'),
      recordId: z.string().describe('DNS record ID to update'),
      type: z.string().optional().describe('New record type'),
      name: z.string().optional().describe('New record name'),
      content: z.string().optional().describe('New record content'),
      ttl: z.number().optional().describe('New TTL in seconds'),
      proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare'),
      priority: z.number().optional().describe('New priority (for MX records)'),
    },
    async ({ zoneId, domain, recordId, type, name, content, ttl, proxied, priority }) => {
      if (!zoneId && !domain) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either zoneId or domain is required' }),
          }],
        };
      }

      const result = getCloudflareAdapter(domain);
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
        let resolvedZoneId = zoneId;

        if (!resolvedZoneId && domain) {
          const zone = await adapter.findZoneByName(domain);
          if (!zone) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Domain "${domain}" not found. This may mean the current API token doesn't have permission for this domain. You can add a new Cloudflare token scoped to "${domain}" using: connection_create provider=cloudflare scope=${domain} credentials={apiToken: "..."}` }),
              }],
            };
          }
          resolvedZoneId = zone.id;
        }

        const updates: Record<string, unknown> = {};
        if (type !== undefined) updates.type = type;
        if (name !== undefined) updates.name = name;
        if (content !== undefined) updates.content = content;
        if (ttl !== undefined) updates.ttl = ttl;
        if (proxied !== undefined) updates.proxied = proxied;
        if (priority !== undefined) updates.priority = priority;

        const record = await adapter.updateDnsRecord(resolvedZoneId!, recordId, updates);

        auditRepo.create({
          action: 'cloudflare.dns_updated',
          resourceType: 'dns_record',
          resourceId: record.id,
          details: { name: record.name, type: record.type, content: record.content },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Updated DNS record ${recordId}`,
              record: {
                id: record.id,
                name: record.name,
                type: record.type,
                content: record.content,
                proxied: record.proxied,
                ttl: record.ttl,
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
    'cloudflare_dns_delete',
    'Delete a DNS record',
    {
      zoneId: z.string().optional().describe('Cloudflare zone ID'),
      domain: z.string().optional().describe('Domain name (e.g., example.com)'),
      recordId: z.string().describe('DNS record ID to delete'),
    },
    async ({ zoneId, domain, recordId }) => {
      if (!zoneId && !domain) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either zoneId or domain is required' }),
          }],
        };
      }

      const result = getCloudflareAdapter(domain);
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
        let resolvedZoneId = zoneId;

        if (!resolvedZoneId && domain) {
          const zone = await adapter.findZoneByName(domain);
          if (!zone) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Domain "${domain}" not found. This may mean the current API token doesn't have permission for this domain. You can add a new Cloudflare token scoped to "${domain}" using: connection_create provider=cloudflare scope=${domain} credentials={apiToken: "..."}` }),
              }],
            };
          }
          resolvedZoneId = zone.id;
        }

        await adapter.deleteDnsRecord(resolvedZoneId!, recordId);

        auditRepo.create({
          action: 'cloudflare.dns_deleted',
          resourceType: 'dns_record',
          resourceId: recordId,
          details: { zoneId: resolvedZoneId },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Deleted DNS record ${recordId}`,
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
    'cloudflare_dns_upsert',
    'Create or update a DNS record by name and type (idempotent operation)',
    {
      zoneId: z.string().optional().describe('Cloudflare zone ID'),
      domain: z.string().optional().describe('Domain name (e.g., example.com)'),
      type: z.string().describe('Record type (A, AAAA, CNAME, TXT, MX, etc.)'),
      name: z.string().describe('Record name (e.g., "www" or "mail.example.com")'),
      content: z.string().describe('Record content (IP address, hostname, or text value)'),
      ttl: z.number().optional().describe('TTL in seconds (1 = automatic)'),
      proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare (default: false)'),
      priority: z.number().optional().describe('Priority (for MX records)'),
      wwwRedirect: z.string().optional().describe('When setting up an apex domain, also create a www CNAME pointing to this target (e.g., user.github.io)'),
    },
    async ({ zoneId, domain, type, name, content, ttl, proxied, priority, wwwRedirect }) => {
      if (!zoneId && !domain) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either zoneId or domain is required' }),
          }],
        };
      }

      const result = getCloudflareAdapter(domain);
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
        let resolvedZoneId = zoneId;

        if (!resolvedZoneId && domain) {
          const zone = await adapter.findZoneByName(domain);
          if (!zone) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: `Domain "${domain}" not found. This may mean the current API token doesn't have permission for this domain. You can add a new Cloudflare token scoped to "${domain}" using: connection_create provider=cloudflare scope=${domain} credentials={apiToken: "..."}` }),
              }],
            };
          }
          resolvedZoneId = zone.id;
        }

        const { record, action } = await adapter.upsertDnsRecord(
          resolvedZoneId!,
          name,
          type,
          content,
          { ttl, proxied, priority }
        );

        auditRepo.create({
          action: `cloudflare.dns_${action}`,
          resourceType: 'dns_record',
          resourceId: record.id,
          details: { name: record.name, type: record.type, content: record.content },
        });

        // Handle www redirect for apex domains
        let wwwRecord = null;
        let wwwAction = null;
        if (wwwRedirect) {
          // Check if this is an apex domain (only one dot, e.g., example.com)
          const isApexDomain = name.split('.').length === 2;
          if (isApexDomain) {
            const wwwName = `www.${name}`;
            const wwwResult = await adapter.upsertDnsRecord(
              resolvedZoneId!,
              wwwName,
              'CNAME',
              wwwRedirect,
              { ttl, proxied: false } // www CNAME should not be proxied for proper redirect
            );
            wwwRecord = wwwResult.record;
            wwwAction = wwwResult.action;

            auditRepo.create({
              action: `cloudflare.dns_${wwwAction}`,
              resourceType: 'dns_record',
              resourceId: wwwRecord.id,
              details: { name: wwwRecord.name, type: wwwRecord.type, content: wwwRecord.content },
            });
          }
        }

        const records = [{
          id: record.id,
          name: record.name,
          type: record.type,
          content: record.content,
          proxied: record.proxied,
          ttl: record.ttl,
        }];

        if (wwwRecord) {
          records.push({
            id: wwwRecord.id,
            name: wwwRecord.name,
            type: wwwRecord.type,
            content: wwwRecord.content,
            proxied: wwwRecord.proxied,
            ttl: wwwRecord.ttl,
          });
        }

        const messages = [
          action === 'created'
            ? `Created ${type} record for ${name}`
            : `Updated ${type} record for ${name}`,
        ];
        if (wwwRecord) {
          messages.push(
            wwwAction === 'created'
              ? `Created www CNAME redirect to ${wwwRedirect}`
              : `Updated www CNAME redirect to ${wwwRedirect}`
          );
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action,
              message: messages.join('. '),
              record: records.length === 1 ? records[0] : undefined,
              records: records.length > 1 ? records : undefined,
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
}
