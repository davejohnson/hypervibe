import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { IDatabaseCheckpointAdapter } from '../../../../domain/ports/database-checkpoint.port.js';
import { checkpointObservationFailures, privateProviderDetail } from './railway.checkpoint-observation.fixture.js';

afterEach(() => vi.unstubAllGlobals());
const identity = ({ backups: _backups, ...source }: import('../../../../domain/ports/database-checkpoint.port.js').DatabaseCheckpointSource) => source;

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const http = await railwayHttpFixture(options);
  http.addService('staging-postgres', 'postgres', stagingId).instances.get(stagingId)!.source = { image: 'postgres:17' };
  const production = http.addVolume('production-postgres-db', productionId, '/var/lib/postgresql/data');
  http.addVolume(null, stagingId, '/other');
  const volume = http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
  const component: Component = { id: 'local-db', environmentId: http.environment.id, type: 'postgres',
    externalId: 'staging-postgres', bindings: { provider: 'railway', resourceKind: 'service',
      providerScope: { projectId, environmentId: stagingId } }, createdAt: new Date(), updatedAt: new Date() };
  const adapter = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter,
    envRepo: { findById: () => http.environment } as never }) as ReturnType<typeof createRailwayDatabaseAdapter> & IDatabaseCheckpointAdapter;
  return { ...http, hostingAdapter: http.adapter, adapter, component, volume, production };
}

/** Real graphql-request serialization and pinned official schema execution.
 * Source: railwayapp/cli f60f3a7 src/commands/database/pitr.rs:1308-1437.
 * The CLI explicitly distinguishes volume-instance IDs from volume IDs.
 * Synthetic state proves the transport contract, not live backup restorability.
 */
describe('Railway database checkpoint API contract', () => {
  it.each(checkpointObservationFailures)('retains only safe diagnostics for $name', async (failure) => {
    const f = await fixture({ responseOverride: ({ query }) => query.includes('query DatabaseCheckpointWorkflow')
      ? failure.respond() : undefined });
    const error = await f.hostingAdapter.observeDatabaseCheckpointWorkflow('workflow').catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(privateProviderDetail);
    expect(JSON.stringify(error)).not.toContain(privateProviderDetail);
    expect(error).toMatchObject({ stage: 'workflow_status', category: failure.category,
      ...('httpStatus' in failure ? { httpStatus: failure.httpStatus } : {}) });
    expect(f.mutations).toEqual([]);
  });

  it('resolves the exact staging volume INSTANCE through pagination and creates only a snapshot', async () => {
    const f = await fixture({ pageSize: 1 });
    const before = structuredClone(f.production.instance);
    const source = await f.adapter.observeCheckpointSource(f.environment, f.component);
    expect(source).toEqual({ provider: 'railway', providerScope: { projectId, environmentId: stagingId },
      primaryExternalId: 'staging-postgres', resourceIdentity: { volumeId: f.volume.id,
      volumeInstanceId: f.volume.instance.id }, backups: [] });
    expect(await f.adapter.createCheckpoint(identity(source), 'hv-pre-beta-unique')).toEqual({ acknowledged: true, operationId: 'backup-workflow' });
    expect(f.mutations).toEqual([{ field: 'volumeInstanceBackupCreate', args: {
      volumeInstanceId: f.volume.instance.id, name: 'hv-pre-beta-unique' } }]);
    expect(await f.hostingAdapter.observeDatabaseCheckpointWorkflow('backup-workflow')).toEqual({ state: 'running' });
    f.backupWorkflows.set('backup-workflow', { status: 'Complete', error: null });
    expect(await f.hostingAdapter.observeDatabaseCheckpointWorkflow('backup-workflow')).toEqual({ state: 'complete' });
    expect((await f.adapter.observeCheckpointSource(f.environment, f.component)).backups).toEqual([
      { id: 'backup-1', externalId: 'snapshot-1', name: 'hv-pre-beta-unique',
        createdAt: '2026-09-30T06:00:00.000Z', expiresAt: null,
        usedMB: null, referencedMB: 8, volumeInstanceSizeMB: 1024 },
    ]);
    expect(f.production.instance).toEqual(before);
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['Error', 'NotFound'] as const)('preserves provider terminal %s without claiming completion', async (status) => {
    const f = await fixture();
    f.backupWorkflows.set('workflow', { status, error: 'synthetic provider detail must not escape' });
    expect(await f.hostingAdapter.observeDatabaseCheckpointWorkflow('workflow')).toEqual({ state: status === 'Error' ? 'error' : 'not-found' });
    expect(f.mutations).toEqual([]);
  });

  it('does not retry a snapshot after an ambiguous transport failure', async () => {
    const f = await fixture({ dropBackupCreateResponse: true });
    const source = await f.adapter.observeCheckpointSource(f.environment, f.component);
    await expect(f.adapter.createCheckpoint(identity(source), 'hv-test')).rejects.toThrow();
    expect(f.mutations).toHaveLength(1);
    expect(f.backups.get(source.resourceIdentity.volumeInstanceId)).toHaveLength(1);
  });

  it('preserves a contract-permitted null workflow identity for uncertain-write handling', async () => {
    const f = await fixture({ backupWorkflowId: null });
    const source = await f.adapter.observeCheckpointSource(f.environment, f.component);
    expect(await f.adapter.createCheckpoint(identity(source), 'hv-test')).toEqual({ acknowledged: false });
    expect(f.contractErrors).toEqual([]);
  });

  it('blocks changed source volume identity before creation', async () => {
    const f = await fixture();
    const source = await f.adapter.observeCheckpointSource(f.environment, f.component);
    f.volume.instance.id = 'replacement-instance';
    await expect(f.adapter.createCheckpoint(identity(source), 'hv-test')).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it.each(['duplicate', 'pending', 'scope', 'missing'] as const)('blocks %s volume ownership before creation', async (scenario) => {
    const f = await fixture();
    if (scenario === 'duplicate') f.addVolume('staging-postgres', stagingId, '/another');
    if (scenario === 'pending') f.volume.instance.isPendingDeletion = true;
    if (scenario === 'scope') f.component.bindings.providerScope = { projectId, environmentId: productionId };
    if (scenario === 'missing') f.volumes.delete(f.volume.id);
    await expect(f.adapter.observeCheckpointSource(f.environment, f.component)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('does not turn a failed backup-list request into an empty inventory', async () => {
    const f = await fixture({ responseOverride: ({ query }) => query.includes('DatabaseCheckpointBackups')
      ? Response.json({ errors: [{ message: 'synthetic denied' }] }, { status: 403 }) : undefined });
    await expect(f.adapter.observeCheckpointSource(f.environment, f.component)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('does not claim an observation failure proves no backup was created', async () => {
    let failInventory = false;
    const f = await fixture({ responseOverride: ({ query }) => failInventory && query.includes('DatabaseCheckpointBackups')
      ? Response.json({ errors: [{ message: privateProviderDetail }] }, { status: 403 }) : undefined });
    const source = await f.adapter.observeCheckpointSource(f.environment, f.component);
    await f.adapter.createCheckpoint(identity(source), 'hv-test');
    failInventory = true;
    const error = await f.adapter.observeCheckpointSource(f.environment, f.component).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('No backup was created');
    expect(String(error)).not.toContain(privateProviderDetail);
    expect(error).toMatchObject({ stage: 'source_inventory', category: 'authorization', httpStatus: 403 });
    expect(f.mutations).toHaveLength(1);
  });

  it('rejects malformed timestamps and duplicate backup identity in opaque scalar responses', async () => {
    const f = await fixture();
    const record = { id: 'backup', externalId: 'snapshot', name: null, createdAt: 'not-a-date',
      expiresAt: null, usedMB: null, referencedMB: null, volumeInstanceSizeMB: null };
    f.backups.set(String(f.volume.instance.id), [record]);
    await expect(f.adapter.observeCheckpointSource(f.environment, f.component)).rejects.toThrow();
    record.createdAt = '2026-09-30T06:00:00Z';
    f.backups.set(String(f.volume.instance.id), [record, record]);
    await expect(f.adapter.observeCheckpointSource(f.environment, f.component)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('rejects unrecognized workflow states even if they are inherited object properties', async () => {
    const f = await fixture({ responseOverride: ({ query }) => query.includes('query DatabaseCheckpointWorkflow')
      ? Response.json({ data: { workflowStatus: { status: 'toString' } } }) : undefined });
    // Negative response outside the pinned enum, not an alleged live provider shape.
    await expect(f.hostingAdapter.observeDatabaseCheckpointWorkflow('workflow')).rejects.toThrow('unknown');
  });
});
