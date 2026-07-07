import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  assessSendGridScopes,
  type SendGridAdapter,
  type SendGridDomainAuthentication,
} from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import {
  getSendGridAdapter,
  sendGridSetupReady,
  sendGridPermissionPayload,
  sendGridPermissionError,
} from '../domain/services/sendgrid-ops.service.js';
import { getCloudflareAdapter } from '../domain/services/cloudflare-ops.service.js';
import {
  resolveCloudflareEmailContext,
  normalizeDomain,
  normalizeAlias,
  normalizeEmail,
  routingRuleForAddress,
  forwardedTo,
  isVerifiedDestination,
  summarizeDestination,
  summarizeRule,
  rulePayload,
  catchAllPayload,
  ensureDestination,
} from '../domain/services/email-routing.service.js';
import type { ToolContext } from './context.js';
import { projectField } from './schemas.js';
import { toolSuccess, toolError, wrapHandler, HvError } from './respond.js';
import { connectionSetupDetails } from '../domain/services/connection-guidance.js';

interface SendGridDnsEntry {
  name: string;
  type: string;
  value: string;
  valid: boolean;
  purpose: string;
}

function sendgridDnsEntries(auth: SendGridDomainAuthentication): SendGridDnsEntry[] {
  const entries = [
    { record: auth.dns.dkim1, purpose: 'DKIM signature 1' },
    { record: auth.dns.dkim2, purpose: 'DKIM signature 2' },
    { record: auth.dns.mail_cname, purpose: 'Mail CNAME' },
  ];
  return entries
    .filter((e) => e.record)
    .map((e) => ({ name: e.record!.host, type: e.record!.type, value: e.record!.data, valid: e.record!.valid, purpose: e.purpose }));
}

async function findDomainAuth(adapter: SendGridAdapter, domain: string): Promise<SendGridDomainAuthentication | null> {
  const domains = await adapter.listDomainAuthentications();
  return domains.find((d) => d.domain.toLowerCase() === domain.toLowerCase()) ?? null;
}

export function registerHvEmailTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_email_setup',
    'Set up and manage transactional email (SendGrid). Default action "setup" runs the full flow for a domain: permission check, domain authentication, Cloudflare DNS records, then validation. Other actions: validate, dns-records, status, webhook-set, webhook-disable, webhook-test, sender-verify.',
    {
      project: projectField,
      domain: z.string().optional().describe('Email domain (e.g. example.com). Required for setup/validate/dns-records.'),
      action: z.enum(['setup', 'validate', 'dns-records', 'status', 'webhook-set', 'webhook-disable', 'webhook-test', 'sender-verify']).optional().describe('Defaults to "setup".'),
      url: z.string().optional().describe('Webhook endpoint URL (webhook-set, webhook-test)'),
      fromEmail: z.string().optional().describe('Sender email to verify (sender-verify)'),
      fromName: z.string().optional().describe('Sender display name (sender-verify)'),
    },
    wrapHandler(async ({ project: projectRef, domain, action = 'setup', url, fromEmail, fromName }) => {
      const project = ctx.resolveProject({ project: projectRef });
      const scopeHints = [
        ...(domain ? [normalizeDomain(domain)] : []),
        ...(project ? getProjectScopeHints(project) : []),
      ];
      const sgResult = getSendGridAdapter(scopeHints.length ? scopeHints : undefined);
      if ('error' in sgResult) {
        return toolError('MISSING_CONNECTION', sgResult.error, {
          details: { connectionSetup: connectionSetupDetails('sendgrid') },
        });
      }
      const { adapter } = sgResult;
      const normalizedDomain = domain ? normalizeDomain(domain) : undefined;

      const requireDomain = (): string => {
        if (!normalizedDomain) {
          throw new HvError('VALIDATION', `domain is required for action "${action}".`);
        }
        return normalizedDomain;
      };

      switch (action) {
        case 'setup': {
          const dom = requireDomain();
          const permissions = assessSendGridScopes(await adapter.getScopes());
          if (!sendGridSetupReady(permissions)) {
            return toolError('PROVIDER_ERROR', sendGridPermissionError(permissions), {
              details: sendGridPermissionPayload(permissions),
            });
          }

          const auth = (await findDomainAuth(adapter, dom)) ?? (await adapter.createDomainAuthentication(dom, { default: false }));
          const entries = sendgridDnsEntries(auth);

          // Create the SendGrid DNS records in Cloudflare.
          let dns: { configured: boolean; records?: Array<{ name: string; type: string; action: string }>; error?: string };
          const cfResult = getCloudflareAdapter(dom);
          if ('error' in cfResult) {
            dns = { configured: false, error: cfResult.error };
          } else {
            const zone = await cfResult.adapter.findZoneByName(dom);
            if (!zone) {
              dns = { configured: false, error: `Cloudflare zone not found for ${dom}` };
            } else {
              const records: Array<{ name: string; type: string; action: string }> = [];
              for (const entry of entries) {
                const upsert = await cfResult.adapter.upsertDnsRecord(zone.id, entry.name, entry.type, entry.value, { proxied: false });
                records.push({ name: entry.name, type: entry.type, action: upsert.action });
              }
              dns = { configured: records.length > 0, records };
            }
          }

          const validation = await adapter.validateDomainAuthentication(auth.id);

          ctx.repos.audit.create({
            action: 'hv.email_setup',
            resourceType: 'sendgrid_domain',
            resourceId: String(auth.id),
            details: { domain: dom, dnsConfigured: dns.configured, valid: validation.valid },
          });

          return toolSuccess(
            {
              domain: dom,
              domainId: auth.id,
              valid: validation.valid,
              validationResults: validation.validation_results,
              dns,
              requiredRecords: entries,
            },
            {
              warnings: dns.error ? [`DNS: ${dns.error}`] : undefined,
              hint: validation.valid
                ? 'Domain authentication is valid — email is ready to send.'
                : 'DNS records were just created; propagation can take a few minutes. Re-run with action="validate" shortly.',
            }
          );
        }
        case 'validate': {
          const dom = requireDomain();
          const auth = await findDomainAuth(adapter, dom);
          if (!auth) {
            return toolError('NOT_FOUND', `No SendGrid domain authentication found for ${dom}.`, {
              hint: 'Run hv_email_setup with action="setup" first.',
            });
          }
          const validation = await adapter.validateDomainAuthentication(auth.id);
          return toolSuccess({
            domain: dom,
            domainId: auth.id,
            valid: validation.valid,
            validationResults: validation.validation_results,
          });
        }
        case 'dns-records': {
          const dom = requireDomain();
          const auth = await findDomainAuth(adapter, dom);
          if (!auth) {
            return toolError('NOT_FOUND', `No SendGrid domain authentication found for ${dom}.`, {
              hint: 'Run hv_email_setup with action="setup" first.',
            });
          }
          return toolSuccess({ domain: dom, domainId: auth.id, valid: auth.valid, records: sendgridDnsEntries(auth) });
        }
        case 'status': {
          const permissions = assessSendGridScopes(await adapter.getScopes());
          const domains = await adapter.listDomainAuthentications();
          let webhook: unknown;
          try {
            const settings = await adapter.getEventWebhookSettings();
            webhook = { enabled: settings.enabled, url: settings.url };
          } catch (error) {
            webhook = { error: error instanceof Error ? error.message : String(error) };
          }
          return toolSuccess({
            permissions: sendGridPermissionPayload(permissions),
            domains: domains.map((d) => ({ id: d.id, domain: d.domain, valid: d.valid, default: d.default })),
            webhook,
          });
        }
        case 'webhook-set': {
          if (!url) throw new HvError('VALIDATION', 'url is required for action "webhook-set".');
          const settings = await adapter.enableEventWebhook(url);
          ctx.repos.audit.create({
            action: 'sendgrid.webhook_configured',
            resourceType: 'sendgrid_webhook',
            resourceId: 'event_webhook',
            details: { url },
          });
          return toolSuccess({ webhook: { enabled: settings.enabled, url: settings.url } });
        }
        case 'webhook-disable': {
          await adapter.disableEventWebhook();
          ctx.repos.audit.create({
            action: 'sendgrid.webhook_disabled',
            resourceType: 'sendgrid_webhook',
            resourceId: 'event_webhook',
            details: {},
          });
          return toolSuccess({ webhook: { enabled: false } });
        }
        case 'webhook-test': {
          if (!url) throw new HvError('VALIDATION', 'url is required for action "webhook-test".');
          const test = await adapter.testEventWebhook(url);
          return test.success
            ? toolSuccess({ url, delivered: true })
            : toolError('PROVIDER_ERROR', `Webhook test failed: ${test.error}`);
        }
        case 'sender-verify': {
          if (!fromEmail) throw new HvError('VALIDATION', 'fromEmail is required for action "sender-verify".');
          const permissions = assessSendGridScopes(await adapter.getScopes());
          if (!permissions.canManageSenderVerification) {
            return toolError('PROVIDER_ERROR', `SendGrid API key cannot create sender verification requests. Missing: ${permissions.missingScopes.senderVerification.join(', ')}.`, {
              details: sendGridPermissionPayload(permissions),
            });
          }
          const sender = await adapter.createVerifiedSender({
            nickname: fromEmail,
            fromEmail,
            replyTo: fromEmail,
            ...(fromName ? { fromName } : {}),
          });
          ctx.repos.audit.create({
            action: 'sendgrid.sender_verification_requested',
            resourceType: 'sendgrid_sender',
            resourceId: String(sender.id ?? fromEmail),
            details: { fromEmail },
          });
          return toolSuccess({ sender }, {
            hint: `SendGrid sent a verification email to ${fromEmail}; it must be accepted before sending.`,
          });
        }
      }
    })
  );

  server.tool(
    'hv_email_forwarding',
    'Manage email forwarding for a domain via Cloudflare Email Routing: list addresses, create or delete a forwarding address, or configure the catch-all route.',
    {
      domain: z.string().optional().describe('Domain name, e.g. example.com (required)'),
      action: z.enum(['list', 'create', 'delete', 'catchall']).describe('list addresses; create/delete a forwarding address; catchall: forward unmatched mail (or drop it when forwardTo is omitted)'),
      address: z.string().optional().describe('Alias, e.g. "support" or support@example.com (create, delete)'),
      forwardTo: z.string().optional().describe('Destination mailbox (create, catchall)'),
    },
    wrapHandler(async ({ domain, action, address, forwardTo }) => {
      if (!domain) {
        throw new HvError('VALIDATION', 'domain is required.', { hint: 'Pass domain=example.com.' });
      }
      const dom = normalizeDomain(domain);
      const context = await resolveCloudflareEmailContext(dom);
      if ('error' in context) {
        const code = context.error.includes('connection') ? 'MISSING_CONNECTION' : 'NOT_FOUND';
        return toolError(code, context.error, code === 'MISSING_CONNECTION'
          ? { details: { connectionSetup: connectionSetupDetails('cloudflare', { scope: dom }) } }
          : undefined);
      }

      switch (action) {
        case 'list': {
          const [rules, catchAll, destinations] = await Promise.all([
            context.adapter.listEmailRoutingRules(context.zone.id),
            context.adapter.getEmailRoutingCatchAll(context.zone.id).catch(() => undefined),
            context.adapter.listEmailRoutingAddresses(context.accountId),
          ]);
          return toolSuccess({
            domain: dom,
            count: rules.length,
            addresses: rules.map((rule) => ({
              id: rule.id,
              enabled: rule.enabled,
              address: rule.matchers.find((m) => m.type === 'literal' && m.field === 'to')?.value,
              forwardsTo: forwardedTo(rule),
            })),
            catchAll: catchAll ? summarizeRule(catchAll) : undefined,
            destinations: destinations.map(summarizeDestination),
          });
        }
        case 'create': {
          if (!address || !forwardTo) {
            throw new HvError('VALIDATION', 'create requires address and forwardTo.');
          }
          const alias = normalizeAlias(address, dom);
          const destinationEmail = normalizeEmail(forwardTo);
          if (!alias.endsWith(`@${dom}`)) {
            throw new HvError('VALIDATION', `Address ${alias} is not under domain ${dom}.`);
          }

          const rules = await context.adapter.listEmailRoutingRules(context.zone.id);
          const existing = rules.find((rule) => routingRuleForAddress(rule, alias));
          const destination = await ensureDestination(context.adapter, context.accountId, destinationEmail, true);
          await context.adapter.enableEmailRoutingDns(context.zone.id);
          const payload = rulePayload(alias, destinationEmail);
          const route = existing
            ? await context.adapter.updateEmailRoutingRule(context.zone.id, existing.id, payload)
            : await context.adapter.createEmailRoutingRule(context.zone.id, payload);

          ctx.repos.audit.create({
            action: existing ? 'email.address_updated' : 'email.address_created',
            resourceType: 'email_address',
            resourceId: alias,
            details: { domain: dom, forwardTo: destinationEmail, routeId: route.id },
          });

          const verificationRequired = destination.destination ? !isVerifiedDestination(destination.destination) : true;
          return toolSuccess(
            {
              domain: dom,
              address: alias,
              forwardTo: destinationEmail,
              route: summarizeRule(route),
              destination: destination.destination ? summarizeDestination(destination.destination) : undefined,
              destinationCreated: destination.destinationCreated ?? false,
              destinationVerificationRequired: verificationRequired,
            },
            {
              hint: verificationRequired
                ? `${destinationEmail} must accept Cloudflare's verification email before forwarding works.`
                : `${alias} now forwards to ${destinationEmail}.`,
            }
          );
        }
        case 'delete': {
          if (!address) throw new HvError('VALIDATION', 'delete requires address.');
          const alias = normalizeAlias(address, dom);
          const rules = await context.adapter.listEmailRoutingRules(context.zone.id);
          const rule = rules.find((candidate) => routingRuleForAddress(candidate, alias));
          if (!rule) {
            return toolSuccess({ domain: dom, address: alias, deleted: false }, {
              hint: `No routing rule exists for ${alias}; nothing to do.`,
            });
          }
          await context.adapter.deleteEmailRoutingRule(context.zone.id, rule.id);
          ctx.repos.audit.create({
            action: 'email.address_deleted',
            resourceType: 'email_address',
            resourceId: alias,
            details: { domain: dom, routeId: rule.id },
          });
          return toolSuccess({ domain: dom, address: alias, deleted: true, deletedRouteId: rule.id });
        }
        case 'catchall': {
          const destinationEmail = forwardTo ? normalizeEmail(forwardTo) : undefined;
          if (destinationEmail) {
            await ensureDestination(context.adapter, context.accountId, destinationEmail, true);
          }
          await context.adapter.enableEmailRoutingDns(context.zone.id);
          const catchAll = await context.adapter.updateEmailRoutingCatchAll(
            context.zone.id,
            catchAllPayload(destinationEmail ? 'forward' : 'drop', destinationEmail, true)
          );
          ctx.repos.audit.create({
            action: 'email.catchall_updated',
            resourceType: 'email_catchall',
            resourceId: dom,
            details: { domain: dom, action: destinationEmail ? 'forward' : 'drop', forwardTo: destinationEmail },
          });
          return toolSuccess({ domain: dom, catchAll: summarizeRule(catchAll) }, {
            hint: destinationEmail
              ? `Catch-all for ${dom} now forwards to ${destinationEmail}.`
              : `Catch-all for ${dom} now drops unmatched email.`,
          });
        }
      }
    })
  );

  server.tool(
    'hv_email_send',
    'Send an email via SendGrid.',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Plain-text email body'),
      from: z.string().optional().describe('Sender address — must belong to an authenticated domain or a verified single sender.'),
    },
    wrapHandler(async ({ to, subject, body, from }) => {
      if (!from) {
        throw new HvError('VALIDATION', 'from is required.', {
          hint: 'Pass a sender on an authenticated domain (hv_email_setup) or a verified single sender (action="sender-verify").',
        });
      }
      const sgResult = getSendGridAdapter();
      if ('error' in sgResult) {
        return toolError('MISSING_CONNECTION', sgResult.error, {
          details: { connectionSetup: connectionSetupDetails('sendgrid') },
        });
      }
      const result = await sgResult.adapter.sendEmail({ to, from, subject, text: body });
      if (!result.success) {
        return toolError('PROVIDER_ERROR', result.error ?? 'SendGrid send failed');
      }
      ctx.repos.audit.create({
        action: 'sendgrid.email_sent',
        resourceType: 'email',
        resourceId: to,
        details: { to, from, subject },
      });
      return toolSuccess({ sent: true, to, from, messageId: result.messageId });
    })
  );
}
