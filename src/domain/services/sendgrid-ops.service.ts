import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import {
  SendGridAdapter,
  SENDGRID_SCOPE_REQUIREMENTS,
} from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { SendGridCredentials } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { SendGridPermissionAudit } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';

const connectionRepo = new ConnectionRepository();

function missingScopeGroups(permissions: SendGridPermissionAudit, requireWebhook = false): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  if (!permissions.hasMailSend) missing.mailSend = permissions.missingScopes.mailSend;
  if (!permissions.canManageDomainAuthentication && !permissions.canManageSenderVerification) {
    missing.domainAuthentication = permissions.missingScopes.domainAuthentication;
    missing.senderVerification = permissions.missingScopes.senderVerification;
  }
  if (requireWebhook && !permissions.canConfigureEventWebhook) {
    missing.eventWebhook = permissions.missingScopes.eventWebhook;
  }
  return missing;
}

export function sendGridSetupReady(permissions: SendGridPermissionAudit, requireWebhook = false): boolean {
  return permissions.setupReady && (!requireWebhook || permissions.canConfigureEventWebhook);
}

export function sendGridPermissionPayload(permissions: SendGridPermissionAudit, requireWebhook = false): Record<string, unknown> {
  return {
    setupReady: sendGridSetupReady(permissions, requireWebhook),
    hasMailSend: permissions.hasMailSend,
    canAuthorizeSenderEmail: permissions.canManageDomainAuthentication || permissions.canManageSenderVerification,
    canManageDomainAuthentication: permissions.canManageDomainAuthentication,
    canManageSenderVerification: permissions.canManageSenderVerification,
    canConfigureEventWebhook: permissions.canConfigureEventWebhook,
    requiredScopes: {
      mailSend: SENDGRID_SCOPE_REQUIREMENTS.mailSend,
      domainAuthentication: SENDGRID_SCOPE_REQUIREMENTS.domainAuthentication,
      senderVerification: SENDGRID_SCOPE_REQUIREMENTS.senderVerification,
      eventWebhook: SENDGRID_SCOPE_REQUIREMENTS.eventWebhook,
    },
    missingScopes: missingScopeGroups(permissions, requireWebhook),
    recommendation: permissions.recommendation,
    docs: {
      apiKeyPermissions: 'https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authorization',
      senderVerification: 'https://www.twilio.com/docs/sendgrid/api-reference/sender-verification/create-verified-sender-request',
      senderIdentity: 'https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity',
    },
  };
}

export function sendGridPermissionError(permissions: SendGridPermissionAudit, requireWebhook = false): string {
  const missing = missingScopeGroups(permissions, requireWebhook);
  const groups = Object.entries(missing)
    .map(([group, scopes]) => `${group}: ${scopes.join(', ')}`)
    .join('; ');
  return `SendGrid API key is valid but cannot complete Hypervibe email setup. Missing ${groups}. ${permissions.recommendation} ${formatConnectionGuidance('sendgrid', { intro: 'Confirm the SendGrid API key type and permissions.' })}`;
}

export function getSendGridAdapter(scopeHints?: string[]): { adapter: SendGridAdapter } | { error: string } {
  const connection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
  if (!connection) {
    return { error: `No SendGrid connection found. ${formatConnectionGuidance('sendgrid')}` };
  }

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<SendGridCredentials>(connection.credentialsEncrypted);
  const adapter = new SendGridAdapter();
  adapter.connect(credentials);

  return { adapter };
}
