import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { ClientSecretCredential } from '@azure/identity';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Route53Client } from '@aws-sdk/client-route-53';
import { z } from 'zod';
import type { CommandContext } from '../../application/context.js';
import type { Connection } from '../../domain/entities/connection.entity.js';
import type { DnsProvider, DnsZoneIdentity, DnsZoneObservation } from '../../domain/ports/dns.port.js';
import type { EngineAuthentication } from '../../domain/ports/infrastructure-engine.port.js';
import { HttpDnsObserver, type DnsObserver } from './http-observer.js';
import { AwsDnsObserver } from './aws-observer.js';

export const gcpDnsCredentialsSchema = z.object({
  authMode: z.enum(['default', 'serviceAccount']).default('serviceAccount'),
  projectId: z.string().min(1).optional(), credentials: z.string().min(1).optional(),
}).refine(value => value.authMode === 'default' || !!value.credentials, 'A saved service account or Google Application Default Credentials is required.');
export const route53CredentialsSchema = z.object({
  authMode: z.enum(['default', 'static']).default('static'),
  accountId: z.string().regex(/^\d{12}$/).optional(), accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(), sessionToken: z.string().min(1).optional(),
}).refine(value => value.authMode === 'default' || (!!value.accessKeyId && !!value.secretAccessKey), 'A saved AWS access key or the AWS default credential chain is required.');
export const azureDnsCredentialsSchema = z.object({
  authMode: z.enum(['servicePrincipal', 'default']).default('servicePrincipal'),
  subscriptionId: z.string().uuid(), tenantId: z.string().uuid().optional(), clientId: z.string().uuid().optional(), clientSecret: z.string().min(1).optional(),
}).refine(value => value.authMode === 'default' || (!!value.tenantId && !!value.clientId && !!value.clientSecret), 'The Azure DNS engine needs a saved service principal connection.');

export const DNS_CONNECTION_PROVIDERS: Record<DnsProvider, readonly string[]> = {
  cloudflare: ['cloudflare'], gcp: ['gcp-dns', 'cloudrun', 'gcs'], aws: ['route53', 's3', 'ecs'], azure: ['azure-dns', 'azureblob', 'azure-container-apps'],
};

export interface DnsAuthenticationDependencies {
  fetch?: typeof fetch;
  googleToken?: (credentials: Record<string, unknown>) => Promise<string>;
  awsCredentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
  awsAccount?: (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }) => Promise<string>;
  route53Client?: (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }) => Route53Client;
  azureToken?: (credentials: Record<string, unknown>) => Promise<string>;
}

/** Private material is returned only to engine orchestration, never a command result. */
export async function dnsAuthentication(provider: DnsProvider, values: Record<string, unknown>, dependencies: DnsAuthenticationDependencies = {}): Promise<{
  auth: EngineAuthentication; token?: string; awsAccountId?: string; route53?: Route53Client; projectId?: string; subscriptionId?: string;
}> {
  if (provider === 'cloudflare') {
    const token = z.string().min(1).parse(values.apiToken);
    return { token, auth: { env: { CLOUDFLARE_API_TOKEN: token }, redact: [token] } };
  }
  if (provider === 'gcp') {
    const credentials = gcpDnsCredentialsSchema.parse(values);
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(credentials.credentials ? { credentials: JSON.parse(credentials.credentials) as Record<string, unknown> } : {}) });
    const token = dependencies.googleToken ? await dependencies.googleToken(credentials) : await auth.getAccessToken();
    if (!token) throw new Error('Google authentication did not return an access token.');
    return { token, projectId: credentials.projectId, auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: token }, redact: [token, ...(credentials.credentials ? [credentials.credentials] : [])] } };
  }
  if (provider === 'aws') {
    const saved = route53CredentialsSchema.parse(values);
    const credentials = saved.authMode === 'default' ? await (dependencies.awsCredentials ?? defaultProvider())()
      : { accessKeyId: saved.accessKeyId!, secretAccessKey: saved.secretAccessKey!, ...(saved.sessionToken ? { sessionToken: saved.sessionToken } : {}) };
    const account = dependencies.awsAccount ? await dependencies.awsAccount(credentials)
      : (await new STSClient({ region: 'us-east-1', credentials }).send(new GetCallerIdentityCommand({}))).Account;
    if (!account || !/^\d{12}$/.test(account) || (saved.accountId && saved.accountId !== account)) throw new Error('AWS account identity could not be verified.');
    const env = { AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}) };
    return { awsAccountId: account, route53: dependencies.route53Client?.(credentials) ?? new Route53Client({ region: 'us-east-1', credentials }),
      auth: { env, redact: [credentials.accessKeyId, credentials.secretAccessKey, ...(credentials.sessionToken ? [credentials.sessionToken] : [])] } };
  }
  const saved = azureDnsCredentialsSchema.parse(values);
  // An ARM bearer token cannot authenticate the AzureRM engine. Do not silently use the CLI or invent an access-token environment variable.
  if (saved.authMode === 'default') throw new Error('Azure DNS engine authentication requires a verified saved service principal; the Azure default credential chain is not yet supported by the engine.');
  const token = dependencies.azureToken ? await dependencies.azureToken(saved)
    : (await new ClientSecretCredential(saved.tenantId!, saved.clientId!, saved.clientSecret!).getToken('https://management.azure.com/.default'))?.token;
  if (!token) throw new Error('Azure authentication did not return an access token.');
  return { token, subscriptionId: saved.subscriptionId, auth: { env: { ARM_SUBSCRIPTION_ID: saved.subscriptionId,
    ARM_TENANT_ID: saved.tenantId!, ARM_CLIENT_ID: saved.clientId!, ARM_CLIENT_SECRET: saved.clientSecret!, ARM_USE_CLI: 'false' },
    redact: [saved.clientSecret!, token] } };
}

function connectionRank(connection: Connection, scopeHints: string[], explicit?: string): number | null {
  if (connection.status !== 'verified') return null;
  if (explicit !== undefined) return connection.scope === explicit || (!connection.scope && explicit === 'global') ? 0 : null;
  if (connection.scope === null) return 2;
  if (scopeHints.includes(connection.scope)) return 0;
  return scopeHints.some(hint => connection.scope!.endsWith('/*') && hint.startsWith(connection.scope!.slice(0, -1))) ? 1 : null;
}

/** Resolve a DNS connection without deriving authority from the application's hosting provider. */
export async function resolveDnsConnection(input: {
  context: Pick<CommandContext, 'repos' | 'secretStore'>; zone: DnsZoneIdentity; scopeHints?: string[]; connectionScope?: string;
  dependencies?: DnsAuthenticationDependencies;
}): Promise<{ observer: DnsObserver; auth: EngineAuthentication; connectionId: string; connectionProvider: string } | { blocked: string }> {
  const providers = DNS_CONNECTION_PROVIDERS[input.zone.provider];
  const candidates = providers.flatMap(provider => input.context.repos.connections.findAllByProvider(provider))
    .map(connection => ({ connection, rank: connectionRank(connection, input.scopeHints ?? [], input.connectionScope) }))
    .filter((item): item is { connection: Connection; rank: number } => item.rank !== null)
    .sort((a, b) => a.rank - b.rank || Number(b.connection.provider === providers[0]) - Number(a.connection.provider === providers[0]));
  const selected = candidates[0];
  if (!selected) return { blocked: `No verified ${providers[0]} connection matches this repository or selected DNS connection scope.` };
  const equivalent = candidates.filter(item => item.rank === selected.rank && (item.connection.provider === providers[0]) === (selected.connection.provider === providers[0]));
  if (equivalent.length > 1) return { blocked: 'Multiple verified DNS connections match. Select one exact connection scope.' };
  try {
    const values = input.context.secretStore.decryptObject<Record<string, unknown>>(selected.connection.credentialsEncrypted);
    const zone = input.zone;
    if (zone.provider === 'cloudflare' && values.accountId && values.accountId !== zone.scope.accountId)
      return { blocked: 'The saved Cloudflare connection belongs to another account.' };
    if (zone.provider === 'gcp' && values.projectId && values.projectId !== zone.scope.projectId)
      return { blocked: 'The saved Google connection belongs to another project.' };
    if (zone.provider === 'azure' && values.subscriptionId !== zone.scope.subscriptionId)
      return { blocked: 'The saved Azure connection belongs to another subscription.' };
    if (zone.provider === 'azure' && values.authMode === 'default') return { blocked: 'Azure DNS currently needs a saved service principal connection for both observation and the infrastructure engine. The default credential chain cannot yet authenticate both.' };
    const material = await dnsAuthentication(zone.provider, values, input.dependencies);
    if (zone.provider === 'aws' && material.awsAccountId !== zone.scope.accountId) return { blocked: 'The authenticated AWS account differs from the selected DNS account.' };
    const observer = zone.provider === 'aws' ? new AwsDnsObserver(zone, material.route53!, material.awsAccountId!)
      : new HttpDnsObserver(zone, material.token!, input.dependencies?.fetch);
    return { observer, auth: material.auth, connectionId: selected.connection.id, connectionProvider: selected.connection.provider };
  } catch { return { blocked: 'The selected DNS connection could not authenticate. Reconnect this DNS provider and retry; no DNS records were changed.' }; }
}

/** Safe coherence evidence; credential values and unrelated zone data never enter the digest. */
export function dnsZoneFingerprint(zone: DnsZoneObservation): string {
  return createHash('sha256').update(JSON.stringify({ provider: zone.identity.provider, zoneId: zone.identity.zoneId,
    zoneName: zone.identity.zoneName.toLowerCase().replace(/\.$/, ''), scope: zone.identity.scope,
    providerNativeId: zone.providerNativeId, etag: zone.etag, visibility: zone.visibility, dnssec: zone.dnssec,
    nameservers: [...zone.nameservers].map(item => item.toLowerCase().replace(/\.$/, '')).sort() })).digest('hex');
}
