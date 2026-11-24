/**
 * The shared database server stays behind one entry. These fail when the
 * Google planner, the workload generator or the dedicated-database module
 * learns something only the shared-database module should know, or when the
 * generated configuration for an environment starts to name the server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, type GcpCloudRunEngineInput } from '../../../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { acquireManagedDatabaseAccess } from '../../../domain/services/database-access.service.js';
import { engineEnvironmentProblems } from '../../../domain/services/infrastructure-engine-selection.js';
import { databaseSpecSchema, projectSpecSchema } from '../../../domain/spec/spec.schema.js';
import { sharedServerConfiguration, sharedServerState } from '../server.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (file: string) => readFileSync(path.join(sourceRoot, file), 'utf8');
/** Words that belong to the module alone: who administers the server, how databases are handed out, and the SQL behind it. */
const INTERNALS = /tenant|administrator|hv_admin|allocat|activeLogin|lock_timeout|listServers|inventory|CREATE (ROLE|DATABASE)|DROP (ROLE|DATABASE)|hv-shared-database|shared-database\/(?!index\.js)/i;

describe('nothing outside the module knows how the shared server works', () => {
  it.each([
    'application/infrastructure-engine.ts',
    'adapters/providers/gcp/tofu/gcp-engine.backend.ts',
    'adapters/providers/gcp/tofu/gcp-dedicated-database.ts',
    'adapters/providers/gcp/tofu/gcp-database-connection.ts',
  ])('%s mentions none of its internals', (file) => {
    expect(read(file).split('\n').filter((line) => INTERNALS.test(line))).toEqual([]);
  });

  it('recognises what it is meant to stop', () => {
    for (const line of ['await ensureTenant(server, identity)', 'const login = binding.database.activeLogin', `import { runStep } from './shared-database/tenancy.js';`, 'user: "hv_admin"', 'allocate: true']) {
      expect(INTERNALS.test(line)).toBe(true);
    }
    expect(INTERNALS.test(`import { sharedDatabase } from './shared-database/index.js';`)).toBe(false);
  });

  it('the planner reaches the module through its entry object only', () => {
    const planner = read('application/infrastructure-engine.ts');
    const uses = [...planner.matchAll(/sharedDatabase\.([A-Za-z]+)/g)].map((match) => match[1]);
    expect([...new Set(uses)].sort()).toEqual(['apply', 'handles', 'plan']);
    expect(planner.match(/from '\.\/shared-database\/[^']+'/g)).toEqual([`from './shared-database/index.js'`]);
  });

  it('the dedicated login steps are never pointed at a shared server', () => {
    // Their fixed app_a/app_b reset would change every environment's password on a shared server.
    const planner = read('application/infrastructure-engine.ts');
    expect(planner).toMatch(/databaseSpec && !placed\s*\n?\s*\? await planDatabaseCredential/);
    expect(planner).toMatch(/if \(databaseSpec && !placed\) \{\n\s+const observed = await observeDatabaseCredential/);
  });
});

describe('an environment whose database is on the shared server', () => {
  const IMAGE = `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`;
  const runtime = 'hv-runtime@demo-project.iam.gserviceaccount.com';
  const web = { logicalName: 'web', resourceName: 'web-prod', workload: 'web' as const, initialImage: IMAGE, runtimeServiceAccountEmail: runtime, public: true,
    env: {}, secretEnv: { DATABASE_URL: { secretId: 'prod-database-url', version: '4' } } };
  const input: GcpCloudRunEngineInput = { projectId: 'demo-project', region: 'us-central1', environmentId: 'ENV123', runtimeServiceAccountEmail: runtime, services: [web],
    secrets: [{ secretId: 'prod-database-url', labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env123' } }],
    databaseConnection: { connectionName: 'demo-project:us-central1:hv-demo-shared-a1b2c3', wireServices: true,
      workerQuery: { projectId: 'demo-project', instanceName: 'hv-demo-shared-a1b2c3', databaseName: 'app_production_0123456789ab' } } };

  it('has no Cloud SQL resource, address or import in its own configuration', () => {
    const configuration = buildCloudRunConfiguration(input);
    expect(JSON.stringify(configuration)).not.toMatch(/google_sql/);
    expect(Object.values(configuration.resources).map((mapping) => mapping.actionId)).not.toContain('database:postgres');
  });

  it('gives its services the literal connection name', () => {
    const text = JSON.stringify(buildCloudRunConfiguration(input));
    expect(text).toContain('{"name":"CLOUD_SQL_CONNECTION_NAME","value":"demo-project:us-central1:hv-demo-shared-a1b2c3"}');
    expect(text).toContain('"cloud_sql_instance":[{"instances":["demo-project:us-central1:hv-demo-shared-a1b2c3"]}]');
    expect(text).toContain('/cloudsql/demo-project:us-central1:hv-demo-shared-a1b2c3');
  });

  it('does not connect services before the database has a login', () => {
    const text = JSON.stringify(buildCloudRunConfiguration({ ...input, databaseConnection: { ...input.databaseConnection!, wireServices: false } }));
    expect(text).not.toContain('hv-demo-shared-a1b2c3');
  });
});

describe('the server\'s own configuration', () => {
  const scope = { projectId: 'project-1', gcpProjectId: 'demo-project', region: 'us-central1' };
  const configuration = sharedServerConfiguration({ scope, instanceName: 'hv-demo-shared-a1b2c3' });
  const file = configuration.files['shared-database.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> };
  const instance = file.resource.google_sql_database_instance!.shared as { database_version: string; deletion_protection: boolean; settings: Array<Record<string, unknown>> };

  it('is one protected PostgreSQL 16 server on the smallest size, with production\'s backups and the dedicated network posture', () => {
    expect(instance.database_version).toBe('POSTGRES_16');
    expect(instance.deletion_protection).toBe(true);
    expect(instance.settings[0]).toMatchObject({ deletion_protection_enabled: true, tier: 'db-f1-micro', edition: 'ENTERPRISE', ip_configuration: [{ ipv4_enabled: true }],
      backup_configuration: [{ enabled: true, point_in_time_recovery_enabled: true, transaction_log_retention_days: 7, backup_retention_settings: [{ retained_backups: 14, retention_unit: 'COUNT' }] }],
      user_labels: { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' } });
  });

  it('holds no login, password or database: only the server and an empty secret container', () => {
    expect(Object.keys(file.resource).sort()).toEqual(['google_secret_manager_secret', 'google_sql_database_instance']);
    expect(JSON.stringify(configuration)).not.toMatch(/password|google_sql_user|google_sql_database"|secret_data/);
  });

  it('is saved apart from every environment, once per app, Google project and region', () => {
    expect(sharedServerState(scope)).toEqual({ provider: 'gcp', projectId: 'project-1', environmentId: 'shared_database_demo-project_us-central1', partition: 'project-shared' });
    expect(sharedServerState({ ...scope, region: 'europe-west1' })).not.toEqual(sharedServerState(scope));
  });

  it('marks the server billable and data-bearing for the engine', () => {
    expect(configuration.resources['google_sql_database_instance.shared']).toMatchObject({ billable: true, dataBearing: true });
  });
});

describe('the spec field', () => {
  it('accepts app and dedicated, and nothing else', () => {
    expect(databaseSpecSchema.parse({ provider: 'cloudsql', placement: 'app' }).placement).toBe('app');
    expect(databaseSpecSchema.parse({ provider: 'cloudsql', placement: 'dedicated' }).placement).toBe('dedicated');
    expect(databaseSpecSchema.parse({ provider: 'cloudsql' }).placement).toBeUndefined();
    expect(databaseSpecSchema.safeParse({ provider: 'cloudsql', placement: 'account' }).success).toBe(false);
  });

  it.each(['aws', 'azure'])('is refused on %s with a pointer to the issue that tracks it', (provider) => {
    const spec = projectSpecSchema.parse({ version: 1, project: 'demo', environments: { production: {
      hosting: { provider, region: 'us-east-1' }, services: {}, database: { provider: provider === 'aws' ? 'aurora' : 'azure-postgres', placement: 'app' } } } });
    expect(engineEnvironmentProblems(spec, 'production').join(' ')).toMatch(/placement="app".*not yet supported.*#831/);
  });
});

describe('what is not available on the shared server yet', () => {
  it('refuses direct database access instead of signing in to the whole server', async () => {
    const environment = { id: 'env-1', name: 'production', createdAt: 'now', updatedAt: 'now', platformBindings: { provider: 'cloudrun', projectId: 'demo-project', region: 'us-central1',
      engine: { database: { instanceName: 'hv-demo-shared-a1b2c3', gcpProjectId: 'demo-project', region: 'us-central1', databaseName: 'app_production_0123456789ab', placement: 'app',
        tenantId: 'env-1', activeLogin: 'app_production_0123456789ab_a' } } } };
    const result = await acquireManagedDatabaseAccess({ id: 'project-1', name: 'demo' } as never, environment as never);
    expect(result).toMatchObject({ ok: false, code: 'no_external_access', resourceCreated: false, cleanup: 'not_needed' });
    expect((result as { error: string }).error).toMatch(/not available yet for production, whose database is on the app's shared database server/);
  });
});
