import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import * as maintenance from '../../domain/services/environment-maintenance.service.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { applyDataMigrationAction } from '../apply-data-migration.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { DatabaseAccessLease } from '../../domain/services/database-access.service.js';
import '../providers.js';

vi.mock('../../domain/services/database-access.service.js', async (original) => ({
  ...await original<typeof import('../../domain/services/database-access.service.js')>(),
  acquireManagedDatabaseAccess: vi.fn(), acquireDatabaseComponentAccess: vi.fn(),
}));
vi.mock('../../domain/services/postgres-transfer.service.js', async (original) => ({
  ...await original<typeof import('../../domain/services/postgres-transfer.service.js')>(),
  transferPostgresDatabase: vi.fn(),
}));
import { acquireManagedDatabaseAccess, acquireDatabaseComponentAccess } from '../../domain/services/database-access.service.js';
import { transferPostgresDatabase } from '../../domain/services/postgres-transfer.service.js';

// Reconstructed HTTP evidence, not a recorded successful GCP deployment.
// Google documents DatabaseInstance.region as the creation region (default
// us-central1) and instances.insert as POST /v1/projects/{project}/instances:
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances/insert
// The desired us-west1 below is the owner's reviewed placement; the credentials
// deliberately retain bootstrap's different default. Successful responses use a
// fixed reviewed region, never echo the submitted region. SQL transfer is outside
// this placement contract and uses a stub; no live data is read or copied.
describe('Cloud SQL placement through shared creation paths', () => {
  let ctx: CommandContext;
  let adapter: CloudSqlAdapter;
  let creates: Array<Record<string, unknown>>;
  let accepted: boolean;
  let createdName: string | undefined;

  beforeEach(async () => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(mkdtempSync(path.join(tmpdir(), 'hv-sql-placement-')), 'test.db')).migrate();
    ctx = createCommandContext();
    adapter = new CloudSqlAdapter();
    await adapter.connect({
      projectId: 'fixture-project', region: 'us-central1',
      credentials: JSON.stringify({ client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: 'fixture' }),
    });
    Object.assign(adapter, { accessToken: 'fixture-token', tokenExpiry: new Date(Date.now() + 60_000) });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter });
    creates = [];
    accepted = false;
    createdName = undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/operations\/(instance-create|database-create)$/.test(url)) {
        return Response.json({ name: url.split('/').at(-1), status: 'DONE' });
      }
      if (method === 'GET' && url.startsWith('https://sqladmin.googleapis.com/v1/projects/fixture-project/instances/')) {
        if (createdName && url.endsWith(`/instances/${createdName}`)) {
          return Response.json({ name: createdName, project: 'fixture-project', state: 'RUNNABLE',
            databaseVersion: 'POSTGRES_15', region: 'us-west1', connectionName: `fixture-project:us-west1:${createdName}` });
        }
        return new Response('not found', { status: 404 });
      }
      if (method === 'POST' && url === 'https://sqladmin.googleapis.com/v1/projects/fixture-project/instances') {
        const { rootPassword: _secret, ...request } = JSON.parse(String(init?.body));
        creates.push(request);
        if (accepted) {
          createdName = request.name;
          return Response.json({ name: 'instance-create' });
        }
        return new Response('fixture rejects creation after inspecting placement', { status: 400 });
      }
      if (accepted && method === 'POST' && url.endsWith(`/instances/${createdName}/databases`)) {
        return Response.json({ name: 'database-create' });
      }
      throw new Error(`Unexpected fixture transport: ${method} ${url}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(acquireManagedDatabaseAccess).mockReset();
    vi.mocked(acquireDatabaseComponentAccess).mockReset();
    vi.mocked(transferPostgresDatabase).mockReset();
    SqliteAdapter.resetInstance();
  });

  function fixture() {
    const project = ctx.repos.projects.create({ name: 'sql-placement', defaultPlatform: 'cloudrun' });
    const source = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
    const target = ctx.repos.environments.create({ projectId: project.id, name: 'gcp-test', platformBindings: { provider: 'cloudrun' } });
    const sourceDatabase = ctx.repos.components.create({
      environmentId: source.id, type: 'postgres', externalId: 'untouched-production',
      bindings: { provider: 'railway', providerScope: { projectId: 'rail-project', environmentId: 'production' } },
    });
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name,
      environments: {
        production: { hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway' }, maintenance: { enabled: true } },
        'gcp-test': { hosting: { provider: 'cloudrun', region: 'us-west1' }, services: {}, database: { provider: 'cloudsql' }, maintenance: { enabled: true } },
      },
    });
    return { project, source, target, sourceDatabase, spec };
  }

  it.each([false, true])('sends normal reviewed creation to the desired region (accepted=%s)', async (succeeds) => {
    accepted = succeeds;
    const f = fixture();
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
    const action = {
      id: 'database:cloudsql', type: 'create' as const,
      resource: { kind: 'database' as const, name: 'postgres', provider: 'cloudsql' },
      verified: true, billable: true, requiresConfirm: true, reason: 'Create reviewed trial database',
    };
    const plan = ctx.repos.runs.create({
      projectId: f.project.id, environmentId: f.target.id, type: 'plan',
      plan: { kind: 'hv_plan', environmentName: f.target.name, specRevision: 1, observedFingerprint: null, actions: [action] },
    });
    const result = await executePlanApply(ctx, {
      project: f.project, spec: f.spec, specRevision: 1, planId: plan.id, confirmActions: [action.id],
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ region: 'us-west1', databaseVersion: 'POSTGRES_15', settings: { tier: 'db-f1-micro' } });
    expect(result).toMatchObject({ kind: 'executed', result: { success: succeeds } });
    const database = ctx.repos.components.findByEnvironmentAndType(f.target.id, 'postgres');
    if (succeeds) {
      expect(database).toMatchObject({ externalId: createdName, bindings: {
        providerScope: { projectId: 'fixture-project', region: 'us-west1' },
        connectionName: `fixture-project:us-west1:${createdName}`,
      } });
    } else expect(database).toBeNull();
    expect(ctx.repos.components.findByEnvironmentAndType(f.source.id, 'postgres')).toEqual(f.sourceDatabase);
  });

  it.each([false, true])('sends a migration candidate to the desired region (accepted=%s)', async (succeeds) => {
    accepted = succeeds;
    const f = fixture();
    f.spec.environments['gcp-test'].dataMigration = {
      id: 'placement-trial', fromEnvironment: 'production', include: { database: true, storage: [] },
    };
    const oldTarget = ctx.repos.components.create({
      environmentId: f.target.id, type: 'postgres', externalId: 'retained-target',
      bindings: { provider: 'cloudsql', providerScope: { projectId: 'fixture-project', region: 'us-central1' } },
    });
    const active = { state: 'active' as const, stage: 'verified' as const, edge: { state: 'active' as const, hostname: 'fixture.example', markerVerified: true }, workloads: {}, database: { state: 'fenced' as const } };
    const fingerprint = createHash('sha256').update(JSON.stringify(active)).digest('hex');
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { name: 'fixture', configureTarget() {} } as never });
    vi.spyOn(maintenance, 'observeEnvironmentMaintenance').mockResolvedValue(active);
    const lease: DatabaseAccessLease = {
      id: 'fixture-lease', provider: 'fixture', mode: 'existing', createdByInvocation: false,
      withConnection: operation => operation('postgresql://fixture'),
      release: async () => ({ status: 'no_op' }),
    };
    vi.mocked(acquireManagedDatabaseAccess).mockResolvedValue({ ok: true, lease });
    vi.mocked(acquireDatabaseComponentAccess).mockResolvedValue({ ok: true, lease });
    vi.mocked(transferPostgresDatabase).mockResolvedValue({
      manifest: { sourceVersion: '150000', extensions: [], tables: [], totalRows: '0', dumpBytes: 64 }, targetVersion: '150000',
    });
    const result = await applyDataMigrationAction({
      ctx, project: f.project, spec: f.spec, targetEnvironmentName: f.target.name,
      action: {
        id: 'data-migration:placement-trial:database', type: 'update',
        resource: { kind: 'database', name: 'postgres', provider: 'cloudsql' },
        verified: true, billable: true, dataBearing: true, requiresConfirm: true, reason: 'Create reviewed migration candidate',
        metadata: {
          operation: 'dataMigrationDatabaseCopy', migrationId: 'placement-trial',
          sourceEnvironment: f.source.name, targetEnvironment: f.target.name,
          sourceProvider: 'railway', targetProvider: 'cloudsql',
          sourceComponentId: f.sourceDatabase.id, sourceExternalId: f.sourceDatabase.externalId,
          sourceMaintenanceFingerprint: fingerprint, targetMaintenanceFingerprint: fingerprint,
        },
      },
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ region: 'us-west1' });
    expect(result.success).toBe(succeeds);
    const database = ctx.repos.components.findByEnvironmentAndType(f.target.id, 'postgres');
    if (succeeds) {
      expect(database).toMatchObject({ externalId: createdName, bindings: {
        providerScope: { projectId: 'fixture-project', region: 'us-west1' },
        connectionName: `fixture-project:us-west1:${createdName}`,
        dataMigrationPreviousTarget: { provider: 'cloudsql', externalId: oldTarget.externalId, bindings: oldTarget.bindings },
      } });
      expect(acquireDatabaseComponentAccess).toHaveBeenCalledWith(f.project, f.target,
        expect.objectContaining({ externalId: createdName, bindings: expect.objectContaining({
          providerScope: { projectId: 'fixture-project', region: 'us-west1' },
        }) }), 'cloudsql');
    } else {
      expect(database).toEqual(oldTarget);
      expect(transferPostgresDatabase).not.toHaveBeenCalled();
    }
    expect(ctx.repos.components.findByEnvironmentAndType(f.source.id, 'postgres')).toEqual(f.sourceDatabase);
    expect(ctx.repos.components.findByEnvironmentAndType(f.target.id, 'data-migration:placement-trial:postgres')).toBeNull();
  });

  it('clears a previous target when region is omitted and preserves explicit provision-option precedence', async () => {
    const f = fixture();
    const configure = (region?: string) => (adapter as IDatabaseAdapter).configureTarget?.({ region });
    configure('us-west1');
    await adapter.provision('postgres', f.target);
    await adapter.provision('postgres', f.target, { region: 'europe-west1' });
    configure();
    await adapter.provision('postgres', f.target);
    expect(creates.map(request => request.region)).toEqual(['us-west1', 'europe-west1', 'us-central1']);
  });

  it('retains the requested region when a create acknowledgement and exact recovery read are unavailable', async () => {
    const f = fixture();
    adapter.configureTarget({ region: 'us-west1' });
    let attempted = false;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        attempted = true;
        return new Response('temporary failure', { status: 503 });
      }
      return new Response(attempted ? 'forbidden' : 'not found', { status: attempted ? 403 : 404 });
    }));
    const result = await adapter.provision('postgres', f.target, { resourceName: 'uncertain-trial' });
    adapter.configureTarget({});
    expect(result.receipt).toMatchObject({ success: false, data: {
      region: 'us-west1', resourceCreated: 'unknown', cleanupRequired: true,
    } });
    expect(result.component).toMatchObject({ externalId: 'uncertain-trial', bindings: {
      providerScope: { projectId: 'fixture-project', region: 'us-west1' }, cleanupRequired: true,
    } });
  });

  it('keeps the existing database scope authoritative after configuring a different creation region', async () => {
    const f = fixture();
    const database = ctx.repos.components.create({
      environmentId: f.target.id, type: 'postgres', externalId: 'existing-db',
      bindings: { provider: 'cloudsql', providerScope: { projectId: 'fixture-project', region: 'us-central1' },
        connectionString: 'postgresql://fixture@existing-db/app' },
    });
    adapter.configureTarget({ region: 'us-west1' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'existing-db', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-central1',
    })));
    expect(await adapter.getConnectionUrl(database)).toBe('postgresql://fixture@existing-db/app');
    expect(creates).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      name: 'existing-db', state: 'RUNNABLE', databaseVersion: 'POSTGRES_15', region: 'us-west1',
    })));
    await expect(adapter.getConnectionUrl(database)).rejects.toThrow('not bound region us-central1');
  });
});
