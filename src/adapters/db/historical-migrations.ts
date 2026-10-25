import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// These fingerprints describe preserved additive historical objects, not migrations
// to replay. Provenance and the full independently recorded definitions are in
// __tests__/fixtures/historical-migration-objects.json and docs/local-state-migrations.md.
// A version number alone never establishes compatibility with a divergent branch.
const historicalMigrations = [
  {
    version: 11, name: 'companion_read_model_v1',
    objects: {
      companion_dirty_sources: '1d6adc707369a3d8118fa9db051ce9772015bbb025e8635d30cd83a8947fed1d',
      companion_environments: '9a80d0111d40d32634138c259a2d4d6d20c8e78e246e17042def8e22b2f145d2',
      companion_meta: 'a46ccf8cfbe81ae0d877d7e526d552e291d69a0819209142fb76c8620a592077',
      companion_plans: '53a25910f010bcf6e04879ec1bea39c0e0a63359c5097c245bdaeddc7b7914e0',
      companion_runs: '14fe0cb7791a9c9de456324f95bc1ff6cdba03f62e6d5aea7514c991ffffb8ec',
      idx_companion_plans_applicability: '8a7d0d3df6031f925daa8e2508a72dbb1123360ddc18ea105a9b3dcfc091e7f3',
      idx_companion_plans_environment: '5aa48a52c55c11f3d84c1d8dc6f8a7895c571dd0246a97f7e9475db35a1edd72',
      idx_companion_runs_environment: '099c3ab22170b48ba6e7b8aa6dcbbb18ed54163bd58e82ef1123e5cbd8a264ce',
      idx_companion_runs_status: 'fe5b0f201c46ddacc4d527c873f1d930177501b5042fe9d73492422b774ffdfd',
      companion_dirty_components_delete: '3db9f5fac0051c501e00f8348950d81f4c574912b2774f3d1124ab3b2cc0b2b6',
      companion_dirty_components_insert: '18c30244c173f6cce8c002369c9073814786d1e8f72aa6768b733eafd9866c72',
      companion_dirty_components_update: 'd4cd896f04b498396103d1c128172d5cd6250958f46c009592e977b4e9156595',
      companion_dirty_connections_delete: 'b97d1ada515f8427c7d54737fcfa0865c4869c1cb62649a4b3d47223edd250a9',
      companion_dirty_connections_insert: '6e791fdbd0db0048e46e46253aa054bffa723210d5ab16061c54a0f69967bf18',
      companion_dirty_connections_update: 'a37c21b8f4f60e861048e6c8606ea3adcb21824184b3fa6d2dde484560656ff6',
      companion_dirty_environments_delete: '2bc74db27a225ca970353644dbab1493b95c6f4440f6c5d82687af2b29ba109d',
      companion_dirty_environments_insert: '5d69580e91a353af2741119679074d13e7c1de3fc26bdc13c5090e408d38def6',
      companion_dirty_environments_update: 'ee7be0c431569c55e48d489edcec17f899c8d019cae5178da518547206d81a8d',
      companion_dirty_project_specs_delete: '0c2b738d29ea0af61f5969f25b7cdb050e497a25f999c07cf40d24cb04bc68bc',
      companion_dirty_project_specs_insert: 'fc077cd30dd3ee5931786abfbe57d07ab11b40afa5578ea95c20373b6a719fbf',
      companion_dirty_project_specs_update: '121b0e40a79e07150411561430f6681bab7e934e1d8c207fb4a2e45bc8768d72',
      companion_dirty_projects_delete: '4f4774ceab665294e3f3d068793a73109265198b8d4dba06ce585df02c9564c9',
      companion_dirty_projects_insert: '482ff1a8294a6d1488cb768b8ce94b8012e511dfc55ecd777f73666912a09409',
      companion_dirty_projects_update: 'b1774bb4b1926e04413ecf9728630a2949d86f360ac4c621db6a431a7407bc03',
      companion_dirty_runs_delete: '40eddb813c8cc439f189d24b8d43aa36fcfc8337682981051bbbf86266510051',
      companion_dirty_runs_insert: 'e039929d339aa5b0e57be0946413aa57d7fa90d11811f39db6ce14c0696b2dbf',
      companion_dirty_runs_update: 'e3ba1dd6c73ea2d204a4f786d2337d54c86a09563f26a94a1abf2a8eeba247b3',
      companion_dirty_services_delete: '4608dfca3137b1454df31b472dc2b07f813313d1514f5ac9ca34b92de6823234',
      companion_dirty_services_insert: '2aa310499b4e031efaf134f79569f4628f21a59567274b3a216de945d3bed2bd',
      companion_dirty_services_update: '848f8029b47e798b8332eb05719461f9858ca496d191abf705b0994bdd759b73',
    },
  },
  {
    version: 12, name: 'rotation_workflow_snapshots',
    objects: {
      rotation_workflows: 'ec5900b8924b735ac4da5b6a14a3f520e484a862d4c9bafd71a2a8aa0dad56be',
      idx_rotation_workflows_project_created: '3427cec14ad17f8b95629dbc6f1f8ae152012054649e1232eeed920be0542c4c',
    },
  },
  {
    version: 12, name: 'provider_login_sessions',
    objects: {
      provider_login_sessions: '9b8f4dffe5a91abcc06d716cca0622e3be2f977259ac1ffc58b1a4a7b049655f',
      idx_provider_login_scope: 'd8dfcf98c45db86164d368857833ac7116ea215d5a9fac05978e0d399b9fc69a',
    },
  },
];

export interface AppliedMigration { version: number; name: string }

function fingerprint(sql: string): string {
  return createHash('sha256').update(sql.trim().replace(/\s+/g, ' ')).digest('hex');
}

export function validateMigrationIdentities(
  db: Database.Database,
  applied: AppliedMigration[],
  canonical: ReadonlyArray<AppliedMigration>,
): void {
  const rows = db.prepare('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as Array<{ name: string; sql: string }>;
  const objects = new Map(rows.map((row) => [row.name, row.sql]));
  for (const migration of applied) {
    if (canonical.some((known) => known.version === migration.version && known.name === migration.name)) continue;
    const historical = historicalMigrations.find((known) => known.version === migration.version && known.name === migration.name);
    if (!historical) {
      // Do not echo names read from an unknown database into diagnostics.
      throw new Error('Unrecognized migration identity at version ' + migration.version + '. Preserve the database and use a runtime that understands its exact history.');
    }
    for (const [name, expected] of Object.entries(historical.objects)) {
      const sql = objects.get(name);
      if (!sql || fingerprint(sql) !== expected) {
        throw new Error('Incompatible or missing historical schema object ' + name + '. Preserve the database and inspect its migration history before upgrading.');
      }
    }
    // Historical additive migrations were built on the complete shared base.
    // Do not run missing old migrations through tables maintained by their triggers.
    for (const base of canonical.filter((known) => known.version <= 10)) {
      if (!applied.some((row) => row.version === base.version && row.name === base.name)) {
        throw new Error('Incomplete base migration history for historical schema version ' + migration.version + '. Preserve the database before reconciliation.');
      }
    }
    if (migration.version === 12 && !applied.some((row) => row.version === 11)) {
      throw new Error('Incomplete base migration history for historical schema version 12. Preserve the database before reconciliation.');
    }
  }
  // Objects without their matching marker, or unrecognized objects in a preserved
  // historical namespace, cannot safely be attributed to a known migration.
  for (const row of rows) {
    const historicalNamespace = row.name.startsWith('companion_') || row.name.startsWith('idx_companion_')
      || row.name.startsWith('rotation_workflow') || row.name.startsWith('idx_rotation_workflow')
      || row.name.startsWith('provider_login_') || row.name.startsWith('idx_provider_login_');
    if (!historicalNamespace) continue;
    const owner = historicalMigrations.find((known) => Object.hasOwn(known.objects, row.name));
    if (!owner || !applied.some((migration) => migration.version === owner.version && migration.name === owner.name)) {
      throw new Error('Unattributed historical schema object. Preserve the database and inspect its migration history before upgrading.');
    }
  }
}
