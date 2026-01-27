import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import type { IDnsProvider, DnsZone, DnsRecord } from '../../../domain/ports/dns.port.js';

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  name_servers: string[];
}

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  proxiable: boolean;
  ttl: number;
  priority?: number;
  created_on: string;
  modified_on: string;
}

export interface CreateDnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface UpdateDnsRecordInput {
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
  };
}

// Credentials schema for self-registration
export const CloudflareCredentialsSchema = z.object({
  apiToken: z.string().min(1, 'API token is required'),
});

export type CloudflareCredentials = z.infer<typeof CloudflareCredentialsSchema>;

export class CloudflareAdapter implements IDnsProvider {
  readonly name = 'cloudflare';
  private credentials: CloudflareCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as CloudflareCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<CloudflareResponse<T>> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.apiToken}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${CLOUDFLARE_API_URL}${endpoint}`, options);
    const data = (await response.json()) as CloudflareResponse<T>;

    if (!data.success) {
      const errorMsg = data.errors.map((e) => e.message).join(', ');
      throw new Error(`Cloudflare API error: ${errorMsg}`);
    }

    return data;
  }

  async verify(): Promise<{ success: boolean; error?: string; email?: string }> {
    try {
      const response = await this.request<{ id: string; email: string }>('GET', '/user/tokens/verify');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listZones(): Promise<CloudflareZone[]> {
    const zones: CloudflareZone[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.request<CloudflareZone[]>('GET', `/zones?page=${page}&per_page=50`);
      zones.push(...response.result);

      if (response.result_info) {
        hasMore = page < response.result_info.total_pages;
        page++;
      } else {
        hasMore = false;
      }
    }

    return zones;
  }

  async findZoneByName(domain: string): Promise<CloudflareZone | null> {
    const response = await this.request<CloudflareZone[]>('GET', `/zones?name=${encodeURIComponent(domain)}`);
    return response.result[0] ?? null;
  }

  async listDnsRecords(zoneId: string, type?: string): Promise<CloudflareDnsRecord[]> {
    const records: CloudflareDnsRecord[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const typeParam = type ? `&type=${encodeURIComponent(type)}` : '';
      const response = await this.request<CloudflareDnsRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?page=${page}&per_page=100${typeParam}`
      );
      records.push(...response.result);

      if (response.result_info) {
        hasMore = page < response.result_info.total_pages;
        page++;
      } else {
        hasMore = false;
      }
    }

    return records;
  }

  async createDnsRecord(zoneId: string, record: CreateDnsRecordInput): Promise<CloudflareDnsRecord> {
    const body: Record<string, unknown> = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1, // 1 = automatic
      proxied: record.proxied ?? false,
    };

    if (record.priority !== undefined) {
      body.priority = record.priority;
    }

    const response = await this.request<CloudflareDnsRecord>('POST', `/zones/${zoneId}/dns_records`, body);
    return response.result;
  }

  async updateDnsRecord(zoneId: string, recordId: string, updates: UpdateDnsRecordInput): Promise<CloudflareDnsRecord> {
    const response = await this.request<CloudflareDnsRecord>(
      'PATCH',
      `/zones/${zoneId}/dns_records/${recordId}`,
      updates as Record<string, unknown>
    );
    return response.result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    const response = await this.request<{ id: string }>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
    return response.result;
  }

  async upsertDnsRecord(
    zoneId: string,
    name: string,
    type: string,
    content: string,
    options?: { ttl?: number; proxied?: boolean; priority?: number }
  ): Promise<{ record: CloudflareDnsRecord; action: 'created' | 'updated' }> {
    // Find existing record by name and type
    const records = await this.listDnsRecords(zoneId, type);
    const existing = records.find((r) => r.name === name || r.name === `${name}.${r.zone_name}`);

    if (existing) {
      const updated = await this.updateDnsRecord(zoneId, existing.id, {
        content,
        ttl: options?.ttl,
        proxied: options?.proxied,
        priority: options?.priority,
      });
      return { record: updated, action: 'updated' };
    } else {
      const created = await this.createDnsRecord(zoneId, {
        type,
        name,
        content,
        ttl: options?.ttl,
        proxied: options?.proxied,
        priority: options?.priority,
      });
      return { record: created, action: 'created' };
    }
  }

  // IDnsProvider interface methods (wrapping Cloudflare-specific methods)

  async listRecords(zoneId: string, type?: string): Promise<DnsRecord[]> {
    const records = await this.listDnsRecords(zoneId, type);
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority,
    }));
  }

  async createRecord(zoneId: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    const created = await this.createDnsRecord(zoneId, record);
    return {
      id: created.id,
      name: created.name,
      type: created.type,
      content: created.content,
      ttl: created.ttl,
      proxied: created.proxied,
      priority: created.priority,
    };
  }

  async updateRecord(zoneId: string, recordId: string, updates: Partial<DnsRecord>): Promise<DnsRecord> {
    const updated = await this.updateDnsRecord(zoneId, recordId, updates);
    return {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      content: updated.content,
      ttl: updated.ttl,
      proxied: updated.proxied,
      priority: updated.priority,
    };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.deleteDnsRecord(zoneId, recordId);
  }

  async upsertRecord(
    zoneId: string,
    name: string,
    type: string,
    content: string,
    options?: Partial<DnsRecord>
  ): Promise<{ record: DnsRecord; action: 'created' | 'updated' }> {
    const result = await this.upsertDnsRecord(zoneId, name, type, content, options);
    return {
      record: {
        id: result.record.id,
        name: result.record.name,
        type: result.record.type,
        content: result.record.content,
        ttl: result.record.ttl,
        proxied: result.record.proxied,
        priority: result.record.priority,
      },
      action: result.action,
    };
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'cloudflare',
    displayName: 'Cloudflare',
    category: 'dns',
    credentialsSchema: CloudflareCredentialsSchema,
    setupHelpUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  factory: (credentials) => {
    const adapter = new CloudflareAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
