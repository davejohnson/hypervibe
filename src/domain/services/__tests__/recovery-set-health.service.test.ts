import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageObjectClient, StorageObjectPayload } from '../../ports/storage.port.js';
import { createRecoverySet, recoverySetRoot } from '../recovery-set.service.js';
import { managedBackupTargetHash, type ManagedBackupTarget } from '../managed-backup-target.service.js';
import { applyManagedRecoveryRetention, observeManagedRecoverySet, recordRecoveryExecution } from '../recovery-set-health.service.js';
import { POSTGRES_BACKUP_FORMAT_VERSION, type PostgresBackupEvidence } from '../postgres-backup.service.js';

const identity = (externalId: string) => ({ provider: 'railway', externalId, instanceScope: { projectId: 'p', environmentId: 'e' } });
const target: ManagedBackupTarget = { version: 1, project: 'hls', environment: 'production',
  hosting: { provider: 'railway', providerScope: { projectId: 'p', environmentId: 'e' } },
  runnerImage: `ghcr.io/example/helper@sha256:${'a'.repeat(64)}`, destination: { name: 'backup', identity: identity('backup') },
  objects: [{ name: 'documents', identity: identity('documents') }], fileReferenceQueries: [],
  retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
const id = (number = 1) => `c3e927ba-7675-45a6-8c34-${String(number).padStart(12, '0')}`;
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, { bytes: Buffer.from(value), props: {} as Record<string, unknown> }]));
  const list = vi.fn(async (options?: { prefix?: string }) => [...values].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
    .map(([key, value]) => ({ key, size: value.bytes.length, revision: { etag: createHash('sha256').update(value.bytes).digest('hex') } })));
  const get = vi.fn(async (key: string): Promise<StorageObjectPayload> => { const value = values.get(key); if (!value) throw new Error('missing');
    return { ...value.props, size: value.bytes.length, body: Readable.from([value.bytes]), revision: { etag: createHash('sha256').update(value.bytes).digest('hex') } }; });
  const put = vi.fn(async (key: string, payload: StorageObjectPayload, options?: { ifAbsent?: boolean }) => {
    if (options?.ifAbsent && values.has(key)) throw new Error('exists');
    const chunks = []; for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
    const { body: _body, ...props } = payload; values.set(key, { bytes: Buffer.concat(chunks), props });
  });
  const remove = vi.fn(async (key: string, revision?: { etag?: string }) => {
    const value = values.get(key); if (value && revision?.etag !== createHash('sha256').update(value.bytes).digest('hex')) throw new Error('changed');
    values.delete(key);
  });
  return { values, get, put, remove, list, client: { get, put, list, remove, destroy() {} } as StorageObjectClient };
}
async function setup(complete = true) {
  const source = store({ 'customer-file.txt': 'private bytes' }), archive = store();
  const create = async (setId = id()) => {
    const result = await createRecoverySet({ runId: setId, project: target.project, environment: target.environment,
      contractHash: managedBackupTargetHash(target), destination: target.destination.identity, archive: archive.client,
      objects: [{ name: 'documents', identity: target.objects[0].identity, client: source.client }] });
    if (complete) await recordRecoveryExecution({ archive: archive.client, target, setId, jobId: 'github-run-123' });
    return result;
  };
  const result = await create(); archive.get.mockClear(); archive.put.mockClear();
  return { source, archive, create, result, input: { target, archive: archive.client } };
}
afterEach(() => vi.useRealTimers());

describe('completed managed recovery observations', () => {
  it('does not certify worker completion until the controller records terminal cleanup', async () => {
    const { input, archive } = await setup(false);
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unhealthy', reasonCodes: ['backup-missing'] });
    expect(archive.put).not.toHaveBeenCalled();
    await recordRecoveryExecution({ ...input, setId: id(), jobId: 'github-run-123' });
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'healthy', evidence: 'inventory-and-prior-restore' });
  });
  it('observes exact retained inventory without downloading data bytes or re-running restore', async () => {
    const { input, archive, result } = await setup();
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'healthy', manifest: { setId: id() } });
    expect(archive.get.mock.calls.every(([key]) => key.endsWith('.json'))).toBe(true);
    const manifest = JSON.parse(archive.values.get(result.manifest.objects[0].manifestKey)!.bytes.toString());
    archive.values.delete(manifest.entries[0].backupKey);
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unknown', reasonCodes: ['backup-unverified'] });
  });
  it('is stale at 24 hours of data age even if completion is more recent', async () => {
    const { input, result } = await setup();
    expect(await observeManagedRecoverySet({ ...input, now: new Date(Date.parse(result.manifest.dataTime) + 86_400_000) }))
      .toMatchObject({ status: 'unhealthy', reasonCodes: ['backup-stale'] });
  });
  it('rejects future evidence and does not substitute another source or contract', async () => {
    const { input, result } = await setup();
    expect(await observeManagedRecoverySet({ ...input, now: new Date(Date.parse(result.manifest.startedAt) - 1) })).toMatchObject({ status: 'unknown' });
    const changed = { ...target, objects: [{ ...target.objects[0], identity: identity('different-source') }] };
    expect(await observeManagedRecoverySet({ ...input, target: changed })).toMatchObject({ status: 'unhealthy', reasonCodes: ['backup-missing'] });
  });
  it('records cleanup once and rejects job identity changes without overwriting a marker', async () => {
    const { input, archive } = await setup();
    expect(await recordRecoveryExecution({ ...input, setId: id(), jobId: 'github-run-123' })).toMatchObject({ applied: 0, skipped: 1 });
    await expect(recordRecoveryExecution({ ...input, setId: id(), jobId: 'different-job' })).rejects.toThrow();
    expect(archive.put).not.toHaveBeenCalled();
  });
  it('requires exact manifest-owned object paths before recording cleanup', async () => {
    const { input, archive, result } = await setup(false);
    const key = result.manifest.objects[0].manifestKey;
    const manifest = JSON.parse(archive.values.get(key)!.bytes.toString());
    manifest.entries[0].backupKey = 'customer-production-file';
    archive.values.get(key)!.bytes = Buffer.from(JSON.stringify(manifest));
    await expect(recordRecoveryExecution({ ...input, setId: id(), jobId: 'job' })).rejects.toThrow();
    expect(archive.put).not.toHaveBeenCalled();
  });
  it('treats an outer completion with a missing inner manifest as unknown and blocks retention', async () => {
    const { input, archive, result } = await setup();
    archive.values.delete(result.receipt.manifestKey);
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unknown', reasonCodes: ['backup-unverified'] });
    await expect(applyManagedRecoveryRetention(input)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it('keeps legacy evidence unknown for the current contract but retains historical contracts without blocking a new set', async () => {
    const { input, archive, create, result } = await setup();
    await create(id(2));
    const key = result.receipt.manifestKey;
    const legacy = { ...result.manifest, version: 1 };
    archive.values.get(key)!.bytes = Buffer.from(JSON.stringify(legacy));
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unknown', reasonCodes: ['backup-unverified'] });
    // A helper digest upgrade creates a new target contract. Old proof remains
    // retained, but must neither certify today's contract nor block its new set.
    legacy.contractHash = 'b'.repeat(64);
    archive.values.get(key)!.bytes = Buffer.from(JSON.stringify(legacy));
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'healthy', manifest: { setId: id(2) } });
    expect(await applyManagedRecoveryRetention(input)).toMatchObject({ success: true, deletedSets: 0 });
    expect(archive.values.has(key)).toBe(true);
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it.each(['truncated', 'same-size replacement'])('rejects a %s SQL archive without reading archive bytes', async change => {
    const source = store({ file: 'bytes' }), archive = store();
    const database = { componentId: 'database-component', source: { provider: 'railway', primaryExternalId: 'database-service',
      providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: {} } };
    const selected: ManagedBackupTarget = { ...target, database, fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT key FROM files' }] };
    const result = await createRecoverySet({ runId: id(), project: selected.project, environment: selected.environment,
      contractHash: managedBackupTargetHash(selected), destination: selected.destination.identity, archive: archive.client,
      database: { source: database.source, sourceUrl: 'postgres://unused-private-source' }, fileReferenceQueries: selected.fileReferenceQueries,
      objects: [{ name: 'documents', identity: selected.objects[0].identity, client: source.client }] }, {
      backupDatabase: async input => {
        const bytes = Buffer.from('retained SQL archive');
        const evidence: PostgresBackupEvidence = { formatVersion: POSTGRES_BACKUP_FORMAT_VERSION, mechanism: 'postgres-logical-archive', source: input.source,
          destination: input.destination, runId: input.runId, archiveKey: `${input.archivePrefix}/${input.runId}/database.dump`,
          manifestKey: `${input.archivePrefix}/${input.runId}/database.complete.json`, archiveRevision: { etag: createHash('sha256').update(bytes).digest('hex') }, sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length, dataTime: new Date().toISOString(), completedAt: new Date().toISOString(), sourceVersion: '16', targetVersion: '16',
          tableCount: 1, totalRows: '1', restoreVerified: true, cleanupVerified: true, coverage: 'single-database-schema-and-data',
          applicationCompatibility: 'unverified', applied: 1, skipped: 0 };
        archive.values.set(evidence.archiveKey, { bytes, props: {} });
        archive.values.set(evidence.manifestKey, { bytes: Buffer.from(JSON.stringify(evidence)), props: {} });
        return { evidence, fileReferences: [{ storageName: 'documents', keys: ['file'] }] };
      },
    });
    const input = { archive: archive.client, target: selected };
    await recordRecoveryExecution({ ...input, setId: id(), jobId: 'provider-private-job' });
    archive.get.mockClear();
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'healthy', manifest: { compatibility: 'references-verified' } });
    expect(archive.get.mock.calls.every(([key]) => key.endsWith('.json'))).toBe(true);
    const retained = archive.values.get(result.manifest.database!.archiveKey)!;
    retained.bytes = change === 'truncated' ? Buffer.from('truncated') : Buffer.alloc(retained.bytes.length, 'x');
    expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unknown', reasonCodes: ['backup-unverified'] });
  });
  it('leaves the joint set incomplete when restored SQL references a file absent from the copied bucket', async () => {
    const source = store({ file: 'bytes' }), archive = store();
    const database = { componentId: 'database-component', source: { provider: 'railway', primaryExternalId: 'database-service',
      providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: {} } };
    const selected: ManagedBackupTarget = { ...target, database, fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT key FROM files' }] };
    await expect(createRecoverySet({ runId: id(), project: selected.project, environment: selected.environment,
      contractHash: managedBackupTargetHash(selected), destination: selected.destination.identity, archive: archive.client,
      database: { source: database.source, sourceUrl: 'postgres://unused-private-source' }, fileReferenceQueries: selected.fileReferenceQueries,
      objects: [{ name: 'documents', identity: selected.objects[0].identity, client: source.client }] }, {
      backupDatabase: async input => {
        const evidence: PostgresBackupEvidence = { formatVersion: POSTGRES_BACKUP_FORMAT_VERSION, mechanism: 'postgres-logical-archive', source: input.source,
          destination: input.destination, runId: input.runId, archiveKey: `${input.archivePrefix}/${input.runId}/database.dump`,
          manifestKey: `${input.archivePrefix}/${input.runId}/database.complete.json`, archiveRevision: { etag: createHash('sha256').update('sql').digest('hex') }, sha256: 'a'.repeat(64), bytes: 3,
          dataTime: new Date().toISOString(), completedAt: new Date().toISOString(), sourceVersion: '16', targetVersion: '16',
          tableCount: 1, totalRows: '1', restoreVerified: true, cleanupVerified: true, coverage: 'single-database-schema-and-data',
          applicationCompatibility: 'unverified', applied: 1, skipped: 0 };
        archive.values.set(evidence.archiveKey, { bytes: Buffer.from('sql'), props: {} });
        archive.values.set(evidence.manifestKey, { bytes: Buffer.from(JSON.stringify(evidence)), props: {} });
        return { evidence, fileReferences: [{ storageName: 'documents', keys: ['missing-customer-file'] }] };
      },
    })).rejects.toThrow(/referenced.*missing/i);
    expect([...archive.values.keys()].some(key => key.endsWith('/manifest.json'))).toBe(true);
    expect([...archive.values.keys()].some(key => key.endsWith('/database.complete.json'))).toBe(true);
    expect([...archive.values.keys()].some(key => key.endsWith('/complete.json'))).toBe(false);
    expect(await observeManagedRecoverySet({ target: selected, archive: archive.client })).toMatchObject({ status: 'unhealthy', reasonCodes: ['backup-missing'] });
    expect(source.remove).not.toHaveBeenCalled();
    expect(source.put).not.toHaveBeenCalled();
  });
});

describe('exact completed-execution retention', () => {
  it.each(['health', 'retention'])('blocks %s when a replacement races the final owned-key inventory', async operation => {
    const { input, archive, create, result } = await setup();
    for (let i = 2; i <= 8; i++) await create(id(i));
    const manifestKey = result.manifest.objects[0].manifestKey;
    const manifest = JSON.parse(archive.values.get(manifestKey)!.bytes.toString());
    const prefix = manifestKey.slice(0, -'manifest.json'.length);
    const list = archive.list.getMockImplementation()!;
    let replaced = false;
    archive.list.mockImplementation(async options => {
      const observed = await list(options);
      if (!replaced && options?.prefix === prefix) {
        replaced = true;
        const value = archive.values.get(manifest.entries[0].backupKey)!;
        value.bytes = Buffer.alloc(value.bytes.length, 'x');
      }
      return observed;
    });
    if (operation === 'health') {
      expect(await observeManagedRecoverySet(input)).toMatchObject({ status: 'unknown', reasonCodes: ['backup-unverified'] });
    } else await expect(applyManagedRecoveryRetention(input)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it('retains seven complete executions, ignores partial sets and deletes only the oldest owned keys', async () => {
    const { input, archive, create } = await setup();
    for (let i = 2; i <= 8; i++) await create(id(i));
    const unrelated = 'unowned/customer-file'; archive.values.set(unrelated, { bytes: Buffer.from('keep'), props: {} });
    const partial = `${recoverySetRoot(target.project, target.environment)}${id(9)}/started.json`;
    archive.values.set(partial, { bytes: Buffer.from('{}'), props: {} });
    const result = await applyManagedRecoveryRetention(input);
    expect(result).toMatchObject({ success: true, deletedSets: 1 });
    expect(archive.remove.mock.calls.length).toBeGreaterThan(1);
    expect(archive.remove.mock.calls[0][0]).toMatch(/execution\.complete\.json$/);
    expect(archive.remove.mock.calls.every(([, revision]) => Boolean(revision?.etag))).toBe(true);
    expect(archive.values.has(unrelated)).toBe(true); expect(archive.values.has(partial)).toBe(true);
    expect([...archive.values.keys()].filter(key => key.endsWith('/execution.complete.json'))).toHaveLength(7);
  });
  it('makes zero deletions when any complete execution inventory or conditional-delete revision is unverified', async () => {
    const { input, archive, create, result } = await setup();
    for (let i = 2; i <= 8; i++) await create(id(i));
    archive.values.delete(result.manifest.objects[0].manifestKey);
    await expect(applyManagedRecoveryRetention(input)).rejects.toThrow();
    expect(archive.remove).not.toHaveBeenCalled();
  });
  it('stops after an ambiguous delete and does not claim an applied count', async () => {
    const { input, archive, create } = await setup();
    for (let i = 2; i <= 8; i++) await create(id(i));
    archive.remove.mockRejectedValueOnce(new Error('connection lost'));
    expect(await applyManagedRecoveryRetention(input)).toMatchObject({ success: false, applied: null, mutationAttempted: true });
    expect(archive.remove).toHaveBeenCalledTimes(1);
  });
  it('does not equate an acknowledged retention deletion with observed absence', async () => {
    const { input, archive, create } = await setup();
    for (let i = 2; i <= 8; i++) await create(id(i));
    archive.remove.mockImplementation(async () => undefined);
    expect(await applyManagedRecoveryRetention(input)).toMatchObject({ success: false, applied: null, deletedSets: 0, mutationAttempted: true });
  });
});
