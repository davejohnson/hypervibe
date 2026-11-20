import { describe, expect, it } from 'vitest';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { engineEnvironmentProblems } from '../../domain/services/infrastructure-engine-selection.js';
import { buildCloudRunConfiguration, planWithCloudRunRevisionMinimums } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { buildEngineInput } from '../infrastructure-engine.js';
import { ciReleaseTargets } from '../launch.js';
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

describe('production settings on Google Cloud', () => {
  const files = configuration().files as Record<string, any>;
  const services = files['cloudrun.tf.json'].resource.google_cloud_run_v2_service;
  const buckets = files['storage.tf.json'].resource.google_storage_bucket;

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
