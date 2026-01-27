import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { AuditRepository } from '../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { SendGridAdapter, SENDGRID_COMMON_WEBHOOK_EVENTS } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import { CloudflareAdapter } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import type { SendGridCredentials } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { CloudflareCredentials } from '../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { RailwayCredentials } from '../adapters/providers/railway/railway.adapter.js';

const connectionRepo = new ConnectionRepository();
const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const auditRepo = new AuditRepository();

function getSendGridAdapter(): { adapter: SendGridAdapter } | { error: string } {
  const connection = connectionRepo.findByProvider('sendgrid');
  if (!connection) {
    return { error: 'No SendGrid connection found. Use connection_create with provider=sendgrid first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<SendGridCredentials>(connection.credentialsEncrypted);
  const adapter = new SendGridAdapter();
  adapter.connect(credentials);

  return { adapter };
}

function getCloudflareAdapter(): { adapter: CloudflareAdapter } | { error: string } {
  const connection = connectionRepo.findByProvider('cloudflare');
  if (!connection) {
    return { error: 'No Cloudflare connection found. Use connection_create with provider=cloudflare first.' };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<CloudflareCredentials>(connection.credentialsEncrypted);
  const adapter = new CloudflareAdapter();
  adapter.connect(credentials);

  return { adapter };
}

export function registerSendGridTools(server: McpServer): void {
  server.tool(
    'sendgrid_domains_list',
    'List domain authentications with their validation status',
    {},
    async () => {
      const result = getSendGridAdapter();
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
        const domains = await adapter.listDomainAuthentications();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: domains.length,
              domains: domains.map((d) => ({
                id: d.id,
                domain: d.domain,
                subdomain: d.subdomain,
                valid: d.valid,
                default: d.default,
                dnsRecords: {
                  dkim1Valid: d.dns.dkim1?.valid ?? false,
                  dkim2Valid: d.dns.dkim2?.valid ?? false,
                  mailCnameValid: d.dns.mail_cname?.valid ?? false,
                },
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
    'sendgrid_domain_dns_records',
    'Get the required DNS records for a SendGrid domain authentication',
    {
      domainId: z.number().describe('SendGrid domain authentication ID'),
    },
    async ({ domainId }) => {
      const result = getSendGridAdapter();
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
        const domain = await adapter.getDomainAuthentication(domainId);
        if (!domain) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `Domain authentication ${domainId} not found` }),
            }],
          };
        }

        const records: Array<{
          name: string;
          type: string;
          value: string;
          valid: boolean;
          purpose: string;
        }> = [];

        if (domain.dns.dkim1) {
          records.push({
            name: domain.dns.dkim1.host,
            type: domain.dns.dkim1.type,
            value: domain.dns.dkim1.data,
            valid: domain.dns.dkim1.valid,
            purpose: 'DKIM signature 1',
          });
        }

        if (domain.dns.dkim2) {
          records.push({
            name: domain.dns.dkim2.host,
            type: domain.dns.dkim2.type,
            value: domain.dns.dkim2.data,
            valid: domain.dns.dkim2.valid,
            purpose: 'DKIM signature 2',
          });
        }

        if (domain.dns.mail_cname) {
          records.push({
            name: domain.dns.mail_cname.host,
            type: domain.dns.mail_cname.type,
            value: domain.dns.mail_cname.data,
            valid: domain.dns.mail_cname.valid,
            purpose: 'Mail CNAME for branded links',
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              domainId,
              domain: domain.domain,
              subdomain: domain.subdomain,
              valid: domain.valid,
              records,
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
    'sendgrid_domain_validate',
    'Re-validate DNS records for a SendGrid domain authentication',
    {
      domainId: z.number().describe('SendGrid domain authentication ID'),
    },
    async ({ domainId }) => {
      const result = getSendGridAdapter();
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
        const validation = await adapter.validateDomainAuthentication(domainId);

        auditRepo.create({
          action: 'sendgrid.domain_validated',
          resourceType: 'sendgrid_domain',
          resourceId: String(domainId),
          details: { valid: validation.valid, results: validation.validation_results },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              domainId: validation.id,
              valid: validation.valid,
              validationResults: validation.validation_results,
              message: validation.valid
                ? 'Domain authentication is valid. All DNS records are correctly configured.'
                : 'Domain authentication is not valid. Check the validation results for details.',
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
    'sendgrid_email_send',
    'Send a test email via SendGrid',
    {
      to: z.string().describe('Recipient email address'),
      from: z.string().describe('Sender email address (must be from authenticated domain)'),
      subject: z.string().describe('Email subject'),
      text: z.string().optional().describe('Plain text body'),
      html: z.string().optional().describe('HTML body'),
      replyTo: z.string().optional().describe('Reply-to email address'),
    },
    async ({ to, from, subject, text, html, replyTo }) => {
      if (!text && !html) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Either text or html body is required' }),
          }],
        };
      }

      const result = getSendGridAdapter();
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
        const sendResult = await adapter.sendEmail({
          to,
          from,
          subject,
          text,
          html,
          replyTo,
        });

        if (sendResult.success) {
          auditRepo.create({
            action: 'sendgrid.email_sent',
            resourceType: 'email',
            resourceId: 'test',
            details: { to, from, subject },
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: `Email sent successfully to ${to}`,
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: sendResult.error,
              }),
            }],
          };
        }
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
    'sendgrid_domain_setup_dns',
    'Auto-create Cloudflare DNS records for SendGrid domain authentication (two-step: preview then confirm)',
    {
      domainId: z.number().describe('SendGrid domain authentication ID'),
      confirm: z.boolean().optional().describe('Set to true to actually create the records'),
    },
    async ({ domainId, confirm }) => {
      // Get SendGrid adapter and domain info
      const sgResult = getSendGridAdapter();
      if ('error' in sgResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: sgResult.error }),
          }],
        };
      }

      const { adapter: sendgridAdapter } = sgResult;

      // Get Cloudflare adapter
      const cfResult = getCloudflareAdapter();
      if ('error' in cfResult) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: cfResult.error }),
          }],
        };
      }

      const { adapter: cloudflareAdapter } = cfResult;

      try {
        // Get SendGrid domain authentication details
        const domain = await sendgridAdapter.getDomainAuthentication(domainId);
        if (!domain) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: `Domain authentication ${domainId} not found` }),
            }],
          };
        }

        // Find the Cloudflare zone for this domain
        const zone = await cloudflareAdapter.findZoneByName(domain.domain);
        if (!zone) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Domain "${domain.domain}" not found in Cloudflare account. Make sure the domain is added to Cloudflare.`,
              }),
            }],
          };
        }

        // Collect DNS records that need to be created
        const recordsToCreate: Array<{
          name: string;
          type: string;
          content: string;
          purpose: string;
          alreadyValid: boolean;
        }> = [];

        if (domain.dns.dkim1) {
          recordsToCreate.push({
            name: domain.dns.dkim1.host,
            type: domain.dns.dkim1.type,
            content: domain.dns.dkim1.data,
            purpose: 'DKIM signature 1',
            alreadyValid: domain.dns.dkim1.valid,
          });
        }

        if (domain.dns.dkim2) {
          recordsToCreate.push({
            name: domain.dns.dkim2.host,
            type: domain.dns.dkim2.type,
            content: domain.dns.dkim2.data,
            purpose: 'DKIM signature 2',
            alreadyValid: domain.dns.dkim2.valid,
          });
        }

        if (domain.dns.mail_cname) {
          recordsToCreate.push({
            name: domain.dns.mail_cname.host,
            type: domain.dns.mail_cname.type,
            content: domain.dns.mail_cname.data,
            purpose: 'Mail CNAME',
            alreadyValid: domain.dns.mail_cname.valid,
          });
        }

        // Filter to only records that aren't already valid
        const pendingRecords = recordsToCreate.filter((r) => !r.alreadyValid);

        if (pendingRecords.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'All DNS records are already valid. No changes needed.',
                domain: domain.domain,
                valid: domain.valid,
              }),
            }],
          };
        }

        // Preview mode - return planned changes
        if (!confirm) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                mode: 'preview',
                message: `Found ${pendingRecords.length} DNS record(s) to create. Call again with confirm=true to create them.`,
                domain: domain.domain,
                zoneId: zone.id,
                plannedChanges: pendingRecords.map((r) => ({
                  action: 'create',
                  name: r.name,
                  type: r.type,
                  content: r.content,
                  purpose: r.purpose,
                })),
                alreadyValid: recordsToCreate.filter((r) => r.alreadyValid).map((r) => ({
                  name: r.name,
                  type: r.type,
                  purpose: r.purpose,
                })),
              }),
            }],
          };
        }

        // Confirm mode - create the records
        const results: Array<{
          name: string;
          type: string;
          success: boolean;
          action?: 'created' | 'updated';
          error?: string;
        }> = [];

        for (const record of pendingRecords) {
          try {
            const { action } = await cloudflareAdapter.upsertDnsRecord(
              zone.id,
              record.name,
              record.type,
              record.content,
              { proxied: false } // DNS records for email should not be proxied
            );

            results.push({
              name: record.name,
              type: record.type,
              success: true,
              action,
            });
          } catch (error) {
            results.push({
              name: record.name,
              type: record.type,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const allSucceeded = results.every((r) => r.success);

        auditRepo.create({
          action: 'sendgrid.dns_setup',
          resourceType: 'sendgrid_domain',
          resourceId: String(domainId),
          details: { domain: domain.domain, results },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: allSucceeded,
              mode: 'executed',
              domain: domain.domain,
              results,
              message: allSucceeded
                ? `Successfully created ${results.length} DNS record(s). Run sendgrid_domain_validate to verify.`
                : `Completed with some errors. ${results.filter((r) => r.success).length}/${results.length} records created.`,
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

  // Event Webhook Tools

  server.tool(
    'sendgrid_webhook_get',
    'Get current SendGrid event webhook settings',
    {},
    async () => {
      const result = getSendGridAdapter();
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
        const settings = await adapter.getEventWebhookSettings();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              webhook: {
                enabled: settings.enabled,
                url: settings.url,
                events: {
                  bounce: settings.bounce,
                  click: settings.click,
                  deferred: settings.deferred,
                  delivered: settings.delivered,
                  dropped: settings.dropped,
                  open: settings.open,
                  processed: settings.processed,
                  spam_report: settings.spam_report,
                  unsubscribe: settings.unsubscribe,
                  group_unsubscribe: settings.group_unsubscribe,
                  group_resubscribe: settings.group_resubscribe,
                },
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
    'sendgrid_webhook_set',
    'Configure SendGrid event webhook URL and events',
    {
      url: z.string().url().describe('Webhook endpoint URL'),
      events: z.array(z.enum([
        'bounce', 'click', 'deferred', 'delivered', 'dropped',
        'open', 'processed', 'spam_report', 'unsubscribe',
        'group_unsubscribe', 'group_resubscribe'
      ])).optional().describe('Events to enable (defaults to all)'),
    },
    async ({ url, events }) => {
      const result = getSendGridAdapter();
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
        // Build event settings
        const eventSettings: Record<string, boolean> = {};
        const eventsToEnable = events ?? SENDGRID_COMMON_WEBHOOK_EVENTS;

        for (const event of SENDGRID_COMMON_WEBHOOK_EVENTS) {
          eventSettings[event] = eventsToEnable.includes(event);
        }

        const settings = await adapter.enableEventWebhook(url, eventSettings as Parameters<typeof adapter.enableEventWebhook>[1]);

        auditRepo.create({
          action: 'sendgrid.webhook_configured',
          resourceType: 'sendgrid_webhook',
          resourceId: 'event_webhook',
          details: { url, events: eventsToEnable },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Event webhook configured for ${url}`,
              webhook: {
                enabled: settings.enabled,
                url: settings.url,
                enabledEvents: eventsToEnable,
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
    'sendgrid_webhook_disable',
    'Disable SendGrid event webhook',
    {},
    async () => {
      const result = getSendGridAdapter();
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
        await adapter.disableEventWebhook();

        auditRepo.create({
          action: 'sendgrid.webhook_disabled',
          resourceType: 'sendgrid_webhook',
          resourceId: 'event_webhook',
          details: {},
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: 'Event webhook disabled',
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
    'sendgrid_webhook_test',
    'Send a test event to the configured webhook URL',
    {
      url: z.string().url().describe('Webhook URL to test'),
    },
    async ({ url }) => {
      const result = getSendGridAdapter();
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
        const testResult = await adapter.testEventWebhook(url);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: testResult.success,
              message: testResult.success
                ? `Test event sent to ${url}`
                : `Test failed: ${testResult.error}`,
              error: testResult.error,
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
    'sendgrid_webhook_events',
    'List available SendGrid webhook event types',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            events: SENDGRID_COMMON_WEBHOOK_EVENTS,
            descriptions: {
              bounce: 'Email bounced (hard or soft)',
              click: 'Recipient clicked a link',
              deferred: 'Email delivery deferred by receiving server',
              delivered: 'Email successfully delivered',
              dropped: 'Email dropped (invalid, spam, etc.)',
              open: 'Recipient opened the email',
              processed: 'Email received by SendGrid',
              spam_report: 'Recipient marked as spam',
              unsubscribe: 'Recipient unsubscribed',
              group_unsubscribe: 'Recipient unsubscribed from group',
              group_resubscribe: 'Recipient resubscribed to group',
            },
            documentation: 'https://docs.sendgrid.com/for-developers/tracking-events/event',
          }),
        }],
      };
    }
  );

  // Combined Setup Tool

  server.tool(
    'sendgrid_setup',
    'Set up SendGrid for an environment: sync API key to Railway and optionally configure webhook',
    {
      projectName: z.string().describe('Infraprint project name'),
      environmentName: z.string().describe('Environment to configure'),
      serviceName: z.string().describe('Service to set env vars on'),
      webhookUrl: z.string().url().optional().describe('Webhook URL for email events (optional)'),
      apiKeyEnvVar: z.string().optional().describe('Env var name for API key (default: SENDGRID_API_KEY)'),
    },
    async ({ projectName, environmentName, serviceName, webhookUrl, apiKeyEnvVar = 'SENDGRID_API_KEY' }) => {
      // Get SendGrid connection
      const sgConnection = connectionRepo.findByProvider('sendgrid');
      if (!sgConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No SendGrid connection found. Use connection_create with provider=sendgrid first.',
            }),
          }],
        };
      }

      // Get Railway connection
      const railwayConnection = connectionRepo.findByProvider('railway');
      if (!railwayConnection) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No Railway connection found. Use connection_create with provider=railway first.',
            }),
          }],
        };
      }

      // Find project and environment
      const project = projectRepo.findByName(projectName);
      if (!project) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Project not found: ${projectName}` }),
          }],
        };
      }

      const environment = envRepo.findByProjectAndName(project.id, environmentName);
      if (!environment) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Environment not found: ${environmentName}` }),
          }],
        };
      }

      const service = serviceRepo.findByProjectAndName(project.id, serviceName);
      if (!service) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Service not found: ${serviceName}` }),
          }],
        };
      }

      // Check Railway bindings
      const bindings = environment.platformBindings as {
        railwayProjectId?: string;
        railwayEnvironmentId?: string;
        services?: Record<string, { serviceId: string }>;
      };

      if (!bindings.railwayProjectId || !bindings.services?.[serviceName]?.serviceId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Service ${serviceName} not deployed to Railway in environment ${environmentName}`,
            }),
          }],
        };
      }

      const secretStore = getSecretStore();
      const response: Record<string, unknown> = { success: true };

      try {
        // Step 1: Sync API key to Railway
        const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
        const railwayCreds = secretStore.decryptObject<RailwayCredentials>(railwayConnection.credentialsEncrypted);

        const railwayAdapter = new RailwayAdapter();
        await railwayAdapter.connect(railwayCreds);

        const envVars: Record<string, string> = {
          [apiKeyEnvVar]: sgCreds.apiKey,
        };

        const syncResult = await railwayAdapter.setEnvVars(environment, service, envVars);

        if (syncResult.success) {
          response.apiKeySynced = true;
          response.apiKeyEnvVar = apiKeyEnvVar;
        } else {
          response.apiKeySynced = false;
          response.apiKeySyncError = syncResult.error;
        }

        // Step 2: Configure webhook if URL provided
        if (webhookUrl) {
          const sgAdapter = new SendGridAdapter();
          sgAdapter.connect(sgCreds);

          try {
            const webhookSettings = await sgAdapter.enableEventWebhook(webhookUrl);
            response.webhookConfigured = true;
            response.webhookUrl = webhookSettings.url;
          } catch (error) {
            response.webhookConfigured = false;
            response.webhookError = error instanceof Error ? error.message : String(error);
          }
        }

        auditRepo.create({
          action: 'sendgrid.setup',
          resourceType: 'sendgrid',
          resourceId: environment.id,
          details: {
            project: projectName,
            environment: environmentName,
            service: serviceName,
            apiKeySynced: response.apiKeySynced,
            webhookConfigured: response.webhookConfigured,
          },
        });

        response.message = response.apiKeySynced
          ? `SendGrid configured for ${serviceName} in ${environmentName}`
          : `Setup completed with errors`;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response),
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
