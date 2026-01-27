/**
 * Common email types and interface for email providers (SendGrid, Mailgun, etc.)
 */

export interface EmailDomainAuth {
  id: string | number;
  domain: string;
  valid: boolean;
  dnsRecords: Array<{
    name: string;
    type: string;
    value: string;
    valid: boolean;
    purpose: string;
  }>;
}

export interface SendEmailInput {
  to: string | string[];
  from: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

export interface IEmailProvider {
  readonly name: string;

  /**
   * Connect with provider credentials
   */
  connect(credentials: unknown): void;

  /**
   * Verify the connection works
   */
  verify(): Promise<{ success: boolean; error?: string }>;

  /**
   * List all domain authentications
   */
  listDomainAuthentications(): Promise<EmailDomainAuth[]>;

  /**
   * Get a specific domain authentication by ID
   */
  getDomainAuthentication(id: string | number): Promise<EmailDomainAuth | null>;

  /**
   * Validate/re-check domain authentication DNS records
   */
  validateDomainAuthentication(
    id: string | number
  ): Promise<{ valid: boolean; results: Record<string, { valid: boolean; reason?: string }> }>;

  /**
   * Send an email
   */
  sendEmail(input: SendEmailInput): Promise<{ success: boolean; messageId?: string; error?: string }>;
}
