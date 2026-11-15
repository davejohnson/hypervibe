import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import {
  SendGridAdapter,
  SENDGRID_SCOPE_REQUIREMENTS,
} from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { SendGridCredentials } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { SendGridPermissionAudit } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import { SendGridLogsError, type SendGridEmailLogsInput } from '../../adapters/providers/sendgrid/sendgrid-email-logs.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import { getProjectScopeHints } from './project-scope.js';

const connectionRepo = new ConnectionRepository();

function missingScopeGroups(permissions: SendGridPermissionAudit, requireWebhook = false): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
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
    canConfigureInboundParse: permissions.canConfigureInboundParse,
    requiredScopes: {
      domainAuthentication: SENDGRID_SCOPE_REQUIREMENTS.domainAuthentication,
      senderVerification: SENDGRID_SCOPE_REQUIREMENTS.senderVerification,
      eventWebhook: SENDGRID_SCOPE_REQUIREMENTS.eventWebhook,
      inboundParse: SENDGRID_SCOPE_REQUIREMENTS.inboundParse,
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

/** Read provider history through the existing scoped connection boundary; never persist email evidence. */
export async function fetchSendGridEmailLogs(project: Project, environment: Environment, input: SendGridEmailLogsInput) {
  try {
    const resolved = getSendGridAdapter(getProjectScopeHints(project));
    if ('error' in resolved) return { success: false as const, code: 'MISSING_CONNECTION' as const, error: resolved.error };
    const logs = await resolved.adapter.readEmailLogs(input);
    return {
      success: true as const,
      data: {
        project: project.name, environment: environment.name, provider: 'sendgrid',
        evidenceSource: 'sendgrid-email-logs-api', persisted: false,
        scope: { kind: 'provider-account', environmentAttribution: 'unverified', region: 'global', delegatedSubuser: false },
        ...logs,
      },
      warnings: [
        'These are SendGrid account logs. Project and environment select the connection context; they do not prove which environment sent a message. EU regional accounts and delegated parent-account subuser searches are not supported by this read.',
        'SendGrid retains limited history. A delivered status reports provider delivery, not inbox placement or human receipt.',
        ...(logs.messages.length === 0 ? ['No messages matched this bounded search. This does not prove that no send was attempted.'] : []),
        ...(logs.truncated ? ['The result may be truncated. Narrow the search window or inspect an exact messageId.'] : []),
      ],
    };
  } catch (error) {
    const safe = error instanceof SendGridLogsError ? error : new SendGridLogsError('unavailable');
    return {
      success: false as const,
      code: safe.category === 'invalid_input' ? 'VALIDATION' as const : safe.category === 'not_found' ? 'NOT_FOUND' as const : 'PROVIDER_ERROR' as const,
      error: safe.message,
      details: { provider: 'sendgrid', operation: 'email-log-read', category: safe.category,
        ...(safe.status ? { status: safe.status } : {}), ...(safe.validation ? { validation: safe.validation } : {}) },
    };
  }
}
