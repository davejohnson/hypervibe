import type { ProviderIntegrationEvidence } from '../../../domain/registry/provider.registry.js';

const read = {access: 'read', status: 'live-unverified'} as const;
const write = {access: 'write', status: 'live-unverified'} as const;

export const sendGridCapabilityEvidence = {
  emailLogs: {
    access: 'read', status: 'partially-verified',
    summary: 'One account search and one exact-message timeline were observed on 2026-10-15. Environment attribution remains unverified.',
    liveEvidence: {
      verifiedAt: '2026-10-15T04:46:59.262Z',
      reference: 'https://github.com/davejohnson/hypervibe/blob/0f5ca3e7532c68db974dd2b3bbb21931b0edbb1a/test/provider-contracts/sendgrid-email-logs.md#bounded-live-evidence',
    },
  },
  connectionScopes: {...read, summary: 'Check management permissions on a connected account.'},
  domainAuthenticationRead: {...read, summary: 'Read domain authentications and their DNS records.'},
  domainAuthenticationWrite: {...write, summary: 'Create and validate a domain authentication.'},
  senderIdentityRead: {...read, summary: 'Inspect sender identity readiness.'},
  senderIdentityWrite: {...write, summary: 'Create a verified-sender request.'},
  eventWebhookRead: {...read, summary: 'Inspect delivery event webhooks and signing keys.'},
  eventWebhookWrite: {...write, summary: 'Configure delivery event webhooks and signing.'},
  inboundParseRead: {...read, summary: 'Inspect inbound routes and signing policies.'},
  inboundParseWrite: {...write, summary: 'Manage inbound routes and attach a signing policy.'},
} satisfies Record<string, ProviderIntegrationEvidence>;
