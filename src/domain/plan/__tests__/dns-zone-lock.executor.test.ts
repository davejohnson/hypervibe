import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { ConvergeExecutor } from '../converge.executor.js';
import type { DnsZoneIdentity } from '../../ports/dns.port.js';

const gcpZone: DnsZoneIdentity = { provider: 'gcp', zoneId: 'public-zone', zoneName: 'example.com', scope: { projectId: 'dns-project' } };
const cfZone: DnsZoneIdentity = { provider: 'cloudflare', zoneId: 'a'.repeat(32), zoneName: 'example.com', scope: { accountId: 'b'.repeat(32) } };
const awsZone: DnsZoneIdentity = { provider: 'aws', zoneId: 'Z12345', zoneName: 'example.com', scope: { accountId: '123456789012' } };
const azureZone: DnsZoneIdentity = { provider: 'azure', zoneId: '/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/Dns/providers/Microsoft.Network/dnsZones/example.com',
  zoneName: 'example.com', scope: { subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceGroup: 'Dns' } };
beforeEach(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hypervibe-dns-zone-lock-')), 'test.db')).migrate();
});
afterEach(() => SqliteAdapter.resetInstance());

function plan(label: string, zone: DnsZoneIdentity, arbitraryKeys?: string[]) {
  const projectId = new ProjectRepository().create({ name: label }).id;
  const environmentId = new EnvironmentRepository().create({ projectId, name: 'fixture' }).id;
  const segment = { id: `segment-${label}`, engine: 'opentofu', planDigest: 'saved-digest', configurationDigest: 'config-digest', engineVersion: '1.13.9', providerVersions: {} };
  const address = { gcp: 'google_dns_record_set.proof', cloudflare: 'cloudflare_dns_record.proof', aws: 'aws_route53_record.proof', azure: 'azurerm_dns_txt_record.proof' }[zone.provider];
  const action = { id: `dns:${address}`, type: 'update', resource: { kind: 'domain', name: 'example.com. TXT', provider: `dns-${zone.provider}` },
    verified: true, requiresConfirm: true, reason: 'Exact approved DNS contribution', metadata: { operation: 'dnsEngine', engineSegment: { ...segment, addresses: [address] } } };
  const document = { kind: 'hv_plan', scope: 'dns-engine', environmentName: 'fixture', specRevision: 1, observedFingerprint: null,
    actions: [action], ...(arbitraryKeys ? { lockResourceKeys: arbitraryKeys } : {}), dns: { descriptor: {
      version: 1, planId: `engine-plan-${label}`, segment, state: { provider: `dns-${zone.provider}`, projectId, environmentId, partition: 'environment' },
      zone, owner: 'domain', domain: 'app.example.com', connectionId: 'verified-connection', zoneFingerprint: 'provider-observed-scope', payloadEncrypted: 'private-plan-ciphertext',
    } } };
  const planRunId = new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document }).id;
  expect(new ConvergeExecutor().loadPlan(planRunId)).not.toHaveProperty('error');
  return { planRunId, address, actionId: action.id };
}

function infrastructurePlan(label: string, zone: DnsZoneIdentity, mode: 'mapping' | 'forget' | 'service', claims: unknown = { 'app.example.com': { zone } }) {
  const projectId = new ProjectRepository().create({ name: label }).id;
  const environmentId = new EnvironmentRepository().create({ projectId, name: 'fixture' }).id;
  const segment = { id: `segment-${label}`, engine: 'opentofu', planDigest: 'saved-digest', configurationDigest: 'config-digest', engineVersion: '1.13.9', providerVersions: {} };
  const address = mode === 'service' ? 'google_cloud_run_v2_service.web' : 'google_cloud_run_domain_mapping.app_example_com';
  const action = { id: mode === 'service' ? 'service:web' : mode === 'forget' ? 'domain-forget:app.example.com' : 'domain:app.example.com',
    type: mode === 'mapping' ? 'destroy' : 'update', resource: { kind: mode === 'service' ? 'service' : 'domain', name: mode === 'service' ? 'web' : 'app.example.com', provider: 'gcp' },
    verified: true, requiresConfirm: true, reason: 'Release only the exact persisted domain claim', metadata: mode === 'forget'
      ? { operation: 'gcpDomainForget', domain: 'app.example.com' } : { engineSegment: { ...segment, addresses: [address] } } };
  const planRunId = new RunRepository().create({ projectId, environmentId, type: 'plan', plan: { kind: 'hv_plan', scope: 'infrastructure-engine',
    engine: { planId: `engine-plan-${label}`, domainClaims: claims }, environmentName: 'fixture', specRevision: 1, observedFingerprint: null,
    actions: [action], lockResourceKeys: ['arbitrary-user-infrastructure-lock'] } }).id;
  return { planRunId, address, actionId: action.id };
}

async function crossScope(first: ReturnType<typeof plan>, second: ReturnType<typeof plan>, expectConflict = true) {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  expect(new ConvergeExecutor().loadPlan(first.planRunId)).not.toHaveProperty('error');
  expect(new ConvergeExecutor().loadPlan(second.planRunId)).not.toHaveProperty('error');
  const running = new ConvergeExecutor().execute({ planRunId: first.planRunId, currentSpecRevision: 1, confirmActions: [first.actionId],
    handler: async () => { entered(); await gate; return { success: true, message: 'Fixture domain claim released.' }; },
    segmentHandler: async () => { entered(); await gate; return { outcomes: { [first.address]: 'succeeded' }, diagnostics: [] }; } });
  await started;
  const handler = vi.fn(async () => ({ success: true, message: 'Fixture domain claim released.' }));
  const segmentHandler = vi.fn(async () => ({ outcomes: { [second.address]: 'succeeded' as const }, diagnostics: [] }));
  try {
    const result = await new ConvergeExecutor().execute({ planRunId: second.planRunId, currentSpecRevision: 1, confirmActions: [second.actionId], handler, segmentHandler });
    expect(result.success).toBe(!expectConflict);
    if (expectConflict) { expect(result.conflict?.kind).toBe('resource_in_progress'); expect(handler).not.toHaveBeenCalled(); expect(segmentHandler).not.toHaveBeenCalled(); }
  } finally { release(); await running; }
}

async function competing(firstZone: DnsZoneIdentity, secondZone: DnsZoneIdentity, expectConflict: boolean) {
  const first = plan('first-app', firstZone, ['arbitrary-user-key-one']);
  const second = plan('second-app', secondZone, ['arbitrary-user-key-two']);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const firstApply = new ConvergeExecutor().execute({ planRunId: first.planRunId, currentSpecRevision: 1, confirmActions: [first.actionId], handler: vi.fn(),
    segmentHandler: async () => { entered(); await gate; return { outcomes: { [first.address]: 'succeeded' }, diagnostics: [] }; } });
  await started;
  const secondHandler = vi.fn(async () => ({ outcomes: { [second.address]: 'succeeded' as const }, diagnostics: [] }));
  try {
    const result = await new ConvergeExecutor().execute({ planRunId: second.planRunId, currentSpecRevision: 1, confirmActions: [second.actionId], handler: vi.fn(), segmentHandler: secondHandler });
    if (expectConflict) {
      expect(result).toMatchObject({ success: false, conflict: { kind: 'resource_in_progress' }, receipts: [] });
      expect(secondHandler).not.toHaveBeenCalled();
    } else { expect(result.success).toBe(true); expect(secondHandler).toHaveBeenCalledOnce(); }
  } finally { release(); await firstApply; }
}

describe('DNS zone authority is serialized across application projects', () => {
  it.each([gcpZone, cfZone, awsZone, azureZone])('prevents concurrent applies in the same $provider native zone', async zone => {
    await competing(zone, { ...zone, zoneName: 'EXAMPLE.COM.' }, true);
  });
  it('canonicalizes Azure native scope casing before deriving the lock', async () => {
    await competing(azureZone, { ...azureZone, zoneId: azureZone.zoneId.toUpperCase(),
      scope: { subscriptionId: azureZone.scope.subscriptionId!.toUpperCase(), resourceGroup: 'dns' } }, true);
  });
  it('allows independent DNS zones to apply concurrently', async () => {
    await competing(gcpZone, { ...gcpZone, zoneId: 'different-zone' }, false);
  });
  it.each(['mapping', 'forget'] as const)('holds the DNS zone while GCP %s releases its claim', async mode => {
    await crossScope(infrastructurePlan('release-app', gcpZone, mode), plan('publisher-app', gcpZone));
  });
  it.each(['mapping', 'forget'] as const)('blocks GCP %s release while a DNS apply owns the zone', async mode => {
    await crossScope(plan('publisher-app', gcpZone), infrastructurePlan('release-app', gcpZone, mode));
  });
  it('does not lock a zone merely because an unrelated hosting plan retains a domain claim', async () => {
    await crossScope(infrastructurePlan('hosting-app', gcpZone, 'service'), plan('publisher-app', gcpZone), false);
  });
  it.each([undefined, { 'app.example.com': { zone: { ...gcpZone, scope: {} } } },
    { 'app.example.com': { zone: { ...gcpZone, scope: { projectId: 'dns-project', unexpected: 'untrusted' } } } }])('rejects missing or malformed exact domain-claim zone evidence before reserving or executing', async claims => {
    const selected = infrastructurePlan('release-app', gcpZone, 'mapping', claims === undefined ? {} : claims);
    const handler = vi.fn(); const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({ planRunId: selected.planRunId, currentSpecRevision: 1, confirmActions: [selected.actionId], handler, segmentHandler });
    expect(result.success).toBe(false); expect(result.applyRunId).toBeUndefined();
    expect(handler).not.toHaveBeenCalled(); expect(segmentHandler).not.toHaveBeenCalled();
  });
});
