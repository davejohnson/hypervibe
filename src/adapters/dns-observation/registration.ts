import { GoogleAuth } from 'google-auth-library';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { dnsAuthentication, gcpDnsCredentialsSchema, route53CredentialsSchema, azureDnsCredentialsSchema } from './connections.js';

const dns = { engine: 'opentofu' as const, records: ['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX'] as const };
const maturity = { lifecycle: { dns: { status: 'ready-for-live' as const, reason: 'Pinned engine configuration and read-only transport contracts; live DNS lifecycle remains unverified.' } } };

providerRegistry.register({
  metadata: { name: 'gcp-dns', displayName: 'Google Cloud DNS', category: 'dns', credentialsSchema: gcpDnsCredentialsSchema,
    credentials: { defaultScalarKey: 'credentials', supportsNativeCliAuth: true }, connectionAliases: ['cloudrun', 'gcs'], lifecycle: { dns }, maturity },
  factory: credentials => ({ async verify() {
    try {
      const saved = gcpDnsCredentialsSchema.parse(credentials);
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...(saved.credentials ? { credentials: JSON.parse(saved.credentials) } : {}) });
      const projectId = saved.projectId ?? await auth.getProjectId(); const token = await auth.getAccessToken();
      if (!projectId || !token) return { success: false, error: 'Google DNS project authentication is unavailable.' };
      const response = await fetch(`https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(projectId)}/managedZones?maxResults=1`,
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return { success: false, error: 'Google DNS zone access could not be verified.' };
      const data = await response.json() as { kind?: unknown; managedZones?: unknown };
      return data.kind === 'dns#managedZonesListResponse' && (data.managedZones === undefined || Array.isArray(data.managedZones))
        ? { success: true } : { success: false, error: 'Google DNS returned incomplete zone evidence.' };
    } catch { return { success: false, error: 'Google DNS authentication could not be verified.' }; }
  } }),
});

providerRegistry.register({
  metadata: { name: 'route53', displayName: 'Amazon Route 53', category: 'dns', credentialsSchema: route53CredentialsSchema,
    credentials: { supportsNativeCliAuth: true }, connectionAliases: ['s3', 'ecs'], lifecycle: { dns }, maturity },
  factory: credentials => ({ async verify() {
    try {
      const saved = route53CredentialsSchema.parse(credentials);
      const resolved = saved.authMode === 'default' ? defaultProvider() : { accessKeyId: saved.accessKeyId!, secretAccessKey: saved.secretAccessKey!, sessionToken: saved.sessionToken };
      const account = (await new STSClient({ region: 'us-east-1', credentials: resolved }).send(new GetCallerIdentityCommand({}))).Account;
      return account && /^\d{12}$/.test(account) && (!saved.accountId || saved.accountId === account)
        ? { success: true, accountId: account } : { success: false, error: 'AWS account identity could not be verified.' };
    } catch { return { success: false, error: 'AWS DNS authentication could not be verified.' }; }
  } }),
});

providerRegistry.register({
  metadata: { name: 'azure-dns', displayName: 'Azure DNS', category: 'dns', credentialsSchema: azureDnsCredentialsSchema,
    connectionAliases: ['azureblob', 'azure-container-apps'], lifecycle: { dns }, maturity },
  factory: credentials => ({ async verify() {
    try {
      const saved = azureDnsCredentialsSchema.parse(credentials);
      if (saved.authMode === 'default') return { success: false, error: 'Azure DNS currently needs a saved service principal connection for both observation and the infrastructure engine.' };
      const material = await dnsAuthentication('azure', saved);
      const response = await fetch(`https://management.azure.com/subscriptions/${saved.subscriptionId}?api-version=2022-12-01`,
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${material.token}` } });
      if (!response.ok) return { success: false, error: 'Azure DNS subscription access could not be verified.' };
      const data = await response.json() as { subscriptionId?: unknown };
      return data.subscriptionId === saved.subscriptionId ? { success: true } : { success: false, error: 'Azure DNS subscription identity does not match.' };
    } catch { return { success: false, error: 'Azure DNS authentication could not be verified.' }; }
  } }),
});
