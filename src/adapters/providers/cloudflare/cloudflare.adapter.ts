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
  account?: {
    id: string;
    name?: string;
  };
}

export interface CloudflareAccount {
  id: string;
  name?: string;
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
  data?: Record<string, unknown>;
}

export interface UpdateDnsRecordInput {
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface CloudflareEmailRoutingAddress {
  id: string;
  email: string;
  created?: string;
  modified?: string;
  tag?: string;
  verified?: string | null;
}

export interface CloudflareEmailRoutingAction {
  type: 'drop' | 'forward' | 'worker';
  value?: string[];
}

export interface CloudflareEmailRoutingMatcher {
  type: 'all' | 'literal';
  field?: 'to';
  value?: string;
}

export interface CloudflareEmailRoutingRule {
  id: string;
  name?: string;
  enabled: boolean;
  actions: CloudflareEmailRoutingAction[];
  matchers: CloudflareEmailRoutingMatcher[];
  priority?: number;
  tag?: string;
}

export interface CloudflareEmailRoutingSettings {
  id: string;
  enabled: boolean;
  name: string;
  status?: 'ready' | 'unconfigured' | 'misconfigured' | 'misconfigured/locked' | 'unlocked' | string;
  created?: string;
  modified?: string;
  skip_wizard?: boolean;
  tag?: string;
}

export interface CloudflareEmailRoutingDnsRecord {
  type?: string;
  name?: string;
  content?: string;
  priority?: number;
  ttl?: number;
}

export interface CloudflareEmailRoutingDnsSettings {
  record?: CloudflareEmailRoutingDnsRecord[];
  errors?: Array<{ code?: string; missing?: CloudflareEmailRoutingDnsRecord }>;
}

export interface RegistrarPricing {
  currency: string;
  registration_cost: string;
  renewal_cost: string;
}

export interface RegistrarDomainCandidate {
  name: string;
  registrable: boolean;
  pricing?: RegistrarPricing;
  reason?: string;
  tier?: 'standard' | 'premium' | string;
}

export interface RegistrarWorkflowStatus {
  completed: boolean;
  created_at: string;
  updated_at: string;
  links: {
    self: string;
    resource?: string;
  };
  state: 'pending' | 'in_progress' | 'action_required' | 'blocked' | 'succeeded' | 'failed' | string;
  context?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface RegistrarRegistrantContact {
  email: string;
  phone: string;
  postal_info: {
    address: {
      city: string;
      country_code: string;
      postal_code: string;
      state: string;
      street: string;
    };
    name: string;
    organization?: string;
  };
  fax?: string;
}

export interface RegistrarRegistrationInput {
  domainName: string;
  autoRenew?: boolean;
  contacts?: {
    registrant?: RegistrarRegistrantContact;
  };
  privacyMode?: 'redaction' | 'off';
  years?: number;
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
  accountId: z.string().min(1).optional(),
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

  async verify(domain?: string): Promise<{ success: boolean; error?: string; zones?: string[] }> {
    try {
      await this.request<{ id: string }>('GET', '/user/tokens/verify');

      if (domain) {
        const zone = await this.findZoneByName(domain);
        if (!zone) {
          const zones = await this.listZones();
          const zoneNames = zones.map(z => z.name);
          return {
            success: false,
            error: `Token is valid but does not have access to "${domain}". Accessible zones: ${zoneNames.join(', ') || 'none'}`,
            zones: zoneNames,
          };
        }
      }

      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Global API Keys return 401 on /user/tokens/verify since that endpoint only works with API Tokens
      if (msg.includes('Authentication') || msg.includes('401') || msg.includes('Invalid access token')) {
        return {
          success: false,
          error: `Token verification failed — this may be a legacy Global API Key, which is not supported. Please create an API Token instead at https://dash.cloudflare.com/profile/api-tokens (use the "Edit zone DNS" template for DNS management).`,
        };
      }
      return { success: false, error: msg };
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

  async listAccounts(): Promise<CloudflareAccount[]> {
    const accounts: CloudflareAccount[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.request<CloudflareAccount[]>('GET', `/accounts?page=${page}&per_page=50`);
      accounts.push(...response.result);

      if (response.result_info) {
        hasMore = page < response.result_info.total_pages;
        page++;
      } else {
        hasMore = false;
      }
    }

    return accounts;
  }

  async resolveAccountId(accountId?: string): Promise<string> {
    const explicit = accountId?.trim() || this.credentials?.accountId?.trim();
    if (explicit) {
      return explicit;
    }

    const accounts = await this.listAccounts();
    if (accounts.length === 1) {
      return accounts[0].id;
    }
    if (accounts.length === 0) {
      throw new Error('No Cloudflare accounts are visible to this API token.');
    }
    throw new Error(`Multiple Cloudflare accounts are visible (${accounts.map((account) => account.name ?? account.id).join(', ')}). Pass accountId or store it in the Cloudflare connection credentials.`);
  }

  async findZoneByName(domain: string): Promise<CloudflareZone | null> {
    const response = await this.request<CloudflareZone[]>('GET', `/zones?name=${encodeURIComponent(domain)}`);
    return response.result[0] ?? null;
  }

  async searchRegistrarDomains(params: {
    accountId: string;
    query: string;
    extensions?: string[];
    limit?: number;
  }): Promise<RegistrarDomainCandidate[]> {
    const search = new URLSearchParams();
    search.set('q', params.query);
    if (params.limit !== undefined) {
      search.set('limit', String(params.limit));
    }
    for (const extension of params.extensions ?? []) {
      search.append('extensions', extension.replace(/^\./, ''));
    }

    const response = await this.request<{ domains: RegistrarDomainCandidate[] }>(
      'GET',
      `/accounts/${params.accountId}/registrar/domain-search?${search.toString()}`
    );
    return response.result.domains;
  }

  async checkRegistrarDomains(accountId: string, domains: string[]): Promise<RegistrarDomainCandidate[]> {
    const response = await this.request<{ domains: RegistrarDomainCandidate[] }>(
      'POST',
      `/accounts/${accountId}/registrar/domain-check`,
      { domains }
    );
    return response.result.domains;
  }

  async createRegistrarRegistration(
    accountId: string,
    input: RegistrarRegistrationInput
  ): Promise<RegistrarWorkflowStatus> {
    const body: Record<string, unknown> = {
      domain_name: input.domainName,
    };
    if (input.autoRenew !== undefined) {
      body.auto_renew = input.autoRenew;
    }
    if (input.contacts) {
      body.contacts = input.contacts;
    }
    if (input.privacyMode) {
      body.privacy_mode = input.privacyMode;
    }
    if (input.years !== undefined) {
      body.years = input.years;
    }

    const response = await this.request<RegistrarWorkflowStatus>(
      'POST',
      `/accounts/${accountId}/registrar/registrations`,
      body
    );
    return response.result;
  }

  async getRegistrarRegistrationStatus(accountId: string, domainName: string): Promise<RegistrarWorkflowStatus> {
    const response = await this.request<RegistrarWorkflowStatus>(
      'GET',
      `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domainName)}/registration-status`
    );
    return response.result;
  }

  async getEmailRoutingSettings(zoneId: string): Promise<CloudflareEmailRoutingSettings> {
    const response = await this.request<CloudflareEmailRoutingSettings>('GET', `/zones/${zoneId}/email/routing`);
    return response.result;
  }

  async getEmailRoutingDnsSettings(zoneId: string): Promise<CloudflareEmailRoutingDnsSettings> {
    const response = await this.request<CloudflareEmailRoutingDnsSettings>('GET', `/zones/${zoneId}/email/routing/dns`);
    return response.result;
  }

  async enableEmailRoutingDns(zoneId: string): Promise<CloudflareEmailRoutingDnsSettings> {
    const response = await this.request<CloudflareEmailRoutingDnsSettings>('POST', `/zones/${zoneId}/email/routing/dns`);
    return response.result;
  }

  async listEmailRoutingAddresses(accountId: string): Promise<CloudflareEmailRoutingAddress[]> {
    const addresses: CloudflareEmailRoutingAddress[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.request<CloudflareEmailRoutingAddress[]>(
        'GET',
        `/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=100`
      );
      addresses.push(...response.result);

      if (response.result_info) {
        hasMore = page < response.result_info.total_pages;
        page++;
      } else {
        hasMore = false;
      }
    }

    return addresses;
  }

  async createEmailRoutingAddress(accountId: string, email: string): Promise<CloudflareEmailRoutingAddress> {
    const response = await this.request<CloudflareEmailRoutingAddress>(
      'POST',
      `/accounts/${accountId}/email/routing/addresses`,
      { email }
    );
    return response.result;
  }

  async deleteEmailRoutingAddress(accountId: string, addressId: string): Promise<{ id: string }> {
    const response = await this.request<{ id: string }>(
      'DELETE',
      `/accounts/${accountId}/email/routing/addresses/${addressId}`
    );
    return response.result;
  }

  async listEmailRoutingRules(zoneId: string): Promise<CloudflareEmailRoutingRule[]> {
    const rules: CloudflareEmailRoutingRule[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.request<CloudflareEmailRoutingRule[]>(
        'GET',
        `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=100`
      );
      rules.push(...response.result);

      if (response.result_info) {
        hasMore = page < response.result_info.total_pages;
        page++;
      } else {
        hasMore = false;
      }
    }

    return rules;
  }

  async createEmailRoutingRule(
    zoneId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: CloudflareEmailRoutingMatcher[];
      priority?: number;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'POST',
      `/zones/${zoneId}/email/routing/rules`,
      rule as Record<string, unknown>
    );
    return response.result;
  }

  async updateEmailRoutingRule(
    zoneId: string,
    ruleId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: CloudflareEmailRoutingMatcher[];
      priority?: number;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'PUT',
      `/zones/${zoneId}/email/routing/rules/${ruleId}`,
      rule as Record<string, unknown>
    );
    return response.result;
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<{ id: string }> {
    const response = await this.request<{ id: string }>(
      'DELETE',
      `/zones/${zoneId}/email/routing/rules/${ruleId}`
    );
    return response.result;
  }

  async getEmailRoutingCatchAll(zoneId: string): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'GET',
      `/zones/${zoneId}/email/routing/rules/catch_all`
    );
    return response.result;
  }

  async updateEmailRoutingCatchAll(
    zoneId: string,
    rule: {
      name?: string;
      enabled: boolean;
      actions: CloudflareEmailRoutingAction[];
      matchers: Array<{ type: 'all' }>;
    }
  ): Promise<CloudflareEmailRoutingRule> {
    const response = await this.request<CloudflareEmailRoutingRule>(
      'PUT',
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      rule as Record<string, unknown>
    );
    return response.result;
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

    if (record.data) {
      body.data = record.data;
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

  /**
   * Ensure a set of DNS records exist for a name+type combination.
   * Creates missing records, deletes extra records, leaves matching records unchanged.
   * Useful for multi-value records like GitHub Pages A records.
   */
  async ensureRecords(
    zoneId: string,
    name: string,
    type: string,
    contents: string[],
    options?: { ttl?: number; proxied?: boolean }
  ): Promise<{ created: string[]; deleted: string[]; unchanged: string[] }> {
    // Get existing records for this name+type
    const allRecords = await this.listDnsRecords(zoneId, type);
    const existingRecords = allRecords.filter(
      (r) => r.name === name || r.name === `${name}.${r.zone_name}`
    );

    const existingContents = new Set(existingRecords.map((r) => r.content));
    const desiredContents = new Set(contents);

    const created: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    // Create missing records
    for (const content of contents) {
      if (!existingContents.has(content)) {
        try {
          await this.createDnsRecord(zoneId, {
            type,
            name,
            content,
            ttl: options?.ttl,
            proxied: options?.proxied,
          });
          created.push(content);
        } catch (error) {
          // Handle race condition where record was created between list and create
          if (error instanceof Error && error.message.includes('already exists')) {
            unchanged.push(content);
          } else {
            throw error;
          }
        }
      } else {
        unchanged.push(content);
      }
    }

    // Delete extra records
    for (const record of existingRecords) {
      if (!desiredContents.has(record.content)) {
        await this.deleteDnsRecord(zoneId, record.id);
        deleted.push(record.content);
      }
    }

    return { created, deleted, unchanged };
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
