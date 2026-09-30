import { describe, expect, it } from 'vitest';
import { recoverySourceIdentitySchema, recoverySourceIdentityMatches } from '../recovery-source.js';
import { recoveryPointSchema } from '../recovery-point.js';
import type { RecoverySourceIdentity } from '../../ports/recovery-source.port.js';
import '../../../application/providers.js';
import { providerRegistry } from '../../registry/provider.registry.js';

// Reconstructed identities from the eight native models checked in
// docs/recovery-contract.md, not claims that recovery adapters exist for all.
const sources: RecoverySourceIdentity[] = [
  { provider: 'railway', primaryExternalId: 'service', providerScope: { projectId: 'project', environmentId: 'production' }, resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'instance' } },
  { provider: 'cloudsql', primaryExternalId: 'instance', providerScope: { projectId: 'project', region: 'us-central1' }, resourceIdentity: {} },
  { provider: 'rds', primaryExternalId: 'arn:aws:rds:us-east-1:123456789012:db:primary', providerScope: { accountId: '123456789012', region: 'us-east-1' }, resourceIdentity: {} },
  { provider: 'supabase', primaryExternalId: 'project-ref', providerScope: { organizationId: 'organization', projectRef: 'project-ref' }, resourceIdentity: {} },
  { provider: 'azure-postgres', primaryExternalId: '/subscriptions/sub/resourceGroups/group/providers/Microsoft.DBforPostgreSQL/flexibleServers/primary', providerScope: { subscriptionId: 'sub', resourceGroup: 'group' }, resourceIdentity: {} },
  { provider: 'neon', primaryExternalId: 'project', providerScope: { organizationId: 'organization', projectId: 'project' }, resourceIdentity: { branchId: 'br-parent' } },
  { provider: 'fly', primaryExternalId: 'cluster', providerScope: { organizationId: 'organization' }, resourceIdentity: { clusterId: 'cluster' } },
  { provider: 'digitalocean', primaryExternalId: 'cluster-uuid', providerScope: { teamId: 'team' }, resourceIdentity: { clusterId: 'cluster-uuid' } },
];

describe('shared recovery identity and point contract', () => {
  it('covers the native identity of every named database provider', () => {
    expect(sources.map(source => source.provider).sort()).toEqual(providerRegistry.namesFor('database').sort());
  });
  it.each(sources)('represents $provider without fabricating another provider\'s coordinates', source => {
    expect(recoverySourceIdentitySchema.parse(source)).toEqual(source);
    expect(recoverySourceIdentityMatches(source, structuredClone(source))).toBe(true);
    expect(recoverySourceIdentityMatches(source, { ...source, primaryExternalId: 'other' })).toBe(false);
    expect(recoverySourceIdentityMatches(source, { ...source, provider: 'another-provider' })).toBe(false);
    for (const key of Object.keys(source.providerScope)) {
      expect(recoverySourceIdentityMatches(source, { ...source, providerScope: { ...source.providerScope, [key]: 'another-scope' } })).toBe(false);
    }
    for (const key of Object.keys(source.resourceIdentity)) {
      expect(recoverySourceIdentityMatches(source, { ...source, resourceIdentity: { ...source.resourceIdentity, [key]: 'another-resource' } })).toBe(false);
    }
  });

  it('does not equate Cloud SQL backup IDs from different source instances', () => {
    // BackupRun IDs are instance-scoped, independently documented at:
    // https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1beta4/backupRuns
    const first = recoveryPointSchema.parse({ kind: 'snapshot', source: sources[1], id: '42',
      createdAt: '2026-09-30T00:00:00Z', expiresAt: null });
    const second = { ...first, source: { ...first.source, primaryExternalId: 'another-instance' } };
    expect(recoverySourceIdentityMatches(first.source, second.source)).toBe(false);
    expect(first).not.toHaveProperty('dataTime');
  });

  it.each([
    { kind: 'timestamp', value: '2026-09-30T00:00:00Z' },
    { kind: 'lsn', value: '0/16B6C50' },
  ])('represents a Neon $kind recovery point without a snapshot or workflow ID', selector => {
    // https://api-docs.neon.tech/reference/createprojectbranch
    const point = { kind: 'point-in-time', source: sources[5], selector };
    expect(recoveryPointSchema.parse(point)).toEqual(point);
    expect(point).not.toHaveProperty('id');
    expect(point).not.toHaveProperty('available');
  });

  it('rejects secret-bearing coordinates and ambiguous point selectors', () => {
    expect(() => recoverySourceIdentitySchema.parse({ ...sources[1], providerScope: { projectId: 'project', password: 'private' } })).toThrow();
    expect(() => recoverySourceIdentitySchema.parse({ ...sources[1], resourceIdentity: { connectionString: 'private' } })).toThrow();
    expect(() => recoveryPointSchema.parse({ kind: 'point-in-time', source: sources[5],
      selector: { kind: 'timestamp', value: '2026-09-30T00:00:00Z', lsn: '0/16B6C50' } })).toThrow();
    expect(() => recoveryPointSchema.parse({ kind: 'point-in-time', source: sources[5], selector: { kind: 'lsn', value: 'not-an-lsn' } })).toThrow();
  });
});
