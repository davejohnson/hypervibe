import { describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, secretEngineKey } from '../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { engineOutsideKeys } from '../engine-secrets.js';
import { buildEngineInput } from '../infrastructure-engine.js';

const runtime = 'runtime@demo-project.iam.gserviceaccount.com';
const secretId = 'hv-staging-database-url';
const aliases = { POSTGRES_DB_URL: 'DATABASE_URL' };
const spec = projectSpecSchema.parse({ version: 1, project: 'invoice', environments: { staging: {
  hosting: { provider: 'cloudrun', gcpRuntimeSecretGrants: 'per-secret' },
  database: { provider: 'cloudsql', engine: 'postgres' },
  services: {
    web: { databaseEnvAliases: aliases },
    worker: { workloadKind: 'worker', databaseEnvAliases: { ...aliases, JOB_DB_URL: 'DIRECT_URL' } },
    scheduled: { workloadKind: 'cron', cronSchedule: '0 4 * * *', startCommand: 'npm run daily', databaseEnvAliases: aliases },
    reports: { workloadKind: 'cron', cronSchedule: '0 5 * * *', startCommand: 'npm run reports' },
  },
  migrations: { mode: 'releaseCommand', command: 'npx sequelize-cli db:migrate' },
} } });

function render(databaseWired: boolean, version?: string, legacyImports: string[] = []) {
  const input = buildEngineInput(spec, 'staging', {
    gcpProjectId: 'demo-project', region: 'us-west1', runtimeServiceAccountEmail: runtime, resourceNameFor: name => name,
    databaseWired, importedSecrets: legacyImports,
    secretVersions: { JOB_DB_URL: '1', ...(version ? { DATABASE_URL: version } : {}) },
  });
  const config = buildCloudRunConfiguration({ ...input, environmentId: 'env-123', runtimeServiceAccountEmail: runtime,
    secrets: [secretId, 'hv-staging-job-db-url'].map(secretId => ({ secretId, labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env-123' } })),
    database: { instanceName: 'hv-staging-db', databaseName: 'app', wireServices: databaseWired },
  });
  const files = config.files as Record<string, any>;
  const jobs = files['jobs.tf.json'].resource.google_cloud_run_v2_job;
  const urls = (container: { env?: { name: string }[] }) => container.env?.filter(entry => entry.name.endsWith('_URL')) ?? [];
  return {
    env: {
      web: urls(files['cloudrun.tf.json'].resource.google_cloud_run_v2_service.web.template[0].containers[0]),
      worker: urls(files['workerpools.tf.json'].resource.google_cloud_run_v2_worker_pool.worker.template[0].containers[0]),
      scheduled: urls(jobs.scheduled.template[0].template[0].containers[0]),
      reports: urls(jobs.reports.template[0].template[0].containers[0]),
      release: urls(jobs.release_command.template[0].template[0].containers[0]),
    },
    grants: files['secrets.tf.json'].resource.google_secret_manager_secret_iam_member ?? {},
  };
}

describe('Cloud SQL database aliases in generated Cloud Run workloads', () => {
  it.each(['3', '4'])('pins aliases to database version %s for only the services that declare them', version => {
    const { env, grants } = render(true, version);
    const key = secretEngineKey(secretId);
    const ref = (name: string) => ({ name, value_source: [{ secret_key_ref: [{ secret: '${google_secret_manager_secret.' + key + '.secret_id}', version }] }] });
    const canonical = ref('DATABASE_URL');
    const alias = ref('POSTGRES_DB_URL');
    expect(env.web).toEqual([canonical, alias]);
    expect(env.worker).toEqual([canonical, ref('JOB_DB_URL'), alias]);
    expect(env.scheduled).toEqual([canonical, alias]);
    expect(env.reports).toEqual([canonical]);
    expect(env.release).toEqual([canonical, alias]);
    expect(Object.keys(grants)).toEqual([key]);
  });

  it.each([[false, '3'], [true, undefined]] as const)('waits for both the login and its pinned version (%s, %s)', (wired, version) => {
    const { env, grants } = render(wired, version);
    expect(Object.values(env).every(entries => !entries?.length)).toBe(true);
    expect(grants).toEqual({});
  });

  it('stops serving or requesting an older imported value once its name is a database alias', () => {
    const imports = ['JOB_DB_URL'];
    expect(engineOutsideKeys(spec, 'staging', [...imports, 'PARTNER_TOKEN'])).toEqual(['PARTNER_TOKEN']);
    expect(render(true, '3', imports)).toEqual(render(true, '3'));
    expect(render(false, undefined, imports)).toEqual(render(false));
  });
});
