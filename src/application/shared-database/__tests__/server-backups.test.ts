import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleSharedDatabaseCloud, sharedDatabase } from '../index.js';

// https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#BackupConfiguration
describe('native backups for a database on the app’s existing Cloud SQL server', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function plan(backupConfiguration: unknown, automatedBackups?: true, extraLabels: Record<string, string> = {}) {
    const labels = { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' };
    const response = { items: [
      { name: 'other-server', project: 'demo-project', region: 'us-east1', state: 'RUNNABLE', instanceType: 'CLOUD_SQL_INSTANCE', databaseVersion: 'POSTGRES_16',
        settings: { userLabels: labels, backupConfiguration: { enabled: true, backupTier: 'STANDARD' } } },
      { name: 'our-server', project: 'demo-project', region: 'us-central1', state: 'RUNNABLE', instanceType: 'CLOUD_SQL_INSTANCE', databaseVersion: 'POSTGRES_16', settings: { userLabels: { ...labels, ...extraLabels }, backupConfiguration } },
    ] };
    const list = vi.fn(async () => Response.json(response));
    vi.stubGlobal('fetch', list);
    const cloud = googleSharedDatabaseCloud({ token: 'test-token', credentials: () => ({}) });
    const observeConnectionSecret = vi.spyOn(cloud, 'observeConnectionSecret').mockResolvedValue({ state: 'absent' });
    const engine = { plan: vi.fn(), apply: vi.fn() };
    const result = await sharedDatabase.plan({ project: { id: 'project-1', name: 'demo' }, environment: { id: 'env-1', name: 'preview' },
      gcpProjectId: 'demo-project', region: 'us-central1', binding: undefined, secret: { id: 'hv-preview-database-url', labels: {} },
      runningSecretVersions: async () => ({ versions: [] }), engine, cloud, desired: { provider: 'cloudsql', engine: 'postgres', placement: 'app', automatedBackups } });
    expect(engine.plan).not.toHaveBeenCalled();
    expect(engine.apply).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    return { result, observeConnectionSecret };
  }

  it.each([
    [{ enabled: false, backupTier: 'STANDARD' }, /our-server.*disabled/i],
    [undefined, /could not confirm.*our-server/i],
    [{ enabled: true }, /could not confirm.*our-server/i],
    [{ enabled: 'true', backupTier: 'STANDARD' }, /could not confirm.*our-server/i],
    [{ enabled: true, backupTier: 'ENHANCED' }, /could not confirm.*our-server/i],
  ] as const)('blocks on the correct server before planning tenant changes when Google reports %j', async (backup, reason) => {
    const { result, observeConnectionSecret } = await plan(backup, true);
    expect(result).toMatchObject({ blocked: expect.stringMatching(reason) });
    expect(observeConnectionSecret).not.toHaveBeenCalled();
  });

  it.each([[{ enabled: true, backupTier: 'STANDARD' }, true], [{ enabled: false }, undefined]] as const)(
    'continues with the tenant when Google reports %j and the intent is %s', async (backup, intent) => {
      const { result } = await plan(backup, intent);
      expect(result).toMatchObject({ actions: [{ id: 'shared-database:allocate' }] });
    });

  it('refuses to claim backups for a server also labelled as an individual environment’s instance', async () => {
    const { result } = await plan({ enabled: true, backupTier: 'STANDARD' }, true, { 'hv-environment': 'another-environment' });
    expect(result).toEqual({ blocked: expect.stringMatching(/could not confirm.*our-server/i) });
  });
});
