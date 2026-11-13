/**
 * Runs the managed pinned OpenTofu binary in ordinary acceptance. Uses only
 * the built-in terraform_data resource, so it
 * needs no cloud account; the Cloud Run validation step downloads the pinned
 * Google provider and verifies its checksum.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineConfiguration, EngineStateIdentity, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { buildCloudRunConfiguration, gcpEngineBackend } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { buildArtifactRegistryConfiguration } from '../../../providers/gcp/tofu/gcp-project.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { ensureEngineBinary } from '../install.js';
import { buildCiReleaseConfiguration } from '../../../providers/gcp/tofu/gcp-ci.backend.js';
import { buildGcpBootstrapConfiguration, buildGcpPreparationConfiguration, defaultGcpPreparationInput, gcpSetupBackend } from '../../../providers/gcp/tofu/gcp-setup.backend.js';
import { composeGcpProjectConfiguration } from '../../../../domain/services/gcp-project-setup.service.js';
import { engineStatePaths, loadOrCreateStatePassphrase } from '../workspace.js';

const SECRET = 'hv-representative-secret-7f3a9c';
const cipher = { encrypt: (v: string) => Buffer.from(v).toString('base64'), decrypt: (v: string) => Buffer.from(v, 'base64').toString() };

const builtinBackend: InfrastructureEngineBackend = {
  provider: 'test', engine: 'opentofu', capabilities: ['hosting'], providerRequirements: {},
  buildConfiguration: () => { throw new Error('unused'); },
  buildAuthenticationProbe: () => { throw new Error('unused'); },
};

function config(resources: Record<string, Record<string, unknown>>): EngineConfiguration {
  return {
    files: {
      'main.tf.json': {
        variable: { secret: { type: 'string', sensitive: true } },
        resource: { terraform_data: resources },
      },
    },
    resources: Object.fromEntries(Object.keys(resources).map((name) => [
      `terraform_data.${name}`, { actionId: `service:${name}`, kind: 'service' as const, name },
    ])),
  };
}

const auth = { env: { TF_VAR_secret: SECRET }, redact: [SECRET] };

describe('OpenTofu engine (real binary, no cloud writes)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-engine-'));
  let engine: OpenTofuEngine;
  beforeAll(async () => {
    const previous = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir;
    try {
      const installed = await ensureEngineBinary();
      if (!installed.ok) throw new Error(installed.error);
      engine = new OpenTofuEngine({ binary: installed.binary, cipher, dataDir, pluginCacheDir: path.join(dataDir, 'plugins'), timeoutMs: 300_000 });
    } finally {
      if (previous === undefined) delete process.env.HYPERVIBE_DATA_DIR;
      else process.env.HYPERVIBE_DATA_DIR = previous;
    }
  }, 300_000);
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state: EngineStateIdentity = { provider: 'test', projectId: 'p1', environmentId: 'e1', partition: 'environment' };
  const paths = engineStatePaths(state, dataDir);
  fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });

  it('validates project-shared keyless CI infrastructure with the pinned provider', async () => {
    const configuration = buildCiReleaseConfiguration({ projectId: 'demo-project', projectNumber: '123456789',
      repository: 'owner/app', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com' });
    expect(await engine.validate(gcpSetupBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates bootstrap plus later worker and CI access as one shared resource graph', async () => {
    const projectId = 'demo-project';
    const deployServiceAccountEmail = `hypervibe-deploy@${projectId}.iam.gserviceaccount.com`;
    const runtimeServiceAccountEmail = `hypervibe-runtime@${projectId}.iam.gserviceaccount.com`;
    const bootstrap = buildGcpBootstrapConfiguration({ projectId, billingAccountName: 'billingAccounts/ABCDEF-123456-ABCDEF',
      deployServiceAccountEmail, runtimeServiceAccountEmail });
    const worker = defaultGcpPreparationInput(projectId, deployServiceAccountEmail, runtimeServiceAccountEmail);
    worker.enableApis.push('workflows.googleapis.com');
    const configuration = composeGcpProjectConfiguration({ bootstrap,
      workers: buildGcpPreparationConfiguration(worker),
      ci: buildCiReleaseConfiguration({ projectId, projectNumber: '123456789', repository: 'owner/app', runtimeServiceAccountEmail }),
    });
    expect(await engine.validate(gcpSetupBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates the project-shared Artifact Registry with deletion protection against the pinned provider', async () => {
    const configuration = buildArtifactRegistryConfiguration({ projectId: 'demo-project', region: 'us-central1' });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates generated Cloud Run configuration against the pinned Google provider', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      environmentId: 'env-secret-container',
      secrets: [{ secretId: 'web-api-key', labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env-secret-container' } }],
      adopt: { secrets: ['web-api-key'] },
      services: [{
        logicalName: 'web', resourceName: 'web-staging', workload: 'web',
        initialImage: `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'web-runtime@demo-project.iam.gserviceaccount.com', public: true,
        env: { NODE_ENV: 'production' }, secretEnv: { API_KEY: { secretId: 'web-api-key', version: '3' } }, healthCheckPath: '/health',
      }],
    });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates Cloud Run wired to engine-managed Cloud SQL', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      database: { instanceName: 'pilot-db-ab12', databaseName: 'app', wireServices: true },
      services: [{
        logicalName: 'web', resourceName: 'web-staging', workload: 'web',
        initialImage: `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'web-runtime@demo-project.iam.gserviceaccount.com', public: true,
        secretEnv: { DATABASE_URL: { secretId: 'hv-pilot-database-url', version: 'latest' } },
      }],
    });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates adoption of an interrupted Cloud SQL create', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1', services: [],
      database: { instanceName: 'hv-launch-db-1', databaseName: 'app', wireServices: false },
      adopt: { databaseInstance: 'hv-launch-db-1' },
    });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates a scheduled Cloud Run job with its trigger and permission', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      database: { instanceName: 'hv-db-1', databaseName: 'app', wireServices: true },
      services: [{
        logicalName: 'nightly', resourceName: 'nightly-staging', workload: 'job', schedule: '0 3 * * *', timeZone: 'America/New_York',
        jobCommand: 'node scripts/nightly.js', initialImage: `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', public: false,
        secretEnv: { DATABASE_URL: { secretId: 'hv-staging-database-url', version: '2' } },
      }],
    });
    expect(Object.keys(configuration.resources).sort()).toEqual([
      'google_cloud_run_v2_job.nightly', 'google_cloud_run_v2_job_iam_member.nightly_invoker', 'google_cloud_scheduler_job.nightly_schedule',
      'google_sql_database.app', 'google_sql_database_instance.db', 'google_sql_user.worker_waker',
    ]);
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates Memorystore Redis with services wired through the VPC', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      cache: { instanceName: 'hv-staging-cache-1', tier: 'BASIC', memorySizeGb: 1, network: 'default', subnetwork: 'default', wireServices: true },
      services: [{
        logicalName: 'web', resourceName: 'web-staging', workload: 'web',
        initialImage: `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', public: true,
        secretEnv: { REDIS_URL: { secretId: 'hv-staging-redis-url', version: '1' } },
      }],
    });
    const web = (configuration.files['cloudrun.tf.json'] as any).resource.google_cloud_run_v2_service.web.template[0];
    expect(web.vpc_access[0]).toEqual({ network_interfaces: [{ network: 'default', subnetwork: 'default' }], egress: 'PRIVATE_RANGES_ONLY' });
    expect(configuration.resources['google_redis_instance.cache']).toMatchObject({ actionId: 'cache:redis', billable: true });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates a background worker as a worker pool with no port or probe', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      cache: { instanceName: 'hv-staging-cache-1', tier: 'BASIC', memorySizeGb: 1, network: 'default', subnetwork: 'default', wireServices: true },
      services: [{
        logicalName: 'worker', resourceName: 'worker-staging', workload: 'worker',
        initialImage: `us-docker.pkg.dev/demo-project/app/worker@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', public: false,
      }],
    });
    const pool = (configuration.files['workerpools.tf.json'] as any).resource.google_cloud_run_v2_worker_pool.worker;
    expect(pool.scaling).toEqual([{ scaling_mode: 'MANUAL', manual_instance_count: 1 }]);
    expect(pool.template[0].containers[0].ports).toBeUndefined();
    expect(configuration.files['cloudrun.tf.json']).toEqual({});
    // A worker that was once a service has that service retired, not left unmanaged.
    expect(configuration.resources['google_cloud_run_v2_service.worker']).toMatchObject({ actionId: 'service:worker' });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates an on-demand worker: pool at zero, scheduled waker, read-only IAM database user', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
      database: { instanceName: 'hv-staging-db-1', databaseName: 'app', wireServices: true },
      services: [{
        logicalName: 'worker', resourceName: 'worker-staging', workload: 'worker',
        initialImage: `us-docker.pkg.dev/demo-project/app/worker@sha256:${'a'.repeat(64)}`,
        runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', public: false,
        pendingWorkQuery: "SELECT count(*) FROM jobs WHERE status IN ('queued', 'running')",
      }],
    });
    const files = configuration.files as any;
    const pool = files['workerpools.tf.json'].resource.google_cloud_run_v2_worker_pool.worker;
    expect(pool.scaling).toEqual([{ scaling_mode: 'MANUAL', manual_instance_count: 0 }]);
    expect(pool.lifecycle[0].ignore_changes).toContain('scaling[0].manual_instance_count');
    const workflow = files['workerpools.tf.json'].resource.google_workflows_workflow.worker_waker.source_contents;
    expect(workflow).toContain('executeSql');
    expect(workflow).not.toMatch(/[^$]\$\{/);
    expect(files['jobs.tf.json'].resource.google_cloud_scheduler_job.worker_waker.schedule).toBe('* * * * *');
    expect(files['cloudsql.tf.json'].resource.google_sql_user.worker_waker).toMatchObject({ name: 'runtime@demo-project.iam', type: 'CLOUD_IAM_SERVICE_ACCOUNT' });
    expect(configuration.resources['google_workflows_workflow.worker_waker']).toMatchObject({ actionId: 'service:worker' });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates Pub/Sub queues (runtime access comes from the queue setup add-on)', async () => {
    const configuration = buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
      queues: [{ name: 'emails', topicId: 'emails-abc123', ackDeadlineSeconds: 30 }],
      services: [],
    });
    expect(Object.keys(configuration.resources).sort()).toEqual([
      'google_pubsub_subscription.queue_emails', 'google_pubsub_subscription_iam_member.queue_emails_subscriber',
      'google_pubsub_topic.queue_emails', 'google_pubsub_topic_iam_member.queue_emails_publisher',
    ]);
    expect(configuration.resources['google_pubsub_topic.queue_emails']).toMatchObject({ dataBearing: true });
    expect(await engine.validate(gcpEngineBackend, configuration)).toEqual({ ok: true });
  }, 300_000);

  it('validates an environment with no services (teardown)', async () => {
    const empty = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [] });
    expect(await engine.validate(gcpEngineBackend, empty)).toEqual({ ok: true });
  }, 300_000);

  it('plans, applies, reaches noop and rejects a stale saved plan, with secrets encrypted at rest', async () => {
    const configuration = config({ app: { input: '${var.secret}' } });
    const first = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-1' });
    if (!first.ok) throw new Error(first.error);
    expect(first.blockers).toEqual([]);
    expect(first.actions.map((a) => [a.id, a.type])).toEqual([['service:app', 'create']]);
    expect(fs.readFileSync(first.planFile).includes(SECRET)).toBe(false);

    const segment = first.actions[0]!.metadata!.engineSegment as any;
    const applied = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-1', segment, approvedAddresses: segment.addresses });
    expect(applied.outcomes).toEqual({ 'terraform_data.app': 'succeeded' });
    const inspected = await engine.inspectState({ backend: builtinBackend, configuration, auth, state,
      project: value => {
        const resources = (value as { values: { root_module: { resources: Array<{ address: string; values: { id: string } }> } } }).values.root_module.resources;
        return resources.map(resource => ({ address: resource.address, id: resource.values.id }));
      } });
    expect(inspected).toEqual({ ok: true, present: true, value: [{ address: 'terraform_data.app', id: expect.any(String) }] });
    expect(JSON.stringify(inspected)).not.toContain(SECRET);
    expect(await engine.inspectState({ backend: builtinBackend, configuration, auth, state,
      project: () => { throw Error(`malformed private state ${SECRET}`); } })).toMatchObject({ ok: false, stage: 'state inspection' });

    const stateBytes = fs.readFileSync(paths.statePath, 'utf8');
    expect(stateBytes).not.toContain(SECRET);
    expect(stateBytes).not.toContain('terraform_data');
    expect(fs.readdirSync(paths.backups)).toHaveLength(0); // no prior state to back up on first apply

    const second = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-2' });
    if (!second.ok) throw new Error(second.error);
    expect(second.actions.map((a) => a.type)).toEqual(['noop']);
    expect(second.actions[0]!.metadata).toBeUndefined();

    const replay = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-1', segment, approvedAddresses: segment.addresses });
    expect(replay.outcomes['terraform_data.app']).not.toBe('succeeded');
    expect(replay.diagnostics.join('\n')).toMatch(/stale|plan/i);
    expect(replay.diagnostics.join('\n')).not.toContain(SECRET);
    expect(fs.readdirSync(paths.backups)).toHaveLength(1);
  }, 300_000);

  it('rejects a tampered saved plan and partial approval without starting', async () => {
    const configuration = config({ app: { input: '${var.secret}' }, extra: { input: 'x' } });
    const planned = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-3' });
    if (!planned.ok) throw new Error(planned.error);
    const segment = planned.actions.find((a) => a.id === 'service:extra')!.metadata!.engineSegment as any;
    const partial = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-3', segment, approvedAddresses: [] });
    expect(partial.diagnostics[0]).toMatch(/approved/);
    fs.appendFileSync(planned.planFile, 'x');
    const tampered = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-3', segment, approvedAddresses: segment.addresses });
    expect(tampered).toEqual({ outcomes: { 'terraform_data.extra': 'not_started' }, diagnostics: ['The saved engine plan changed after review. Re-run hv_plan.'] });
  }, 300_000);

  it('reports partial failure per address', async () => {
    const failing = { input: 'boom', provisioner: [{ 'local-exec': { command: 'exit 1' } }] };
    const configuration = config({ app: { input: '${var.secret}' }, good: { input: 'ok' }, bad: failing });
    const planned = await engine.plan({ backend: builtinBackend, configuration, auth, state, planId: 'plan-4' });
    if (!planned.ok) throw new Error(planned.error);
    const addresses = planned.actions.flatMap((a) => ((a.metadata?.engineSegment as any)?.addresses ?? []) as string[]);
    const segment = { ...(planned.actions.find((a) => a.metadata)!.metadata!.engineSegment as any), addresses };
    const result = await engine.apply({ backend: builtinBackend, auth, state, planId: 'plan-4', segment, approvedAddresses: addresses });
    expect(result.outcomes).toMatchObject({ 'terraform_data.good': 'succeeded', 'terraform_data.bad': 'failed' });
  }, 300_000);

  it('refuses to mint a new key for existing state', () => {
    fs.renameSync(paths.passphraseFile, `${paths.passphraseFile}.bak`);
    expect(() => loadOrCreateStatePassphrase(paths, cipher)).toThrow(/Restore passphrase\.enc/);
    fs.renameSync(`${paths.passphraseFile}.bak`, paths.passphraseFile);
  });
});
