import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../db/sqlite.adapter.js';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import type { CommandContext } from '../../../application/context.js';
import type { DnsZoneIdentity, DnsZoneObservation } from '../../../domain/ports/dns.port.js';
import { dnsAuthentication, dnsZoneFingerprint, resolveDnsConnection } from '../connections.js';

const cf: DnsZoneIdentity = { provider: 'cloudflare', zoneId: 'zone', zoneName: 'example.com', scope: { accountId: 'account' } };
let context: Pick<CommandContext, 'repos' | 'secretStore'>;
let repository: ConnectionRepository;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-dns-connection-')), 'test.db')).migrate();
  repository = new ConnectionRepository();
  context = { repos: { connections: repository }, secretStore: getSecretStore() } as Pick<CommandContext, 'repos' | 'secretStore'>;
});
afterEach(() => { SqliteAdapter.resetInstance(); });
function save(provider: string, scope: string | null, credentials: Record<string, unknown>, verified = true) {
  const connection = repository.create({ provider, scope, credentialsEncrypted: context.secretStore.encryptObject(credentials) });
  if (verified) repository.updateStatus(connection.id, 'verified');
  return connection;
}

describe('DNS private saved connection resolution', () => {
  it('reuses encrypted exact-repository credentials and keeps the token only in private engine env', async () => {
    const saved = save('cloudflare', 'owner/repo', { apiToken: 'private-dns-token', accountId: 'account' });
    save('cloudflare', 'other/repo', { apiToken: 'wrong-token', accountId: 'account' });
    expect(saved.credentialsEncrypted).not.toContain('private-dns-token');
    const result = await resolveDnsConnection({ context, zone: cf, scopeHints: ['owner/repo'] });
    expect(result).toMatchObject({ connectionId: saved.id, connectionProvider: 'cloudflare', auth: { env: { CLOUDFLARE_API_TOKEN: 'private-dns-token' }, redact: ['private-dns-token'] } });
  });
  it('never borrows another repository when scope is unknown or a connection failed', async () => {
    save('cloudflare', 'other/repo', { apiToken: 'other-token' });
    save('cloudflare', null, { apiToken: 'pending-token' }, false);
    expect(await resolveDnsConnection({ context, zone: cf })).toHaveProperty('blocked');
    expect(await resolveDnsConnection({ context, zone: cf, scopeHints: ['owner/repo'] })).toHaveProperty('blocked');
  });
  it('honors explicit connection scope and rejects credential account mismatches', async () => {
    const saved = save('cloudflare', 'dns-team', { apiToken: 'private-dns-token', accountId: 'account' });
    expect(await resolveDnsConnection({ context, zone: cf, connectionScope: 'dns-team' })).toMatchObject({ connectionId: saved.id });
    expect(await resolveDnsConnection({ context, zone: { ...cf, scope: { accountId: 'other' } }, connectionScope: 'dns-team' })).toHaveProperty('blocked');
  });
  it('reuses a matching saved Google connection independently of the hosting provider', async () => {
    save('cloudrun', 'owner/repo', { projectId: 'dns-project', credentials: JSON.stringify({ client_email: 'dns@dns-project.iam.gserviceaccount.com', private_key: 'fixture-key' }) });
    const zone: DnsZoneIdentity = { provider: 'gcp', zoneId: 'public-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } };
    const googleToken = vi.fn(async () => 'private-google-token');
    const result = await resolveDnsConnection({ context, zone, scopeHints: ['owner/repo'], dependencies: { googleToken } });
    expect(result).toMatchObject({ connectionProvider: 'cloudrun', auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'private-google-token' } } });
    expect(await resolveDnsConnection({ context, zone: { ...zone, scope: { projectId: 'another-project' } }, scopeHints: ['owner/repo'], dependencies: { googleToken } })).toHaveProperty('blocked');
    expect(googleToken).toHaveBeenCalledTimes(1);
  });
  it('blocks ambiguous alias connections rather than borrowing a global credential silently', async () => {
    save('ecs', null, { accessKeyId: 'key1', secretAccessKey: 'secret1' });
    save('s3', null, { accessKeyId: 'key2', secretAccessKey: 'secret2' });
    const result = await resolveDnsConnection({ context, zone: { provider: 'aws', zoneId: 'Z123', zoneName: 'example.com', scope: { accountId: '123456789012' } } });
    expect(result).toHaveProperty('blocked');
  });
  it('materializes the AWS native credential chain privately including its temporary session token', async () => {
    const result = await dnsAuthentication('aws', { authMode: 'default' }, {
      awsCredentials: async () => ({ accessKeyId: 'temporary-key', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session' }),
      awsAccount: async () => '123456789012',
    });
    expect(result.auth).toMatchObject({ env: { AWS_ACCESS_KEY_ID: 'temporary-key', AWS_SECRET_ACCESS_KEY: 'temporary-secret', AWS_SESSION_TOKEN: 'temporary-session', AWS_REGION: 'us-east-1' }, redact: ['temporary-key', 'temporary-secret', 'temporary-session'] });
    expect(result.awsAccountId).toBe('123456789012');
  });
  it('rejects AWS caller account mismatch and exposes no provider error or credential', async () => {
    save('route53', 'owner/repo', { authMode: 'default' });
    const zone: DnsZoneIdentity = { provider: 'aws', zoneId: 'Z123', zoneName: 'example.com', scope: { accountId: '123456789012' } };
    const dependencies = { awsCredentials: async () => ({ accessKeyId: 'private-key', secretAccessKey: 'private-secret' }), awsAccount: async () => '999999999999' };
    expect(await resolveDnsConnection({ context, zone, scopeHints: ['owner/repo'], dependencies })).toHaveProperty('blocked');
    const result = await resolveDnsConnection({ context, zone, scopeHints: ['owner/repo'], dependencies: { ...dependencies, awsAccount: async () => { throw new Error('provider echoed private-secret'); } } });
    expect(result).toHaveProperty('blocked'); expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('supports saved Azure service principals but does not present ARM bearer tokens as engine authentication', async () => {
    const subscriptionId = '11111111-1111-4111-8111-111111111111';
    const result = await dnsAuthentication('azure', { subscriptionId, tenantId: subscriptionId, clientId: subscriptionId, clientSecret: 'private-client-secret' }, { azureToken: async () => 'private-arm-token' });
    expect(result.auth.env).toEqual({ ARM_SUBSCRIPTION_ID: subscriptionId, ARM_TENANT_ID: subscriptionId, ARM_CLIENT_ID: subscriptionId, ARM_CLIENT_SECRET: 'private-client-secret', ARM_USE_CLI: 'false' });
    expect(result.auth.redact).toEqual(['private-client-secret', 'private-arm-token']);
    await expect(dnsAuthentication('azure', { subscriptionId, authMode: 'default' })).rejects.toThrow('not yet supported');
  });
  it('invalidates zone evidence when Google recreates an identically named managed zone', () => {
    const observation: DnsZoneObservation = { identity: { provider: 'gcp', zoneId: 'public-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } },
      providerNativeId: '123', visibility: 'public', dnssec: 'enabled', nameservers: ['ns.example.com.'] };
    expect(dnsZoneFingerprint(observation)).not.toBe(dnsZoneFingerprint({ ...observation, providerNativeId: '456' }));
    expect(dnsZoneFingerprint(observation)).toBe(dnsZoneFingerprint({ ...observation, nameservers: ['NS.EXAMPLE.COM'] }));
  });
  it('registers DNS capabilities without promoting AWS or Azure hosting maturity', () => {
    for (const provider of ['cloudflare', 'gcp-dns', 'route53', 'azure-dns']) expect(providerRegistry.getMetadata(provider)?.lifecycle?.dns?.engine).toBe('opentofu');
    for (const provider of ['ecs', 'azure-container-apps']) expect(providerRegistry.getMetadata(provider)?.maturity?.lifecycle?.hosting?.status).toBe('planned');
    for (const provider of ['gcp-dns', 'route53', 'azure-dns']) expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting).toBeUndefined();
  });
});
