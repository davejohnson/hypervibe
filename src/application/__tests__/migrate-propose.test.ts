import { describe, expect, it } from 'vitest';
import { pointsAtSourceData, proposeTargetEnvironment, scopedToEnvironment } from '../migrate.js';
import type { EnvironmentSpec } from '../../domain/spec/spec.schema.js';

describe('proposed migration target', () => {
  it('preserves the database variable names each workload reads', () => {
    const source = {
      hosting: { provider: 'railway' }, database: { provider: 'railway' }, envVars: {},
      services: {
        web: { workloadKind: 'web', databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' } },
        worker: { workloadKind: 'worker', databaseEnvAliases: { WORKER_DB: 'DIRECT_URL' } },
        hourly: { workloadKind: 'cron', cronSchedule: '0 * * * *', startCommand: 'npm run hourly', databaseEnvAliases: { JOB_DB: 'DATABASE_URL' } },
        other: { workloadKind: 'web' },
      },
    } as unknown as EnvironmentSpec;
    const target = proposeTargetEnvironment(source, {});
    for (const [name, service] of Object.entries(source.services)) {
      expect(target.services[name]?.databaseEnvAliases).toEqual(service.databaseEnvAliases);
    }
  });

  it('maps a Railway environment onto OpenTofu-managed Google Cloud equivalents', () => {
    const source = {
      hosting: { provider: 'railway', region: 'us-west1' },
      services: {
        'staging-web': { workloadKind: 'web', startCommand: 'npm start', healthCheckPath: '/', public: true },
        'staging-worker': { workloadKind: 'worker', startCommand: 'npm run worker', public: false },
      },
      database: { provider: 'railway', engine: 'postgres' },
      domain: 'staging.example.com',
      envVars: { APP_URL: 'https://staging.example.com', NODE_ENV: 'production' },
      migrations: { mode: 'releaseCommand', command: 'npm run migrate' },
      storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['staging-web', 'staging-worker'] } },
      email: { enabled: true },
    } as unknown as EnvironmentSpec;
    const target = proposeTargetEnvironment(source, { domain: 'gcp.example.com' }) as unknown as Record<string, any>;
    expect(target.hosting).toEqual({ provider: 'cloudrun', region: 'us-central1' });
    expect(target.database).toEqual({ provider: 'cloudsql' });
    expect(target.storage.documents).toEqual({ provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: ['staging-web', 'staging-worker'], access: 's3' });
    expect(target.envVars.APP_URL).toBe('https://gcp.example.com');
    expect(target.migrations).toEqual({ mode: 'releaseCommand', command: 'npm run migrate' });
    expect(target.domain).toBe('gcp.example.com');
    // Features the engine cannot manage yet are not silently carried over.
    expect(target.email).toBeUndefined();
    expect(Object.keys(target.services)).toEqual(['staging-web', 'staging-worker']);
  });

  it('requests native database backups when moving a database with a daily backup policy', () => {
    const source = { hosting: { provider: 'railway' }, services: {}, envVars: {},
      database: { provider: 'railway', engine: 'postgres' }, backups: { mode: 'daily' } } as EnvironmentSpec;
    const proposal = proposeTargetEnvironment(source, {});
    expect(proposal.database).toEqual({ provider: 'cloudsql', automatedBackups: true });
    expect(proposal.backups).toBeUndefined();
    expect(proposeTargetEnvironment({ ...source, database: undefined }, {}).database).toBeUndefined();
  });
});

// Contract: a migration must not silently drop how the app's schema is migrated.
// The engine runs migrations as a release step, so a source that ran them through
// the migration tool keeps its command in that form.
describe('proposed migration target keeps schema migrations', () => {
  const propose = (migrations: unknown) => proposeTargetEnvironment({
    hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web', startCommand: 'sh scripts/start.sh' } },
    database: { provider: 'railway', engine: 'postgres' }, envVars: {}, email: { enabled: false }, migrations,
  } as unknown as EnvironmentSpec, {}) as unknown as Record<string, any>;

  it('carries a tool-mode migration command over as a release command', () => {
    expect(propose({ mode: 'tool', command: 'alembic upgrade head' }).migrations).toEqual({ mode: 'releaseCommand', command: 'alembic upgrade head' });
  });

  it('keeps a release command as it is and invents nothing when there is no command', () => {
    expect(propose({ mode: 'releaseCommand', command: 'npm run migrate', runInDeploy: true }).migrations).toEqual({ mode: 'releaseCommand', command: 'npm run migrate', runInDeploy: true });
    expect(propose({ mode: 'tool' }).migrations).toBeUndefined();
    expect(propose({ mode: 'none' }).migrations).toBeUndefined();
    expect(propose(undefined).migrations).toBeUndefined();
  });
});

describe('migrated settings', () => {
  it('never copies a setting that points at the source database or cache, whatever its name', () => {
    expect(pointsAtSourceData('postgresql://user:pw@roundhouse.proxy.rlwy.net:5432/railway')).toBe(true);
    expect(pointsAtSourceData('rediss://default:pw@host:6379')).toBe(true);
    expect(pointsAtSourceData('https://api.anthropic.com')).toBe(false);
    expect(pointsAtSourceData('sk-ant-abc')).toBe(false);
  });

  it('leaves settings named for the source environment behind', () => {
    expect(scopedToEnvironment('STAGING_AUTH_TEST_INBOX_TOKEN', 'staging')).toBe(true);
    expect(scopedToEnvironment('PREVIEW_APP_TOKEN', 'preview-app')).toBe(true);
    expect(scopedToEnvironment('PRODUCTION_KEY', 'staging')).toBe(false);
    expect(scopedToEnvironment('PREVIEW_APP_TOKEN', 'preview')).toBe(true);
    expect(scopedToEnvironment('SESSION_SECRET', 'staging')).toBe(false);
  });
});
