/**
 * Recovery DG-011: ordinary infrastructure keeps existing native protection.
 * Uses the real pinned engine. Cloud SQL opt-in plans refresh the Google provider
 * against a local, read-only API fixture. Creation/default tests mock the providers.
 * https://opentofu.org/docs/v1.13/cli/commands/test/
 * https://opentofu.org/docs/v1.13/language/resources/behavior/
 * https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/configure-pitr
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, gcpEngineBackend } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
import { reviewDedicatedBackupPlan } from '../../../providers/gcp/tofu/gcp-dedicated-database.js';
import { buildAwsSharedConfiguration } from '../../../providers/aws/tofu/aws-engine.config.js';
import { awsEngineBackend } from '../../../providers/aws/tofu/aws-engine.backend.js';
import { buildAzureSharedConfiguration } from '../../../providers/azure/tofu/azure-engine.config.js';
import { azureEngineBackend } from '../../../providers/azure/tofu/azure-engine.backend.js';
import { fullSharedInput } from '../../../providers/azure/tofu/__tests__/azure-fixtures.js';
import type { InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import { gcpDatabaseShape } from '../../../../application/gcp-database-shape.js';
import { ensureEngineBinary } from '../install.js';
import { materializeWorkingDirectory } from '../workspace.js';
import { engineProcessEnv, runTofu } from '../runner.js';
import { parseEnginePlan, translateEnginePlan } from '../plan-mapping.js';

const execFileAsync = promisify(execFile);

describe('ordinary database retention plans (real engine, mocked cloud)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-retention-plan-'));
  let binary: string;
  beforeAll(async () => {
    const previous = process.env.HYPERVIBE_DATA_DIR;
    process.env.HYPERVIBE_DATA_DIR = directory;
    try {
      const installed = await ensureEngineBinary();
      if (!installed.ok) throw new Error(installed.error);
      binary = installed.binary;
    } finally {
      if (previous === undefined) delete process.env.HYPERVIBE_DATA_DIR;
      else process.env.HYPERVIBE_DATA_DIR = previous;
    }
  }, 300_000);
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function checkPlan(provider: string, backend: InfrastructureEngineBackend, resource: Record<string, unknown>, assertions: string,
    freshAssertions = '', output: Record<string, unknown> = {}, expectFailure = false) {
    const work = materializeWorkingDirectory({ parent: directory, requirements: backend.providerRequirements,
      configuration: { resources: {}, files: { 'database.tf.json': {
        variable: { seed: { type: 'bool', default: false }, previous: { type: 'any', default: null } }, resource,
        ...(Object.keys(output).length ? { output } : {}),
      } } } });
    fs.writeFileSync(path.join(work, 'retention.tftest.hcl'), `
mock_provider "${provider}" {}
run "new_database" {
  command = plan
  ${freshAssertions}
}
run "existing" {
  command = apply
  variables { seed = true }
}
run "ordinary_plan" {
  command = plan
  ${Object.keys(output).length ? 'variables { previous = run.existing.backup_policy }' : ''}
  ${expectFailure ? 'expect_failures = [google_sql_database_instance.db]' : ''}
  ${assertions}
}
`);
    const env: Record<string, string> = process.env.TF_PLUGIN_CACHE_DIR ? { TF_PLUGIN_CACHE_DIR: process.env.TF_PLUGIN_CACHE_DIR } : {};
    const init = await runTofu({ kind: 'init' }, { binary, workingDirectory: work, env, redact: [], timeoutMs: 300_000 });
    expect(init.exitCode, init.stderr || init.stdout).toBe(0);
    const result = await execFileAsync(binary, ['test', '-no-color'], { cwd: work, env: engineProcessEnv(env), timeout: 300_000 })
      .then(value => ({ exitCode: 0, output: value.stdout + value.stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({ exitCode: error.code, output: error.stdout + error.stderr }));
    expect(result.exitCode, result.output).toBe(0);
  }

  function gcpConfiguration(size?: 'medium', automatedBackups?: true, adopt?: boolean) {
    const shape = gcpDatabaseShape('production', { provider: 'cloudsql', engine: 'postgres', ...(size ? { size } : {}) });
    return buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', environmentId: 'env-1', services: [],
      ...(adopt ? { adopt: { databaseInstance: 'existing-production-db' } } : {}),
      database: { instanceName: 'existing-production-db', databaseName: 'app', wireServices: false, ...shape, automatedBackups } });
  }

  function gcpInstance(size?: 'medium', automatedBackups?: true, adopt?: boolean) {
    const configuration = gcpConfiguration(size, automatedBackups, adopt);
    const sql = configuration.files['cloudsql.tf.json'] as { resource: { google_sql_database_instance: { db: Record<string, any> } } };
    return structuredClone(sql.resource.google_sql_database_instance.db);
  }

  it('reviews the backup tier and switch returned by the real Google provider before approving an existing instance', async () => {
    const name = 'existing-production-db';
    const project = 'demo-project';
    const region = 'us-central1';
    const id = `projects/${project}/instances/${name}`;
    let backupTier = 'STANDARD';
    let enabled = false;
    const ownerLabels: Record<string, string> = { 'managed-by': 'hypervibe', 'hv-environment': 'env-1' };
    const scope = { projectId: project, region, environmentId: 'env-1' };
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' || !new URL(request.url!, 'http://localhost').pathname.endsWith(`/${id}`)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name, project, region, connectionName: `${project}:${region}:${name}`, databaseVersion: 'POSTGRES_16', instanceType: 'CLOUD_SQL_INSTANCE', state: 'RUNNABLE',
        settings: { tier: 'db-custom-1-3840', edition: 'ENTERPRISE', availabilityType: enabled ? 'REGIONAL' : 'ZONAL', deletionProtectionEnabled: true,
          ipConfiguration: { ipv4Enabled: true }, userLabels: ownerLabels,
          retainBackupsOnDelete: true, finalBackupConfig: { enabled: true, retentionDays: 30 },
          backupConfiguration: { enabled, backupTier, startTime: '04:00', location: 'us-east4', pointInTimeRecoveryEnabled: enabled,
            transactionLogRetentionDays: 5, backupRetentionSettings: { retainedBackups: 30, retentionUnit: 'COUNT' } } },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const work = materializeWorkingDirectory({ parent: directory, requirements: gcpEngineBackend.providerRequirements, configuration: { resources: {}, files: {
        'database.tf.json': { resource: { google_sql_database_instance: { db: gcpInstance(undefined, true) } } },
        'provider.tf.json': { provider: { google: [{ project, region, sql_custom_endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sql/v1beta4/` }] } },
      } } });
      fs.writeFileSync(path.join(work, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, resources: [{ mode: 'managed', type: 'google_sql_database_instance', name: 'db',
        provider: 'provider["registry.opentofu.org/hashicorp/google"]', instances: [{ schema_version: 0, attributes: { id, project, name, region, deletion_protection: true } }] }] }));
      const initEnv: Record<string, string> = {};
      for (const key of ['TF_CLI_CONFIG_FILE', 'TF_PLUGIN_CACHE_DIR']) if (process.env[key]) initEnv[key] = process.env[key];
      const options = { binary, workingDirectory: work, redact: [], timeoutMs: 300_000 };
      const init = await runTofu({ kind: 'init' }, { ...options, env: initEnv });
      expect(init.exitCode, init.stderr).toBe(0);
      const env = { GOOGLE_OAUTH_ACCESS_TOKEN: 'synthetic', GCE_METADATA_HOST: '127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' };
      const segment = { id: 'opentofu:database', engine: 'opentofu' as const, planDigest: 'p', configurationDigest: 'c', engineVersion: '1.13.9', providerVersions: {} };
      const planDocument = async () => {
        const plan = await runTofu({ kind: 'plan', out: 'test.tfplan' }, { ...options, env });
        expect([0, 2], plan.stderr || plan.stdout).toContain(plan.exitCode);
        const shown = await runTofu({ kind: 'show-plan', planFile: 'test.tfplan' }, { ...options, env });
        expect(shown.exitCode, shown.stderr).toBe(0);
        return JSON.parse(shown.stdout);
      };
      for (const [tier, wasEnabled] of [['STANDARD', false], ['STANDARD', true], ['ENHANCED', false], ['', false]] as const) {
        backupTier = tier;
        enabled = wasEnabled;
        const document = await planDocument();
        const review = reviewDedicatedBackupPlan(document, name, scope);
        if (tier !== 'STANDARD') {
          expect(review).toEqual({ blocked: expect.stringMatching(/could not confirm the standard backup tier/i) });
          continue;
        }
        const { before, after, actions } = document.resource_changes[0].change;
        expect(review).toEqual({ instance: 'existing' });
        if (!wasEnabled) {
          expect(actions).toEqual(['update']);
          const translated = translateEnginePlan({ provider: 'gcp', configuration: gcpConfiguration(undefined, true), segment, parsed: parseEnginePlan(JSON.stringify(document)) });
          expect(translated.actions).toMatchObject([{ id: 'database:postgres', billable: true, requiresConfirm: true,
            diff: expect.arrayContaining([{ field: 'google_sql_database_instance.settings.0.backup_configuration.0.enabled' }]) }]);
        }
        expect(after.settings[0].backup_configuration[0]).toEqual({ ...before.settings[0].backup_configuration[0], enabled: true });
        expect(after.settings[0].retain_backups_on_delete).toBe(true);
        expect(after.settings[0].final_backup_config).toEqual(before.settings[0].final_backup_config);
        expect(after.settings[0].availability_type).toBe(before.settings[0].availability_type);
        for (const wrong of [{ projectId: 'other-project' }, { region: 'europe-west1' }, { environmentId: 'other-env' }]) {
          expect(reviewDedicatedBackupPlan(document, name, { ...scope, ...wrong })).toEqual({ blocked: expect.stringMatching(/ownership|verify/i) });
        }
      }
      // State was lost after a create. An import may carry an update in OpenTofu JSON, yet the public translator
      // represents it as adoption. Require an actual import-only plan, then review enabling backups separately.
      backupTier = 'STANDARD';
      enabled = false;
      const adopt = gcpConfiguration(undefined, true, true);
      fs.writeFileSync(path.join(work, 'terraform.tfstate'), JSON.stringify({ version: 4, serial: 1, resources: [] }));
      fs.writeFileSync(path.join(work, 'imports.tf.json'), JSON.stringify(adopt.files['imports.tf.json']));
      fs.writeFileSync(path.join(work, 'database.tf.json'), JSON.stringify({ resource: { google_sql_database_instance: { db: gcpInstance(undefined, true, true) } } }));
      const imported = await planDocument();
      const change = imported.resource_changes[0].change;
      expect(change.importing).toMatchObject({ id });
      expect(change.actions).toEqual(['no-op']);
      expect(change.after.settings[0].backup_configuration[0].enabled).toBe(false);
      expect(reviewDedicatedBackupPlan(imported, name, scope)).toEqual({ instance: 'adopt' });
      const translated = translateEnginePlan({ provider: 'gcp', configuration: adopt, segment, parsed: parseEnginePlan(JSON.stringify(imported)) });
      expect(translated.actions).toMatchObject([{ id: 'database:postgres', requiresConfirm: true, metadata: { engineAdopt: true } }]);
      ownerLabels['hv-shared-database'] = 'demo';
      expect(reviewDedicatedBackupPlan(await planDocument(), name, scope)).toEqual({ blocked: expect.stringMatching(/ownership|verify/i) });
      fs.writeFileSync(path.join(work, 'imports.tf.json'), '{}');
      fs.writeFileSync(path.join(work, 'database.tf.json'), JSON.stringify({ resource: { google_sql_database_instance: { db: gcpInstance(undefined, true) } } }));
      expect(reviewDedicatedBackupPlan(await planDocument(), name, scope)).toEqual({ instance: 'create' });
    } finally {
      server.close();
    }
  }, 300_000);

  it('blocks the actual Enterprise-only default size for an existing Enterprise Plus database', async () => {
    const instance = gcpInstance();
    const backup = instance.settings[0].backup_configuration[0];
    // Seed an independently specified existing database; the second run uses the
    // exact ordinary defaults emitted above, through the same resource address.
    backup.backup_retention_settings[0].retained_backups = `\${var.seed ? 30 : ${backup.backup_retention_settings[0].retained_backups}}`;
    backup.transaction_log_retention_days = `\${var.seed ? 14 : ${backup.transaction_log_retention_days}}`;
    instance.settings[0].edition = `\${var.seed ? "ENTERPRISE_PLUS" : ${JSON.stringify(instance.settings[0].edition)}}`;
    // Seed a valid Plus instance; the ordinary branch keeps the compiler's real
    // db-custom size, which cannot be used with the retained Plus edition.
    instance.settings[0].tier = `\${var.seed ? "db-perf-optimized-N-2" : ${JSON.stringify(instance.settings[0].tier)}}`;
    await checkPlan('google', gcpEngineBackend, { google_sql_database_instance: { db: instance } }, '', `
  assert {
    condition = google_sql_database_instance.db.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 14
    error_message = "A new database still receives its reviewed creation default."
  }
`, {}, true);
  }, 300_000);

  it('preserves 30 existing Cloud SQL backups while allowing a supported Enterprise resize', async () => {
    const instance = gcpInstance('medium');
    const backup = instance.settings[0].backup_configuration[0];
    backup.backup_retention_settings[0].retained_backups = `\${var.seed ? 30 : ${backup.backup_retention_settings[0].retained_backups}}`;
    instance.settings[0].tier = `\${var.seed ? "db-custom-1-3840" : ${JSON.stringify(instance.settings[0].tier)}}`;
    await checkPlan('google', gcpEngineBackend, { google_sql_database_instance: { db: instance } }, `
  assert {
    condition = google_sql_database_instance.db.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 30
    error_message = "A supported resize must preserve all 30 retained backups."
  }
  assert {
    condition = google_sql_database_instance.db.settings[0].tier == "db-custom-2-7680"
    error_message = "Backup preservation must not disable supported database sizing."
  }
`);
  }, 300_000);

  it('does not replace unreported Cloud SQL retention fields with environment defaults', async () => {
    const instance = gcpInstance();
    const backup = instance.settings[0].backup_configuration[0];
    const retentionSettings = backup.backup_retention_settings[0];
    delete backup.backup_retention_settings;
    backup.dynamic = { backup_retention_settings: {
      for_each: '${var.seed ? [] : [1]}', content: retentionSettings,
    } };
    backup.transaction_log_retention_days = `\${var.seed ? null : ${backup.transaction_log_retention_days}}`;
    await checkPlan('google', gcpEngineBackend, { google_sql_database_instance: { db: instance } }, `
  assert {
    condition = length(google_sql_database_instance.db.settings[0].backup_configuration[0].backup_retention_settings) == 0
    error_message = "Missing retention evidence must not authorize imposing a default."
  }
  assert {
    condition = google_sql_database_instance.db.settings[0].backup_configuration[0].transaction_log_retention_days == var.previous.transaction_log_retention_days
    error_message = "Missing PITR evidence must not authorize imposing a default."
  }
`, '', { backup_policy: { value: '${google_sql_database_instance.db.settings[0].backup_configuration[0]}' } });
  }, 300_000);

  it('keeps existing AWS cluster backup retention', async () => {
    const configuration = buildAwsSharedConfiguration({ accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-shared',
      environmentId: 'shared-testing', database: { engineVersion: '18.6', minCapacity: 0, maxCapacity: 2 } });
    const database = configuration.files['database.tf.json'] as { resource: { aws_rds_cluster: { postgres: Record<string, unknown> } } };
    const cluster = structuredClone(database.resource.aws_rds_cluster.postgres);
    // Replace unrelated graph references with synthetic existing identifiers.
    cluster.db_subnet_group_name = 'existing-subnets';
    cluster.vpc_security_group_ids = ['sg-0123456789abcdef0'];
    cluster.db_cluster_parameter_group_name = 'existing-parameters';
    cluster.backup_retention_period = `\${var.seed ? 30 : ${cluster.backup_retention_period}}`;
    await checkPlan('aws', awsEngineBackend, { aws_rds_cluster: { postgres: cluster } }, `
  assert {
    condition = aws_rds_cluster.postgres.backup_retention_period == 30
    error_message = "Ordinary AWS plans must preserve the existing retention window."
  }
`, `
  assert {
    condition = aws_rds_cluster.postgres.engine == "aurora-postgresql" && aws_rds_cluster.postgres.backup_retention_period == 1
    error_message = "A new managed cluster must use native Aurora backups."
  }
`);
  }, 300_000);

  it('keeps existing Azure retention and redundant backups', async () => {
    const configuration = buildAzureSharedConfiguration(fullSharedInput);
    const database = configuration.files['database.tf.json'] as { resource: { azurerm_postgresql_flexible_server: { postgres: Record<string, unknown> } } };
    const server = structuredClone(database.resource.azurerm_postgresql_flexible_server.postgres);
    // A synthetic write-only password replaces only the unrelated ephemeral generator.
    server.administrator_password_wo = 'Synthetic-password-for-mocked-provider-123';
    server.backup_retention_days = `\${var.seed ? 30 : ${server.backup_retention_days}}`;
    server.geo_redundant_backup_enabled = `\${var.seed ? true : ${server.geo_redundant_backup_enabled}}`;
    await checkPlan('azurerm', azureEngineBackend, { azurerm_postgresql_flexible_server: { postgres: server } }, `
  assert {
    condition = azurerm_postgresql_flexible_server.postgres.backup_retention_days == 30
    error_message = "Ordinary Azure plans must preserve the existing retention window."
  }
  assert {
    condition = azurerm_postgresql_flexible_server.postgres.geo_redundant_backup_enabled
    error_message = "Ordinary Azure plans must preserve geo-redundant backups."
  }
`, `
  assert {
    condition = azurerm_postgresql_flexible_server.postgres.backup_retention_days == 7
    error_message = "A new Flexible Server must retain seven days of native backups."
  }
`);
  }, 300_000);
});
