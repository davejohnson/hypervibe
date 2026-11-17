import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { createCommandContext } from '../context.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import * as backend from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import * as native from '../../adapters/providers/aws/aws-engine.client.js';
import * as setup from '../../adapters/providers/aws/aws-setup.client.js';
import * as shared from '../engine-shared.js';
import { planAwsInfrastructureEngine, applyAwsInfrastructureEngine } from '../infrastructure-engine-aws.js';

let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance(); directory = mkdtempSync(path.join(tmpdir(), 'hv-db-query-upgrade-'));
  SqliteAdapter.getInstance(path.join(directory, 'db.sqlite')).migrate();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live calls.'); }));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

it.each(['fresh', 'upgrade', 'wrong-native', 'complete'] as const)('plans and records the reviewed application-credential capability: %s', async scenario => {
  const ctx = createCommandContext(); const project = ctx.repos.projects.create({ name: 'db-app', defaultPlatform: 'aws' });
  const env = ctx.repos.environments.create({ projectId: project.id, name: 'testing', platformBindings: { aws: { kind: 'opentofu', sharedDatabase: true, ...(scenario === 'fresh' ? {} : { databaseLoginAt: '2026-01-01T00:00:00Z' }) } } });
  const accountId = '111122223333'; const region = 'us-west-2';
  const querySecretArn = `arn:aws:secretsmanager:${region}:${accountId}:secret:hypervibe/${env.id.toLowerCase()}/database-query-AbCd12`;
  if (scenario === 'complete') ctx.repos.environments.updatePlatformBindings(env.id, { aws: { ...env.platformBindings.aws as object, database: { querySecretArn } } });
  const connection = ctx.repos.connections.create({ provider: 'aws', scope: project.name, credentialsEncrypted: getSecretStore().encryptObject({ accountId, region,
    roleArn: `arn:aws:iam::${accountId}:role/hypervibe/hypervibe-deploy`, accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'private-local-secret-32-characters' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  vi.spyOn(backend, 'awsEngineAuthentication').mockResolvedValue({ env: { AWS_ACCESS_KEY_ID: 'private-key', AWS_SECRET_ACCESS_KEY: 'private-secret', AWS_SESSION_TOKEN: 'private-session' }, redact: [] });
  vi.spyOn(setup, 'awsAccessCurrent').mockResolvedValue('current');
  vi.spyOn(native, 'newestAuroraVersion').mockResolvedValue('17.6'); vi.spyOn(native, 'tlsRequiredByDefault').mockResolvedValue(true);
  const engine = { plan: vi.fn(async ({ configuration }: any) => ({ ok: true, blockers: [], actions: configuration.files['database-access.tf.json'] ? [{
    id: 'database-query:credential', type: scenario === 'complete' ? 'noop' : 'create', verified: true, requiresConfirm: true, reason: 'Create the reviewed query credential resource.',
    resource: { kind: 'secret', name: 'database query access', provider: 'aws' },
  }] : [] })), inspectState: vi.fn(async (request: any) => ({ ok: true, present: true, value: request.project({ values: { root_module: { resources: [{
    address: 'aws_secretsmanager_secret.database_query', mode: 'managed', type: 'aws_secretsmanager_secret', values: {
      arn: querySecretArn, name: `hypervibe/${env.id.toLowerCase()}/database-query`, tags_all: { 'managed-by': 'hypervibe', 'hv-environment': scenario === 'wrong-native' ? 'foreign' : env.id.toLowerCase() },
    },
  }] } } }) })) };
  vi.spyOn(shared, 'openTofuEngine').mockResolvedValue(engine as never);
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { testing: { hosting: { provider: 'aws', engine: 'opentofu' }, services: {}, database: { provider: 'rds' } } } });
  const planned = await planAwsInfrastructureEngine(ctx, { project, spec, specRevision: 1, environmentName: 'testing' });
  if ('blocked' in planned) throw new Error(JSON.stringify(planned));
  const action = planned.actions.find(action => action.id === (scenario === 'fresh' ? 'database-login:postgres' : 'database-login:query'));
  if (scenario === 'complete') { expect(action).toBeUndefined(); return; }
  expect(action).toMatchObject({ dependsOn: ['database-query:credential'], metadata: { appLogin: scenario === 'fresh', queryCredential: true } });
  expect(planned.confirmActions).toContain('database-query:credential');
  expect(planned.confirmActions).toContain(action!.id);
  const login = vi.spyOn(native, 'ensureDatabaseLogin').mockResolvedValue({ success: true, message: 'Stored the app credential.' });
  vi.spyOn(native, 'describeDatabaseCluster').mockResolvedValue({ clusterArn: `arn:aws:rds:${region}:${accountId}:cluster:hv-db-app-shared-postgres`, secretArn: 'private-administrator-reference', endpoint: 'accepted.cluster.us-west-2.rds.amazonaws.com' });
  const run = ctx.repos.runs.findById(planned.planRunId)!;
  vi.spyOn(ConvergeExecutor.prototype, 'loadPlan').mockReturnValue({ run, document: run.plan } as never);
  vi.spyOn(ConvergeExecutor.prototype, 'execute').mockImplementation(async params => {
    const result = await params.handler!(action!, {} as never); return { success: result.success, receipts: [] };
  });
  const applied = await applyAwsInfrastructureEngine(ctx, { project, spec, specRevision: 1, planId: planned.planRunId, confirmActions: planned.confirmActions });
  if (scenario === 'wrong-native') { expect(login).not.toHaveBeenCalled(); expect((ctx.repos.environments.findById(env.id)!.platformBindings.aws as any).database).toBeUndefined(); }
  else {
    expect(login, JSON.stringify(applied)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ appLogin: scenario === 'fresh', queryCredential: { arn: querySecretArn, accountId, environmentId: env.id } }));
    expect((ctx.repos.environments.findById(env.id)!.platformBindings.aws as any).database.querySecretArn).toBe(querySecretArn);
  }
});
