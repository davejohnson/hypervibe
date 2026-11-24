/**
 * Workloads can be pointed at a database that is named outright, while the
 * database the environment itself creates stays in the configuration: the
 * state a move between two databases passes through. Nothing passes this
 * input yet; without it the generated output is the recorded one
 * (database-seam.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, secretEngineKey, type GcpCloudRunEngineInput, type GcpCloudRunServiceInput } from '../gcp-engine.backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`;
const runtime = 'hv-runtime@demo-project.iam.gserviceaccount.com';
const own = { secretId: 'prod-database-url', version: '4' };
const moved = { secretId: 'prod-database-url-move', version: '1' };
const workload = { initialImage: IMAGE, runtimeServiceAccountEmail: runtime, public: false, secretEnv: { DATABASE_URL: own, DIRECT_URL: own, JOBS_DB: own, API_KEY: { secretId: 'prod-api-key', version: '2' } } };
const web = { ...workload, logicalName: 'web', resourceName: 'web-prod', workload: 'web' as const, public: true };
const worker = { ...workload, logicalName: 'jobs', resourceName: 'jobs-prod', workload: 'worker' as const };
const cron = { ...workload, logicalName: 'nightly', resourceName: 'nightly-prod', workload: 'job' as const, schedule: '0 3 * * *', jobCommand: 'npm run nightly' };
const releaseJob = { ...workload, logicalName: 'release', resourceName: 'release-prod', workload: 'web' as const, jobCommand: 'npm run migrate' };
const base: GcpCloudRunEngineInput = { projectId: 'demo-project', region: 'us-central1', environmentId: 'ENV123', runtimeServiceAccountEmail: runtime, services: [web, worker, cron], releaseJob,
  secrets: [own, moved, { secretId: 'prod-api-key' }].map(({ secretId }) => ({ secretId, labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env123' } })) };
const ownInstance = { instanceName: 'hv-prod-db-a1b2c3', databaseName: 'app', wireServices: true, deletionProtection: true };
const OWN_SOCKET = '${google_sql_database_instance.db.connection_name}';
const ELSEWHERE = 'demo-project:us-central1:hv-demo-shared-d4e5f6';
const elsewhere = { connection: { connectionName: ELSEWHERE, wireServices: true, workerQuery: { projectId: 'demo-project', instanceName: 'hv-demo-shared-d4e5f6', databaseName: 'app_production_0123456789ab' } }, credential: moved };

type Json = Record<string, any>;
const SECRET_IDS = [own.secretId, moved.secretId, 'prod-api-key'];
const files = (input: GcpCloudRunEngineInput) => buildCloudRunConfiguration(input).files as Record<string, Json>;
/** Every workload's container, by what it is. */
function containers(input: GcpCloudRunEngineInput): Record<string, Json> {
  const generated = files(input);
  return {
    web: generated['cloudrun.tf.json']!.resource.google_cloud_run_v2_service.web.template[0],
    worker: generated['workerpools.tf.json']!.resource.google_cloud_run_v2_worker_pool.jobs.template[0],
    cron: generated['jobs.tf.json']!.resource.google_cloud_run_v2_job.nightly.template[0].template[0],
    release: generated['jobs.tf.json']!.resource.google_cloud_run_v2_job.release_command.template[0].template[0],
  };
}
/** What one workload connects with: its socket in all three places it appears, and every secret it reads. */
function wiring(template: Json) {
  const env = template.containers[0].env as Array<{ name: string; value?: string; value_source?: Array<{ secret_key_ref: Array<{ secret: string; version: string }> }> }>;
  const value = (name: string) => env.find((entry) => entry.name === name)?.value;
  return {
    sockets: [...new Set([value('CLOUD_SQL_CONNECTION_NAME'), value('PGHOST')?.replace('/cloudsql/', ''), ...(template.volumes ?? []).flatMap((volume: Json) => volume.cloud_sql_instance?.[0]?.instances ?? [])])],
    secrets: Object.fromEntries(env.filter((entry) => entry.value_source).map((entry) => {
      const { secret, version } = entry.value_source![0]!.secret_key_ref[0]!;
      // A secret this configuration holds is referred to by its address; that is turned back into its id.
      return [entry.name, `${SECRET_IDS.find((id) => secret === `\${google_secret_manager_secret.${secretEngineKey(id)}.secret_id}`) ?? secret}@${version}`];
    })),
  };
}
const ON_OWN = { sockets: [OWN_SOCKET], secrets: { API_KEY: 'prod-api-key@2', DATABASE_URL: 'prod-database-url@4', DIRECT_URL: 'prod-database-url@4', JOBS_DB: 'prod-database-url@4' } };
const ON_ELSEWHERE = { sockets: [ELSEWHERE], secrets: { API_KEY: 'prod-api-key@2', DATABASE_URL: 'prod-database-url-move@1', DIRECT_URL: 'prod-database-url-move@1', JOBS_DB: 'prod-database-url-move@1' } };

describe('without a named database, nothing changes', () => {
  it('every workload is on the environment\'s own instance, as before', () => {
    for (const template of Object.values(containers({ ...base, database: ownInstance }))) expect(wiring(template)).toEqual(ON_OWN);
  });

  it('the generator still decides the connection in one place, with the named database first', () => {
    const source = readFileSync(path.join(here, '..', 'gcp-engine.backend.ts'), 'utf8');
    expect(source.split('\n').filter((line) => /const connection = /.test(line))).toEqual([
      '  const connection = input.workloadDatabase?.connection ?? dedicatedDatabaseConnection(input.projectId, input.database) ?? input.databaseConnection;']);
    // It learns nothing about what kind of database that is.
    expect(readFileSync(path.join(here, '..', 'gcp-workload-database.ts'), 'utf8')).not.toMatch(/shared|tenant|dedicated|placement/i);
  });
});

describe('with a database named for the workloads', () => {
  it('every workload uses it for the socket, the connection secret and every alias together, while the own instance stays exactly as declared', () => {
    const before = files({ ...base, database: ownInstance });
    const after = files({ ...base, database: ownInstance, workloadDatabase: elsewhere });
    for (const [name, template] of Object.entries(containers({ ...base, database: ownInstance, workloadDatabase: elsewhere }))) expect(wiring(template), name).toEqual(ON_ELSEWHERE);
    // The instance the environment created is not touched by the switch: same resources, same protection, same addresses.
    expect(after['cloudsql.tf.json']).toEqual(before['cloudsql.tf.json']);
    expect(after['cloudsql.tf.json']!.resource.google_sql_database_instance.db).toMatchObject({ name: 'hv-prod-db-a1b2c3', deletion_protection: true });
    const withName = buildCloudRunConfiguration({ ...base, database: ownInstance, workloadDatabase: elsewhere });
    expect(withName.resources['google_sql_database_instance.db']).toEqual(buildCloudRunConfiguration({ ...base, database: ownInstance }).resources['google_sql_database_instance.db']);
    // Nothing a workload runs with mentions the own instance or its secret version any more.
    const workloads = JSON.stringify([after['cloudrun.tf.json'], after['workerpools.tf.json'], after['jobs.tf.json']]);
    expect(workloads).not.toContain('google_sql_database_instance');
    expect(workloads).not.toContain(`\${google_secret_manager_secret.${secretEngineKey(own.secretId)}.secret_id}`);
  });

  it('works the same when the environment creates no instance at all, and when its own instance is not ready for workloads', () => {
    for (const template of Object.values(containers({ ...base, workloadDatabase: elsewhere }))) expect(wiring(template)).toEqual(ON_ELSEWHERE);
    for (const template of Object.values(containers({ ...base, database: { ...ownInstance, wireServices: false }, workloadDatabase: elsewhere }))) expect(wiring(template)).toEqual(ON_ELSEWHERE);
  });

  it('points an on-demand worker\'s pending-work check at it too', () => {
    const counting = { ...worker, pendingWorkQuery: 'SELECT count(*) FROM jobs' };
    const workflow = (input: GcpCloudRunEngineInput) => JSON.stringify(files(input)['workflows.tf.json'] ?? files(input));
    const moved = workflow({ ...base, services: [web, counting], database: ownInstance, workloadDatabase: elsewhere });
    expect(moved).toContain('hv-demo-shared-d4e5f6');
    expect(moved).toContain('app_production_0123456789ab');
    expect(workflow({ ...base, services: [web, counting], database: ownInstance })).not.toContain('hv-demo-shared-d4e5f6');
  });

  it('connects nothing while the named database is not ready for workloads, and refuses a workload that already carries a connection secret', () => {
    const waiting = { ...elsewhere, connection: { ...elsewhere.connection, wireServices: false } };
    const bare = (service: GcpCloudRunServiceInput): GcpCloudRunServiceInput => ({ ...service, secretEnv: { API_KEY: service.secretEnv!.API_KEY! } });
    const quiet = containers({ ...base, services: [bare(web), bare(worker), bare(cron)], releaseJob: bare(releaseJob), database: ownInstance, workloadDatabase: waiting });
    for (const template of Object.values(quiet)) expect(wiring(template)).toEqual({ sockets: [undefined], secrets: { API_KEY: 'prod-api-key@2' } });
    expect(() => files({ ...base, database: ownInstance, workloadDatabase: waiting })).toThrow('Workload web has a database connection secret, but the database it is pointed at is not ready for workloads.');
  });

  it.each([
    ['a workload with no connection secret', (input: GcpCloudRunEngineInput) => ({ ...input, services: [web, { ...worker, secretEnv: { API_KEY: worker.secretEnv.API_KEY } }] }),
      'Workload jobs would be connected to a database it has no connection secret for.'],
    ['a release job with no connection secret', (input: GcpCloudRunEngineInput) => ({ ...input, releaseJob: { ...releaseJob, secretEnv: {} } }), 'Workload release would be connected to a database it has no connection secret for.'],
    ['an alias on another version of the secret it is leaving', (input: GcpCloudRunEngineInput) => ({ ...input, services: [{ ...web, secretEnv: { ...web.secretEnv, OLD_DB: { secretId: own.secretId, version: '3' } } }] }),
      'Workload web would use two databases at once: OLD_DB points at another connection than DATABASE_URL.'],
    ['an alias on another version of the secret it is going to', (input: GcpCloudRunEngineInput) => ({ ...input, services: [{ ...web, secretEnv: { ...web.secretEnv, NEXT_DB: { secretId: moved.secretId, version: '2' } } }] }),
      'Workload web would use two databases at once: NEXT_DB points at another connection than DATABASE_URL.'],
    ['a connection secret that is not pinned', (input: GcpCloudRunEngineInput) => ({ ...input, workloadDatabase: { ...elsewhere, credential: { secretId: moved.secretId, version: 'latest' } } }), 'The named database needs one pinned version of its connection secret.'],
    ['two ways of naming the workloads\' database', (input: GcpCloudRunEngineInput) => ({ ...input, database: undefined, databaseConnection: elsewhere.connection }), 'A configuration names the database its workloads use in one way only.'],
  ])('refuses %s', (_what, change, message) => {
    expect(() => files(change({ ...base, database: ownInstance, workloadDatabase: elsewhere }) as GcpCloudRunEngineInput)).toThrow(message);
  });

  it('leaves the caller\'s input as it was', () => {
    const input = { ...base, database: ownInstance, workloadDatabase: elsewhere };
    const copy = JSON.stringify(input);
    files(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});
