import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter, assessSendGridScopes, type SendGridCredentials } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Service } from '../entities/service.entity.js';
import type { IHostingAdapter } from '../ports/hosting.port.js';

const envRepo = new EnvironmentRepository();
const connectionRepo = new ConnectionRepository();

/**
 * Email leg of executeBootstrap: assess SendGrid API-key scopes, sync
 * SENDGRID_API_KEY into every workload, and (when a domain is given) create
 * the domain authentication and write its DNS records to Cloudflare.
 * Mutates `summary` in place; returns a failure result only for the
 * missing-scope hard stop, matching the inline behavior this was extracted
 * from.
 */
export async function setupBootstrapEmail(args: {
  domain?: string;
  workloads: Service[];
  environment: Environment;
  hostingAdapter: IHostingAdapter;
  scopeHints: string[];
  summary: Record<string, unknown>;
}): Promise<{ failure?: { success: false; summary: Record<string, unknown> } }> {
  const { domain, workloads, environment, hostingAdapter, scopeHints, summary } = args;
  const secretStore = getSecretStore();

  const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
  if (!sgConnection) {
    summary.sendgridApiKeySynced = false;
    summary.sendgridApiKeySyncError = `No SendGrid connection found. ${formatConnectionGuidance('sendgrid')}`;
    return {};
  }

  const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
  const sgAdapter = new SendGridAdapter();
  sgAdapter.connect(sgCreds);
  const sendgridPermissions = assessSendGridScopes(await sgAdapter.getScopes());
  const missingSendgridScopes: Record<string, string[]> = {};
  if (!sendgridPermissions.hasMailSend) {
    missingSendgridScopes.mailSend = sendgridPermissions.missingScopes.mailSend;
  }
  if (domain) {
    if (!sendgridPermissions.canManageDomainAuthentication) {
      missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
    }
  } else if (!sendgridPermissions.canManageDomainAuthentication && !sendgridPermissions.canManageSenderVerification) {
    missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
    missingSendgridScopes.senderVerification = sendgridPermissions.missingScopes.senderVerification;
  }

  if (Object.keys(missingSendgridScopes).length > 0) {
    return {
      failure: {
        success: false,
        summary: {
          ...summary,
          sendgridApiKeySynced: false,
          sendgridApiKeySyncError: `SendGrid API key is valid but cannot complete setupEmail. ${sendgridPermissions.recommendation} ${formatConnectionGuidance('sendgrid', { intro: 'Confirm the SendGrid API key type and permissions.' })}`,
          sendgridMissingScopes: missingSendgridScopes,
        },
      },
    };
  }

  const latestEnvironment = envRepo.findById(environment.id) ?? environment;
  const sendgridFailures: string[] = [];
  for (const service of workloads) {
    const receipt = await hostingAdapter.setEnvVars(latestEnvironment, service, {
      SENDGRID_API_KEY: sgCreds.apiKey,
    });
    if (!receipt.success) {
      sendgridFailures.push(`${service.name}: ${receipt.error || receipt.message}`);
    }
  }
  summary.sendgridApiKeySynced = sendgridFailures.length === 0;
  if (sendgridFailures.length > 0) {
    summary.sendgridApiKeySyncError = sendgridFailures.join('; ');
  }

  if (domain) {
    const existingDomains = await sgAdapter.listDomainAuthentications();
    const existingAuth = existingDomains.find((d) => d.domain.toLowerCase() === domain.toLowerCase());
    const auth = existingAuth ?? await sgAdapter.createDomainAuthentication(domain, { default: false });
    const records = [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname].filter(
      (r): r is NonNullable<typeof r> => Boolean(r)
    );

    const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [domain, ...scopeHints]);
    if (cfConnection) {
      const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
      const cfAdapter = new CloudflareAdapter();
      cfAdapter.connect(cfCreds);
      const zone = await cfAdapter.findZoneByName(domain);
      if (zone) {
        const dnsResults: Array<{ name: string; type: string; action: string }> = [];
        for (const record of records) {
          const upsert = await cfAdapter.upsertDnsRecord(zone.id, record.host, record.type, record.data, {
            proxied: false,
          });
          dnsResults.push({ name: record.host, type: record.type, action: upsert.action });
        }
        summary.sendgridDnsSynced = true;
        summary.sendgridDnsRecords = dnsResults;
      } else {
        summary.sendgridDnsSynced = false;
        summary.sendgridDnsError = `Cloudflare zone not found for ${domain}`;
      }
    } else {
      summary.sendgridDnsSynced = false;
      summary.sendgridDnsError = `No Cloudflare connection available for domain DNS setup. ${formatConnectionGuidance('cloudflare', { scope: domain })}`;
    }
  }

  return {};
}
