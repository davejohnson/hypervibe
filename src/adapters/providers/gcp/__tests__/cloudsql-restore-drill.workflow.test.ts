import { describe, expect, it } from 'vitest';
import {
  buildCloudSqlRestoreDrillWorkflow,
  CLOUDSQL_RESTORE_DRILL_SCRIPT_PATH,
  cloudSqlRestoreDrillScript,
} from '../cloudsql-restore-drill.workflow.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const target = {
  environmentName: 'production',
  projectId: 'gcp-project',
  region: 'us-central1',
  sourceInstanceId: 'production-postgres',
  sourceConnectionName: 'gcp-project:us-central1:production-postgres',
  databaseName: 'app',
  schedule: { cron: '15 5 * * 1', timezone: 'America/Vancouver' },
  credentialsSecretName: 'HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS',
  verificationQuery: 'SELECT count(*) FROM users',
  restoreLagMinutes: 10,
  retainFailedInstanceDays: 3,
};

describe('Cloud SQL restore-drill workflow', () => {
  it('compiles a timezone-aware scheduled workflow without embedding credentials or SQL', () => {
    const compiled = buildCloudSqlRestoreDrillWorkflow(target);
    const workflow = compiled.files.find((file) => file.path.endsWith('.yml'))?.content ?? '';
    const script = compiled.files.find((file) => file.path === CLOUDSQL_RESTORE_DRILL_SCRIPT_PATH)?.content ?? '';

    expect(compiled.requiredSecrets).toEqual(['HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS']);
    expect(workflow).toContain('name: "Hypervibe / db-restore-drill-production"');
    expect(workflow).toContain('cron: "15 5 * * 1"');
    expect(workflow).toContain('timezone: "America/Vancouver"');
    expect(workflow).toContain('${{ secrets.HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS }}');
    expect(workflow).toContain('$RUNNER_TEMP/hypervibe-cloudsql-restore-drill');
    expect(workflow).toContain('@google-cloud/cloud-sql-connector@1.10.0 pg@8.17.2');
    expect(workflow.indexOf('HYPERVIBE_DRILL_CREDENTIALS:')).toBeGreaterThan(workflow.indexOf('npm install'));
    expect(workflow).not.toContain(target.verificationQuery);
    expect(workflow).not.toContain('private_key');
    const encodedConfig = workflow.match(/HYPERVIBE_DRILL_CONFIG_B64: "([A-Za-z0-9+/=]+)"/)?.[1];
    expect(encodedConfig).toBeTruthy();
    const decodedConfig = JSON.parse(Buffer.from(encodedConfig!, 'base64').toString('utf8'));
    expect(decodedConfig).toEqual({
      projectId: 'gcp-project',
      region: 'us-central1',
      sourceInstanceId: 'production-postgres',
      sourceConnectionName: 'gcp-project:us-central1:production-postgres',
      databaseName: 'app',
      verificationQuery: 'SELECT count(*) FROM users',
      restoreLagMinutes: 10,
      retainFailedInstanceDays: 3,
    });
    expect(JSON.stringify(decodedConfig)).not.toMatch(/postgresql:\/\/|password|private_key/i);
    expect(script).toBe(cloudSqlRestoreDrillScript());
  });

  it('pins isolation, ownership, read-only verification, and terminal cleanup invariants', () => {
    const script = cloudSqlRestoreDrillScript();

    expect(() => new AsyncFunction(script.replace(/^import .*;$/gm, ''))).not.toThrow();

    expect(script).toContain("name === config.sourceInstanceId");
    expect(script).toContain("name.startsWith(namePrefix)");
    expect(script).toContain("'hypervibe-drill': 'true'");
    expect(script).toContain("labels['hypervibe-source'] === ownershipLabels['hypervibe-source']");
    expect(script).toContain('destinationInstanceName: targetName, pointInTime');
    expect(script).toContain("await client.query('BEGIN TRANSACTION READ ONLY')");
    expect(script).toContain('await waitForAbsence(instance.name)');
    expect(script).toContain('Retained failed drill instance');
    expect(script).toContain('current-run unlabeled clone cleanup');
    expect(script).toContain("process.stdout.write('::add-mask::'");
    expect(script).toContain("mode: 0o600");
    expect(script).toContain("delete process.env.HYPERVIBE_DRILL_CREDENTIALS");
  });
});
