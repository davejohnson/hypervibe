import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSqlAdapter } from '../cloudsql.adapter.js';
import type { DatabaseBackupTarget, DailyBackupReview } from '../../../../domain/ports/daily-backup.port.js';

// Reconstructed transport fixtures, not recorded/live evidence. Independent contracts:
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances
// Settings.backupConfiguration is daily; enabled is independent of PITR. COUNT and
// RETENTION_UNIT_UNSPECIFIED both mean backup count. Missing retention is not zero.
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances/patch
// PATCH merges provided fields; settingsVersion protects concurrent settings writes.
const source = { provider: 'cloudsql', primaryExternalId: 'primary', providerScope: { projectId: 'project', region: 'us-central1' }, resourceIdentity: { instanceId: 'primary' } };
const now = new Date('2026-09-30T00:00:00Z');
const target: DatabaseBackupTarget = {
  environment: { id: 'env', projectId: 'local-project', name: 'production', platformBindings: {}, createdAt: now, updatedAt: now },
  component: { id: 'db', environmentId: 'env', type: 'postgres', externalId: 'primary', bindings: { provider: 'cloudsql', providerScope: source.providerScope }, createdAt: now, updatedAt: now },
};
const instance = (backup: Record<string, unknown> = { enabled: false }, extra: Record<string, unknown> = {}) => ({
  name: 'primary', project: 'project', region: 'us-central1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_16',
  connectionName: 'project:us-central1:primary',
  settings: { settingsVersion: '42', backupConfiguration: backup, tier: 'db-custom-2-7680' }, ...extra,
});

async function connected() {
  const adapter = new CloudSqlAdapter();
  await adapter.connect({ projectId: 'project', credentials: JSON.stringify({ type: 'service_account', project_id: 'project', private_key: 'dummy', client_email: 'test@project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'test-token', tokenExpiry: new Date(Date.now() + 60_000) });
  return adapter;
}

function transport(initial: ReturnType<typeof instance>, options: { final?: ReturnType<typeof instance>; patchError?: boolean } = {}) {
  let live = initial;
  const patches: unknown[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === 'https://sqladmin.googleapis.com/v1/projects/project/instances/primary') {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        if (options.patchError) throw new Error('connection closed after write');
        live = options.final ?? instance({ ...initial.settings.backupConfiguration, enabled: true });
        return Response.json({ name: 'update-1', status: 'PENDING' });
      }
      return Response.json(live);
    }
    if (String(url) === 'https://sqladmin.googleapis.com/v1/projects/project/operations/update-1') return Response.json({ name: 'update-1', status: 'DONE' });
    throw new Error(`Unexpected transport request ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, patches, replace: (next: ReturnType<typeof instance>) => { live = next; } };
}

async function review(adapter: CloudSqlAdapter): Promise<DailyBackupReview> {
  const observed = await adapter.dailyBackups.observe(target);
  expect(observed.state).toBe('known');
  if (observed.state !== 'known') throw new Error(observed.reason);
  return { source: observed.source, policyFingerprint: observed.policyFingerprint };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Cloud SQL additive daily backup policy', () => {
  it.each(['COUNT', 'RETENTION_UNIT_UNSPECIFIED', undefined])('observes automatic daily backups and count retention with unit %s', async unit => {
    const adapter = await connected();
    transport(instance({ enabled: true, pointInTimeRecoveryEnabled: false, backupRetentionSettings: { retainedBackups: 14, ...(unit ? { retentionUnit: unit } : {}) } }));
    expect(await adapter.dailyBackups.observe(target)).toMatchObject({ state: 'known', source, daily: true, mechanism: 'snapshot', retention: { unit: 'backups', value: 14 } });
  });

  it('does not invent retention when the API omits it', async () => {
    const adapter = await connected();
    transport(instance({ enabled: true }));
    const observed = await adapter.dailyBackups.observe(target);
    expect(observed).toMatchObject({ state: 'known', daily: true });
    expect(observed).not.toHaveProperty('retention');
  });

  it.each([{}, { enabled: null }, { enabled: 'true' }, { enabled: true, backupTier: 'ENHANCED' }, { enabled: true, backupRetentionSettings: { retentionUnit: 'DAYS', retainedBackups: 14 } }])('keeps incomplete/unsupported native configuration unknown: %j', async backup => {
    const adapter = await connected();
    transport(instance(backup));
    expect(await adapter.dailyBackups.observe(target)).toMatchObject({ state: 'unknown' });
  });

  it('patches only enabled using the current settings version and preserves PITR, retention and start time', async () => {
    const adapter = await connected();
    const native = { enabled: false, startTime: '22:00', pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7, location: 'us', backupRetentionSettings: { retainedBackups: 30, retentionUnit: 'COUNT' } };
    const wire = transport(instance(native));
    const receipt = await adapter.dailyBackups.configureDaily(target, await review(adapter));
    expect(wire.patches).toEqual([{ settings: { settingsVersion: '42', backupConfiguration: { enabled: true } } }]);
    expect(receipt).toMatchObject({ success: true, data: { applied: 1, skipped: 0 } });
    expect(receipt.message).toMatch(/not.*restore|restore.*not/i);
  });

  it('keeps a separate preservation fingerprint stable when only daily enablement and settings revision change', async () => {
    const adapter = await connected();
    const native = { enabled: false, startTime: '22:00', pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7, backupRetentionSettings: { retainedBackups: 30, retentionUnit: 'COUNT' } };
    const wire = transport(instance(native));
    const before = await adapter.dailyBackups.observe(target);
    expect(before).toHaveProperty('preservationFingerprint', expect.stringMatching(/^[a-f0-9]{64}$/));
    wire.replace(instance({ ...native, enabled: true }, { settings: { settingsVersion: '43', backupConfiguration: { ...native, enabled: true } } }));
    const after = await adapter.dailyBackups.observe(target);
    if (before.state !== 'known' || after.state !== 'known') throw new Error('Expected independently observed standard policies');
    expect(after.preservationFingerprint).toBe(before.preservationFingerprint);
    expect(after.policyFingerprint).not.toBe(before.policyFingerprint);
  });

  it('detects lost PITR in preservation evidence even when daily scheduling is enabled', async () => {
    const adapter = await connected();
    const native = { enabled: false, pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7, backupRetentionSettings: { retainedBackups: 30, retentionUnit: 'COUNT' } };
    const wire = transport(instance(native));
    const before = await adapter.dailyBackups.observe(target);
    wire.replace(instance({ ...native, enabled: true, pointInTimeRecoveryEnabled: false }));
    const after = await adapter.dailyBackups.observe(target);
    if (before.state !== 'known' || after.state !== 'known') throw new Error('Expected independently observed standard policies');
    expect(after.daily).toBe(true);
    expect(after.preservationFingerprint).not.toBe(before.preservationFingerprint);
  });

  it('leaves already enabled daily backups unchanged', async () => {
    const adapter = await connected();
    const wire = transport(instance({ enabled: true }));
    expect(await adapter.dailyBackups.configureDaily(target, await review(adapter))).toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(wire.patches).toEqual([]);
  });

  it('blocks a changed reviewed policy without writing', async () => {
    const adapter = await connected();
    const wire = transport(instance());
    const reviewed = await review(adapter);
    wire.replace(instance({ enabled: false, backupRetentionSettings: { retainedBackups: 30 } }));
    expect(await adapter.dailyBackups.configureDaily(target, reviewed)).toMatchObject({ success: false });
    expect(wire.patches).toEqual([]);
  });

  it('blocks a reviewed source from another project before writing', async () => {
    const adapter = await connected();
    const wire = transport(instance());
    const reviewed = await review(adapter);
    reviewed.source.providerScope.projectId = 'other';
    expect(await adapter.dailyBackups.configureDaily(target, reviewed)).toMatchObject({ success: false });
    expect(wire.patches).toEqual([]);
  });

  it.each([{ name: 'different' }, { project: 'other' }, { region: 'europe-west1' }, { connectionName: 'other:us-central1:primary' }])('rejects wrong live source coordinates %j', async changed => {
    const adapter = await connected();
    transport(instance({ enabled: true }, changed));
    expect(await adapter.dailyBackups.observe(target)).toMatchObject({ state: 'unknown' });
  });

  it('requires settings version before enabling an unconfigured schedule', async () => {
    const adapter = await connected();
    const wire = transport(instance({ enabled: false }, { settings: { backupConfiguration: { enabled: false } } }));
    const observed = await adapter.dailyBackups.observe(target);
    expect(observed).toMatchObject({ state: 'unknown' });
    expect(wire.patches).toEqual([]);
  });

  it('does not confuse operation completion with verified daily configuration', async () => {
    const adapter = await connected();
    const wire = transport(instance(), { final: instance() });
    expect(await adapter.dailyBackups.configureDaily(target, await review(adapter))).toMatchObject({ success: false });
    expect(wire.patches).toHaveLength(1);
  });

  it('does not retry an uncertain patch', async () => {
    const adapter = await connected();
    const wire = transport(instance(), { patchError: true });
    expect(await adapter.dailyBackups.configureDaily(target, await review(adapter))).toMatchObject({ success: false });
    expect(wire.patches).toHaveLength(1);
  });

  it('keeps authorization failures unknown', async () => {
    const adapter = await connected();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    expect(await adapter.dailyBackups.observe(target)).toMatchObject({ state: 'unknown' });
  });
});
