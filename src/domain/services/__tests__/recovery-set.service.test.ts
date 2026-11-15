import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRecoverySet } from '../recovery-set.service.js';
import type { PostgresBackupEvidence } from '../postgres-backup.service.js';
import type { StorageObjectClient, StorageObjectPayload } from '../../ports/storage.port.js';

function store(initial: Record<string, string> = {}) {
  const bytes = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const properties = new Map<string, Omit<StorageObjectPayload, 'body'>>();
  const client: StorageObjectClient = {
    async list(options) { return [...bytes].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => ({ key, size: value.length, revision: { etag: createHash('sha256').update(value).digest('hex') } })); },
    async get(key) { const value = bytes.get(key); if (!value) throw new Error('missing');
      return { ...properties.get(key), size: value.length, body: Readable.from([value]), revision: { etag: createHash('sha256').update(value).digest('hex') } }; },
    async put(key, payload, options) {
      if (options?.ifAbsent && bytes.has(key)) throw new Error('exists');
      const chunks = []; for await (const chunk of payload.body as Readable) chunks.push(Buffer.from(chunk));
      bytes.set(key, Buffer.concat(chunks)); const { body: _body, ...rest } = payload; properties.set(key, rest);
    },
    destroy() {},
  };
  return { bytes, client };
}
const identity = (externalId: string) => ({ provider: 'railway', externalId, instanceScope: { projectId: 'p', environmentId: 'e' } });
const runId = 'c3e927ba-7675-45a6-8c34-0c68a651a4ac';
const setup = (files: Record<string, string> = { 'doc.txt': 'verified bytes' }) => {
  const source = store(files), archive = store();
  return { source, archive, input: { runId, environment: 'staging', project: 'hls', contractHash: 'a'.repeat(64),
    destination: identity('backup'), archive: archive.client,
    objects: [{ name: 'documents', identity: identity('source'), client: source.client }],
  } };
};
describe('usable database and file recovery sets', () => {
  it.each([
    { mechanism: 'native-volume-snapshot' },
    { coverage: 'schema-only' },
    { sourceVersion: undefined },
  ])('rejects incomplete SQL evidence before joint completion: %j', async invalid => {
    const { input, archive } = setup();
    const source = { provider: 'railway', primaryExternalId: 'database',
      providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: {} };
    await expect(createRecoverySet({ ...input, objects: [], database: { source, sourceUrl: 'postgres://unused' } }, {
      backupDatabase: async request => ({ evidence: {
        formatVersion: 2, mechanism: 'postgres-logical-archive', source, destination: request.destination,
        runId: request.runId, archiveKey: `${request.archivePrefix}/${request.runId}/database.dump`,
        manifestKey: `${request.archivePrefix}/${request.runId}/database.complete.json`,
        archiveRevision: { etag: 'stored-revision' }, sha256: 'a'.repeat(64), bytes: 3,
        dataTime: new Date().toISOString(), completedAt: new Date().toISOString(), sourceVersion: '16', targetVersion: '16',
        tableCount: 1, totalRows: '1', restoreVerified: true, cleanupVerified: true,
        coverage: 'single-database-schema-and-data', applicationCompatibility: 'unverified', applied: 1, skipped: 0,
        ...invalid,
      } as PostgresBackupEvidence, fileReferences: [] }),
    })).rejects.toThrow();
    expect([...archive.bytes.keys()].some(key => key.endsWith('/complete.json'))).toBe(false);
  });
  it('only commits joint completion after files restore and cleanup succeed', async () => {
    const { input, archive, source } = setup();
    const result = await createRecoverySet(input);
    expect(result.receipt).toMatchObject({ applied: 1, skipped: 0, objectCount: 1, restoreVerified: true, cleanupVerified: true });
    expect(result.manifest.compatibility).toBe('not-applicable');
    expect([...archive.bytes.keys()].at(-1)).toMatch(/\/complete\.json$/);
    expect([...source.bytes.keys()]).toEqual(['doc.txt']);
  });
  it('does not reuse a started execution or write a second completion', async () => {
    const { input } = setup(); await createRecoverySet(input);
    await expect(createRecoverySet(input)).rejects.toThrow(/execution/i);
  });
  it('refuses to call a database-and-files set compatible without an application reference projection', async () => {
    const { input, archive } = setup();
    await expect(createRecoverySet({ ...input, database: { sourceUrl: 'postgres://unused', source: { provider: 'railway', primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: {} } } })).rejects.toThrow(/reference/i);
    expect(archive.bytes.size).toBe(0);
  });
  it('does not complete when cleanup cannot be verified', async () => {
    const { input, archive } = setup();
    await expect(createRecoverySet(input, { createRestoreStore: async () => ({ client: store().client, identity: identity('scratch'), cleanup: vi.fn().mockRejectedValue(new Error('busy')) }) })).rejects.toThrow();
    expect([...archive.bytes.keys()].some(key => key.endsWith('/complete.json'))).toBe(false);
  });

  it.each(['recovery-reservation', 'object-copy', 'object-restore', 'restore-cleanup'] as const)(
    'retains the safe %s stage without exposing the storage error or completing the set', async stage => {
      const { input, archive, source } = setup();
      const sensitive = new Error('https://access-secret:storage-secret@example.invalid/private-document');
      if (stage === 'recovery-reservation') archive.client.list = vi.fn().mockRejectedValue(sensitive);
      if (stage === 'object-copy') source.client.list = vi.fn().mockRejectedValue(sensitive);
      const scratch = store();
      if (stage === 'object-restore') scratch.client.put = vi.fn().mockRejectedValue(sensitive);
      const cleanup = stage === 'restore-cleanup' ? vi.fn().mockRejectedValue(sensitive) : vi.fn().mockResolvedValue(undefined);
      const error = await createRecoverySet(input, { createRestoreStore: async () => ({
        client: scratch.client, identity: identity('scratch'), cleanup,
      }) }).catch(error => error);
      expect(error).toMatchObject({ diagnostic: { stage, category: stage === 'restore-cleanup' ? 'cleanup' : 'execution' } });
      expect(String(error)).not.toMatch(/storage-secret|access-secret|private-document/);
      expect(JSON.stringify(error)).not.toMatch(/storage-secret|access-secret|private-document/);
      expect([...archive.bytes.keys()].some(key => key.endsWith('/complete.json'))).toBe(false);
    });

  it('preserves the object restore failure when local cleanup also fails', async () => {
    const { input, archive } = setup(), scratch = store();
    scratch.client.put = vi.fn().mockRejectedValue(new Error('private-file-data'));
    const error = await createRecoverySet(input, { createRestoreStore: async () => ({ client: scratch.client,
      identity: identity('scratch'), cleanup: vi.fn().mockRejectedValue(new Error('secret-path')),
    }) }).catch(error => error);
    expect(error).toMatchObject({ diagnostic: { stage: 'object-restore', category: 'execution', localCleanupFailed: true } });
    expect(JSON.stringify(error)).not.toMatch(/private-file-data|secret-path/);
    expect([...archive.bytes.keys()].some(key => key.endsWith('/complete.json'))).toBe(false);
  });
});
