import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnginePlan, translateEnginePlan } from '../plan-mapping.js';
import { buildCloudRunConfiguration } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { buildAwsConfiguration, buildAwsSharedConfiguration } from '../../../providers/aws/tofu/aws-engine.config.js';
import { buildAzureConfiguration } from '../../../providers/azure/tofu/azure-engine.config.js';
import { fullEnvironmentInput, fullSharedInput } from '../../../providers/azure/tofu/__tests__/azure-fixtures.js';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { RunRepository } from '../../../db/repositories/run.repository.js';
import { ConvergeExecutor, type PlanRunDocument } from '../../../../domain/plan/converge.executor.js';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../../../../domain/plan/plan.types.js';

// Synthetic OpenTofu show JSON: expected paths come from pinned primary provider docs,
// not configuration snapshots. See test/provider-contracts/engine-cost-confirmation.md.
const image = `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`;
const gcp = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1',
  database: { instanceName: 'app-db', databaseName: 'app', wireServices: false },
  services: [
    { logicalName: 'web', resourceName: 'web', workload: 'web', initialImage: image, runtimeServiceAccountEmail: 'r@demo-project.iam.gserviceaccount.com', public: true },
    { logicalName: 'worker', resourceName: 'worker', workload: 'worker', initialImage: image, runtimeServiceAccountEmail: 'r@demo-project.iam.gserviceaccount.com', public: false },
    { logicalName: 'nightly', resourceName: 'nightly', workload: 'job', initialImage: image, runtimeServiceAccountEmail: 'r@demo-project.iam.gserviceaccount.com', public: false, schedule: '0 3 * * *', jobCommand: 'node job.js' },
  ] });
const awsBase = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-aws', environmentId: 'env1', parameterPath: '/hypervibe/env1/' };
const aws = buildAwsConfiguration({ ...awsBase,
  services: [{ logicalName: 'web', resourceName: 'web', initialImageUri: image, public: true }, { logicalName: 'api', resourceName: 'api', initialImageUri: image, public: false }],
  workers: [{ logicalName: 'worker', resourceName: 'worker', initialImageUri: image }],
  jobs: [{ logicalName: 'nightly', resourceName: 'nightly', initialImageUri: image, schedule: '0 3 * * *' }],
});
const awsShared = buildAwsSharedConfiguration({ ...awsBase, database: { engineVersion: '18.6', minCapacity: 0, maxCapacity: 2 } });
const azure = buildAzureConfiguration(fullEnvironmentInput);
const azureShared = buildAzureConfiguration(fullSharedInput);
const backupOptIn = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [],
  database: { instanceName: 'app-db', databaseName: 'app', wireServices: false, automatedBackups: true } });
const segment = { id: 'opentofu:cost-plan', engine: 'opentofu' as const, planDigest: 'p', configurationDigest: 'c', engineVersion: '1.13.9', providerVersions: {} };

interface CostCase { name: string; provider: string; config: EngineConfiguration; address: string; before: unknown; after: unknown; unknown?: unknown }
const enableBackups: CostCase = { name: 'Cloud SQL automated backups', provider: 'gcp', config: backupOptIn, address: 'google_sql_database_instance.db',
  before: { settings: [{ backup_configuration: [{ enabled: false }] }] }, after: { settings: [{ backup_configuration: [{ enabled: true }] }] } };
const cloudRun = (cpu = '1', memory = '512Mi', idle = true, min = 0, max = 3, extra = {}) => ({ template: [{ scaling: [{ min_instance_count: min, max_instance_count: max }], containers: [{ image, resources: [{ limits: { cpu, memory }, cpu_idle: idle }], ...extra }] }] });
const containerApp = (cpu = 0.25, memory = '0.5Gi', min = 0, max = 2, extra = {}) => ({ template: [{ min_replicas: min, max_replicas: max, container: [{ name: 'app', image, cpu, memory, ...extra }] }] });
const cases: CostCase[] = [
  { name: 'Cloud SQL tier', provider: 'gcp', config: gcp, address: 'google_sql_database_instance.db', before: { settings: [{ tier: 'db-f1-micro' }] }, after: { settings: [{ tier: 'db-custom-2-7680' }] } },
  { name: 'Cloud SQL disk', provider: 'gcp', config: gcp, address: 'google_sql_database_instance.db', before: { settings: [{ disk_size: 10 }] }, after: { settings: [{ disk_size: 20 }] } },
  { name: 'Cloud Run CPU', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_service.web', before: cloudRun(), after: cloudRun('2') },
  { name: 'Cloud Run memory', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_service.web', before: cloudRun(), after: cloudRun('1', '1Gi') },
  { name: 'Cloud Run continuous CPU', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_service.web', before: cloudRun(), after: cloudRun('1', '512Mi', false) },
  { name: 'Cloud Run instance floor', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_service.web', before: cloudRun(), after: cloudRun('1', '512Mi', true, 1) },
  { name: 'Cloud Run instance limit', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_service.web', before: cloudRun(), after: cloudRun('1', '512Mi', true, 0, 5) },
  { name: 'Cloud Run worker count', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_worker_pool.worker', before: { scaling: [{ manual_instance_count: 0 }] }, after: { scaling: [{ manual_instance_count: 1 }] } },
  { name: 'Cloud Run worker CPU', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_worker_pool.worker', before: cloudRun(), after: cloudRun('2') },
  { name: 'Cloud Run job memory', provider: 'gcp', config: gcp, address: 'google_cloud_run_v2_job.nightly', before: { template: [cloudRun()] }, after: { template: [cloudRun('1', '1Gi')] } },
  { name: 'Aurora capacity floor', provider: 'aws', config: awsShared, address: 'aws_rds_cluster.postgres', before: { serverlessv2_scaling_configuration: [{ min_capacity: 0, max_capacity: 2 }] }, after: { serverlessv2_scaling_configuration: [{ min_capacity: 0.5, max_capacity: 2 }] } },
  { name: 'Aurora capacity limit', provider: 'aws', config: awsShared, address: 'aws_rds_cluster.postgres', before: { serverlessv2_scaling_configuration: [{ min_capacity: 0, max_capacity: 2 }] }, after: { serverlessv2_scaling_configuration: [{ min_capacity: 0, max_capacity: 4 }] } },
  { name: 'ECS Express CPU', provider: 'aws', config: aws, address: 'aws_ecs_express_gateway_service.web', before: { cpu: '256', memory: '1024' }, after: { cpu: '512', memory: '1024' } },
  { name: 'ECS Express memory', provider: 'aws', config: aws, address: 'aws_ecs_express_gateway_service.web', before: { cpu: '256', memory: '1024' }, after: { cpu: '256', memory: '2048' } },
  { name: 'ECS Express task limit', provider: 'aws', config: aws, address: 'aws_ecs_express_gateway_service.web', before: { scaling_target: [{ min_task_count: 1, max_task_count: 3 }] }, after: { scaling_target: [{ min_task_count: 1, max_task_count: 5 }] } },
  { name: 'ECS worker floor', provider: 'aws', config: aws, address: 'aws_ecs_service.worker', before: { desired_count: 0 }, after: { desired_count: 1 } },
  ...['api', 'worker', 'nightly'].map(name => ({ name: `ECS ${name} memory`, provider: 'aws', config: aws, address: `aws_ecs_task_definition.${name}`, before: { cpu: '256', memory: '512' }, after: { cpu: '256', memory: '1024' } })),
  { name: 'Azure database SKU', provider: 'azure', config: azureShared, address: 'azurerm_postgresql_flexible_server.postgres', before: { sku_name: 'B_Standard_B1ms' }, after: { sku_name: 'B_Standard_B2s' } },
  { name: 'Azure database storage', provider: 'azure', config: azureShared, address: 'azurerm_postgresql_flexible_server.postgres', before: { storage_mb: 32768 }, after: { storage_mb: 65536 } },
  { name: 'Container App CPU', provider: 'azure', config: azure, address: 'azurerm_container_app.web', before: containerApp(), after: containerApp(0.5) },
  { name: 'Container App memory', provider: 'azure', config: azure, address: 'azurerm_container_app.web', before: containerApp(), after: containerApp(0.25, '1Gi') },
  { name: 'Container App worker floor', provider: 'azure', config: azure, address: 'azurerm_container_app.worker', before: containerApp(), after: containerApp(0.25, '0.5Gi', 1) },
  { name: 'Container App replica limit', provider: 'azure', config: azure, address: 'azurerm_container_app.web', before: containerApp(), after: containerApp(0.25, '0.5Gi', 0, 4) },
  { name: 'Container App job CPU', provider: 'azure', config: azure, address: 'azurerm_container_app_job.nightly', before: containerApp(), after: containerApp(0.5) },
];

function actionsFor(entry: CostCase, actions = ['update']): PlanAction[] {
  const parsed = parseEnginePlan(JSON.stringify({ resource_changes: [{ address: entry.address, type: entry.address.split('.')[0], mode: 'managed',
    change: { actions, before: entry.before, after: entry.after, after_unknown: entry.unknown } }] }));
  const result = translateEnginePlan({ provider: entry.provider, configuration: entry.config, segment, parsed });
  expect(result.blockers).toEqual([]);
  return result.actions;
}

describe('billable in-place changes across providers', () => {
  it.each([...cases, enableBackups])('$name needs exact confirmation', entry => {
    expect(actionsFor(entry)).toEqual([expect.objectContaining({ type: 'update', billable: true, requiresConfirm: true })]);
  });

  it.each([
    { before: { settings: [{ tier: 'db-f1-micro' }] }, after: { settings: [{}] }, unknown: { settings: [{ tier: true }] } },
    { before: { settings: [{ tier: 'db-f1-micro' }] }, after: {}, unknown: { settings: true } },
    { before: {}, after: {}, unknown: { settings: [{ tier: true }] } },
    { before: {}, after: {}, unknown: true },
  ])('keeps unknown cost leaves and ancestors confirmation-gated: %j', change => {
    expect(actionsFor({ ...cases[0]!, ...change })[0]).toMatchObject({ billable: true, requiresConfirm: true });
  });

  it.each([
    { ...cases[0]!, before: { settings: [{ tier: 'db-f1-micro', backup_configuration: [{ start_time: '03:00' }] }] }, after: { settings: [{ tier: 'db-f1-micro', backup_configuration: [{ start_time: '04:00' }] }] } },
    { ...cases[2]!, before: cloudRun(), after: cloudRun('1', '512Mi', true, 0, 3, { image: 'new-image', env: [{ name: 'DEBUG', value: 'false' }] }) },
    { ...cases[2]!, before: cloudRun(), after: cloudRun(), unknown: { template: [{ containers: [{ image: true }] }] } },
    { ...cases[10]!, before: { serverlessv2_scaling_configuration: [{ min_capacity: 0, max_capacity: 2 }], tags: { team: 'one' } }, after: { serverlessv2_scaling_configuration: [{ max_capacity: 2, min_capacity: 0 }], tags: { team: 'two' } } },
    { ...cases[12]!, before: { cpu: '256', primary_container: [{ image: 'old' }] }, after: { cpu: '256', primary_container: [{ image: 'new' }] } },
    { ...cases[16]!, before: { cpu: '256', memory: '512', container_definitions: '[{"image":"old"}]' }, after: { cpu: '256', memory: '512', container_definitions: '[{"image":"new"}]' } },
    { ...cases[19]!, before: { sku_name: 'B_Standard_B1ms', tags: { team: 'one' } }, after: { sku_name: 'B_Standard_B1ms', tags: { team: 'two' } } },
    { ...cases[21]!, before: containerApp(), after: containerApp(0.25, '0.5Gi', 0, 2, { image: 'new-image', env: [{ name: 'DEBUG', value: 'false' }] }) },
  ])('does not bill unrelated image/config changes for $name', entry => {
    const [action] = actionsFor(entry);
    expect(action).not.toHaveProperty('billable');
    expect(action).not.toHaveProperty('requiresConfirm');
  });

  it('checks every container and does not publish raw values', () => {
    const before = { template: [{ containers: [{ resources: [{ limits: { cpu: '1' } }] }, { resources: [{ limits: { cpu: '1' } }], env: [{ value: 'do-not-publish' }] }] }] };
    const after = structuredClone(before);
    after.template[0]!.containers[1]!.resources[0]!.limits.cpu = '2';
    const actions = actionsFor({ ...cases[2]!, before, after });
    expect(actions[0]).toMatchObject({ requiresConfirm: true, billable: true });
    expect(JSON.stringify(actions)).not.toContain('do-not-publish');
  });
});

describe('persisted plan apply confirmation boundary', () => {
  let directory: string;
  let projectId: string;
  let environmentId: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-cost-confirmation-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    projectId = new ProjectRepository().create({ name: 'cost-confirmation' }).id;
    environmentId = new EnvironmentRepository().create({ projectId, name: 'staging' }).id;
  });
  afterEach(() => { SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  const store = (actions: PlanAction[]) => {
    const document = { kind: 'hv_plan', scope: 'infrastructure-engine', engine: { planId: 'cost-plan' }, environmentName: 'staging', specRevision: 1, observedFingerprint: null, actions } as PlanRunDocument;
    return new RunRepository().create({ projectId, environmentId, type: 'plan', plan: document as unknown as Record<string, unknown> }).id;
  };

  it.each([cases[0]!, cases[2]!, cases[10]!, cases[12]!, cases[19]!, cases[21]!, enableBackups])('rejects missing/wrong approval and executes exactly approved $name', async entry => {
    const actions = actionsFor(entry);
    const planRunId = store(actions);
    const segmentHandler = vi.fn(async () => ({ outcomes: { [entry.address]: 'succeeded' as const }, diagnostics: [] }));
    const handler = vi.fn();
    const executor = new ConvergeExecutor();
    for (const confirmActions of [[], ['unrelated:action']]) {
      const result = await executor.execute({ planRunId, currentSpecRevision: 1, confirmActions, handler, segmentHandler });
      expect(result.receipts[0]?.status).toBe('skipped_requires_confirm');
      expect(segmentHandler).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
    const approved = await executor.execute({ planRunId, currentSpecRevision: 1, confirmActions: [actions[0]!.id], handler, segmentHandler });
    expect(approved.success).toBe(true);
    expect(segmentHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps a cost-mapped noop free of confirmation and mutations', async () => {
    const actions = actionsFor({ ...cases[0]!, after: cases[0]!.before }, ['no-op']);
    expect(actions[0]).toMatchObject({ type: 'noop' });
    expect(actions[0]).not.toHaveProperty('requiresConfirm');
    expect(actions[0]).not.toHaveProperty('metadata');
    const handler = vi.fn(); const segmentHandler = vi.fn();
    const result = await new ConvergeExecutor().execute({ planRunId: store(actions), currentSpecRevision: 1, handler, segmentHandler });
    expect(result.success).toBe(true);
    expect(handler).not.toHaveBeenCalled(); expect(segmentHandler).not.toHaveBeenCalled();
  });
});
