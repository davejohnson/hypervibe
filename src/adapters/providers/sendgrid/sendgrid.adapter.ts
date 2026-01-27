import { z } from 'zod';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import type { IEmailProvider, EmailDomainAuth, SendEmailInput as EmailInput } from '../../../domain/ports/email.port.js';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3';

export interface SendGridDomainAuthentication {
  id: number;
  domain: string;
  subdomain: string;
  username: string;
  valid: boolean;
  default: boolean;
  legacy: boolean;
  dns: SendGridDnsRecords;
}

export interface SendGridDnsRecords {
  mail_cname?: SendGridDnsRecord;
  dkim1?: SendGridDnsRecord;
  dkim2?: SendGridDnsRecord;
  mail_server?: SendGridDnsRecord;
  subdomain_spf?: SendGridDnsRecord;
}

export interface SendGridDnsRecord {
  host: string;
  type: string;
  data: string;
  valid: boolean;
}

export interface SendGridValidationResult {
  id: number;
  valid: boolean;
  validation_results: {
    mail_cname?: { valid: boolean; reason?: string };
    dkim1?: { valid: boolean; reason?: string };
    dkim2?: { valid: boolean; reason?: string };
  };
}

export interface SendEmailInput {
  to: string | string[];
  from: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

export interface SendGridEventWebhook {
  enabled: boolean;
  url: string;
  oauth_client_id?: string;
  oauth_token_url?: string;
}

export interface SendGridEventWebhookSettings {
  enabled: boolean;
  url: string;
  group_resubscribe: boolean;
  delivered: boolean;
  group_unsubscribe: boolean;
  spam_report: boolean;
  bounce: boolean;
  deferred: boolean;
  unsubscribe: boolean;
  processed: boolean;
  open: boolean;
  click: boolean;
  dropped: boolean;
}

// Common event types for SendGrid webhooks
export const SENDGRID_COMMON_WEBHOOK_EVENTS = [
  'bounce',
  'click',
  'deferred',
  'delivered',
  'dropped',
  'open',
  'processed',
  'spam_report',
  'unsubscribe',
  'group_unsubscribe',
  'group_resubscribe',
];

// Credentials schema for self-registration
export const SendGridCredentialsSchema = z.object({
  apiKey: z.string().min(1, 'API key is required').refine(
    (key) => key.startsWith('SG.'),
    'SendGrid API key must start with SG.'
  ),
});

export type SendGridCredentials = z.infer<typeof SendGridCredentialsSchema>;

export class SendGridAdapter {
  readonly name = 'sendgrid';
  private credentials: SendGridCredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = credentials as SendGridCredentials;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.apiKey}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${SENDGRID_API_URL}${endpoint}`, options);

    // Handle no-content responses (e.g., successful email send returns 202 with no body)
    if (response.status === 202 || response.status === 204) {
      return {} as T;
    }

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = (data as { errors?: Array<{ message: string }> }).errors
        ?.map((e) => e.message)
        .join(', ') || `HTTP ${response.status}`;
      throw new Error(`SendGrid API error: ${errorMsg}`);
    }

    return data as T;
  }

  async verify(): Promise<{ success: boolean; error?: string }> {
    try {
      // Test API key by fetching scopes
      await this.request<{ scopes: string[] }>('GET', '/scopes');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDomainAuthentications(): Promise<SendGridDomainAuthentication[]> {
    const result = await this.request<SendGridDomainAuthentication[]>(
      'GET',
      '/whitelabel/domains'
    );
    return result;
  }

  async getDomainAuthentication(domainId: number): Promise<SendGridDomainAuthentication | null> {
    try {
      const result = await this.request<SendGridDomainAuthentication>(
        'GET',
        `/whitelabel/domains/${domainId}`
      );
      return result;
    } catch {
      return null;
    }
  }

  async getDomainDnsRecords(domainId: number): Promise<SendGridDnsRecords | null> {
    const domain = await this.getDomainAuthentication(domainId);
    return domain?.dns ?? null;
  }

  async validateDomainAuthentication(domainId: number): Promise<SendGridValidationResult> {
    const result = await this.request<SendGridValidationResult>(
      'POST',
      `/whitelabel/domains/${domainId}/validate`
    );
    return result;
  }

  async sendEmail(input: SendEmailInput): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const toArray = Array.isArray(input.to) ? input.to : [input.to];

      const body: Record<string, unknown> = {
        personalizations: [
          {
            to: toArray.map((email) => ({ email })),
          },
        ],
        from: { email: input.from },
        subject: input.subject,
        content: [],
      };

      if (input.replyTo) {
        body.reply_to = { email: input.replyTo };
      }

      const content: Array<{ type: string; value: string }> = [];
      if (input.text) {
        content.push({ type: 'text/plain', value: input.text });
      }
      if (input.html) {
        content.push({ type: 'text/html', value: input.html });
      }
      if (content.length === 0) {
        content.push({ type: 'text/plain', value: '' });
      }
      body.content = content;

      await this.request('POST', '/mail/send', body);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createDomainAuthentication(
    domain: string,
    options?: { subdomain?: string; default?: boolean }
  ): Promise<SendGridDomainAuthentication> {
    const body: Record<string, unknown> = {
      domain,
      default: options?.default ?? false,
    };

    if (options?.subdomain) {
      body.subdomain = options.subdomain;
    }

    const result = await this.request<SendGridDomainAuthentication>(
      'POST',
      '/whitelabel/domains',
      body
    );
    return result;
  }

  // IEmailProvider interface methods

  private convertToEmailDomainAuth(domain: SendGridDomainAuthentication): EmailDomainAuth {
    const dnsRecords: EmailDomainAuth['dnsRecords'] = [];

    if (domain.dns.mail_cname) {
      dnsRecords.push({
        name: domain.dns.mail_cname.host,
        type: domain.dns.mail_cname.type,
        value: domain.dns.mail_cname.data,
        valid: domain.dns.mail_cname.valid,
        purpose: 'mail_cname',
      });
    }
    if (domain.dns.dkim1) {
      dnsRecords.push({
        name: domain.dns.dkim1.host,
        type: domain.dns.dkim1.type,
        value: domain.dns.dkim1.data,
        valid: domain.dns.dkim1.valid,
        purpose: 'dkim1',
      });
    }
    if (domain.dns.dkim2) {
      dnsRecords.push({
        name: domain.dns.dkim2.host,
        type: domain.dns.dkim2.type,
        value: domain.dns.dkim2.data,
        valid: domain.dns.dkim2.valid,
        purpose: 'dkim2',
      });
    }
    if (domain.dns.mail_server) {
      dnsRecords.push({
        name: domain.dns.mail_server.host,
        type: domain.dns.mail_server.type,
        value: domain.dns.mail_server.data,
        valid: domain.dns.mail_server.valid,
        purpose: 'mail_server',
      });
    }
    if (domain.dns.subdomain_spf) {
      dnsRecords.push({
        name: domain.dns.subdomain_spf.host,
        type: domain.dns.subdomain_spf.type,
        value: domain.dns.subdomain_spf.data,
        valid: domain.dns.subdomain_spf.valid,
        purpose: 'subdomain_spf',
      });
    }

    return {
      id: domain.id,
      domain: domain.domain,
      valid: domain.valid,
      dnsRecords,
    };
  }

  async listDomainAuthenticationsAsPort(): Promise<EmailDomainAuth[]> {
    const domains = await this.listDomainAuthentications();
    return domains.map((d) => this.convertToEmailDomainAuth(d));
  }

  async getDomainAuthenticationAsPort(id: string | number): Promise<EmailDomainAuth | null> {
    const domainId = typeof id === 'string' ? parseInt(id, 10) : id;
    const domain = await this.getDomainAuthentication(domainId);
    return domain ? this.convertToEmailDomainAuth(domain) : null;
  }

  async validateDomainAuthenticationAsPort(
    id: string | number
  ): Promise<{ valid: boolean; results: Record<string, { valid: boolean; reason?: string }> }> {
    const domainId = typeof id === 'string' ? parseInt(id, 10) : id;
    const result = await this.validateDomainAuthentication(domainId);

    const results: Record<string, { valid: boolean; reason?: string }> = {};
    if (result.validation_results.mail_cname) {
      results.mail_cname = result.validation_results.mail_cname;
    }
    if (result.validation_results.dkim1) {
      results.dkim1 = result.validation_results.dkim1;
    }
    if (result.validation_results.dkim2) {
      results.dkim2 = result.validation_results.dkim2;
    }

    return { valid: result.valid, results };
  }

  // Event Webhook Management

  async getEventWebhookSettings(): Promise<SendGridEventWebhookSettings> {
    return this.request<SendGridEventWebhookSettings>('GET', '/user/webhooks/event/settings');
  }

  async updateEventWebhookSettings(
    settings: Partial<SendGridEventWebhookSettings>
  ): Promise<SendGridEventWebhookSettings> {
    return this.request<SendGridEventWebhookSettings>(
      'PATCH',
      '/user/webhooks/event/settings',
      settings as Record<string, unknown>
    );
  }

  async enableEventWebhook(
    url: string,
    events?: {
      bounce?: boolean;
      click?: boolean;
      deferred?: boolean;
      delivered?: boolean;
      dropped?: boolean;
      open?: boolean;
      processed?: boolean;
      spam_report?: boolean;
      unsubscribe?: boolean;
      group_unsubscribe?: boolean;
      group_resubscribe?: boolean;
    }
  ): Promise<SendGridEventWebhookSettings> {
    // Default to all common events if not specified
    const eventSettings = events ?? {
      bounce: true,
      click: true,
      deferred: true,
      delivered: true,
      dropped: true,
      open: true,
      processed: true,
      spam_report: true,
      unsubscribe: true,
      group_unsubscribe: true,
      group_resubscribe: true,
    };

    return this.updateEventWebhookSettings({
      enabled: true,
      url,
      ...eventSettings,
    });
  }

  async disableEventWebhook(): Promise<SendGridEventWebhookSettings> {
    return this.updateEventWebhookSettings({ enabled: false });
  }

  async testEventWebhook(url: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request('POST', '/user/webhooks/event/test', { url });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Inbound Parse Webhook (for receiving emails)

  async listInboundParseWebhooks(): Promise<Array<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }>> {
    const result = await this.request<{ result: Array<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }> }>(
      'GET',
      '/user/webhooks/parse/settings'
    );
    return result.result ?? [];
  }

  async createInboundParseWebhook(
    hostname: string,
    url: string,
    options?: { spam_check?: boolean; send_raw?: boolean }
  ): Promise<{ hostname: string; url: string; spam_check: boolean; send_raw: boolean }> {
    return this.request(
      'POST',
      '/user/webhooks/parse/settings',
      {
        hostname,
        url,
        spam_check: options?.spam_check ?? true,
        send_raw: options?.send_raw ?? false,
      }
    );
  }

  async deleteInboundParseWebhook(hostname: string): Promise<void> {
    await this.request('DELETE', `/user/webhooks/parse/settings/${hostname}`);
  }
}

// Self-register with provider registry
providerRegistry.register({
  metadata: {
    name: 'sendgrid',
    displayName: 'SendGrid',
    category: 'email',
    credentialsSchema: SendGridCredentialsSchema,
    setupHelpUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  factory: (credentials) => {
    const adapter = new SendGridAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
