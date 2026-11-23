/**
 * Upgrade safety (workflow DG-137): the Google configuration an existing app
 * gets must not change when the generator's internals move. OpenTofu's plan is
 * a function of configuration and state, so identical configuration, address
 * mappings and imports mean an unchanged app still plans to no changes.
 *
 * The recorded output was captured from the generator before the database
 * resources moved into their own module. Regenerate only for an intended,
 * reviewed change to generated output:
 *   UPDATE_DATABASE_SEAM_BASELINE=1 npx vitest run src/adapters/providers/gcp/tofu/__tests__/database-seam.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCloudRunConfiguration, type GcpCloudRunEngineInput } from '../gcp-engine.backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'database-seam.baseline.json');
const IMAGE = `us-docker.pkg.dev/demo-project/app/web@sha256:${'a'.repeat(64)}`;
const runtime = 'hv-runtime@demo-project.iam.gserviceaccount.com';
const web = { logicalName: 'web', resourceName: 'web-prod', workload: 'web' as const, initialImage: IMAGE, runtimeServiceAccountEmail: runtime, public: true,
  env: { NODE_ENV: 'production' }, secretEnv: { DATABASE_URL: { secretId: 'prod-database-url', version: '4' } } };
const worker = { logicalName: 'jobs', resourceName: 'jobs-prod', workload: 'worker' as const, initialImage: IMAGE, runtimeServiceAccountEmail: runtime, public: false,
  pendingWorkQuery: 'SELECT count(*) FROM "PendingWork"' };
const base = { projectId: 'demo-project', region: 'us-central1', environmentId: 'ENV123', runtimeServiceAccountEmail: runtime,
  secrets: [{ secretId: 'prod-database-url', labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env123' } }] };
const database = { instanceName: 'hv-demo-db-a1', databaseName: 'app' };

const cases: Record<string, GcpCloudRunEngineInput> = {
  'no database': { ...base, services: [web] },
  'database before its login exists': { ...base, services: [web], database: { ...database, wireServices: false } },
  'database wired to a web service': { ...base, services: [web], database: { ...database, wireServices: true } },
  'production settings': { ...base, services: [web], database: { ...database, wireServices: true, tier: 'db-custom-1-3840', deletionProtection: true, retainedBackups: 14, transactionLogDays: 7, majorVersion: 17 } },
  'on-demand worker': { ...base, services: [web, worker], database: { ...database, wireServices: true } },
  'adopting an interrupted create': { ...base, services: [web], database: { ...database, wireServices: false }, adopt: { databaseInstance: database.instanceName, secrets: ['prod-database-url'] } },
  'database removed from the spec': { ...base, services: [web], retiredDatabase: true },
  'database with storage, a release job and a retired service': { ...base, services: [web], database: { ...database, wireServices: true },
    storage: [{ name: 'uploads', bucketName: 'hv-demo-uploads-a1', location: 'US', injectInto: ['web'] }], adopt: { buckets: ['uploads'], databaseInstance: database.instanceName },
    releaseJob: { ...web, logicalName: 'release', resourceName: 'release-prod', public: false, jobCommand: 'npm run migrate' }, retiredServices: ['old'] },
};

function render(input: GcpCloudRunEngineInput): string {
  try { return JSON.stringify(buildCloudRunConfiguration(input)); } catch (error) { return `threw: ${(error as Error).message}`; }
}

describe('Google configuration is unchanged by the database seam', () => {
  const rendered = Object.fromEntries(Object.entries(cases).map(([name, input]) => [name, render(input)]));
  if (process.env.UPDATE_DATABASE_SEAM_BASELINE) writeFileSync(baselinePath, `${JSON.stringify(rendered, null, 1)}\n`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, string>;

  it.each(Object.keys(cases))('%s', (name) => {
    expect(rendered[name]).toBe(baseline[name]);
  });

  it('reports the same problem first when several inputs are wrong', () => {
    expect(render({ ...base, services: [web], adopt: { databaseInstance: 'other', secrets: ['not-desired'] } })).toBe('threw: Only a desired secret container can be adopted.');
    expect(render({ ...base, services: [web], database: { ...database, wireServices: false }, adopt: { databaseInstance: 'other' },
      releaseJob: { ...web, logicalName: 'release', resourceName: 'release-prod', public: false, jobCommand: '' } })).toBe('threw: Scheduled job release needs an explicit command (startCommand).');
    expect(render({ ...base, services: [web], adopt: { databaseInstance: 'other' } })).toBe('threw: Only the desired database instance can be adopted.');
  });

  it('covers every recorded case and none of them failed to render', () => {
    expect(Object.keys(baseline).sort()).toEqual(Object.keys(cases).sort());
    expect(Object.values(baseline).filter((value) => value.startsWith('threw:'))).toEqual([]);
  });
});

describe('the workload generator cannot tell where a database comes from', () => {
  const source = readFileSync(path.join(here, '..', 'gcp-engine.backend.ts'), 'utf8');

  it('names no Cloud SQL resource; those live in the database module', () => {
    expect(source).not.toMatch(/google_sql/);
  });

  it('reads the database input only to hand it to the database module', () => {
    const readers = source.split('\n').filter((line) => /input\.(database|retiredDatabase)\b|adopt\?\.databaseInstance/.test(line));
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((line) => !/dedicatedDatabase(Connection|Imports)?\(|retired: input\.retiredDatabase/.test(line))).toEqual([]);
  });

  it('gives services a database through the connection alone', () => {
    expect(readFileSync(path.join(here, '..', 'gcp-database-connection.ts'), 'utf8')).not.toMatch(/tier|deletion|backup|adopt|shared|pool|dedicated/i);
  });
});
