import { describe, expect, it } from 'vitest';
import { interpretApplyEvents, parseEnginePlan, translateEnginePlan } from '../plan-mapping.js';
import { buildCloudRunConfiguration, gcpEngineAuthentication } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { redactEngineOutput } from '../runner.js';

const IMAGE = `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`;
const configuration = buildCloudRunConfiguration({
  projectId: 'demo-project',
  region: 'us-central1',
  services: [{
    logicalName: 'web', resourceName: 'web-staging', workload: 'web', initialImage: IMAGE,
    runtimeServiceAccountEmail: 'web-runtime@demo-project.iam.gserviceaccount.com', public: true,
    env: { NODE_ENV: 'production' }, secretEnv: { API_KEY: { secretId: 'web-api-key', version: '3' } },
    healthCheckPath: '/health',
  }],
});
const segment = { id: 'opentofu:p1', engine: 'opentofu' as const, planDigest: 'd', configurationDigest: 'c', engineVersion: '1.13.9', providerVersions: {} };

function plan(changes: Array<{ address: string; type: string; actions: string[]; before?: unknown; after?: unknown }>): string {
  return JSON.stringify({
    resource_changes: changes.map((c) => ({ address: c.address, type: c.type, mode: 'managed', change: { actions: c.actions, before: c.before ?? null, after: c.after ?? null } })),
  });
}

describe('Cloud Run engine configuration', () => {
  it('wires secrets by reference, keeps image ownership narrow and never embeds values', () => {
    const service = (configuration.files['cloudrun.tf.json'] as any).resource.google_cloud_run_v2_service.web;
    const env = service.template[0].containers[0].env;
    expect(env).toContainEqual({ name: 'API_KEY', value_source: [{ secret_key_ref: [{ secret: 'web-api-key', version: '3' }] }] });
    expect(service.lifecycle[0].ignore_changes).toEqual(['template[0].containers[0].image', 'client', 'client_version']);
    expect(configuration.resources).toHaveProperty('google_cloud_run_v2_service_iam_member.web_public');
  });

  it('rejects mutable image tags', () => {
    expect(() => buildCloudRunConfiguration({
      projectId: 'demo-project', region: 'us-central1',
      services: [{ logicalName: 'web', resourceName: 'web', workload: 'web', initialImage: 'nginx:latest', runtimeServiceAccountEmail: 'r@demo-project.iam.gserviceaccount.com', public: false }],
    })).toThrow(/digest/);
  });

  it('carries the connection credential only in the process environment and redacts it', () => {
    const credentials = JSON.stringify({ type: 'service_account', client_email: 'd@demo-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----\n' });
    const auth = gcpEngineAuthentication({ projectId: 'demo-project', credentials });
    expect(JSON.stringify(configuration.files)).not.toContain('private_key');
    expect(redactEngineOutput(`Error: bad key ${JSON.stringify(credentials)}`, auth.redact)).not.toContain('abcdef');
  });
});

describe('engine plan translation', () => {
  it('maps service and IAM changes to one reviewed action', () => {
    const parsed = parseEnginePlan(plan([
      { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service', actions: ['create'], after: { name: 'web-staging' } },
      { address: 'google_cloud_run_v2_service_iam_member.web_public', type: 'google_cloud_run_v2_service_iam_member', actions: ['create'], after: { role: 'roles/run.invoker' } },
    ]));
    const { actions, blockers } = translateEnginePlan({ provider: 'gcp', parsed, configuration, segment });
    expect(blockers).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: 'service:web', type: 'create', billable: true });
    expect((actions[0]!.metadata!.engineSegment as any).addresses).toHaveLength(2);
  });

  it('requires confirmation for replacement and reports no-ops as noop without a segment', () => {
    const replace = translateEnginePlan({ provider: 'gcp', configuration, segment, parsed: parseEnginePlan(plan([
      { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service', actions: ['delete', 'create'], before: { name: 'a' }, after: { name: 'b' } },
    ])) });
    expect(replace.actions[0]).toMatchObject({ type: 'replace', requiresConfirm: true, diff: [{ field: 'google_cloud_run_v2_service.name' }] });
    const noop = translateEnginePlan({ provider: 'gcp', configuration, segment, parsed: parseEnginePlan(plan([
      { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service', actions: ['no-op'] },
    ])) });
    expect(noop.actions[0]).toMatchObject({ type: 'noop' });
    expect(noop.actions[0]!.metadata).toBeUndefined();
  });

  it('blocks unmanaged addresses and unsupported actions', () => {
    const { blockers } = translateEnginePlan({ provider: 'gcp', configuration, segment, parsed: parseEnginePlan(plan([
      { address: 'google_sql_database_instance.db', type: 'google_sql_database_instance', actions: ['delete'] },
      { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service', actions: ['forget'] },
    ])) });
    expect(blockers).toHaveLength(2);
  });
});

describe('apply event interpretation', () => {
  it('only treats explicit completion as success', () => {
    const events = [
      { type: 'apply_start', hook: { resource: { addr: 'a.one' } } },
      { type: 'apply_complete', hook: { resource: { addr: 'a.one' } } },
      { type: 'apply_start', hook: { resource: { addr: 'a.two' } } },
      { type: 'apply_errored', hook: { resource: { addr: 'a.two' } } },
      { type: 'apply_start', hook: { resource: { addr: 'a.three' } } },
    ].map((e) => JSON.stringify(e)).join('\n');
    expect(interpretApplyEvents(events, ['a.one', 'a.two', 'a.three', 'a.four'])).toEqual({
      'a.one': 'succeeded', 'a.two': 'failed', 'a.three': 'unknown', 'a.four': 'not_started',
    });
  });
});

describe('engine output redaction', () => {
  it('keeps machine-readable JSON parseable when a URL precedes an email address', async () => {
    const { redactExactEngineValues } = await import('../runner.js');
    const json = JSON.stringify({ uri: 'https://web-x.a.run.app', sa: 'runtime@demo-project.iam.gserviceaccount.com' });
    expect(() => JSON.parse(redactExactEngineValues(json, ['unrelated-secret']))).not.toThrow();
    // Pattern redaction silently swallows structure here, which is why JSON output never uses it.
    expect(JSON.parse(redactEngineOutput(json, [])).sa).toBeUndefined();
  });
});

describe('teardown mapping', () => {
  it('maps deletion of a previously created service to a confirm-gated action', () => {
    const retired = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [], retiredServices: ['web'] });
    const { actions, blockers } = translateEnginePlan({ provider: 'gcp', configuration: retired, segment, parsed: parseEnginePlan(plan([
      { address: 'google_cloud_run_v2_service.web', type: 'google_cloud_run_v2_service', actions: ['delete'], before: { name: 'web' } },
      { address: 'google_cloud_run_v2_service_iam_member.web_public', type: 'google_cloud_run_v2_service_iam_member', actions: ['delete'] },
    ])) });
    expect(blockers).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ id: 'service:web', type: 'destroy', requiresConfirm: true })]);
    expect(retired.files['cloudrun.tf.json']).toEqual({});
  });
});

describe('Cloud SQL wiring', () => {
  const base = {
    projectId: 'demo-project', region: 'us-central1',
    services: [{ logicalName: 'web', resourceName: 'web', workload: 'web' as const, initialImage: IMAGE,
      runtimeServiceAccountEmail: 'r@demo-project.iam.gserviceaccount.com', public: false }],
  };
  const web = (wireServices: boolean) => (buildCloudRunConfiguration({ ...base, database: { instanceName: 'hv-pilot-db-a1', databaseName: 'app', wireServices } })
    .files['cloudrun.tf.json'] as any).resource.google_cloud_run_v2_service.web.template[0];

  it('connects services only once Hypervibe has created the login', () => {
    expect(web(false).volumes).toBeUndefined();
    expect(web(true).volumes[0].cloud_sql_instance[0].instances).toEqual(['${google_sql_database_instance.db.connection_name}']);
    expect(web(true).containers[0].volume_mounts).toEqual([{ name: 'cloudsql', mount_path: '/cloudsql' }]);
  });

  it('never puts a database password in engine configuration and marks the instance data-bearing', () => {
    const configuration = buildCloudRunConfiguration({ ...base, database: { instanceName: 'hv-pilot-db-a1', databaseName: 'app', wireServices: true } });
    expect(JSON.stringify(configuration.files)).not.toMatch(/password|root_password/i);
    expect(configuration.resources['google_sql_database_instance.db']).toMatchObject({ dataBearing: true, billable: true });
  });
});

describe('adopting interrupted creates', () => {
  it('turns an engine import into a confirm-gated adoption action', () => {
    const parsed = parseEnginePlan(JSON.stringify({ resource_changes: [{
      address: 'google_sql_database_instance.db', type: 'google_sql_database_instance', mode: 'managed',
      change: { actions: ['no-op'], importing: { id: 'projects/p/instances/db' }, before: {}, after: {} },
    }] }));
    expect(parsed.changes[0]?.action).toBe('import');
    const withDb = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [],
      database: { instanceName: 'hv-launch-db-1', databaseName: 'app', wireServices: false }, adopt: { databaseInstance: 'hv-launch-db-1' } });
    expect((withDb.files['imports.tf.json'] as any).import).toEqual([{ to: 'google_sql_database_instance.db', id: 'projects/demo-project/instances/hv-launch-db-1' }]);
    const { actions } = translateEnginePlan({ provider: 'gcp', parsed, configuration: withDb, segment });
    expect(actions[0]).toMatchObject({ id: 'database:postgres', type: 'update', requiresConfirm: true, metadata: { engineAdopt: true } });
  });
});

describe('network interruptions', () => {
  it('distinguishes a dropped connection from a provider rejection', async () => {
    const { networkInterruptedAddresses } = await import('../engine.js');
    const line = (address: string, summary: string) => JSON.stringify({ type: 'diagnostic', diagnostic: { severity: 'error', address, summary } });
    const stdout = [
      line('google_sql_database_instance.db', 'Error waiting for Update Instance: read tcp 1.2.3.4:5->6.7.8.9:443: read: can\'t assign requested address'),
      line('google_storage_bucket.b', 'googleapi: Error 403: does not have storage.buckets.create access'),
    ].join('\n');
    expect([...networkInterruptedAddresses(stdout)]).toEqual(['google_sql_database_instance.db']);
  });
});

describe('database major-version changes', () => {
  it('require their own approval even as an in-place update', () => {
    const withDb = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [],
      database: { instanceName: 'hv-db-1', databaseName: 'app', wireServices: false, majorVersion: 18 } });
    const { actions } = translateEnginePlan({ provider: 'gcp', configuration: withDb, segment, parsed: parseEnginePlan(plan([
      { address: 'google_sql_database_instance.db', type: 'google_sql_database_instance', actions: ['update'], before: { database_version: 'POSTGRES_16' }, after: { database_version: 'POSTGRES_18' } },
    ])) });
    expect(actions[0]).toMatchObject({ type: 'update', requiresConfirm: true, metadata: { engineMajorUpgrade: true } });
  });
});
