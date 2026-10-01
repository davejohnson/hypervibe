import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RDSClient, CreateDBSnapshotCommand, DescribeDBSnapshotsCommand } from '@aws-sdk/client-rds';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, initializeDatabase } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { applyDatabaseCheckpoint } from '../apply-database-checkpoint.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { databaseCheckpointIdentitySchema, databaseCheckpointBindings } from '../../domain/services/database-checkpoint.js';
import { planDatabaseResilience } from '../../domain/services/database-resilience-plan.service.js';

const source = { provider: 'rds', primaryExternalId: 'postgres-primary',
  providerScope: { accountId: '123456789012', region: 'us-east-1' }, resourceIdentity: {} };
const legacy = { source: { primaryExternalId: 'postgres', providerScope: { projectId: 'p', environmentId: 'prod' },
  volumeId: 'volume', volumeInstanceId: 'instance' }, label: 'hv-before-release', beforeBackupIds: [],
  beforeBackupExternalIds: [], requestStartedAt: '2026-09-30T06:00:00Z', state: 'running', workflowId: 'workflow' };

describe('provider-neutral checkpoint source and durable request contract', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), 'hv-shared-checkpoint-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'test.db')); });
  afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

  it('accepts a database instance identity without Railway volumes', () => {
    expect(databaseCheckpointIdentitySchema.safeParse(source).success).toBe(true);
  });
  it('normalizes only the exact retained Railway legacy source and acknowledgement', () => {
    const binding = databaseCheckpointBindings({}, { databaseCheckpoints: { release: legacy } }).release;
    expect(binding).toMatchObject({ source: { provider: 'railway', resourceIdentity: {
      volumeId: 'volume', volumeInstanceId: 'instance' } }, operationId: 'workflow', acknowledged: true });
  });
  it('rejects arbitrary credentials in an otherwise valid source', () => {
    expect(databaseCheckpointIdentitySchema.safeParse({ ...source, providerScope: { ...source.providerScope, password: 'private' } }).success).toBe(false);
    expect(databaseCheckpointIdentitySchema.safeParse({ ...source, resourceIdentity: { accessToken: 'private' } }).success).toBe(false);
  });

  it.each(['postgresql://user:private@database/app', 'id\nsecret', 'id\tsecret'])('rejects unsafe identity values before they can bypass export redaction: %s', value => {
    for (const malformed of [
      { ...source, primaryExternalId: value },
      { ...source, providerScope: { ...source.providerScope, accountId: value } },
      { ...source, resourceIdentity: { instanceId: value } },
    ]) expect(databaseCheckpointIdentitySchema.safeParse(malformed).success).toBe(false);
  });

  it('refuses a legacy Railway source replayed as a different provider before observation or creation', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'foreign-replay', defaultPlatform: 'ecs' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {} });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'postgres', bindings: { provider: 'rds' } });
    const spec = environmentSpecSchema.parse({ hosting: { provider: 'ecs' }, services: {}, database: { provider: 'rds', resilience: { checkpoint: { id: 'release' } } } });
    const adapter = { observeCheckpointSource: vi.fn(), observeCheckpointRequest: vi.fn(), createCheckpoint: vi.fn() };
    const action = { id: 'database:rds:checkpoint:release', type: 'create', verified: true, billable: true, dataBearing: true, requiresConfirm: true,
      resource: { kind: 'database', provider: 'rds', name: 'postgres' }, metadata: { checkpointId: 'release', source: legacy.source } };
    expect(await applyDatabaseCheckpoint({ ctx, environment, component, environmentSpec: spec, adapter, action: action as never,
      confirmedActionIds: new Set([action.id]) })).toMatchObject({ success: false, status: 'blocked' });
    expect(adapter.observeCheckpointSource).not.toHaveBeenCalled();
    expect(adapter.createCheckpoint).not.toHaveBeenCalled();
  });

  /** Reconstructed response using AWS's documented CreateDBSnapshot/DescribeDBSnapshots
   * contract: a snapshot resource with Status, not a Railway workflow or volume.
   * https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_CreateDBSnapshot.html
   * The real SDK serializes/parses transport; this test adapter is deliberately NOT
   * registered as implemented RDS checkpoint support or evidence of live recovery.
   */
  it('completes and resumes a resource-polled acknowledgement with no workflow id through real SDK transport', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'shared-checkpoint', defaultPlatform: 'ecs' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {} });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: source.primaryExternalId,
      bindings: { provider: 'rds', providerScope: source.providerScope } });
    const spec = environmentSpecSchema.parse({ hosting: { provider: 'ecs' }, services: {}, database: { provider: 'rds', resilience: { checkpoint: { id: 'release' } } } });
    let creates = 0; let label = ''; let pending = true; const serializedActions: string[] = [];
    const createdAt = new Date().toISOString();
    const point = () => ({ id: label, name: label, createdAt, expiresAt: null });
    const client = new RDSClient({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1,
      requestHandler: { handle: async (request: { body?: unknown }) => {
        const body = new URLSearchParams(String(request.body)); const action = body.get('Action')!; serializedActions.push(action);
        if (action === 'CreateDBSnapshot') {
          creates++; label = body.get('DBSnapshotIdentifier')!;
          const retained = ctx.repos.components.findById(component.id)!.bindings.resilience as any;
          expect(retained.checkpoints.release.state).toBe('attempting');
        }
        const snapshot = `<DBSnapshotIdentifier>${label}</DBSnapshotIdentifier><DBInstanceIdentifier>postgres-primary</DBInstanceIdentifier><Status>${pending ? 'creating' : 'available'}</Status><SnapshotCreateTime>${createdAt}</SnapshotCreateTime>`;
        const contents = action === 'CreateDBSnapshot' ? `<DBSnapshot>${snapshot}</DBSnapshot>` : `<DBSnapshots><DBSnapshot>${snapshot}</DBSnapshot></DBSnapshots>`;
        return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(`<${action}Response xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><${action}Result>${contents}</${action}Result></${action}Response>`) } };
      } } as never });
    const adapter = {
      observeCheckpointSource: async () => ({ ...source, backups: label ? [point()] : [] }),
      createCheckpoint: async (_source: unknown, requestedLabel: string) => {
        const response = await client.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: source.primaryExternalId, DBSnapshotIdentifier: requestedLabel }));
        return { acknowledged: response.DBSnapshot?.DBSnapshotIdentifier === requestedLabel };
      },
      observeCheckpointRequest: async (_environment: unknown, _component: unknown, binding: any) => {
        const response = await client.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: binding.label }));
        const exact = response.DBSnapshots?.filter(value => value.DBSnapshotIdentifier === binding.label && value.DBInstanceIdentifier === source.primaryExternalId);
        if (exact?.length !== 1) return { state: 'unknown' };
        if (exact[0]!.Status !== 'available') return { state: 'pending' };
        return { state: 'complete', source, backup: point() };
      },
    };
    const plan = async () => planDatabaseResilience({ environmentSpec: spec, capabilities: { checkpoints: true },
      local: { components: [ctx.repos.components.findById(component.id)!], services: [], bindings: ctx.repos.environments.findById(environment.id)!.platformBindings } as never,
      observed: { databases: [{ provider: 'rds', externalId: source.primaryExternalId, resilience: { checkpointSource: await adapter.observeCheckpointSource() } }], completeness: { databases: 'complete' } } as never,
    }).actions[0]!;
    const apply = async () => { const action = await plan(); return applyDatabaseCheckpoint({ ctx, environment: ctx.repos.environments.findById(environment.id)!,
      component: ctx.repos.components.findById(component.id)!, environmentSpec: spec, action, adapter,
      confirmedActionIds: new Set([action.id]) }); };
    expect(await apply()).toMatchObject({ success: false, status: 'pending', data: { applied: null } });
    pending = false;
    expect(await apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1, restoreVerified: false } });
    expect(await apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(creates).toBe(1);
    expect(serializedActions.filter(action => action === 'CreateDBSnapshot')).toHaveLength(1);
    client.destroy();
  });
});
