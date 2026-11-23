import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { buildCloudRunConfiguration, planWithCloudRunRevisionMinimums } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { buildEngineInput, gcpStorageSettings } from '../infrastructure-engine.js';
import { describeStorageAutoTieringChanges } from '../engine-shared.js';
import { buildAwsEngineInput } from '../infrastructure-engine-aws.js';
import { buildAwsConfiguration } from '../../adapters/providers/aws/tofu/aws-engine.config.js';
import { parseEnginePlan, translateEnginePlan } from '../../adapters/engine/opentofu/plan-mapping.js';
import { ciReleaseTargets, estimateAwsMonthlyCost, estimateMonthlyCost } from '../launch.js';
import { startCommandFields } from '../../adapters/providers/gcp/gcp-cloud-run.client.js';
import { RELEASE_SCRIPT } from '../../adapters/providers/gcp/gcp-ci-release-script.js';
import { databaseRemovalBlocker, gcpDatabaseShape } from '../gcp-database-shape.js';

// Contract (docs/development/support-matrix.md): settings an app needs to run for real
// on Google Cloud reach the engine configuration; a cloud that cannot build one says so.
function specFor(provider: 'cloudrun' | 'aws' | 'azure') {
  const storageProvider = provider === 'cloudrun' ? 'gcs' : provider === 'aws' ? 's3' : 'azureblob';
  return projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
    hosting: { provider },
    services: {
      web: { alwaysOn: true, startCommand: 'sh scripts/start.sh', cpu: '2', memory: '2Gi' },
      worker: { workloadKind: 'worker', startCommand: 'python scripts/worker.py' },
      plain: {},
    },
    database: { provider: provider === 'cloudrun' ? 'cloudsql' : provider === 'aws' ? 'rds' : 'azure-postgres', size: 'medium', deletionProtection: true },
    storage: { media: { provider: storageProvider, type: 'bucket', region: 'us-west1', injectInto: ['web', 'worker'], versioning: true, browserUploads: true },
      scratch: { provider: storageProvider, type: 'bucket', region: 'us-west1', injectInto: [] } },
  } } });
}

function engineInput(spec = specFor('cloudrun')) {
  return buildEngineInput(spec, 'staging', {
    gcpProjectId: 'demo-project', region: 'us-west1', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    resourceNameFor: (service) => `${service}-staging`,
  });
}

function configuration() {
  const spec = specFor('cloudrun');
  return buildCloudRunConfiguration({ ...engineInput(spec), runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    storage: Object.entries(spec.environments.staging!.storage ?? {}).map(([name, storage]) => ({
      name, bucketName: `demo-${name}`, location: storage.region, injectInto: storage.injectInto,
      ...(storage.versioning ? { versioning: true } : {}), ...(storage.browserUploads ? { browserUploads: true } : {}),
    })) });
}

describe('fixed-size Fargate workers', () => {
  it.each([[true, 0], [false, 1], [undefined, 1]] as const)('plans and prices workerPaused=%s', (workerPaused, count) => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider: 'aws' }, services: { api: { public: false }, worker: { workloadKind: 'worker', workerPaused } },
    } } });
    const context = { prefix: 'hv-studio', parameterPath: '/hypervibe/s1/', environment: { id: 's1', platformBindings: {} },
      connection: { accountId: '111122223333', region: 'us-west-2' } };
    const configuration = buildAwsConfiguration(buildAwsEngineInput(spec, 'staging', context as never, { secretKeys: [], image: 'registry/app:test' }));
    const resources = (configuration.files['tasks.tf.json'] as any).resource;
    expect(resources.aws_ecs_service.worker).toMatchObject({ name: 'hv-studio-worker', desired_count: count });
    expect(resources.aws_ecs_service.worker.lifecycle?.[0]?.ignore_changes ?? []).not.toContain('desired_count');
    expect(resources.aws_ecs_service.api.desired_count).toBe(1);
    expect(resources.aws_sfn_state_machine).toBeUndefined();
    expect(resources.aws_scheduler_schedule).toBeUndefined();
    const estimate = estimateAwsMonthlyCost(spec.environments.staging!).find(line => line.item.includes('worker ('));
    expect(estimate?.item).toContain(workerPaused ? 'paused' : 'always on');
    if (workerPaused) expect(estimate?.estimate).toContain('$0');
    const review = translateEnginePlan({ provider: 'aws', configuration,
      segment: { id: 'test', engine: 'opentofu', planDigest: 'p', configurationDigest: 'c', engineVersion: '1', providerVersions: {} },
      parsed: parseEnginePlan(JSON.stringify({ resource_changes: [{ address: 'aws_ecs_service.worker', type: 'aws_ecs_service', mode: 'managed',
        change: { actions: ['update'], before: { desired_count: 1 - count }, after: { desired_count: count } } }] })) });
    expect(review).toMatchObject({ blockers: [], actions: [{ id: 'service:worker', type: 'update', requiresConfirm: true,
      diff: [{ field: 'aws_ecs_service.desired_count' }] }] });
  });
});

describe('production settings on Google Cloud', () => {
  const files = configuration().files as Record<string, any>;
  const services = files['cloudrun.tf.json'].resource.google_cloud_run_v2_service;
  const buckets = files['storage.tf.json'].resource.google_storage_bucket;

  it.each([[true, 0], [false, 1], [undefined, 1]] as const)('plans the fixed worker count with workerPaused=%s', (workerPaused, count) => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider: 'cloudrun' }, services: { web: {}, worker: { workloadKind: 'worker', workerPaused } },
    } } });
    const input = engineInput(spec);
    const estimate = estimateMonthlyCost(spec.environments.staging!).find(line => line.item.startsWith('Worker worker'));
    expect(estimate?.item).toContain(workerPaused ? 'paused' : 'always on');
    if (workerPaused) expect(estimate?.estimate).toContain('$0');
    const files = buildCloudRunConfiguration({ ...input, runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com' }).files as Record<string, any>;
    const resources = files['workerpools.tf.json'].resource;
    const pool = resources.google_cloud_run_v2_worker_pool.worker;
    expect(pool.name).toBe('worker-staging');
    expect(pool.scaling).toEqual([{ scaling_mode: 'MANUAL', manual_instance_count: count }]);
    expect(pool.lifecycle[0].ignore_changes).not.toContain('scaling[0].manual_instance_count');
    expect(resources.google_cloud_scheduler_job).toBeUndefined();
    expect(files['cloudrun.tf.json'].resource.google_cloud_run_v2_service.web).toBeDefined();
  });

  it.each([
    ['cloudrun', { workloadKind: 'web' }],
    ['cloudrun', { workloadKind: 'worker', onDemand: { pendingWorkQuery: 'SELECT 1' } }],
    ['aws', { workloadKind: 'worker', onDemand: { pendingWorkQuery: 'SELECT 1' } }], ['aws', { workloadKind: 'web' }],
    ['aws', { workloadKind: 'cron', cronSchedule: '0 1 * * *' }],
    ['railway', { workloadKind: 'worker' }], ['azure', { workloadKind: 'worker' }],
  ])('rejects workerPaused when %s cannot hold that workload at zero', (provider, service) => {
    const result = projectSpecSchema.safeParse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider }, services: { worker: { ...service as object, workerPaused: true } },
    } } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.path.at(-1))).toContain('workerPaused');
  });

  it('keeps an always-on web service running with its CPU available, and leaves others to scale to zero', () => {
    expect(services.web.template[0].scaling[0].min_instance_count).toBe(1);
    expect(services.web.template[0].containers[0].resources[0]).toEqual({ limits: { cpu: '2', memory: '2Gi' }, cpu_idle: false });
    // Cloud Run reports no revision scaling block for the default zero minimum.
    expect(services.plain.template[0]).not.toHaveProperty('scaling');
    expect(services.plain.template[0].containers[0].resources[0].cpu_idle).toBe(true);
  });

  it('rejects the second candidate when another rollout clears the floor during planning', async () => {
    const { services } = engineInput();
    const accepted: boolean[] = [];
    const result = await planWithCloudRunRevisionMinimums(services, async verify => {
      const scaling = accepted.length === 0 ? [{ min_instance_count: 2 }] : [];
      const matches = verify({ resource_changes: [{ address: 'google_cloud_run_v2_service.plain',
        change: { actions: ['update'], before: { template: [{ scaling }] } } }] });
      accepted.push(matches);
      return matches;
    });
    expect(accepted).toEqual([false, false]);
    expect(result).toBe(false);
  });

  it('requires a readable prior minimum or an explicit create before accepting a candidate', async () => {
    const { services } = engineInput();
    const candidate = (actions: string[], before: unknown) => planWithCloudRunRevisionMinimums(services,
      async verify => verify({ resource_changes: [{ address: 'google_cloud_run_v2_service.plain', change: { actions, before } }] }));
    await expect(candidate(['create'], null)).resolves.toBe(true);
    await expect(candidate(['update'], null)).rejects.toThrow('Missing prior');
    await expect(candidate(['update'], { template: [{ scaling: [{ min_instance_count: 'unknown' }] }] })).rejects.toThrow('Invalid prior');
  });

  // A service is created with a placeholder image that cannot run the app's command, so the
  // command is never part of creation: it arrives with the app's image at release.
  it('creates services and workers without the start command and leaves it to the release', () => {
    const worker = files['workerpools.tf.json'].resource.google_cloud_run_v2_worker_pool.worker;
    for (const workload of [services.web, services.plain, worker]) {
      expect(workload.template[0].containers[0]).not.toHaveProperty('command');
      expect(workload.template[0].containers[0]).not.toHaveProperty('args');
      expect(workload.lifecycle[0].ignore_changes).toEqual(expect.arrayContaining(
        ['template[0].containers[0].image', 'template[0].containers[0].command', 'template[0].containers[0].args']));
    }
  });

  it('releases a declared start command with the image, and the image default otherwise', () => {
    expect(startCommandFields('python scripts/worker.py')).toEqual({ command: ['/bin/sh'], args: ['-lc', 'python scripts/worker.py'] });
    expect(startCommandFields(undefined)).toEqual({});
    const spec = specFor('cloudrun');
    const targets = ciReleaseTargets(spec.environments.staging!, { web: { serviceId: 'web-staging' }, worker: { workerPoolName: 'worker-staging' }, plain: { serviceId: 'plain-staging' } },
      { region: 'us-west1', gcpProjectId: 'demo-project', environmentName: 'staging' });
    expect(targets.map((target) => [target.name, target.startCommand])).toEqual([['web', 'sh scripts/start.sh'], ['worker', 'python scripts/worker.py'], ['plain', undefined]]);
    // The workflow script applies it: '-' keeps the current command, base64 text replaces it.
    expect(RELEASE_SCRIPT).toContain("startCommand !== '-'");
    expect(RELEASE_SCRIPT).toContain("containers[0].args = ['-lc', command]");
  });

  // #548: Cloud Run must not re-run a one-off migration by itself; a scheduled job keeps its single retry.
  it('never lets Cloud Run retry the release command on its own', () => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider: 'cloudrun' }, migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
      services: { web: {}, nightly: { workloadKind: 'cron', cronSchedule: '0 3 * * *', startCommand: 'npm run nightly' } },
    } } });
    const input = engineInput(spec);
    const jobs = (buildCloudRunConfiguration({ ...input, runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com' }).files as Record<string, any>)['jobs.tf.json'].resource.google_cloud_run_v2_job;
    expect(jobs.release_command.template[0].template[0].max_retries).toBe(0);
    expect(jobs.nightly.template[0].template[0].max_retries).toBe(1);
  });

  it('keeps replaced and deleted files for 30 days only in a versioned bucket', () => {
    expect(buckets.storage_media.versioning).toEqual([{ enabled: true }]);
    expect(buckets.storage_media.lifecycle_rule).toEqual([{ action: [{ type: 'Delete' }], condition: [{ days_since_noncurrent_time: 30, with_state: 'ARCHIVED' }] }]);
    expect(buckets.storage_scratch).not.toHaveProperty('versioning');
    expect(buckets.storage_scratch).not.toHaveProperty('lifecycle_rule');
  });

  it('lets browsers upload to a bucket that asked for it, while every bucket stays private', () => {
    expect(buckets.storage_media.cors[0].method).toEqual(expect.arrayContaining(['PUT', 'POST']));
    expect(buckets.storage_media.cors[0].response_header).toEqual(expect.arrayContaining(['Location', 'Content-Range']));
    expect(buckets.storage_scratch).not.toHaveProperty('cors');
    for (const bucket of Object.values<any>(buckets)) {
      expect(bucket).toMatchObject({ public_access_prevention: 'enforced', uniform_bucket_level_access: true, force_destroy: false });
    }
  });

  it('accepts storage protection and browser upload intent on all three clouds', () => {
    expect(engineEnvironmentProblems(specFor('cloudrun'), 'staging')).toEqual([]);
    for (const [provider, cloud] of [['aws', 'AWS'], ['azure', 'Azure']] as const) {
      expect(engineEnvironmentProblems(specFor(provider), 'staging')).toEqual([
        `Service web: alwaysOn is not yet supported on ${cloud}.`,
        `database.size is not yet supported on ${cloud}.`,
        `database.deletionProtection is not yet supported on ${cloud}.`,
      ]);
    }
  });

  it('gives production and staging a dedicated, protected database and everything else the cheapest one', () => {
    const database = { provider: 'cloudsql', engine: 'postgres' } as const;
    expect(gcpDatabaseShape('production', database)).toMatchObject({ tier: 'db-custom-1-3840', deletionProtection: true, retainedBackups: 14, transactionLogDays: 7 });
    expect(gcpDatabaseShape('staging', database).tier).toBe('db-custom-1-3840');
    expect(gcpDatabaseShape('preview-42', database)).toMatchObject({ tier: 'db-f1-micro', deletionProtection: false, retainedBackups: 7 });
    expect(gcpDatabaseShape('preview-42', { ...database, size: 'large', deletionProtection: true })).toMatchObject({ tier: 'db-custom-4-15360', deletionProtection: true });
    expect(gcpDatabaseShape('production', { ...database, deletionProtection: false }).deletionProtection).toBe(false);
  });

  it('states size, monthly cost, backups and protection in one plan sentence', () => {
    expect(gcpDatabaseShape('production', { provider: 'cloudsql', engine: 'postgres' }).summary).toBe(
      'Database: 1 vCPU, 3.75 GB, about US$50 a month plus storage. New databases start with 14 daily backups and 7 days of point-in-time recovery; existing backup and recovery settings are preserved. Deletion protection is on.');
  });

  it('protects the instance in the engine and on Google, and keeps the declared backups', () => {
    const shape = gcpDatabaseShape('production', { provider: 'cloudsql', engine: 'postgres' });
    const sql = (buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-west1', services: [], database: {
      instanceName: 'hv-production-db-a1', databaseName: 'app', wireServices: false, tier: shape.tier,
      deletionProtection: shape.deletionProtection, retainedBackups: shape.retainedBackups, transactionLogDays: shape.transactionLogDays,
    } }).files['cloudsql.tf.json'] as any).resource.google_sql_database_instance.db;
    expect(sql.deletion_protection).toBe(true);
    expect(sql.settings[0]).toMatchObject({ tier: 'db-custom-1-3840', deletion_protection_enabled: true });
    expect(sql.settings[0].backup_configuration).toEqual([{ enabled: true, point_in_time_recovery_enabled: true,
      transaction_log_retention_days: 7, backup_retention_settings: [{ retained_backups: 14, retention_unit: 'COUNT' }] }]);
  });

  it('plans the deletion of a database only when Google confirms it is unprotected or gone', async () => {
    const answer = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });
    expect(await databaseRemovalBlocker('db-a1', answer(200, { settings: { deletionProtectionEnabled: true } }))).toMatch(/deletion protection on.*"deletionProtection": false/);
    expect(await databaseRemovalBlocker('db-a1', answer(200, { settings: { deletionProtectionEnabled: false } }))).toBeUndefined();
    expect(await databaseRemovalBlocker('db-a1', answer(404))).toBeUndefined();
    // An unreadable instance is unknown, never permission to delete.
    expect(await databaseRemovalBlocker('db-a1', answer(503))).toBe('Cloud SQL returned HTTP 503 while checking deletion protection on db-a1.');
  });

  it('rejects alwaysOn on anything but a web service', () => {
    expect(() => projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
      hosting: { provider: 'cloudrun' }, services: { worker: { workloadKind: 'worker', alwaysOn: true } } } } })).toThrow(/alwaysOn applies only to web services/);
  });
});

// Contract: hashicorp/google 8.9.0 google_storage_bucket.autoclass (updated in place, never ForceNew) and
// https://docs.cloud.google.com/storage/docs/autoclass (allowed with Delete lifecycle rules; the bucket's default class stays Standard).
describe('storage auto-tiering', () => {
  const runtime = 'runtime@demo-project.iam.gserviceaccount.com';
  const gcpSpec = (media: Record<string, unknown>) => projectSpecSchema.parse({ version: 1, project: 'studio', environments: { staging: {
    hosting: { provider: 'cloudrun' }, services: { web: {} },
    storage: { media: { provider: 'gcs', type: 'bucket', region: 'us-west1', injectInto: ['web'], ...media } },
  } } });
  const gcpConfiguration = (media: Record<string, unknown>) => {
    const spec = gcpSpec(media);
    return buildCloudRunConfiguration({ ...engineInput(spec), runtimeServiceAccountEmail: runtime,
      storage: Object.entries(spec.environments.staging!.storage ?? {}).map(([name, storage]) => ({
        name, bucketName: `demo-${name}`, location: storage.region, injectInto: storage.injectInto, ...gcpStorageSettings(storage) })) });
  };
  const bucket = (media: Record<string, unknown>) => (gcpConfiguration(media).files as Record<string, any>)['storage.tf.json'].resource.google_storage_bucket.storage_media;
  const segment = { id: 'test', engine: 'opentofu' as const, planDigest: 'p', configurationDigest: 'c', engineVersion: '1', providerVersions: {} };
  const autoclass = [{ enabled: true, terminal_storage_class: 'NEARLINE' }];
  const versionCleanup = [{ action: [{ type: 'Delete' }], condition: [{ days_since_noncurrent_time: 30, with_state: 'ARCHIVED' }] }];
  const today = {
    name: 'demo-media', project: 'demo-project', location: 'US-WEST1', uniform_bucket_level_access: true, public_access_prevention: 'enforced', force_destroy: false,
    labels: { 'managed-by': 'hypervibe', 'hv-storage': 'media' },
  };

  it('is off unless asked for: the bucket is written exactly as before, byte for byte', () => {
    expect(bucket({})).toEqual(today);
    expect(bucket({ versioning: true })).toEqual({ ...today, versioning: [{ enabled: true }], lifecycle_rule: versionCleanup });
    for (const settings of [{}, { versioning: true, browserUploads: true }]) {
      expect(JSON.stringify(gcpConfiguration({ ...settings, autoTiering: false }).files)).toBe(JSON.stringify(gcpConfiguration(settings).files));
    }
    expect(gcpStorageSettings(gcpSpec({ versioning: true }).environments.staging!.storage!.media!)).toEqual({ versioning: true });
    expect(JSON.stringify(gcpConfiguration({}).files)).not.toMatch(/autoclass|storage_class/);
  });

  it('turns on Autoclass with Nearline as the coldest class, so files stay instantly readable', () => {
    expect(gcpStorageSettings(gcpSpec({ autoTiering: true }).environments.staging!.storage!.media!)).toEqual({ autoTiering: true });
    expect(bucket({ autoTiering: true })).toEqual({ ...today, autoclass });
  });

  it('keeps versioning and the 30-day cleanup of old versions, and adds no lifecycle rule Autoclass forbids', () => {
    const tiered = bucket({ autoTiering: true, versioning: true });
    expect(tiered).toEqual({ ...today, versioning: [{ enabled: true }], lifecycle_rule: versionCleanup, autoclass });
    // Google rejects a bucket that has Autoclass and a SetStorageClass action or a matchesStorageClass condition.
    expect(JSON.stringify(tiered)).not.toMatch(/SetStorageClass|matches_storage_class/);
    // Autoclass requires the bucket's default class to stay Standard, which is the provider default when unset.
    expect(tiered).not.toHaveProperty('storage_class');
  });

  it('changes only the autoclass setting, never a field that would recreate the bucket', () => {
    for (const settings of [{}, { versioning: true, browserUploads: true }]) {
      const { autoclass: added, ...rest } = bucket({ ...settings, autoTiering: true });
      expect(added).toEqual(autoclass);
      expect(rest).toEqual(bucket(settings));
    }
    const on = gcpConfiguration({ autoTiering: true });
    const off = gcpConfiguration({});
    expect(Object.keys(on.resources).sort()).toEqual(Object.keys(off.resources).sort());
    expect(on.resources['google_storage_bucket.storage_media']).toEqual(off.resources['google_storage_bucket.storage_media']);
  });

  const review = (media: Record<string, unknown>, change: Record<string, unknown>) => {
    const spec = gcpSpec(media);
    const translated = translateEnginePlan({ provider: 'gcp', configuration: gcpConfiguration(media), segment,
      parsed: parseEnginePlan(JSON.stringify({ resource_changes: [{ address: 'google_storage_bucket.storage_media', type: 'google_storage_bucket', mode: 'managed', change }] })) });
    describeStorageAutoTieringChanges(translated.actions, spec.environments.staging!, 'gcp');
    return translated;
  };
  const before = { name: 'demo-media', location: 'US-WEST1', versioning: [{ enabled: true }], lifecycle_rule: versionCleanup, autoclass: [] as unknown[] };

  it('reviews turning it on for an existing bucket as an in-place, separately approved cost change with a plain explanation', () => {
    const { actions, blockers } = review({ versioning: true, autoTiering: true }, { actions: ['update'], before, after: { ...before, autoclass } });
    expect(blockers).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: 'storage:media', type: 'update', requiresConfirm: true, billable: true });
    expect(actions[0]).not.toHaveProperty('dataBearing');
    expect(actions[0]!.diff).toEqual([{ field: 'google_storage_bucket.autoclass.0.enabled' }, { field: 'google_storage_bucket.autoclass.0.terminal_storage_class' }]);
    expect(actions[0]!.reason).toMatch(/^Hypervibe will turn on automatic storage tiering \(Google Cloud Storage Autoclass\) for this existing bucket in place: the bucket and its files are not recreated, moved or deleted\./);
    expect(actions[0]!.reason).toMatch(/not read for 30 days move to cheaper Nearline storage/);
    expect(actions[0]!.reason).toMatch(/stay instantly readable/);
    expect(actions[0]!.reason).toMatch(/no retrieval or early-deletion fees/);
    expect(actions[0]!.reason).toMatch(/management fee/);
    expect(actions[0]!.reason).toMatch(/one-time enablement charge/);
    expect(actions[0]!.reason).toMatch(/OpenTofu will update google_storage_bucket\.storage_media\.$/);
  });

  it('never presents a bucket replacement as a tiering change: it stays a data-bearing replacement that needs its own approval', () => {
    const { actions } = review({ autoTiering: true }, { actions: ['delete', 'create'], before, after: { ...before, autoclass } });
    expect(actions[0]).toMatchObject({ type: 'replace', dataBearing: true, requiresConfirm: true });
    expect(actions[0]!.reason).not.toMatch(/in place/);
  });

  it('reviews turning it off deliberately: files stay where they are and ordinary Nearline charges return', () => {
    const { actions } = review({ versioning: true }, { actions: ['update'], before: { ...before, autoclass }, after: before });
    expect(actions[0]).toMatchObject({ id: 'storage:media', type: 'update', requiresConfirm: true });
    expect(actions[0]!.reason).toMatch(/^Hypervibe will turn off automatic storage tiering \(Autoclass\) for this bucket\. Nothing is deleted or moved: each file stays in the storage class it has now\./);
    expect(actions[0]!.reason).toMatch(/cannot be turned back on for one day/);
  });

  it('says nothing about tiering when a plan changes something else on the bucket, and describes a new tiered bucket without calling it existing', () => {
    const unrelated = review({ autoTiering: true }, { actions: ['update'], before: { ...before, autoclass, labels: {} }, after: { ...before, autoclass, labels: { a: 'b' } } });
    expect(unrelated.actions[0]!.reason).toBe('OpenTofu will update google_storage_bucket.storage_media.');
    expect(unrelated.actions[0]).not.toHaveProperty('requiresConfirm');
    const created = review({ autoTiering: true }, { actions: ['create'], before: null, after: { ...before, autoclass } });
    expect(created.actions[0]!.reason).toMatch(/^This bucket uses automatic storage tiering \(Google Cloud Storage Autoclass\)\./);
    expect(created.actions[0]!.reason).not.toMatch(/existing bucket/);
    const plain = review({}, { actions: ['create'], before: null, after: before });
    expect(plain.actions[0]!.reason).toBe('OpenTofu will create google_storage_bucket.storage_media.');
  });

  describe('on AWS', () => {
    const awsSpec = (docs: Record<string, unknown>) => projectSpecSchema.parse({ version: 1, project: 'studio', environments: { test: {
      hosting: { provider: 'aws' }, services: { web: {} },
      storage: { docs: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['web'], ...docs } },
    } } });
    const awsReview = (docs: Record<string, unknown>, changes: Array<Record<string, unknown>>) => {
      const spec = awsSpec(docs);
      const translated = translateEnginePlan({ provider: 'aws', segment,
        configuration: buildAwsConfiguration({ accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app', environmentId: 'ENV1', parameterPath: '/hypervibe/env1/',
          storage: [{ name: 'docs', bucket: 'hv-app-docs', ...(docs.versioning ? { versioning: true } : {}), ...(docs.autoTiering ? { autoTiering: true } : {}) }] }),
        parsed: parseEnginePlan(JSON.stringify({ resource_changes: changes.map(change => ({ mode: 'managed', type: String(change.address).split('.')[0], ...change })) })) });
      describeStorageAutoTieringChanges(translated.actions, spec.environments.test!, 'aws');
      return translated.actions[0]!;
    };
    const tieringRule = { id: 'auto-tiering', transition: [{ days: 0, storage_class: 'INTELLIGENT_TIERING' }], noncurrent_version_expiration: [] };
    const versionsRule = { id: 'expire-old-versions', transition: [], noncurrent_version_expiration: [{ noncurrent_days: 30 }] };
    const lifecycle = 'aws_s3_bucket_lifecycle_configuration.docs';

    it('explains what turning it on does when the lifecycle configuration is created or its tiering rule is added', () => {
      const created = awsReview({ autoTiering: true }, [{ address: lifecycle, change: { actions: ['create'], before: null, after: { rule: [tieringRule] } } }]);
      expect(created.reason).toMatch(/^Automatic storage tiering: files of 128 KB or more in this bucket move to S3 Intelligent-Tiering/);
      expect(created.reason).toMatch(/stay instantly readable/);
      expect(created.reason).toMatch(/monitoring fee/);
      expect(created.reason).toMatch(/not recreated or deleted/);
      expect(created).toMatchObject({ requiresConfirm: true, billable: true });
      const added = awsReview({ autoTiering: true, versioning: true }, [{ address: lifecycle, change: { actions: ['update'], before: { rule: [versionsRule] }, after: { rule: [tieringRule, versionsRule] } } }]);
      expect(added).toMatchObject({ type: 'update', requiresConfirm: true });
      expect(added.reason).toMatch(/^Automatic storage tiering:/);
    });

    it('explains turning it off, and stays quiet when only versioning changes', () => {
      const removed = awsReview({ versioning: true }, [{ address: lifecycle, change: { actions: ['update'], before: { rule: [tieringRule, versionsRule] }, after: { rule: [versionsRule] } } }]);
      expect(removed.reason).toMatch(/^Hypervibe will stop moving files to S3 Intelligent-Tiering\. Files already moved stay there/);
      expect(removed).toMatchObject({ type: 'update', requiresConfirm: true });
      const deleted = awsReview({}, [{ address: lifecycle, change: { actions: ['delete'], before: { rule: [tieringRule] }, after: null } }]);
      expect(deleted.reason).toMatch(/^Hypervibe will stop moving files to S3 Intelligent-Tiering\./);
      const versioningOff = awsReview({}, [
        { address: lifecycle, change: { actions: ['delete'], before: { rule: [versionsRule] }, after: null } },
        { address: 'aws_s3_bucket_versioning.docs', change: { actions: ['delete'], before: {}, after: null } }]);
      expect(versioningOff.reason).not.toMatch(/Intelligent-Tiering/);
      const versioningOn = awsReview({ autoTiering: true, versioning: true }, [
        { address: lifecycle, change: { actions: ['update'], before: { rule: [tieringRule] }, after: { rule: [tieringRule, versionsRule] } } },
        { address: 'aws_s3_bucket_versioning.docs', change: { actions: ['create'], before: null, after: {} } }]);
      expect(versioningOn.reason).not.toMatch(/Intelligent-Tiering/);
      expect(versioningOn).not.toHaveProperty('requiresConfirm');
    });

    it('reaches the AWS engine input only when asked for', () => {
      const context = { connection: { accountId: '111122223333', region: 'us-west-2' }, prefix: 'hv-app', parameterPath: '/hypervibe/env1/', environment: { id: 'ENV1', platformBindings: {} },
        shared: { clusterArn: 'arn', clusterIdentifier: 'c' }, database: { name: 'db' } } as never;
      expect(buildAwsEngineInput(awsSpec({ autoTiering: true }), 'test', context, { secretKeys: [] }).storage).toEqual([{ name: 'docs', bucket: 'hv-app-docs-111122223333', autoTiering: true }]);
      expect(buildAwsEngineInput(awsSpec({}), 'test', context, { secretKeys: [] }).storage).toEqual([{ name: 'docs', bucket: 'hv-app-docs-111122223333' }]);
    });
  });
});
