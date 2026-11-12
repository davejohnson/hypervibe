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
});
