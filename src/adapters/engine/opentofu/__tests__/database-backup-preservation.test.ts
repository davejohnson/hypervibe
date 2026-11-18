/**
 * Recovery DG-011: ordinary infrastructure keeps existing native protection.
 * Runs the real pinned engine/provider schemas; provider operations are mocked,
 * so these reconstructed settings exercise planning without any cloud writes.
 * https://opentofu.org/docs/v1.13/cli/commands/test/
 * https://opentofu.org/docs/v1.13/language/resources/behavior/
 * https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/configure-pitr
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, gcpEngineBackend } from '../../../providers/gcp/tofu/gcp-engine.backend.js';
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

  function gcpInstance(size?: 'medium') {
    const shape = gcpDatabaseShape('production', { provider: 'cloudsql', engine: 'postgres', ...(size ? { size } : {}) });
    const configuration = buildCloudRunConfiguration({ projectId: 'demo-project', region: 'us-central1', services: [],
      database: { instanceName: 'existing-production-db', databaseName: 'app', wireServices: false, ...shape } });
    const sql = configuration.files['cloudsql.tf.json'] as { resource: { google_sql_database_instance: { db: Record<string, any> } } };
    return structuredClone(sql.resource.google_sql_database_instance.db);
  }

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
`);
  }, 300_000);
});
