import { createHash } from 'crypto';
import { z } from 'zod';
import { SendGridAdapter } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import type { ObservedState } from '../ports/observe.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { getProjectScopeHints } from './project-scope.js';
import { inspectEmailDnsReadiness, type EmailDnsReadiness } from './email-dns-readiness.service.js';

type SenderStatus = 'verified' | 'unverified' | 'unknown';
export interface EmailSenderReadiness {
  basis: 'configured-addresses';
  status: SenderStatus;
  senders: Array<{ key: string; status: SenderStatus; method?: 'domain' | 'single-sender' }>;
  replyTo: Array<{ key: string; status: SenderStatus; method?: 'domain' | 'single-sender' }>;
  guidance?: string;
  dns?: EmailDnsReadiness;
}

// These identify configuration roles, never all variables containing an email.
const fromKey = /(?:^|_)(?:FROM_EMAIL|FROM_ADDRESS|EMAIL_FROM|MAIL_FROM|SENDER_EMAIL|SENDER_ADDRESS)$/;
const replyKey = /(?:^|_)(?:REPLY_TO|REPLY_TO_EMAIL|REPLY_TO_ADDRESS)$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const address = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const mailbox = /^[^<>\r\n]+<([^<>\r\n]+)>$/.exec(trimmed)?.[1] ?? trimmed;
  return z.string().email().safeParse(mailbox).success ? mailbox : undefined;
};

/** Reports only key names and authorization status, never runtime values. */
export async function inspectEmailSenderReadiness(params: {
  project: Project;
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
  runtimeValues?: Record<string, string>;
}): Promise<EmailSenderReadiness | undefined> {
  const { environmentSpec: spec, observed } = params;
  const values = params.runtimeValues ?? spec.envVars;
  const live = observed?.services.filter(service => Object.hasOwn(spec.services, service.name)) ?? [];
  const keys = [...new Set([...Object.keys(values), ...live.flatMap(service => service.envVarKeys)])]
    .filter(key => !spec.email.enabled || !['SENDGRID_FROM_EMAIL', 'SENDGRID_REPLY_TO'].includes(key));
  if (!spec.email.enabled && !keys.includes('SENDGRID_API_KEY')) return undefined;
  const from = keys.filter(key => fromKey.test(key)).sort().map(key => ({ key, value: values[key] }));
  if (spec.email.sender) from.push({ key: 'email.sender.address', value: spec.email.sender.address });
  const replies = keys.filter(key => replyKey.test(key)).sort().map(key => ({ key, value: values[key] }));
  if (spec.email.sender?.replyTo) replies.push({ key: 'email.sender.replyTo', value: spec.email.sender.replyTo });
  const result: EmailSenderReadiness = {
    basis: 'configured-addresses',
    status: 'unknown',
    senders: from.map(item => ({ key: item.key, status: item.value === undefined ? 'unknown' : address(item.value) ? 'unknown' : 'unverified' })),
    replyTo: replies.map(item => ({ key: item.key, status: item.value === undefined ? 'unknown' : address(item.value) ? 'unknown' : 'unverified' })),
  };
  if (!from.length) {
    result.guidance = 'SendGrid is configured but the app’s From address is not declared. Declare the app’s From-address environment variable or email.sender before treating mail as ready.';
    return result;
  }
  let apiKey = values.SENDGRID_API_KEY;
  if (!apiKey) {
    try {
      const connection = new ConnectionRepository().findBestMatchFromHints('sendgrid', [
        ...(spec.domain ? [spec.domain] : []), ...getProjectScopeHints(params.project),
      ]);
      if (connection?.status === 'verified') {
        const credentials = getSecretStore().decryptObject<{ apiKey: string }>(connection.credentialsEncrypted);
        // A globally connected account cannot certify another application's key.
        const sendingServices = live.filter(service => service.envVarKeys.includes('SENDGRID_API_KEY'));
        if (spec.email.enabled || (sendingServices.length > 0 && sendingServices.every(service => service.envVarHashes.SENDGRID_API_KEY === hash(credentials.apiKey)))) apiKey = credentials.apiKey;
      }
    } catch {
      // Local credential reads can fail too. Never expose decrypted inputs or errors.
    }
  }
  if (apiKey?.trim()) {
    const adapter = new SendGridAdapter();
    adapter.connect({ apiKey });
    const all = [...from, ...replies];
    const readable = all.flatMap((item, index) => address(item.value) ? [{ index, address: address(item.value)! }] : []);
    const checks = readable.length ? await adapter.inspectSenderIdentities(readable.map(item => item.address)) : [];
    const sending = readable.flatMap((item, index) => item.index < from.length
      ? [{ key: all[item.index].key, address: item.address, evidence: checks[index] }] : []);
    if (sending.length) result.dns = await inspectEmailDnsReadiness(sending);
    readable.forEach((item, index) => {
      const check = checks[index].status;
      const entry: EmailSenderReadiness['senders'][number] = { key: all[item.index].key,
        status: check === 'verified-domain' || check === 'verified-sender' ? 'verified' : check,
        ...(check === 'verified-domain' ? { method: 'domain' as const } : check === 'verified-sender' ? { method: 'single-sender' as const } : {}),
      };
      if (item.index < from.length) result.senders[item.index] = entry;
      else result.replyTo[item.index - from.length] = entry;
    });
  }
  result.status = [...result.senders, ...result.replyTo].some(item => item.status === 'unverified')
    ? 'unverified' : result.senders.some(item => item.status === 'unknown') || result.replyTo.some(item => item.status === 'unknown') ? 'unknown' : 'verified';
  if (result.status !== 'verified') result.guidance = !apiKey
    ? 'Sender verification needs the application’s exact SendGrid credential through its private deploy inputs, or a verified connection whose key matches the observed runtime. Do not paste the key into chat.'
    : 'Hypervibe requires both From and Reply-To to match an exact authenticated domain or verified single sender in the application’s SendGrid account. Unknown means values or read permissions were insufficient; it is not verification. Configure sender authorization through reviewed email desired state before treating app email as ready.';
  if (result.dns && result.dns.status !== 'configured') {
    result.guidance = [result.guidance, result.dns.guidance].filter(Boolean).join(' ');
  }
  return result;
}
