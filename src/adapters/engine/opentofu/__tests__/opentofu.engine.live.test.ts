/**
 * Runs the managed pinned OpenTofu binary in ordinary acceptance. Uses only
 * the built-in terraform_data resource, so it
 * needs no cloud account; the Cloud Run validation step downloads the pinned
 * Google provider and verifies its checksum.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineConfiguration, EngineStateIdentity, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { buildCloudRunConfiguration, gcpEngineBackend, secretEngineKey } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { buildArtifactRegistryConfiguration } from '../../../providers/gcp/tofu/gcp-project.backend.js';
import { OpenTofuEngine } from '../engine.js';
import { ensureEngineBinary } from '../install.js';
import { buildCiReleaseConfiguration } from '../../../providers/gcp/tofu/gcp-ci.backend.js';
import { buildGcpBootstrapConfiguration, buildGcpPreparationConfiguration, defaultGcpPreparationInput, gcpSetupBackend } from '../../../providers/gcp/tofu/gcp-setup.backend.js';
import { composeGcpProjectConfiguration } from '../../../../domain/services/gcp-project-setup.service.js';
import { engineProcessEnv, runTofu } from '../runner.js';
import { engineStatePaths, fileDigest, loadOrCreateStatePassphrase, materializeWorkingDirectory } from '../workspace.js';

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
  let binary: string;
  beforeAll(async () => {
    const previous = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = dataDir;
    try {
      const installed = await ensureEngineBinary();
      if (!installed.ok) throw new Error(installed.error);
      binary = installed.binary;
      engine = new OpenTofuEngine({ binary, cipher, dataDir, pluginCacheDir: path.join(dataDir, 'plugins'), timeoutMs: 300_000 });
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
      repository: 'owner/app', repositoryId: '345', releases: [{ environmentName: 'staging', branch: 'main', autoDeploy: true }], runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com' });
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
      ci: buildCiReleaseConfiguration({ projectId, projectNumber: '123456789', repository: 'owner/app', repositoryId: '345', releases: [{ environmentName: 'staging', branch: 'main', autoDeploy: true }], runtimeServiceAccountEmail }),
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

  it('plans an explicitly reviewed grant only on the owned secret consumed by Cloud Run', async () => {
    const projectId = 'synthetic-project';
    const environmentId = 'env-staging';
    const runtimeServiceAccountEmail = `runtime@${projectId}.iam.gserviceaccount.com`;
    const consumed = 'staging-api-key';
    const unused = 'staging-unused';
    const input = {
      projectId, environmentId, region: 'us-central1', runtimeServiceAccountEmail,
      services: [{ logicalName: 'web', resourceName: 'web-staging', workload: 'web' as const,
        initialImage: `us-docker.pkg.dev/${projectId}/app/web@sha256:${'a'.repeat(64)}`, public: false,
        runtimeServiceAccountEmail, secretEnv: { API_KEY: { secretId: consumed, version: '1' } },
      }],
      secrets: [consumed, unused].map(secretId => ({ secretId, labels: { 'managed-by': 'hypervibe', 'hv-environment': environmentId } })),
    };
    const legacy = buildCloudRunConfiguration(input);
    const optIn = buildCloudRunConfiguration({ ...input, gcpRuntimeSecretGrants: 'per-secret' });
    const address = `google_secret_manager_secret_iam_member.${secretEngineKey(consumed)}`;
    const env: Record<string, string> = {};
    for (const key of ['TF_PLUGIN_CACHE_DIR', 'TF_CLI_CONFIG_FILE']) if (process.env[key]) env[key] = process.env[key];
    const exec = promisify(execFile);
    const prepare = async (configuration: EngineConfiguration) => {
      const work = materializeWorkingDirectory({ parent: dataDir, configuration, requirements: gcpEngineBackend.providerRequirements });
      fs.writeFileSync(path.join(work, 'secret-access.tftest.hcl'), 'mock_provider "google" {}\nrun "app" { command = apply }\n');
      const init = await runTofu({ kind: 'init' }, { binary, workingDirectory: work, env, redact: [], timeoutMs: 300_000 });
      expect(init.exitCode, init.stderr || init.stdout).toBe(0);
      const result = await exec(binary, ['test', '-json', '-verbose'], { cwd: work, env: engineProcessEnv(env), timeout: 300_000 });
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      type MockResource = { mode: string; type: string; name: string; schema_version: number; values: Record<string, unknown> };
      const resources: MockResource[] = events.find(event => event.type === 'test_state').test_state.values.root_module.resources;
      // Rebuild native state from the mock apply's public JSON. The next run can now
      // plan the other generated configuration against the same installed app.
      const state = path.join(work, 'mock.tfstate');
      fs.writeFileSync(state, JSON.stringify({ version: 4, serial: 1, resources: resources.map(resource => ({
        mode: resource.mode, type: resource.type, name: resource.name, provider: 'provider["registry.opentofu.org/hashicorp/google"]',
        instances: [{ schema_version: resource.schema_version, attributes: resource.values }],
      })) }));
      return { work, state, resources };
    };
    const planTransition = async (work: string, state: string) => {
      const planFile = path.join(work, 'transition.tfplan');
      // Skip refresh; planning only needs the synthetic state and static access token.
      const offline = engineProcessEnv({ ...env, GOOGLE_OAUTH_ACCESS_TOKEN: 'synthetic', GCE_METADATA_HOST: '127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
      await exec(binary, ['plan', '-no-color', '-refresh=false', `-state=${state}`, `-out=${planFile}`], { cwd: work, env: offline, timeout: 300_000 });
      const shown = await runTofu({ kind: 'show-plan', planFile }, { binary, workingDirectory: work, env, redact: [] });
      expect(shown.exitCode, shown.stderr).toBe(0);
      const changes: Array<{ address: string; type: string; change: { actions: string[]; after: Record<string, string> | null } }> =
        JSON.parse(shown.stdout).resource_changes;
      return changes.filter(resource => resource.change.actions.some(action => action !== 'no-op'));
    };
    const changedGrants = async (previous: { work: string; state: string }, nextWork: string) => {
      // Mock state invents computed values such as labels. Check the provider's
      // normalizations are identical with or without changing the secret setting.
      const baseline = await planTransition(previous.work, previous.state);
      const changed = await planTransition(nextWork, previous.state);
      const isGrant = (resource: { type: string }) => resource.type.includes('_iam_');
      expect(changed.filter(resource => !isGrant(resource))).toEqual(baseline.filter(resource => !isGrant(resource)));
      return changed.filter(isGrant);
    };
    const existing = await prepare(legacy);
    expect(existing.resources.filter(resource => resource.type.includes('_iam_'))).toEqual([]);
    const enabled = await prepare(optIn);
    const grants = await changedGrants(existing, enabled.work);
    expect(grants.map(grant => grant.address)).toEqual([address]);
    expect(grants[0]!.change).toMatchObject({ actions: ['create'], after: {
      project: projectId, secret_id: consumed, role: 'roles/secretmanager.secretAccessor', member: `serviceAccount:${runtimeServiceAccountEmail}`,
    } });
    expect(optIn.resources[address]).toMatchObject({ requiresConfirm: true });
    const rollback = await changedGrants(enabled, existing.work);
    expect(rollback.map(grant => [grant.address, grant.change.actions])).toEqual([[address, ['delete']]]);
    expect(legacy.resources[address]).toMatchObject({ requiresConfirm: true });
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
    // Google refuses to delete a PostgreSQL login that holds grants (live 2026-11-20: "cannot be dropped because
    // some objects depend on it"), which stopped the database from being removed. The login goes with its instance instead.
    expect(files['cloudsql.tf.json'].resource.google_sql_user.worker_waker.deletion_policy).toBe('ABANDON');
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
    expect(fs.existsSync(paths.statePath)).toBe(false);

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

  it('checks the exact private plan values before saving a reviewed change', async () => {
    const isolatedState = { ...state, environmentId: 'review-plan' };
    const plans = engineStatePaths(isolatedState, dataDir).plans;
    const settings = (account: string) => config({ target: { input: { account, credential: '${var.secret}' } } });
    const params = { backend: builtinBackend, auth, state: isolatedState };
    const initial = await engine.plan({ ...params, configuration: settings('old'), planId: 'initial' });
    if (!initial.ok) throw new Error(initial.error);
    const addresses = ['terraform_data.target'];
    expect((await engine.apply({ ...params, planId: 'initial', segment: { ...initial.segment, addresses }, approvedAddresses: addresses })).outcomes)
      .toEqual({ 'terraform_data.target': 'succeeded' });

    type Values = { input: { account: string; credential: string } };
    type Entry = { address: string; change: { before: Values; after: Values; actions: string[] } };
    let observed: unknown;
    const verifyPlannedChanges = (document: unknown) => {
      const entry = (document as { resource_changes: Entry[] }).resource_changes.find(row => row.address === addresses[0]);
      observed = entry?.change;
      return entry?.change.before.input.account === 'old' && entry?.change.after.input.account === 'approved';
    };
    const mismatch = { ok: false, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' };
    const denied = await engine.plan({ ...params, configuration: settings('other'), planId: 'wrong-account', verifyPlannedChanges });
    expect(denied).toEqual(mismatch);
    expect(observed).toMatchObject({ actions: ['update'], before: { input: { account: 'old', credential: '[redacted]' } },
      after: { input: { account: 'other', credential: '[redacted]' } } });
    expect(await engine.plan({ ...params, configuration: settings('approved'), planId: 'failed-review',
      verifyPlannedChanges: () => { throw new Error(SECRET); } })).toEqual(mismatch);
    expect(fs.readdirSync(plans).filter(name => /^(wrong-account|failed-review)\./.test(name))).toEqual([]);
    const approved = await engine.plan({ ...params, configuration: settings('approved'), planId: 'exact-account', verifyPlannedChanges });
    if (!approved.ok) throw new Error(approved.error);
    expect(approved.actions.map(action => action.type)).toEqual(['update']);
    expect(JSON.stringify(approved)).not.toContain(SECRET);
    expect(fs.existsSync(approved.planFile)).toBe(true);
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

  it('recovers only the reviewed, protected resource after a failed create', async () => {
    const isolatedState = { ...state, environmentId: 'protected-recovery' };
    const recoveryPaths = engineStatePaths(isolatedState, dataDir);
    const address = 'terraform_data.protected';
    const configuration = config({
      protected: { input: '${var.secret}', lifecycle: { prevent_destroy: true },
        provisioner: [{ 'local-exec': { command: 'exit 1' } }] },
      sibling: { input: 'unrelated' },
    });
    const params = { backend: builtinBackend, configuration, auth, state: isolatedState };
    const initial = await engine.plan({ ...params, planId: 'first-create' });
    if (!initial.ok) throw new Error(initial.error);
    const addresses = Object.keys(configuration.resources);
    const failed = await engine.apply({ ...params, planId: 'first-create', segment: { ...initial.segment, addresses }, approvedAddresses: addresses });
    expect(failed.outcomes).toMatchObject({ [address]: 'failed', 'terraform_data.sibling': 'succeeded' });
    expect(await engine.plan({ ...params, planId: 'blocked-retry' })).toMatchObject({ ok: false, error: expect.stringContaining('prevent_destroy') });

    type Row = { address: string; tainted?: boolean; values: { id: string } };
    const rows = (value: unknown) => (value as { values: { root_module: { resources: Row[] } } }).values.root_module.resources;
    const identities = (value: unknown) => rows(value).map(row => ({ address: row.address, id: row.values.id, tainted: row.tainted === true }));
    const projection = await engine.inspectState({ ...params, project: identities });
    if (!projection.ok || !projection.present) throw new Error('Expected readable state after partial create.');
    const owned = projection.value.find(row => row.address === address)!;
    expect(owned).toMatchObject({ tainted: true, id: expect.any(String) });
    const verifyResource = (value: unknown, expectedTainted: boolean) => rows(value).some(row =>
      row.address === address && row.values.id === owned.id && (row.tainted === true) === expectedTainted);
    const stateDigest = fileDigest(recoveryPaths.statePath);
    const recovery = { ...params, address, stateDigest, verifyResource };
    expect(await engine.recoverTaintedResource({ ...recovery, stateDigest: '0'.repeat(64) })).toMatchObject({ ok: false });
    expect(await engine.recoverTaintedResource({ ...recovery, address: 'terraform_data.sibling' })).toMatchObject({ ok: false });
    expect(await engine.recoverTaintedResource({ ...recovery, verifyResource: () => false })).toMatchObject({ ok: false });
    expect(fileDigest(recoveryPaths.statePath)).toBe(stateDigest);
    expect(fs.readdirSync(recoveryPaths.backups)).toHaveLength(0);
    // A failed process response after the native write is settled by reading the same object.
    const shim = path.join(dataDir, 'tofu-interrupted-response');
    fs.symlinkSync(binary, path.join(dataDir, 'pinned-tofu'));
    fs.writeFileSync(shim, [
      '#!/bin/sh', 'tofu="$(dirname "$0")/pinned-tofu"',
      'if [ "$1" = untaint ]; then',
      '  if [ -f "$(dirname "$0")/refuse-write" ]; then echo "state is locked" >&2; exit 1; fi',
      '  "$tofu" "$@" && exit 17', '  exit 1', 'fi', 'exec "$tofu" "$@"', '',
    ].join('\n'), { mode: 0o700 });
    const interrupted = new OpenTofuEngine({ binary: shim, dataDir, cipher });
    const refuseWrite = path.join(dataDir, 'refuse-write');
    fs.writeFileSync(refuseWrite, '');
    expect(await interrupted.recoverTaintedResource(recovery)).toMatchObject({ ok: false, error: expect.stringContaining('state is locked') });
    expect(fileDigest(recoveryPaths.statePath)).toBe(stateDigest);
    fs.unlinkSync(refuseWrite);
    expect(await interrupted.recoverTaintedResource(recovery)).toEqual({ ok: true });
    const backups = fs.readdirSync(recoveryPaths.backups);
    expect(backups).toHaveLength(2);
    expect(backups.map(backup => fileDigest(path.join(recoveryPaths.backups, backup)))).toEqual([stateDigest, stateDigest]);
    expect(fs.statSync(recoveryPaths.statePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(recoveryPaths.statePath, 'utf8')).not.toContain(SECRET);
    expect(await engine.inspectState({ ...params, project: identities }))
      .toEqual({ ...projection, value: projection.value.map(row => ({ ...row, tainted: false })) });
    expect(await engine.recoverTaintedResource(recovery)).toMatchObject({ ok: false });
    const retry = await engine.plan({ ...params, planId: 'remaining-work' });
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.actions.map(action => action.type)).toEqual(['noop', 'noop']);
  }, 300_000);
});
